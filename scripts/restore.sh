#!/usr/bin/env bash
# scripts/restore.sh — restore a Zembil backup over the live data volume.
#
#   ./scripts/restore.sh backups/zembil-20260831-175645Z.db
#   ./scripts/restore.sh --yes backups/zembil-....db     # no prompt, for cron
#
# This REPLACES the database. It is the one destructive script in the repo, so
# it refuses to continue unless each of these holds, in this order:
#
#   1. The backup is valid — opened read-only, `PRAGMA integrity_check`,
#      `user_version`, and a `users` table. A restore that discovers the backup
#      was corrupt after deleting the live database is the worst possible
#      outcome and is entirely avoidable.
#   2. Docker actually answered when asked whether the app is running. "I could
#      not tell" is not the same as "it is not running", and treating it that
#      way swaps the database out from under a live process — which keeps
#      writing into the file it was rescued from, silently, until the next
#      restart throws that work away.
#   3. Nothing else has the database open. Proved by taking an EXCLUSIVE lock
#      rather than by looking for a `-shm` file, which a reader that exited can
#      leave behind — a restore that refuses forever on a stale file is one the
#      operator learns to work around.
#   4. The new file is copied in and verified IN PLACE before anything is moved
#      aside, and then swapped by `mv` on the same filesystem — atomic. A `cp`
#      straight over the live path can run out of disk halfway and leave a
#      truncated database and no good one.
#
# The previous database is moved to `/data/pre-restore-<stamp>/`, not deleted.
# Those directories are never cleaned up automatically — see README.md.

set -euo pipefail

VOLUME="${ZEMBIL_VOLUME:-zembil_data}"
IMAGE="${ZEMBIL_IMAGE:-zembil:latest}"
CONTAINER="${ZEMBIL_CONTAINER:-zembil}"
ASSUME_YES=0

while [ $# -gt 0 ]; do
	case "$1" in
		-y|--yes) ASSUME_YES=1; shift ;;
		-h|--help) sed -n '2,30p' "$0"; exit 0 ;;
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

case "$BACKUP_DIR" in
	*:*)
		echo "restore: the backup's directory contains a colon, which docker -v cannot express." >&2
		echo "restore: move it somewhere without one." >&2
		exit 1
		;;
esac

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

# ---- 2. Find out — for certain — whether the app is running -------------
# `|| echo false` would be wrong here. A wrong container name, a compose
# project prefix, a daemon hiccup and a permission error on the socket all
# produce a non-zero exit, and reading any of them as "not running" is how the
# database gets swapped out from under a live process.
inspect_err="$(mktemp)"
trap 'rm -f "$inspect_err"' EXIT

if RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>"$inspect_err")"; then
	:
elif grep -qi 'no such object' "$inspect_err"; then
	RUNNING=false
	echo "restore: no container named '$CONTAINER' exists."
else
	echo "restore: could not ask docker whether '$CONTAINER' is running:" >&2
	sed 's/^/  /' "$inspect_err" >&2
	echo "restore: refusing to continue. Set ZEMBIL_CONTAINER if your deployment renamed it." >&2
	exit 1
fi

if [ "$RUNNING" != "true" ] && [ "$RUNNING" != "false" ]; then
	echo "restore: unexpected answer from docker inspect: '$RUNNING'. Refusing to continue." >&2
	exit 1
fi

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
	echo "restore: no docker volume named '$VOLUME'." >&2
	echo "restore: set ZEMBIL_VOLUME if your deployment renamed it." >&2
	exit 1
fi

if [ "$ASSUME_YES" -ne 1 ]; then
	echo "restore: container '$CONTAINER' is running=$RUNNING; volume '$VOLUME'."
	printf 'restore: this REPLACES the database in that volume. Type yes to continue: '
	read -r reply
	[ "$reply" = "yes" ] || { echo "restore: aborted."; exit 1; }
fi

# ---- 3. Stop the app ----------------------------------------------------
WAS_RUNNING=0
if [ "$RUNNING" = "true" ]; then
	WAS_RUNNING=1
	echo "restore: stopping $CONTAINER"
	docker stop "$CONTAINER" >/dev/null
fi

