#!/bin/sh
# scripts/entrypoint.sh — container entrypoint (CONTRACT.md §3.8, DECISIONS.md D-012)
#
# Runs as the non-root `node` user (set by `USER node` in the Dockerfile), so
# it cannot chown anything — the Dockerfile already gave /data the right
# ownership before switching users, and this script's only jobs are:
#
#   1. Fail fast and loudly if the data volume turns out not to be writable
#      anyway (a misconfigured bind mount overriding the named volume, for
#      example), instead of letting node:sqlite surface a cryptic
#      "unable to open database file" three log lines into startup.
#   2. `exec` node so it REPLACES this shell and becomes PID 1 itself.
#
# That second point is load-bearing. Docker sends SIGTERM to PID 1. If this
# script were left running as PID 1 with node as a child process, SIGTERM
# would hit this shell — which does nothing with it by default — and node
# would never see the signal at all, silently skipping the WAL checkpoint
# CONTRACT.md §3.8 requires on shutdown. Do not wrap the final line in a
# subshell, backticks, or `&`; any of those would break this.

set -eu

DATA_DIR="${ZEMBIL_DATA_DIR:-/data}"

mkdir -p "$DATA_DIR" 2>/dev/null || true

# A REAL write, not `test -w`. On a read-only mount (`-v vol:/data:ro`) the
# permission bits still say writable and `[ -w ]` passes, and the failure then
# surfaces as "attempt to write a readonly database" from inside node — which
# is exactly the cryptic ending this check exists to prevent.
if ! (touch "$DATA_DIR/.zembil-write-test" && rm -f "$DATA_DIR/.zembil-write-test") 2>/dev/null; then
	echo "entrypoint: cannot write to $DATA_DIR as uid $(id -u) ($(id -un 2>/dev/null || echo unknown))." >&2
	echo "entrypoint: the volume mounted there must be writable by this container's" >&2
	echo "entrypoint: non-root user, and must not be mounted read-only." >&2
	echo "entrypoint: See README.md, 'The data volume'." >&2
	exit 1
fi

exec node build/index.js "$@"
