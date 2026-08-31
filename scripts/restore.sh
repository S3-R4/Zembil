#!/usr/bin/env bash
# scripts/restore.sh — restore a Zembil backup over the live data volume.
#
#   ./scripts/restore.sh backups/zembil-20260831-175645Z.db
#   ./scripts/restore.sh --yes backups/zembil-....db     # no prompt, for cron
#
# This REPLACES the database. It is the one destructive script in the repo, so
# it does three things in this order and refuses to continue if any fails:
#
#   1. Validates the backup FIRST — opens it, runs `PRAGMA integrity_check`,
#      checks `user_version` and that a `users` table exists. A restore that
#      discovers the backup was corrupt after deleting the live database is the
#      worst possible outcome and is entirely avoidable.
#   2. Stops the container, so nothing is mid-write. SQLite recovers from a
#      crash, but it cannot recover from a file swapped underneath an open
#      handle.
#   3. Moves the current database aside into `/data/pre-restore-<stamp>/`
#      rather than deleting it — including the `-wal` and `-shm` sidecars,
#      which MUST NOT survive next to a restored file. A stale `-wal` belongs to
#      the database that is now gone, and SQLite would replay it over the one
#      you just restored.
#
# Undo: the previous database is still in the volume under pre-restore-<stamp>/.

set -euo pipefail

VOLUME="${ZEMBIL_VOLUME:-zembil_data}"
IMAGE="${ZEMBIL_IMAGE:-zembil:latest}"
CONTAINER="${ZEMBIL_CONTAINER:-zembil}"
ASSUME_YES=0

while [ $# -gt 0 ]; do
	case "$1" in
		-y|--yes) ASSUME_YES=1; shift ;;
		-h|--help) sed -n '2,25p' "$0"; exit 0 ;;
		*) BACKUP="$1"; shift ;;
	esac
done

if [ -z "${BACKUP:-}" ]; then
	echo "restore: usage: $0 [--yes] <backup.db>" >&2
	exit 2
fi
if [ ! -f "$BACKUP" ]; then
	echo "restore: no such file: $BACKUP" >&2
	exit 1
fi

BACKUP_DIR="$(cd "$(dirname "$BACKUP")" && pwd)"
BACKUP_FILE="$(basename "$BACKUP")"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"

# ---- 1. Validate the backup before touching anything --------------------
echo "restore: validating $BACKUP"
docker run --rm -v "$BACKUP_DIR":/in:ro --entrypoint node "$IMAGE" -e '
	const { DatabaseSync } = require("node:sqlite");
	const db = new DatabaseSync("/in/" + process.argv[1], { readOnly: true });
	const integrity = db.prepare("PRAGMA integrity_check").get();
	if (integrity.integrity_check !== "ok") {
		console.error("restore: integrity_check said:", integrity.integrity_check);
		process.exit(1);
	}
	const version = db.prepare("PRAGMA user_version").get();
	if (Number(version.user_version) < 1) {
		console.error("restore: this file has no Zembil schema (user_version=" + version.user_version + ").");
		process.exit(1);
	}
	const users = db.prepare("SELECT COUNT(*) AS n FROM users").get();
	const stores = db.prepare("SELECT COUNT(*) AS n FROM stores").get();
	const items = db.prepare("SELECT COUNT(*) AS n FROM items").get();
	db.close();
	console.log("restore: valid — schema v" + version.user_version + ", " + users.n +
		" account(s), " + stores.n + " store(s), " + items.n + " item(s)");
' "$BACKUP_FILE" 2>&1 | sed 's/^/  /'

if [ "$ASSUME_YES" -ne 1 ]; then
	printf 'restore: this REPLACES the database in volume "%s". Type yes to continue: ' "$VOLUME"
	read -r reply
	[ "$reply" = "yes" ] || { echo "restore: aborted."; exit 1; }
fi

# ---- 2. Stop the app ----------------------------------------------------
WAS_RUNNING=0
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; then
	WAS_RUNNING=1
	echo "restore: stopping $CONTAINER"
	docker stop "$CONTAINER" >/dev/null
fi

# ---- 3. Swap the files --------------------------------------------------
echo "restore: installing $BACKUP_FILE into $VOLUME"
docker run --rm \
	-v "$VOLUME":/data \
	-v "$BACKUP_DIR":/in:ro \
	--entrypoint sh \
	"$IMAGE" -euc '
		mkdir -p "/data/pre-restore-$2"
		# The sidecars move too. A -wal left beside a restored .db belongs to the
		# database that was just moved away, and SQLite would replay it over the
		# file you meant to restore.
		for f in /data/zembil.db /data/zembil.db-wal /data/zembil.db-shm; do
			[ -e "$f" ] && mv "$f" "/data/pre-restore-$2/" || true
		done
		cp "/in/$1" /data/zembil.db
		chmod 644 /data/zembil.db
		echo "restore: previous database kept at /data/pre-restore-$2/"
	' sh "$BACKUP_FILE" "$STAMP" 2>&1 | sed 's/^/  /'

# ---- 4. Back up ---------------------------------------------------------
if [ "$WAS_RUNNING" -eq 1 ]; then
	echo "restore: starting $CONTAINER"
	docker start "$CONTAINER" >/dev/null
	printf 'restore: waiting for health'
	for _ in $(seq 1 60); do
		state="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
		[ "$state" = "healthy" ] && { echo " ok"; break; }
		printf '.'
		sleep 2
	done
	[ "$state" = "healthy" ] || { echo; echo "restore: container is '$state' — check 'docker compose logs'." >&2; exit 1; }
else
	echo "restore: $CONTAINER was not running; start it with 'docker compose up -d'."
fi

echo "restore: done."
