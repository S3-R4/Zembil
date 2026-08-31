#!/usr/bin/env bash
# scripts/backup.sh — a consistent backup of a RUNNING Zembil (CONTRACT.md §1.1).
#
# Why this is not `cp /data/zembil.db somewhere`:
#
# The database runs in WAL mode. At any moment some committed transactions live
# only in `zembil.db-wal`, not yet in `zembil.db`. Copying the `.db` file alone
# silently loses them; copying all three files while the app is writing can
# capture them at different instants and produce a set that does not agree with
# itself. Both failures look like a perfectly good backup right up until the
# restore.
#
# `VACUUM INTO` is SQLite's own answer: it reads a single consistent snapshot
# and writes ONE self-contained file with no sidecars, while the app keeps
# serving. That file is the backup.
#
#   ./scripts/backup.sh                      # -> ./backups/zembil-<stamp>.db
#   ./scripts/backup.sh /mnt/nas/zembil      # -> /mnt/nas/zembil/zembil-<stamp>.db
#
# The container runs as uid 1000, so the destination directory must be writable
# by uid 1000. The script checks and says so rather than failing halfway.

set -euo pipefail

VOLUME="${ZEMBIL_VOLUME:-zembil_data}"
IMAGE="${ZEMBIL_IMAGE:-zembil:latest}"
DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/backups}"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
NAME="zembil-${STAMP}.db"

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
	echo "backup: no docker volume named '$VOLUME'." >&2
	echo "backup: set ZEMBIL_VOLUME if your deployment renamed it." >&2
	exit 1
fi

# uid 1000 is the image's `node` user. Checked up front: a permission failure
# discovered by VACUUM INTO leaves a zero-byte file that looks like a backup.
if ! docker run --rm -v "$DEST":/out --entrypoint node "$IMAGE" \
	-e 'require("node:fs").writeFileSync("/out/.zembil-write-test","");require("node:fs").unlinkSync("/out/.zembil-write-test")' \
	>/dev/null 2>&1; then
	echo "backup: $DEST is not writable by uid 1000 (the container's 'node' user)." >&2
	echo "backup: run   sudo chown 1000:1000 '$DEST'   or pick another destination." >&2
	exit 1
fi

echo "backup: $VOLUME -> $DEST/$NAME"

docker run --rm \
	-v "$VOLUME":/data \
	-v "$DEST":/out \
	--entrypoint node \
	"$IMAGE" \
	-e '
		const { DatabaseSync } = require("node:sqlite");
		const out = process.argv[1];
		const db = new DatabaseSync("/data/zembil.db");
		db.exec("PRAGMA busy_timeout = 30000");
		// A single consistent snapshot, written as ONE file with no -wal/-shm
		// beside it. Safe against a live writer: WAL readers never block it.
		db.exec("VACUUM INTO '"'"'" + out + "'"'"'");
		db.close();
		// Prove the file that was just written opens and passes SQLite own
		// integrity check — here, while somebody is still watching, rather than
		// during a restore six months from now.
		const check = new DatabaseSync(out, { readOnly: true });
		const integrity = check.prepare("PRAGMA integrity_check").get();
		const users = check.prepare("SELECT COUNT(*) AS n FROM users").get();
		const version = check.prepare("PRAGMA user_version").get();
		check.close();
		if (integrity.integrity_check !== "ok") {
			console.error("backup: integrity_check said:", integrity.integrity_check);
			process.exit(1);
		}
		console.log("backup: ok — integrity_check=ok, schema v" + version.user_version + ", " + users.n + " account(s)");
	' "/out/$NAME" 2>&1 | sed 's/^/  /'

ls -l "$DEST/$NAME"
echo
echo "Restore with:  ./scripts/restore.sh '$DEST/$NAME'"
