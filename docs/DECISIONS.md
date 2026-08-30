# Zembil — Architecture Decision Log

Format per record: context, decision, alternatives rejected, consequences. Status is `accepted`
unless stated. Records are append-only; a reversal is a new record that supersedes an old one.

Decisions were made by the orchestrator. A planned multi-agent design workflow (4 adversarial
proposals, 5 empirical probes, a 3-judge panel) was cut short by an account spend limit after 3 of 13
agents completed, so the judged synthesis did not run. Where a decision below would have benefited
from that adversarial pass, it is flagged **[unjudged]**. The empirical claims are all first-hand:
they were measured in this environment, not recalled.

---

## D-001 — Runtime and framework: SvelteKit 2 on Node 26, `adapter-node`

**Context.** Mobile-first PWA, server-rendered login, a handful of JSON endpoints, one long-lived SSE
stream, and a hard requirement that the whole thing is one `docker compose up`.

**Decision.** SvelteKit 2 (Svelte 5) with `@sveltejs/adapter-node`, running as a single Node process.

**Alternatives rejected.**
- *Next.js* — React's runtime and hydration cost is paid on every phone in the family, for an app
  whose hardest screen is a list of checkboxes. Its server model also assumes more infrastructure
  than one container.
- *Fastify or Hono plus a hand-rolled client* — more control, but I would end up rebuilding routing,
  SSR, form handling and asset hashing. That is work spent on plumbing rather than on rollover
  correctness.
- *htmx or Datastar over server-rendered HTML* — genuinely attractive for this problem and it would
  produce the smallest client. Rejected because optimistic ticking with an undo affordance and a
  reconciling realtime stream is exactly the case where a hypermedia approach starts growing a
  client-side state machine anyway, at which point Svelte's is better than mine. **[unjudged]** — this
  is the decision the cancelled contrarian judge would most plausibly have overturned.

**Consequences.** Svelte 5 runes are the state model. One process means the realtime bus can be a
plain in-memory emitter with no broker. Horizontal scaling is forfeited, which for fewer than ten
users is not a cost.

---

## D-002 — Database: SQLite via the built-in `node:sqlite` module

**Context.** Fewer than ten users, one home server, and a requirement not to block spending analytics
later. Also a strong desire that a container rebuild never fails on a native compile.

**Decision.** SQLite in WAL mode, accessed through Node's built-in `node:sqlite` module.

I verified the following first-hand on this machine's Node v26.1.0 rather than trusting recall:
SQLite 3.53.0; `journal_mode=WAL`; window functions; `json1`; FTS5; `COLLATE NOCASE`;
`INSERT … RETURNING`; prepared statements with `.run/.get/.all/.iterate`; `db.function`,
`db.aggregate`, `db.serialize`. There is **no** `db.backup()` method, which directly shapes D-013.

**Alternatives rejected.**
- *`better-sqlite3`* — the obvious default, and the API I would rather have. Rejected because it is a
  native addon: on a Node release this new, a missing prebuild means the image needs python, make and
  g++, and an arm64 home server is exactly where that goes wrong at 23:00. `node:sqlite` makes the
  dependency disappear rather than making it easier.
- *PostgreSQL* — the honest argument for it is analytics later. It loses anyway: it doubles the
  compose file, adds a second failure domain and a second backup story, and its analytical advantage
  is irrelevant at a scale where the entire dataset is smaller than the query planner. SQLite has
  window functions and CTEs; a family's grocery history will not exhaust them.

**Consequences.** Zero native dependencies in the whole stack, so the runtime image needs no
toolchain. One file to back up. Writes are serialized, which at this scale is a feature — it makes
the rollover transaction trivially correct. Analytics later attach as nullable columns on `items`
via `ALTER TABLE ADD COLUMN`, a non-destructive migration.

---

## D-003 — No ORM. Hand-written SQL and a numbered migration runner

**Decision.** Plain parameterized SQL in repository modules. Forward-only numbered migrations in
`.sql` files, applied in a transaction, tracked with `PRAGMA user_version`. A shipped migration is
immutable; corrections are new migrations.

