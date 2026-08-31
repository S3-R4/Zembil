# Zembil

A shopping list for one household, self-hosted. *Zembil* is Turkish for a woven basket.

Lists are per store. Ticking an item does not delete it — it stays visible as history and sinks to
the bottom of the list, and it can be un-ticked. When a trip is closed, anything still unticked
rolls over onto the next list for that store automatically, so the milk you keep forgetting keeps
following you.

Accounts are created by an admin and handed out. There is no public registration. Sign in with a
password or a passkey.

---

## Requirements

- Docker with Compose v2 (`docker compose`, not `docker-compose`). Built and verified on 29.6.0.
- A reverse proxy terminating HTTPS in front of it. **Passkeys will not work over plain HTTP**, and
  the session cookie is `Secure`. This is not a recommendation.
- About 300 MB of disk. The built image measures 264 MB; a family's list for a decade is a few
  megabytes.

Multi-arch: the base image publishes `linux/amd64` and `linux/arm64/v8`, so an x86 home server and a
Raspberry Pi 4/5 are both fine.

---

## Deploy

```sh
git clone <this repo> zembil && cd zembil
cp .env.example .env
$EDITOR .env            # set ZEMBIL_ORIGIN — nothing else is required
docker compose up -d --build
docker compose logs zembil | grep -A6 'first-admin'
```

That last line is the only place the generated admin password will ever appear. Copy it now.

`ZEMBIL_ORIGIN` is the externally visible origin — scheme and host, no trailing slash, e.g.
`https://zembil.example.com`. The app refuses to start without it, on purpose: it is the constant
that the CSRF origin check and WebAuthn's `expectedOrigin`/`expectedRPID` are all measured against,
and there is no safe default.

Compose publishes the app on `127.0.0.1:3000` only. Nothing on the LAN or the internet reaches the
container directly — only whatever terminates TLS on this host.

### Reverse proxy

**Caddy** (this is the whole file):