# ---- 4. Install, atomically ---------------------------------------------
echo "restore: installing $BACKUP_FILE into $VOLUME"
docker run --rm \
	-v "$VOLUME":/data \
	-v "$BACKUP_DIR":/in:ro \
	--entrypoint sh \
	"$IMAGE" -euc '
		BK="$1"; STAMP="$2"; D=/data

		# Prove nothing else has the database open, whatever docker said about the
		# container. A bare `-shm` existence test is not enough on its own: a
		# read-only reader that exited can leave one behind, and a restore that
		# refuses forever on a stale file is a restore the operator learns to work
		# around.
		#
		# So: take an EXCLUSIVE lock. If another connection is attached, SQLite
		# refuses with SQLITE_BUSY and we stop. If it succeeds we are alone, and
		# closing that connection checkpoints the WAL and removes both sidecars —
		# so the file we are about to move aside is a complete database, not one
		# with committed data still living in a `-wal` we would strand beside it.
		if [ -e "$D/zembil.db" ]; then
			node -e "
				const { DatabaseSync } = require(\"node:sqlite\");
				try {
					const db = new DatabaseSync(\"/data/zembil.db\");
					db.exec(\"PRAGMA busy_timeout = 0\");
					db.exec(\"PRAGMA locking_mode = EXCLUSIVE\");
					db.exec(\"BEGIN IMMEDIATE\");
					db.exec(\"COMMIT\");
					db.exec(\"PRAGMA wal_checkpoint(TRUNCATE)\");
					db.close();
				} catch (err) {
					console.error(\"restore: something still has the database open (\" + err.message + \").\");
					console.error(\"restore: stop everything using this volume and try again.\");
					process.exit(1);
				}
			" || exit 1
		fi

		need=$(wc -c < "/in/$BK")
		avail=$(df -k "$D" 2>/dev/null | awk "NR==2 {print \$4 * 1024}") || avail=""
		if [ -n "$avail" ] && [ "$avail" -lt "$((need * 2))" ]; then
			echo "restore: only $avail bytes free in the volume; need about $((need * 2))."
			echo "restore: old pre-restore-* directories in there are the usual cause."
			exit 1
		fi

		# Copy in beside the live file, NOT over it. If this runs out of disk the
		# live database has not been touched.
		rm -f "$D/.zembil.db.incoming"
		cp "/in/$BK" "$D/.zembil.db.incoming"
		chmod 644 "$D/.zembil.db.incoming"

		# Verify the copy that will actually become the database — not the source.
		node -e "
			const { DatabaseSync } = require(\"node:sqlite\");
			const db = new DatabaseSync(\"/data/.zembil.db.incoming\", { readOnly: true });
			const integrity = db.prepare(\"PRAGMA integrity_check\").get();
			const version = db.prepare(\"PRAGMA user_version\").get();
			db.close();
			if (integrity.integrity_check !== \"ok\" || Number(version.user_version) < 1) {
				console.error(\"restore: the installed copy did not verify.\");
				process.exit(1);
			}
		" || { rm -f "$D/.zembil.db.incoming"; exit 1; }

		mkdir -p "$D/pre-restore-$STAMP"
		# The sidecars move too. A -wal left beside a restored .db belongs to the
		# database that was just moved away, and SQLite would replay it over the
		# file you meant to restore.
		for f in zembil.db zembil.db-wal zembil.db-shm; do
			if [ -e "$D/$f" ]; then mv "$D/$f" "$D/pre-restore-$STAMP/"; fi
		done

		# Same filesystem, so this is atomic: there is no instant at which
		# /data/zembil.db is a partial file.
		if ! mv "$D/.zembil.db.incoming" "$D/zembil.db"; then
			echo "restore: the final swap failed; putting the previous database back."
			for f in zembil.db zembil.db-wal zembil.db-shm; do
				if [ -e "$D/pre-restore-$STAMP/$f" ]; then mv "$D/pre-restore-$STAMP/$f" "$D/"; fi
			done
			rmdir "$D/pre-restore-$STAMP" 2>/dev/null || true
			exit 1
		fi

		if [ -d "$D/pre-restore-$STAMP" ] && [ -n "$(ls -A "$D/pre-restore-$STAMP")" ]; then
			echo "restore: previous database kept at $D/pre-restore-$STAMP/"
		else
			rmdir "$D/pre-restore-$STAMP" 2>/dev/null || true
			echo "restore: there was no previous database in this volume."
		fi
	' sh "$BACKUP_FILE" "$STAMP" 2>&1 | sed 's/^/  /'

# ---- 5. Back up ---------------------------------------------------------
if [ "$WAS_RUNNING" -eq 1 ]; then
	echo "restore: starting $CONTAINER"
	docker start "$CONTAINER" >/dev/null
	printf 'restore: waiting for health'
	state=unknown
	for _ in $(seq 1 60); do
		state="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
		if [ "$state" = "healthy" ]; then echo " ok"; break; fi
		printf '.'
		sleep 2
	done
	[ "$state" = "healthy" ] || { echo; echo "restore: container is '$state' — check 'docker compose logs'." >&2; exit 1; }
else
	echo "restore: $CONTAINER was not running; start it with 'docker compose up -d'."
fi

echo "restore: done."