**Alternatives rejected.** *Drizzle* and *Kysely* both give real type safety, and Drizzle's migration
generation is genuinely good. Rejected because the schema is nine tables that will barely change, the
invariants that matter live in partial unique indexes and `CHECK` constraints that I want to read
literally, and an ORM is one more thing that can break on a Node upgrade in an app nobody will touch
for a year. **[unjudged]**

**Consequences.** Types are hand-written in `src/lib/types.ts` and enforced by tests rather than by a
generator. Every statement must be prepared and bound — string-interpolating a value into SQL is a
defect the reviewer treats as blocking.

---

## D-004 — Sessions: opaque random tokens stored hashed, not JWTs

**Context.** "Only the admin creates accounts, hands them out, disables them." Disabling must mean
*now*.

**Decision.** 32 random bytes in a cookie. The database stores only `sha256(token)`. Idle expiry 30
days, absolute expiry 180 days, both enforced server-side. Rotated on login and password change.

**Alternatives rejected.** *JWT* — a stateless token cannot be revoked, so "disable this account"
becomes "disable this account within fifteen minutes". Adding a revocation list to fix that
reintroduces the database lookup JWTs existed to avoid, while keeping their footguns.

**Consequences.** One indexed lookup per request, which is free. A database disclosure yields no
usable session because the stored value is a hash. **There is no application signing key at all** —
one less secret to provision, rotate or leak.

---

## D-005 — Password hashing: `scrypt` from `node:crypto`

**Decision.** `crypto.scrypt` with `N=65536, r=8, p=1`, 16-byte salt, 32-byte key, ~64 MiB per
verification. Stored as `scrypt$N=…,r=…,p=…$salt$hash` so parameters can be raised later without a
schema change. Compared with `crypto.timingSafeEqual`. Transparent rehash on login when parameters
are below target.

**Alternatives rejected.** *Argon2id* is the better algorithm and I would prefer it. Both routes to it
have costs that outweigh the margin here: `@node-rs/argon2` is a native addon, which throws away the
main prize of D-002; a WASM build adds a dependency whose supply chain I would have to trust for the
single most security-critical operation in the app. Memory-hard scrypt at 64 MiB, guarding
admin-generated 20-character passwords, is not the weak point in this system.

**Consequences.** Login costs ~150–250 ms of CPU and 64 MiB transiently. `maxmem` must be raised
explicitly or Node throws. Migrating to Argon2 later is a login-time rehash, not a migration.

---

## D-006 — CSRF: `SameSite=Lax` plus a mandatory `Origin` check