```caddy
zembil.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Caddy needs no SSE configuration: it does not buffer proxied responses, and it sets
`X-Forwarded-For` with exactly one hop, which is what `ZEMBIL_TRUST_PROXY=1` expects.

**nginx** — the `proxy_buffering off` line is load-bearing:

```nginx
server {
	listen 443 ssl;
	http2 on;
	server_name zembil.example.com;

	# your certificate directives here

	add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

	location / {
		proxy_pass http://127.0.0.1:3000;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;

		# The realtime stream is Server-Sent Events. With nginx's default
		# buffering, the browser receives nothing until the buffer fills, so
		# every other device's changes appear minutes late or not at all — and
		# nothing anywhere reports an error. `proxy_read_timeout` must also
		# exceed the 25-second keepalive comment the stream sends, or nginx
		# closes an idle-looking connection that is working perfectly.
		proxy_buffering off;
		proxy_cache off;
		proxy_read_timeout 1h;
	}
}
```

**Traefik**: no buffering by default; SSE works with a plain `loadbalancer.server.port=3000`
service. Set `forwardedHeaders` on the entrypoint if it sits behind another proxy.

**HSTS is set by the proxy, not by the app.** An app that sets `Strict-Transport-Security` on a
response it served over plain HTTP inside a container is setting a header for a scheme it cannot
see. The proxy knows the truth.

**Do not set `PROTOCOL_HEADER` or `HOST_HEADER`.** They are `@sveltejs/adapter-node` variables that
make the app derive its own origin from `X-Forwarded-Proto` / `X-Forwarded-Host`. Setting either
lets anything that reaches the container directly declare what origin the app believes it is, which
defeats the origin check and WebAuthn together. The compose file does not set them.

### Behind more than one proxy

`ZEMBIL_TRUST_PROXY` is the number of proxies you actually run, and it is the only thing that
decides which `X-Forwarded-For` entry is treated as the client. Counting is from the right:
with `X-Forwarded-For: 1.2.3.4, 203.0.113.9` and `ZEMBIL_TRUST_PROXY=1`, the client is
`203.0.113.9` — the address your proxy really saw. Everything to the left of your own hops is
written by the client and is never read. Set it too high and a visitor picks their own rate-limit
identity; set it to `0` and the header is ignored entirely.

---

## First-admin bootstrap

On the first start, and only while the users table is empty, the app creates one admin account and
requires it to change its password at first sign-in. This runs in-process before the server starts
listening, so `docker compose up` really is the whole setup.

- Username: `ZEMBIL_BOOTSTRAP_ADMIN_USERNAME`, default `admin`.
- Password: `ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD` if you set one; otherwise 20 random characters,
  printed to the log **once** and stored nowhere in plaintext.

It is a no-op on every later start, so leaving those variables in `.env` is harmless — it will never
reset an existing admin's password.

### Recovering a forgotten admin password

If nobody can sign in as an admin any more:

```sh
docker compose run --rm --entrypoint node zembil scripts/bootstrap-admin.js --username admin
```

That re-enables the named account, grants it admin, sets a fresh password, prints it once, and
requires a change at next sign-in. Existing passkeys survive it — the account's WebAuthn handle is
untouched. If the account does not exist, it is created.

---

## Accounts

An admin creates accounts from the admin screen. The server generates the password, shows it once,
and requires the member to change it before they can do anything else — that gate is enforced
server-side, so dismissing the prompt does not get past it.

An admin can also rename an account, grant or revoke admin, disable and re-enable it, issue a fresh
temporary password, and remove all of somebody's passkeys (the fix for a lost phone). Disabling an
account destroys its sessions and closes its live connections immediately. The system will not let
you disable or demote yourself, or reach zero active admins.

### Passkeys

Each member can register passkeys on their own account screen, and sign in with one without typing a
username. Passwords remain as the fallback — every account has one, always.

**Choose `ZEMBIL_RP_ID` before the first passkey is registered, then never change it.** It defaults
to the full hostname of `ZEMBIL_ORIGIN`, which is what you want. Setting it to a registrable domain
(`example.com` rather than `zembil.example.com`) lets *any* page on any sibling subdomain of that
host ask for these credentials. And authenticators key credentials by rpID: changing it later
invalidates every passkey your family has registered, silently, with no migration and no warning
until someone tries to sign in.

---

## Data and backups

Everything lives in one Docker volume, `zembil_data`, as `zembil.db` plus its `-wal` and `-shm`
sidecars while the app is running.

**Do not back up by copying `zembil.db`.** The database runs in WAL mode, so at any instant some
committed data is only in `zembil.db-wal`. Copying the `.db` alone loses it; copying all three while
the app is writing can catch them at different moments. Both produce a file that looks like a
backup and is not.

```sh
./scripts/backup.sh                    # -> ./backups/zembil-<utc-stamp>.db
./scripts/backup.sh /mnt/nas/zembil    # anywhere writable by uid 1000
```

This uses SQLite's `VACUUM INTO`, which writes one self-contained consistent file with no sidecars
while the app keeps serving, then reopens that file and runs `PRAGMA integrity_check` on it. It
prints the account count so you can see at a glance that you backed up the right thing. Run it from
cron; it needs no downtime.

### Cleaning up after a restore

Each restore moves the database it replaced into `pre-restore-<stamp>/` **inside the volume** and
never removes it. That is deliberate — it is the undo — but it means every restore roughly doubles
the volume's size, and a full volume is the one thing that can make a later restore fail halfway.
Delete the old ones once you are satisfied:

```sh
docker run --rm -v zembil_data:/data alpine sh -c 'ls -d /data/pre-restore-*'
docker run --rm -v zembil_data:/data alpine rm -rf /data/pre-restore-20260831-175727Z
```

Restoring replaces the database:

```sh
./scripts/restore.sh backups/zembil-20260831-175645Z.db
```

It validates the backup *before* touching anything, then refuses to continue unless Docker actually
answered when asked whether the app is running — "I could not tell" is not "it is not running", and
treating it that way swaps the database out from under a live process that keeps writing into the
file it was rescued from. It stops the container, copies the backup in **beside** the live database
and verifies that copy in place, and only then moves the current database and both sidecars into
`/data/pre-restore-<stamp>/` and swaps the new file in with an atomic `mv`. If anything fails before
that swap, nothing has moved. Add `--yes` to skip the prompt for scripted use.

If your deployment renames the container or the volume, set `ZEMBIL_CONTAINER` and `ZEMBIL_VOLUME` —
the script tells you which names it is using before it asks for confirmation.

Sessions survive a restore only if they existed in the backup; passkeys likewise. Members whose
accounts were created after the backup was taken will not exist afterwards.

---

## Operations

```sh
docker compose logs -f zembil          # the bootstrap password is here, once
docker compose ps                      # STATUS shows (healthy) / (unhealthy)
curl -s localhost:3000/api/health      # {"status":"ok"} or {"status":"unavailable"}
docker compose up -d --build           # upgrade: rebuild and replace
```

`/api/health` is the only endpoint that answers without a session. It reports two words and nothing
else — no version, no uptime, no counts — because it faces the public internet and a health endpoint
that names its build is a free hint for choosing an exploit. It returns `503` when the database
stops answering, which is what makes the container's health status mean something.

Shutdown is graceful: on `SIGTERM` the app stops accepting connections, closes every open realtime
stream, checkpoints the WAL into the database file, and exits 0 — typically in well under a second.
That checkpoint is why a stopped container leaves a single tidy `zembil.db` behind.

Upgrades that change the schema run their migrations at startup, inside a transaction, before the
server listens. A migration that fails crashes the process rather than leaving a half-migrated
database serving requests. **Take a backup before upgrading.**

---

## Configuration

`.env.example` documents every variable with its default and a reason. `docs/CONTRACT.md` §6 is the
normative reference if the two ever disagree.

### Secrets

There is exactly one, and only if you choose to set it: `ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD` in `.env`.
Everything else in that file is configuration. `.env` is git-ignored and must stay that way; it is
never copied into the image (`.dockerignore` excludes it, and the build context is checked).

There is no application *signing* secret to provision or rotate: sessions are opaque random tokens
stored only as SHA-256 hashes, so nothing needs signing.

`ZEMBIL_LOG_LEVEL` is validated at startup but nothing filters on it yet — setting it will not hide
the first-admin password banner. It is in `docs/BACKLOG.md`.

---

## Development

```sh
npm install
ZEMBIL_ORIGIN=http://localhost:5173 ZEMBIL_DATA_DIR=./data npm run dev
npm test          # vitest, against real SQLite files
npm run test:e2e  # playwright at 390×844, against the production build
npm run check     # svelte-check
```

Over `http://` the session cookie drops the `__Host-` prefix and the `Secure` attribute so local
development works; passkeys still work on `localhost`, which browsers treat as a secure context.
Use `localhost`, not `127.0.0.1` — WebAuthn requires the relying-party ID to be a domain name and
rejects an IP literal before any request leaves the browser.

`npm run test:e2e` builds nothing for you: run `npm run build` first. It starts the real production
server against a throwaway database in `.playwright-data/`, which it wipes on every run.

| Document | What it is |
|---|---|
| [`PLAN.md`](PLAN.md) | Stack, milestones, file ownership, test strategy |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | **The frozen integration boundary.** Schema, rollover rules, HTTP API, session and env contract |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why each choice was made, and what was rejected |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Design tokens and screen specs, distilled from the canvas |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Deliberately deferred |