**Decision.** `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Every `POST`, `PATCH`
and `DELETE` additionally requires `Origin` to equal `ZEMBIL_ORIGIN`. A **missing** `Origin` on a
mutation is rejected rather than allowed through.

**Alternatives rejected.** *Synchronizer tokens* — real protection, but they need a token in every
form and every fetch, and they break confusingly on a stale PWA tab. `SameSite` plus a strict origin
check gets the same guarantee for browsers from the last several years, which is the entire audience.

**Consequences.** The `__Host-` prefix forbids a `Domain` attribute and requires `Secure`, so plain
HTTP dev drops to an unprefixed cookie name, selected from `ZEMBIL_ORIGIN`'s scheme.

---

## D-007 — Rate limiting: in-memory token buckets, and deliberately no lockout

**Decision.** Per-username and per-IP buckets on login and passkey assertion, per-actor on admin user
creation. In-process, reset on restart. **No account lockout.**

**Rationale for no lockout.** On a family app with known usernames, a lockout is a denial-of-service
that any anonymous visitor can inflict on a family member from a supermarket car park. Throttling
degrades an attacker; locking out degrades the user.

**Consequences.** Buckets do not survive a restart, which is acceptable because restarting requires
host access. Client IP is derived **only** from `ZEMBIL_TRUST_PROXY` hop counting — reading the
leftmost `X-Forwarded-For` entry would let any client forge its identity, and that is treated as a
blocking defect.

---

## D-008 — Passkeys: `@simplewebauthn` v13, usernameless, always with a password fallback

**Decision.** `@simplewebauthn/server` 13.x and `@simplewebauthn/browser` 13.x. Registration requires
an authenticated session. Login uses discoverable credentials with an empty `allowCredentials`, so no
username is typed. Password login always remains available and `users.password_hash` is never NULL.

**Details that are load-bearing.**
- `rpID` and `expectedOrigin` come from configuration, never from the request. Deriving them from a
  `Host` header is an authentication bypass.
- The WebAuthn user handle is 32 random bytes stored per account — not the username, not a sequential
  id. It is an identifier that leaves the server and must carry no information.
- Challenges are server-side rows, single-use, deleted on first use whether verification succeeded
  or failed, and short-lived.
- **A zero signature counter is accepted.** Most platform authenticators report zero; rejecting them
  breaks passkeys outright. A clone is only inferred when both stored and returned counters are
  non-zero and the returned one did not increase.
- The usernameless flow is what makes passkeys enumeration-safe: the options response is identical
  regardless of which accounts exist.

**Alternatives rejected.** Passkey-only accounts — one lost phone locks a family member out of the
shopping list with no self-service recovery. `Passkey as second factor` — friction with no threat
model to justify it here.

**Note.** The probe that would have verified v13's exact API surface against its shipped type
definitions was cancelled by the spend limit. **The implementing agent must read the `.d.ts` files in
`node_modules` rather than trusting recall** — this API changed materially across v9, v10, v11 and v13.

---

## D-009 — Rollover: one open trip per store, closed manually, unticked items cloned forward

**Context.** The brief left the model open. The design canvas settles it: the list screen's primary
action is **"Finish trip · 3 bought"**, and the confirm sheet reads **Bought / Left on the list / Keep
shopping**.

**Decision.** A "list" is a **trip**. Each store has exactly one open trip at all times. Closing is an
explicit user action. Closing atomically: closes the trip, opens its successor, and **clones** each
unticked item forward with `carried_from_item_id`, `origin_item_id` and an incremented `carry_count`,
marking the original `carried`. Ticked items stay in the closed trip untouched — they are the history.

**Alternatives rejected.**
- *Move the row forward instead of cloning* — cheaper, but it destroys the record that this item was
  on trip 3 and not bought. That record is precisely the substrate the deferred spending analytics
  will need, and per-item carry history is what would later power "you have carried bread four times".
- *Dated or scheduled auto-rollover* — needs a scheduler, and it silently closes a list while someone
  is standing in the shop. The brief says an unticked item lands on the next list *automatically*;
  that describes the carry-over, not the closing.

**Consequences.** Item identity changes across a rollover; `origin_item_id` preserves lineage through
it. Closed trips are immutable, so undo is scoped to the open trip (**R-9**). Empty trips cannot be
closed, keeping history free of meaningless entries.

**The invariant is enforced by the database, not by hope**: `CREATE UNIQUE INDEX
trips_one_open_per_store ON trips (store_id) WHERE status='open'`. I verified that a second open trip
is rejected, and that the `state`/`ticked_at` and `state`/`carried_to_item_id` couplings are rejected
too.

---

## D-010 — Add is scoped to the store, not to the trip

**Decision.** `POST /api/stores/{storeId}/items`. The server resolves the currently-open trip inside
the write transaction.

**Rationale.** This is what makes the add-versus-close race correct by construction. Someone typing an
item while another family member finishes the trip either lands on the old trip and carries over, or
lands on the new one. Neither ordering loses the item, and no client-side retry logic is needed. A
trip-scoped endpoint would have to fail and re-target.

---

## D-011 — Realtime: SSE carrying hints, not data

**Decision.** One `GET /api/events` stream per tab, authenticated by the session cookie. Events say
*"store X changed, revision N"*; the client refetches. Events are emitted **after** commit. A `:ping`
comment every 25 s. The client also revalidates on `visibilitychange`, `focus` and `online`.

**Alternatives rejected.** *Polling* — simpler, but either wastes battery or feels stale; the brief
asks for stale state to resolve quickly. *WebSockets* — bidirectional capability nothing here needs,
plus its own reconnection and proxy-configuration burden.

**Why hints rather than payloads.** A hint is immune to out-of-order delivery and to the gap across a
reconnect, both of which are routine when a phone moves between cell and wifi. Ten users refetching a
short list costs nothing. Carrying data would mean designing a merge algorithm to solve a problem
this scale does not have.

**Consequences.** Buffering proxies break SSE, so `X-Accel-Buffering: no` plus documented nginx,
Caddy and Traefik settings are mandatory, not optional. A stream is torn down the moment its session
is revoked. **[unjudged]** — the SSE probe was cancelled; the implementing agent must verify
`adapter-node` does not compress or buffer `text/event-stream`.

---

## D-012 — Deployment: one service, one volume, non-root, no database container

**Decision.** Multi-stage build on a Node 26 base. The runtime stage carries no toolchain and no
sources, runs as a non-root user, and binds to loopback so the reverse proxy is the only ingress. One
named volume at `/data`. Migrations run at boot.

**Consequences.** `docker compose up` is literally one service. No database port exists to expose.
Secrets arrive as environment variables, with the documented caveat that anyone who can run
`docker inspect` can read them. **[unjudged]** — the Docker probe was cancelled; the deploy agent must
verify base-image tags and the non-root volume-ownership approach empirically rather than assuming.

---

## D-013 — Backup: `VACUUM INTO`, because `node:sqlite` has no `.backup()`

**Context.** I checked the `DatabaseSync` prototype directly: `open, close, prepare, exec, function,
aggregate, createSession, applyChangeset, enableLoadExtension, loadExtension, serialize, deserialize,
setAuthorizer`. There is no `backup`.

**Decision.** Online backup is `VACUUM INTO '<path>'`, which produces a consistent single-file
snapshot while the app keeps serving. Restore is documented as a stop, replace, remove stale
`-wal`/`-shm`, start sequence.

**Rationale.** WAL mode means the database is three files. Copying `zembil.db` alone while the app is
running yields a **silently corrupt** backup, which is the worst failure mode available — it is only
discovered when it is needed. `VACUUM INTO` is SQLite's blessed answer and needs no extra tooling.

---

## D-014 — First admin: bootstrap on an empty users table only

**Decision.** At boot, if `SELECT COUNT(*) FROM users` is zero, create the admin from
`ZEMBIL_BOOTSTRAP_ADMIN_USERNAME` / `ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD`. If no password is supplied, a
random one is generated and logged once. `must_change_password` is set either way.

**Alternatives rejected.** *Unconditional env application* — turns a leftover variable in a compose
file into a permanent password reset on every restart. *A first-run web setup wizard* — a
publicly-reachable unauthenticated endpoint that creates an admin is a race against every scanner on
the internet.

**Consequences.** Idempotent across restarts. A forgotten admin password is recovered through a
documented one-shot `docker compose run` command, not by restarting with the variable set.

---

## D-015 — Self-hosted fonts, no CDN

**Decision.** Bricolage Grotesque and DM Sans are vendored as woff2 under `static/fonts/` and served
from the app's own origin.

**Rationale.** The design canvas loads them from Google Fonts, which is right for a canvas and wrong
for this app: it leaks every family member's IP and user agent to a third party on every cold load,
breaks the app offline, and would force `font-src` and `connect-src` in the CSP to admit an external
origin. Self-hosting keeps the CSP at `'self'` throughout.

---

## D-016 — Testing: Vitest against a real SQLite file, Playwright at 390 px

**Decision.** Vitest for unit and integration tests, each running migrations into a fresh temporary
database file — not `:memory:`, so WAL and `busy_timeout` behaviour is the real thing. Playwright with
an iPhone-class 390×844 device descriptor for end-to-end.

**Rationale.** The brief requires tick, un-tick and carry-over across a rollover to be covered by
tests, and rollover correctness is a transaction-and-constraint property. A mocked database would
test the mock. `npm test` stays fast and dependency-free; Playwright is a separate `npm run test:e2e`
so a browser download is never on the critical path of a build.

---

## D-017 — Scope taken from the design canvas

**Context.** The canvas is the user's own design and shows screens the prose brief did not name.

**Decision.** In scope for the MVP: password and passkey login, store list, item list with tick and
undo, the quick-add sheet that stays open for the next item, item edit and delete, finish-trip
confirm, a read-only trip history, the account screen (passkeys, appearance, sign out), and admin user
management. Deferred to `docs/BACKLOG.md`: "Add all again" from a past trip, "Search past items", and
the desktop keyboard shortcuts.

**Rationale.** Trip history is a read-only view of rows D-009 already produces, so it costs one query
rather than a feature. "Add all again" and search are genuine additions and the brief says MVP means
working, not feature-complete.
