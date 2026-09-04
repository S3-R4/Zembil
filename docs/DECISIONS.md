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

- _Next.js_ — React's runtime and hydration cost is paid on every phone in the family, for an app
  whose hardest screen is a list of checkboxes. Its server model also assumes more infrastructure
  than one container.
- _Fastify or Hono plus a hand-rolled client_ — more control, but I would end up rebuilding routing,
  SSR, form handling and asset hashing. That is work spent on plumbing rather than on rollover
  correctness.
- _htmx or Datastar over server-rendered HTML_ — genuinely attractive for this problem and it would
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

- _`better-sqlite3`_ — the obvious default, and the API I would rather have. Rejected because it is a
  native addon: on a Node release this new, a missing prebuild means the image needs python, make and
  g++, and an arm64 home server is exactly where that goes wrong at 23:00. `node:sqlite` makes the
  dependency disappear rather than making it easier.
- _PostgreSQL_ — the honest argument for it is analytics later. It loses anyway: it doubles the
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

**Alternatives rejected.** _Drizzle_ and _Kysely_ both give real type safety, and Drizzle's migration
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
_now_.

**Decision.** 32 random bytes in a cookie. The database stores only `sha256(token)`. Idle expiry 30
days, absolute expiry 180 days, both enforced server-side. Rotated on login and password change.

**Alternatives rejected.** _JWT_ — a stateless token cannot be revoked, so "disable this account"
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

**Alternatives rejected.** _Argon2id_ is the better algorithm and I would prefer it. Both routes to it
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

**Alternatives rejected.** _Synchronizer tokens_ — real protection, but they need a token in every
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

- _Move the row forward instead of cloning_ — cheaper, but it destroys the record that this item was
  on trip 3 and not bought. That record is precisely the substrate the deferred spending analytics
  will need, and per-item carry history is what would later power "you have carried bread four times".
- _Dated or scheduled auto-rollover_ — needs a scheduler, and it silently closes a list while someone
  is standing in the shop. The brief says an unticked item lands on the next list _automatically_;
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
_"store X changed, revision N"_; the client refetches. Events are emitted **after** commit. A `:ping`
comment every 25 s. The client also revalidates on `visibilitychange`, `focus` and `online`.

**Alternatives rejected.** _Polling_ — simpler, but either wastes battery or feels stale; the brief
asks for stale state to resolve quickly. _WebSockets_ — bidirectional capability nothing here needs,
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

## D-013 — Backup: `backup()` for snapshots, `VACUUM INTO` for pre-migration

**Superseded an earlier version of this record.** That version claimed `node:sqlite` has no online
backup, based on inspecting the `DatabaseSync` prototype (`open, close, prepare, exec, function,
aggregate, createSession, applyChangeset, enableLoadExtension, loadExtension, serialize, deserialize,
setAuthorizer` — no `backup`). That inspection was too narrow and the conclusion was wrong. A design
agent challenged it; I re-measured.

**Measured on this machine.** `node:sqlite` exports `DatabaseSync, StatementSync, Session, constants,
backup`. `backup` is a **module-level function**, not a method: `import { backup } from 'node:sqlite'`.
It is async and incremental, taking `{ rate, progress }`. Run against a live WAL database of 5000
rows it copied 21 pages and the resulting file passed `PRAGMA quick_check`.

**Decision.**

- **Scheduled and on-demand snapshots use `backup()`.** Being incremental, it yields between page
  batches instead of holding a read lock for the whole copy, so a backup never stalls someone
  ticking an item in a shop.
- **`VACUUM INTO` is kept for the pre-migration snapshot and for periodic compaction**, where a
  defragmented single-file output is what is wanted and a brief lock is acceptable.
- Every migration takes an automatic `pre-migration-<from>-to-<to>.sqlite` snapshot first and
  **refuses to proceed if the snapshot fails**.

**Rationale.** WAL mode means the database is three files. Copying `zembil.db` alone while the app is
running yields a **silently corrupt** backup — the worst failure mode available, because it is only
discovered when it is needed. Both mechanisms above produce a consistent single file.

**Consequence.** Restore is stop, replace the single file, delete any stale `-wal`/`-shm`, start.
Forward-only migrations need no down-scripts: the rollback is restoring the pre-migration snapshot,
which is strictly more reliable than a down-script nobody has ever run.

**Amended at M4 — `scripts/backup.sh` uses `VACUUM INTO`, and that is deliberate.** The M4 audit
caught the shipped script contradicting the first bullet above without a record, which is fair: a
decision that was itself a correction of a wrong measurement is exactly the one not to drift away
from silently. The reasoning has changed with the deployment shape, not with the measurement:

- The argument for `backup()` was that being incremental it "never stalls someone ticking an item in
  a shop". That concern was about a copy running **inside the app process**. `backup.sh` runs in a
  separate one-off container against the same volume, and under WAL a reader takes a snapshot
  without blocking the writer at all — so there is nothing to stall.
- `VACUUM INTO` is synchronous, which is what a shell script wants: one process, one exit code, no
  partial-file window to reason about across an `await`.
- It defragments, so the file an operator carries to a NAS is the smallest correct one.

`backup()` remains the right call for anything running in-process, which is where the pre-migration
snapshot in the third bullet would live. That snapshot is **still not implemented** —
`src/lib/server/db/migrations.ts` mentions it in a comment only, and `README.md` currently tells the
operator to take a backup before upgrading by hand. Recorded in `docs/BACKLOG.md` rather than left as
an unmarked promise.

## D-014 — First admin: bootstrap on an empty users table only

**Decision.** At boot, if `SELECT COUNT(*) FROM users` is zero, create the admin from
`ZEMBIL_BOOTSTRAP_ADMIN_USERNAME` / `ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD`. If no password is supplied, a
random one is generated and logged once. `must_change_password` is set either way.

**Alternatives rejected.** _Unconditional env application_ — turns a leftover variable in a compose
file into a permanent password reset on every restart. _A first-run web setup wizard_ — a
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

---

## D-018 — `STRICT` tables and a schema-drift test

**Decision.** Every table is declared `STRICT`. CI builds a database from zero by running every
migration in order and diffs `SELECT sql FROM sqlite_schema ORDER BY name` against a checked-in
`schema.snapshot.sql`.

**Rationale.** SQLite's default type affinity will happily store `'banana'` in an `INTEGER` column.
`STRICT` turns that into an immediate error — verified on this build. The snapshot diff catches the
failure mode an ORM is usually bought to prevent and does not actually fix: **schema drift**, where
the migration sequence that produced the development database is not the sequence that will run
against the production file. That is discovered at 23:00 when the container will not boot. The
snapshot also doubles as readable documentation of the current schema.

**Consequence.** Column types are restricted to `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, `ANY` —
which the schema already satisfies. Editing a shipped migration in place becomes a CI failure rather
than a production surprise.

---

## D-019 — `client_id` idempotency is scoped to the store and survives rollover

**Decision.** The uniqueness index moves from `(trip_id, client_id)` to
`(store_id, client_id) WHERE client_id IS NOT NULL AND state <> 'carried' AND deleted_at IS NULL`,
carry-over **preserves** `client_id` instead of nulling it, and R-6 step 5 updates the original to
`carried` **before** inserting the clone.

**Rationale.** The original design was provably broken and it was reproduced by executing the DDL,
not argued about: add an item, retry the add on a flaky connection, and let a rollover land between
the two. The first request creates the item; the close clones it forward with `client_id=NULL`; the
retry finds no `(trip_id, client_id)` match on the new trip and creates a second item. The family
ends up with two of everything, permanently, and the one feature that exists specifically to prevent
duplicates is the thing that caused them. Store scope is also the honest scope: the client's mental
model is "I added this to Migros", not "I added this to Migros trip #7".

**Consequence.** The partial predicate is what keeps the chain legal — a carried original and its
live clone share a `client_id` but only one of them is inside the index. That makes statement order
in close load-bearing rather than stylistic. A retry that crosses a close returns `200` with an item
on a **later** trip than the caller asked about; the client must accept that.

**Correction (M0 audit round 2).** This decision originally claimed the two-statement
update-then-insert order was "verified against `node:sqlite` on this build". It was not. What I had
actually verified was the index behaviour on a stripped-down table with no foreign key, and I
carried the conclusion across to a schema where `carried_to_item_id` is a self-referencing FK that
SQLite checks immediately. Run against the real §1.1 DDL with `foreign_keys=ON`, that order fails
with `FOREIGN KEY constraint failed`, and the reverse order fails on `items_client_id` — so as
written, the very first close of any store with a pending item would have returned `500` and
carry-over, the brief's headline feature, would never have worked once. The reviewer caught it by
executing the DDL. The fix is the three-statement sequence now in R-6 step 5, and I have reproduced
both failures and the fix. See D-024 for the shape of the mistake, which is the more useful lesson
than the SQL.

---

## D-020 — `sort_order` is allocated by the server in gaps of 1000

**Decision.** The server assigns `MAX(sort_order) + 1000` inside the write transaction. Clones inherit
their original's value verbatim. Clients never send an item `sort_order`.

**Rationale.** Nothing in the contract assigned this field, which left every agent free to invent an
answer — the frontend could have sent it, the repository could have defaulted it to zero, and close
could have reset it. Under the zero-default reading every carried item shares the key `(0, created_at)`
with `created_at` set to the same `now`, so the list after a rollover would render in an order SQLite
chose and reshuffle between refetches. Inheritance keeps the order the family last saw, which is the
whole point of carry-over: the list should look like the list, one trip later.

**Consequence.** `sort_order` is unique per trip (I-12) and the 1000-gap leaves room for a future
drag-to-reorder to insert between neighbours without rewriting every row. R-13 gains an `id` tiebreak
so the order is total even if that invariant is ever violated.

---

## D-021 — Realtime effects are enumerated per endpoint, not left to inference

**Decision.** Contract §3.0 is a normative table naming, for every write, whether it bumps
`stores.rev` and which event it emits. The SSE wire format is pinned to unnamed events with
single-line JSON `data`, no `event:` name and no `id:`.

**Rationale.** `stores.rev` and `store.changed` were specified only for close. Read literally, that
means adding an item produced no event at all and every other phone kept showing a stale list until
someone pulled to refresh — the multi-user requirement silently unimplemented, and unimplemented in a
way that looks like a network flake rather than a bug. The wire format matters for the same reason:
the data agent writing `event: store.changed` and the frontend agent writing `es.onmessage` produce
code that compiles, passes both agents' own tests, and never delivers a single event. These two agents
never see each other's files, so the wire is the only place the agreement can live.

**Consequence.** The table is the acceptance criterion for the realtime tests. Idempotent no-ops
(re-ticking, re-deleting, an idempotent add hit) explicitly emit nothing, so two phones racing to tick
the same item generate one event, not two.

---

## D-022 — `ZEMBIL_RP_ID` is the full hostname, never the registrable domain

**Decision.** The WebAuthn relying-party ID defaults to and is documented as the full hostname of
`ZEMBIL_ORIGIN`. Startup warns loudly if it is configured as a proper suffix.

**Rationale.** The earlier wording said "registrable domain", which is a real WebAuthn option and the
wrong one here. rpID is a **scope**: a credential minted for `example.com` can be requested by any
page under `*.example.com`. The deployment target is a home server that very likely runs other things
on sibling subdomains, and any one of them — including anything with a stored-XSS hole — could then
ask the browser for a Zembil passkey and be handed a valid assertion. It is also effectively
irreversible: authenticators key credentials by rpID, so narrowing it later invalidates every passkey
the family has registered.

**Consequence.** Passkeys work only on the exact hostname. That is the intended behaviour for a
single-origin app.

---

## D-023 — The `Origin` check is ours, and per-IP rate limits are deliberately loose

**Decision.** The mutating-request `Origin` check lives in `hooks.server.ts` and runs for every method
and every content type. SvelteKit's `kit.csrf.checkOrigin` stays on but is not the control. The per-IP
login and passkey buckets rise to 300 per 15 minutes; the per-username bucket stays at 10.

**Rationale.** Two separate near-misses with the same shape — a defence that appears present and is
not. `checkOrigin` only inspects the three HTML form content types; Zembil speaks `application/json`
exclusively, so relying on the framework would have left every mutation covered by nothing but
`SameSite=Lax`. And the per-IP bucket, at 30 per 15 minutes, was sized as if each family member had
their own address. They share one home WAN IP, and behind the reverse proxy they may all present that
single value — so one person mistyping their password on the sofa could lock the rest of the household
out of the shopping list. That is exactly the denial-of-service D-007 refuses to build, arriving
through a different door.

**Consequence.** Per-IP is now a coarse brake against a bot, and per-`username_key` is the real
credential-stuffing control — the knob to tighten if abuse ever appears. `PROTOCOL_HEADER` and
`HOST_HEADER` must stay unset (§6) so that nothing a client sends can influence what the app believes
its own origin is.

---

## D-024 — Carry-over commits in three statements, and FKs stay immediate

**Decision.** R-6 step 5 inserts the clone with `client_id = NULL`, marks the original `carried`, then
writes the clone's `client_id` — three statements, inside the existing `BEGIN IMMEDIATE`. The
`carried_to_item_id` foreign key is **not** made `DEFERRABLE INITIALLY DEFERRED`.

**Rationale.** Two constraints pull in opposite directions and neither two-statement order satisfies
both. `carried_to_item_id` is a self-reference and SQLite checks foreign keys immediately, so marking
the original `carried` first points at a clone that does not exist yet. Inserting the clone first puts
two rows carrying the same `client_id` inside `items_client_id`'s partial predicate at once. Measured,
not reasoned:

| Sequence                                                               | Result                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| update original, then insert clone                                     | `FOREIGN KEY constraint failed`                             |
| insert clone, then update original                                     | `UNIQUE constraint failed: items.store_id, items.client_id` |
| insert with `client_id=NULL`, update original, set clone's `client_id` | commits                                                     |

Deferring the FK would also work and would save one `UPDATE`. It is the wrong trade: `DEFERRABLE
INITIALLY DEFERRED` suspends that check for **every** transaction in the application, forever, to buy
one statement on a path that runs once per shopping trip. The three-statement form is local to close,
costs nothing at family scale, and leaves the constraint doing its job everywhere else.

**Consequence.** Close is the one place in the codebase where statement order is load-bearing, so a
test asserts that _both_ wrong orders raise `SQLITE_CONSTRAINT`. Without that test the sequence would
appear to "start working" the day someone drops a constraint for an unrelated reason.

---

## D-025 — Cross-agent seams are named in the contract, not left to convention

**Decision.** Three interfaces move into the frozen contract: `App.Locals` (§7), the
`src/lib/server/realtime/bus.ts` export surface (§4.1), and file ownership for the build skeleton
(`PLAN.md` §4, assigned to the orchestrator). `src/app.d.ts` goes to `zembil-auth`.

**Rationale.** Three separate findings in the second audit round had one shape: an interface between
two agents that the contract described in prose but never named. The contract said the actor is
"attached to the request by `hooks.server.ts`" without saying under what property — so the auth agent
writes `locals.session.user` and the data agent reads `locals.user.id`, both suites pass, and every
write route throws `TypeError` at integration. It required auth-owned admin endpoints to terminate a
user's SSE streams while forbidding that agent from touching the realtime module and never defining
the function to call — so "disabling an account means _now_", the entire rationale for choosing
server-side sessions over JWTs in D-004, would have shipped unimplemented. And nobody owned
`svelte.config.js`, which carries a CSP that D-026 shows is load-bearing.

The general rule this makes explicit: **whenever two agents that never see each other's code must
agree on something, the agreement goes in the contract — including the ones that feel too small to
write down.** D-021 already applied this to the SSE wire format and it was not enough, because
pinning the bytes on the wire is worthless if the two sides disagree about the function that emits
them.

**Consequence.** The contract now contains TypeScript that is not a data shape but an API surface.
That is a widening of what "contract" means here, and it is the right one.

---

## D-026 — CSP comes from `kit.csp`, and `hooks.server.ts` must not set it

**Decision.** `svelte.config.js` owns `Content-Security-Policy` via `kit.csp` hash mode.
`hooks.server.ts` sets the other security headers and never CSP. `style-src` carries
`'unsafe-inline'`; `script-src` never does.

**Rationale.** §5 previously required a static CSP header set in hooks _and_ `kit.csp` hash mode. Both
cannot hold. SvelteKit emits an inline hydration script and injects its `'sha256-…'` into the CSP it
generates; a static header either replaces that one or is sent alongside it, and a browser enforces
the intersection of multiple CSP headers — the hash is lost either way. The result is an app that
renders and never hydrates, **in the production build only**, which is the failure mode most likely to
survive every dev-mode check and reach the server. The `style-src` asymmetry is a separate, smaller
judgement: one `style="transform: translateX(…)"` on a swipe-to-tick row is enough to break a strict
`style-src`, and on a same-origin app with no user-supplied HTML the injection risk from inline styles
is not comparable to that from inline scripts.

**Consequence.** `Cache-Control: no-store` on every authenticated response joins the header set at the
same time — a shopping list carrying family members' names must not land in an intermediary cache, and
a header does not depend on the frontend agent remembering the service worker rule.

---

## D-027 — `must_change_password` is enforced by the server

**Decision.** While the flag is set, every endpoint except `GET /api/me`, `POST /api/auth/password`
and `POST /api/auth/logout` returns `403 PASSWORD_CHANGE_REQUIRED`. `mustChangePassword` joins the
`User` type.

**Rationale.** The flag was written by admin-create and reset-password, returned once by login, and
enforced by nothing. The realistic sequence: an admin creates an account, sends the generated
20-character password over WhatsApp, the member logs in, dismisses the change prompt, reloads — the
flag is gone from client state and the temporary password stays valid for the full 180-day absolute
session TTL, known to the admin and to anyone who read that chat. A prompt the client can dismiss is
not a control.

**Consequence.** The frontend must handle `403 PASSWORD_CHANGE_REQUIRED` as a redirect to the change
screen rather than as an error, on any request. Putting the flag on `User` means a reload cannot lose
it.

---

## D-028 — The SSE stream bound is `desiredSize`, and its real ceiling is the socket buffer

**Decision.** `src/routes/api/events/+server.ts` tears a stream down when
`controller.desiredSize <= -64`. That bound stays, but it is documented as an _eventual_ bound, not a
64-event one: the measured ceiling per stalled stream is roughly **2.5 MB**, not 64 chunks.

**Rationale.** Measured, not reasoned, against `@sveltejs/kit/node`'s `setResponse` on Node 26.1.0
with a client that opens the stream and never reads a byte (a paused TCP socket, which is what a
suspended phone or a deliberate stall actually looks like):

| probe                                                 | result                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| chunks flush as enqueued, nothing buffers to EOF      | headers at 29 ms, chunks at 30/47/68 ms — **pass**     |
| client disconnect fires the stream's `cancel`         | fires — the route's unsubscribe is reachable, **pass** |
| `desiredSize` falls for a consumer that stops reading | falls, but only after **27,749 events / 2.51 MB**      |

The reason for the gap is that `setResponse` pipes the web stream into the Node response, and the
kernel and libuv socket buffers absorb everything until they are full. Until then the reader keeps
pulling and `desiredSize` sits at 1, so the queue bound cannot see a stalled client at all. Only once
the socket stalls does backpressure reach the `ReadableStream` queue, and then the bound fires
immediately.

**Consequence.** Worst case is ~2.5 MB per stalled stream, ×4 streams per session (§4) × fewer than
ten users — bounded, and acceptable for this deployment. It is _not_ the tight bound the constant's
name suggests, so the comment in `+server.ts` must not claim one. Probes 1 and 2 also close two of
the `PLAN.md` §7 known gaps: adapter-node needs no explicit flush call, and disconnects do not leak
bus subscriptions. Buffering at the **reverse proxy** is a separate risk and remains M4's problem —
`proxy_buffering off` for the events endpoint belongs in the deployment notes.

---

## D-029 — The `@simplewebauthn` v13 API surface is pinned from the shipped types, not from recall

**Decision.** M2 builds against the v13.3.3 signatures below, and `docs/CONTRACT.md` §3.2 now pins
`authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }` rather than
accepting the library defaults.

**Rationale.** Read out of `node_modules/@simplewebauthn/server/esm/**/*.d.ts` — this API changed
materially across v9, v10, v11 and v13, and `PLAN.md` §7 flagged recall as untrustworthy here. What
the installed version actually says:

|                                      | v13.3.3                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `verifyRegistrationResponse` →       | `registrationInfo.credential: { id: Base64URLString, publicKey: Uint8Array, counter, transports? }` |
|                                      | **not** the flat `credentialID` / `credentialPublicKey` / `counter` of v9–v10                       |
| `verifyAuthenticationResponse` takes | `credential: WebAuthnCredential` (**not** `authenticator:`)                                         |
|                                      | and `expectedRPID` is **required**, not optional                                                    |
| `generateRegistrationOptions` takes  | `userID?: Uint8Array`, `userName`, `rpName`, `rpID`                                                 |
| `verifyAuthenticationResponse` →     | `authenticationInfo.newCounter`                                                                     |

The trap worth naming: the JSDoc block above `VerifiedRegistrationResponse` still documents the old
flat shape (`registrationInfo.credentialPublicKey`, `registrationInfo.credentialID`) while the type
underneath it returns the nested `credential` object. Anyone reading the comment rather than the type
writes code that compiles against `any` and fails at runtime.

The §1.1 `credentials` DDL needs no change: `id TEXT` matches `Base64URLString`, `public_key BLOB`
matches `Uint8Array`, and `users.webauthn_user_handle` as a 32-byte BLOB matches `userID`.

**Consequence.** Closes `PLAN.md` §7 probe 1. The `residentKey` ruling is the load-bearing part: under
the library default of `'preferred'`, an authenticator may create a non-discoverable credential, the
registration succeeds, the account screen lists the passkey, and the usernameless login flow — which
sends an empty `allowCredentials` by design (§3.2) — can never find it. The member ends up with a
passkey that exists and cannot log them in. `'required'` converts that into a visible refusal at
registration time.

---

## D-030 — Guards are verified by mutation, not by reading the tests

**Decision.** Every milestone from M2 on carries a mutation sweep as an exit criterion: break each
guard, run the suite, and treat anything that stays green as a finding. Recorded in `PLAN.md` §6.

**Rationale.** M1 took three audit rounds, and all three found the same failure — not a missing
guard, but a guard that could not be reached by the test written to protect it:

| round | guard                                | why the test could not reach it                                                          |
| ----- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1     | `Number.isInteger` on `sortOrder`    | the check itself was wrong; the test asserted the 400 and never read the store list back |
| 2     | `itemVersion`                        | the test omitted `name`, so `updateItem`'s "nothing to update" guard fired first         |
| 2     | `beforeSeq`                          | no test of any kind; it is reachable only through a query string                         |
| 3     | `readJson`'s body-shape check        | route layer — structurally unreachable from any domain-level test                        |
| 3     | `handle()`'s generic-message promise | nothing ever forced a non-`DomainError` through a route                                  |

Each of these was correctly written and accurately commented. Reading the code confirmed the guard;
reading the tests confirmed a test existed that named it. Only mutation showed the two were not
connected. In round 3 a 40-mutation sweep separated 33 real protections from 7 vacuous ones in a
single pass, which no amount of re-reading had managed across two prior audits.

**Consequence.** A green suite is evidence about the mutations someone tried, and nothing more. The
route seam gets its own pass every time: guards reachable only through a query string, a path
parameter or a raw JSON body are invisible to domain-level tests by construction, and three of the
five findings above lived exactly there. This is also why the reviewer agent's brief says to attack
the tests as hard as the code — that instruction came out of round 1 and has paid for itself twice.

---

## D-031 — The deployment seam is pinned before M2 and M4 run in parallel

**Decision.** `CONTRACT.md` §3.8 now specifies `GET /api/health`, where bootstrap runs, and what
`SIGTERM` does. `zembil-auth` (M2) and `zembil-deploy` (M4) then run concurrently, since PLAN.md §4
gives them disjoint file sets.

**Rationale.** M4 cannot write a healthcheck, an entrypoint or a backup script without knowing what
M2 builds, and M2 owns every file that would answer those questions. The contract had nothing on any
of the three — a gap invisible while the milestones were sequential, and guaranteed to produce two
incompatible guesses the moment they are not.

Three rulings worth their reasons:

- **`/api/health` returns two words.** It is the only unauthenticated endpoint and the only one
  exempt from the origin check, and it faces the public internet. A health endpoint that reports the
  build version hands an attacker a free fingerprint for choosing a matching CVE. It must still
  return `503` when the database is gone, or Docker restarts nothing while every real request 500s.
- **Bootstrap runs in-process, at `hooks.server.ts` load.** The brief's constraint is a single
  `docker compose up`; a first-admin step an operator has to know about does not meet it. The
  generated password is logged once, at `warn`, with `must_change_password` set — a handoff
  credential, not a standing one.
- **`SIGTERM` checkpoints the WAL.** A container killed mid-write leaves a `-wal` sidecar that
  SQLite can recover but a file-copy backup cannot, and that is discovered at restore time.

**Consequence.** M2 gains one route and a shutdown hook it would not otherwise have written. M4 can
be built and verified against Docker 29.6.0 without waiting for M2 to land. This is the parallel case
the file-ownership table was built for: the sets are disjoint, so the only real coupling was the
seam, and the seam is now in the document both agents are handed rather than in either agent's head.

---

## D-032 — The request seam is a factory, not a module side effect

**Decision.** `src/hooks.server.ts` does nothing but the once-per-process startup of §3.8 and then
exports `createHandle(db, config)` from `$lib/server/auth/handle.ts`. The per-request logic —
origin check, session resolution, security headers, the `must_change_password` gate — lives in that
factory and takes its connection and configuration as arguments.

**Rationale.** `hooks.server.ts` must run migrations and bootstrap at module load, because §6
requires a failed migration to crash the process rather than surface as a 500 on the first request.
That makes the module unimportable from a test: evaluating it opens `/data/zembil.db`, hashes a
password and registers signal handlers. The first draft put the `handle` implementation there too,
and the result was a request seam carrying four of the milestone's guards — including the
load-bearing Origin check — with no way to exercise any of them.

**Consequence.** `tests/auth/handle.test.ts` drives the real hook against a temporary database, and
the mutation sweep below could reach all eleven of its guards. The cost is one extra module and one
extra indirection in the file SvelteKit actually loads.

Two smaller rulings recorded here rather than given their own numbers:

- **`closeAllStreams()` is added to the §4.1 bus surface.** §3.8 requires SIGTERM to close every
  open SSE stream, and an SSE response never ends on its own — without this the container waits for
  its kill timeout instead of exiting 0. The addition is purely additive; the four functions §4.1
  pins keep their signatures. No `session.revoked` is sent first, because nothing was revoked:
  clients reconnect and revalidate on `open`, which is the right behaviour across a restart.
- **The `must_change_password` gate covers `/api/**` only.** §3.2 says "every endpoint". Taken
  literally that includes the HTML shell, which is where the change-password screen lives — the
  member would be locked out of the one action that clears the flag. Every route that returns family
  data is under `/api/`, so that is where the gate sits.

---

## D-033 — M2's mutation sweep, and the third outcome a mutation can have

**Decision.** 102 mutations were applied across M2's guards (93 in the first pass, 9 corrections and
re-runs in the second). 99 were killed. The remaining three are kept and documented in the code
rather than tested, because no test can distinguish them: they are **provably redundant**, which
D-030 did not anticipate as a category distinct from _vacuous_.

| Guard                                                             | Why no test can kill it                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clientIp`'s `if (trustProxy <= 0) return socketAddress`          | With `N = 0` the index is `parts[parts.length]`, always `undefined`, which falls through to the same socket address. Deleting the line changes no behaviour. |
| `verification.verified` alongside `!info` in `verifyRegistration` | `@simplewebauthn` v13 throws rather than returning `{verified:false}` with a `registrationInfo`, so the two halves are never separately reachable.           |
| `Number.isSafeInteger` in `config.parseIntEnv`                    | Every current caller passes a `max` small enough (20, 3650) to reject `1e300` and `9007199254740993` anyway.                                                 |

**Rationale.** A vacuous guard and a redundant one look identical from the sweep — both stay green —
and treating them the same way produces one of two bad outcomes: deleting a correct guard, or
writing a test that asserts something the code does not actually decide. The distinction is whether
the _protection_ is missing (vacuous: the property is unenforced, and the sweep has found a hole) or
merely _duplicated_ (redundant: the property holds through another path, and the guard is insurance
against a later refactor breaking that path). The first is a defect. The second is a comment that
was never written.

Four survivors from the first pass were genuine test gaps and were fixed rather than explained:

- **A registration challenge was accepted by the authentication flow.** The purpose column was
  checked, but the only test aiming at it went the harmless direction — a login challenge into
  registration, which the separate `userId !== user.id` guard rejects for its own reasons. The
  dangerous direction is a registration challenge, which carries a `user_id`, handed to
  `passkey/login/verify`. Now tested.
- **The challenge TTL asserted itself.** The test compared `expires_at - created_at` against
  `CHALLENGE_TTL_MS`, so any change to the constant moved the assertion with it. Now pinned to the
  literal five minutes.
- **Bootstrap's in-transaction re-read looked dead.** It is not: bootstrap awaits a scrypt between
  reading the user count and opening its transaction, and `scripts/bootstrap-admin.js` can be
  running against the same file from another process while the container starts. The test now
  commits a competing row synchronously inside that window.
- **Bootstrap's outer check has no observable outcome, only a cost.** It exists so a restart does
  not pay for a scrypt it will discard. The test asserts the cost, since the outcome is identical
  either way.

**Consequence.** D-030's exit criterion stands with one refinement: a surviving mutation is a
finding, and closing it means _either_ a test that kills it _or_ a written argument that the
protection exists elsewhere. Silence is not one of the options.

---

## D-034 — The runtime image ships production `node_modules`, because the bundler does not

**Decision.** The Dockerfile has a third stage, `deps`, running `npm ci --omit=dev --ignore-scripts`,
and the runtime stage copies its `node_modules`. The runtime image is not dependency-free.

**Rationale.** The Dockerfile that M4's terminated agent left behind asserted the opposite, in a
comment that presented itself as measured: that `@sveltejs/adapter-node` bundles every dependency
into `build/`, so `grep`ing the build output for bare imports returns nothing and no `node_modules`
need ship. It is not true of this project. `build/server/chunks/webauthn.js-*.js` contains a bare
`import ... from "@simplewebauthn/server"`, and the container died on its first line:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@simplewebauthn/server'
    imported from /app/build/server/chunks/chunks/webauthn.js-Dh8I-ubq.js
```

The failure mode is worth naming: this happens before `hooks.server.ts` is evaluated, so there is no
migration log, no bootstrap banner, no health endpoint and no application error — only a Node stack
trace and a container that restarts forever. A deployment that had shipped this would have looked
like a database problem.

`--ignore-scripts` because nothing in the dependency tree needs a postinstall, and a build stage
that runs arbitrary install scripts to produce the image's runtime is a supply-chain surface with no
benefit here. `node:sqlite` is inside the Node binary, so there is still no native addon to compile
and musl remains irrelevant.

**Consequence.** The image is larger by the size of two packages. The comment in the Dockerfile now
records the measurement and tells the next reader to run the container rather than trust the claim.

More generally: three comments in that partial Dockerfile claimed verification (`node_modules`, the
base-image manifest, `/data` ownership) and the agent that wrote them terminated at the spend limit
before running anything. Two of the three happened to be right. Written-in-the-past-tense
verification is not verification, and this is the second time in this project that a confidently
worded comment has been the thing that was wrong — see D-030.

---

## D-035 — M3's mutation sweep, and pulling two rules out of places a test cannot reach

**Decision.** The service worker's caching rule and the sign-in screen's `next=` handling are now
`src/lib/client/cache-policy.ts` and `src/lib/client/redirect.ts` — plain functions with no browser
in the way — and the SSE client's wire parsing is `parseEvent`. Twenty-one mutations were applied
across M3's guards; nineteen died first time, and the two survivors were test gaps that are now
closed.

**Rationale.** M3's most dangerous rule was inside a service worker, which is reachable only through
a real browser and a real cache. The Playwright spec that covers it is worth having and is kept, but
it can only assert what a browser happened to request during the run; it cannot ask what happens to
`/offline.html/../api/me`, a `HEAD`, a cross-origin URL, or an unparseable one. Those are exactly the
inputs that turn "we never cache the API" into "we never cached the API during the test".

The two survivors, and what each one taught:

- **Precache membership matched by prefix.** The mutation swapped `includes` for
  `some(p => pathname.startsWith(p))` and the suite stayed green, because both of the paths the test
  probed (`/_app/`, `/fonts/`) are _shorter_ than the precached entries — the direction a prefix
  check gets right by accident. The dangerous direction is longer: `/offline.html.map`,
  `/offline.html/anything`. Now tested.
- **The `createdAt` tiebreak in R-13.** The test's item ids ran in the same order as their
  timestamps, so the `id` tiebreak alone produced the expected answer and the `createdAt` comparison
  could be deleted with nothing noticing. The ids now run backwards against the timestamps, which is
  the only arrangement that can tell the two comparisons apart.

Both are the same failure the M1 audits kept producing and D-030 was written for: a guard that is
correct, commented, and covered by a test that cannot reach it. The second one is the more
instructive, because the test looked _more_ thorough for having chosen tidy ascending ids.

**Consequence.** 350 unit tests and 10 Playwright specs. The service worker keeps its browser-level
test — the unit tests prove the rule, and the spec proves the worker actually applies it.

---

## D-036 — Acting on the M2/M3/M4 audits, and what they said about the process

**Decision.** The three reviewer passes that M5 was blocked on finally ran, and their blocking
findings are closed. This entry records what they found and, more usefully, _why the suite could not
have found it_.

### M4: `restore.sh` had two ways to destroy the database while printing `restore: done.`

- **A container-name mismatch was read as "not running".** `docker inspect … || echo false` maps a
  wrong name, a compose project prefix, a socket permission error and a daemon hiccup all onto
  `false`, and the script then moved the live `zembil.db`, `-wal` and `-shm` aside while the server
  held them open. The reviewer showed the app healthy and serving with its file descriptors pointing
  into `pre-restore-…/`, still writing work that the next restart would throw away. Now: any
  `inspect` failure other than a genuine _No such object_ aborts, the resolved container name is
  printed before the confirmation prompt, and — the part that actually closes it — the swap
  container proves nothing has the database open by taking an **EXCLUSIVE lock**, which also
  checkpoints the WAL so the file being moved aside is complete.
- **The install was not atomic.** `cp` straight over the live path, so a full volume left a
  truncated `zembil.db` and the only good copy in a directory whose name does not say "this one is
  the real database". Now the backup is copied to `.zembil.db.incoming`, verified _in place_, and
  swapped with `mv` on the same filesystem; a failure before that swap leaves the original untouched,
  and a failure of the swap itself rolls the previous files back.

Both were reachable by an operator on a normal Tuesday. Neither was covered by anything, because
**nothing in `tests/` touched an M4 artefact at all** — the suite would have stayed green with
`restore.sh` deleted. `tests/deploy/scripts.test.ts` now shells out to both scripts against a
scratch Docker volume and pins both regressions.

### M3: two client-state defects that showed a state the server never agreed to

- **`revalidate()` reloaded only the home screen.** §4 makes revalidation-on-`open` normative
  precisely because a dropped stream replays nothing — no `id:`, no `Last-Event-ID`. The list on
  screen kept its own cursor and was refetched only by an event arriving over a live stream, so a
  change made during the gap was lost permanently. The reviewer reproduced the worst presentation of
  it: the store card reading _2 to buy_ above a list showing one row.
- **`load()` had no generation guard.** Two `/list` responses overtaking each other let the older one
  win by arriving last, overwriting the items _and_ dragging `rev` backwards — silently un-ticking an
  item the server had accepted, with its own echo already spent.

Both were invisible to 360 green tests, and both are the same shape: a rule stated correctly in the
contract, implemented for the case the tests exercise, and not for the case a bad connection
produces.

**Consequence, and the reason this entry exists at all.** Every previous decision in this file that
corrected a wrong belief — D-030, D-034 — was found by _executing_ something. These were found by
somebody reading the code who had not written it. The mutation sweep is good at "is this guard
load-bearing"; it is useless at "is there a guard missing here", because it can only break code that
exists. Those are different questions and the project needs both. The reviewer is not a formality at
the end of a milestone, and running the milestones without it — which is what the spend limit forced
for most of a day — produced exactly the class of defect it exists to catch.

### M3, second pass: an untested guard turned out to be an unreached one

The audit's ninth finding was filed as a coverage gap — "`safeNext` is thoroughly tested as a
function, but nothing tests that login _calls_ it. Replace `next()` with
`page.url.searchParams.get('next')` and the suite is green with an open redirect." Writing the
missing test found a live defect rather than the absence of one: **the `next=` mechanism was inert
entirely.** `await invalidateAll(); await goto(next())` re-runs the `(auth)` layout load with the
new session in place, and that load redirects a signed-in visitor away from `/login` — so the
redirect always won and every `next` target, safe or not, was discarded. It went unnoticed because
home is where the app sends you anyway. Now: `goto(target, { replaceState: true, invalidateAll: true
})`, and `tests/e2e/session.spec.js` drives a real sign-in with `?next=` and asserts where the
browser lands.

That is a sharper version of the same lesson: D-030's "correct guard, test that cannot reach it" has
a worse sibling, the correct guard nothing reaches _at runtime either_. Only a test that exercises
the caller can tell the two apart.

The rest of the audit's findings were design drift against `docs/DESIGN.md` and the canvas, and are
closed with it: `.z-title` renders in the display face, the Shops screen's primary action is **Add
an item** rather than "Add a shop" (which cost a tap on the most frequent action in the app — the
cold-open path is now 3 taps to the first item, and 2 per item after), the account avatar is a 48px
target, sheets share a `.z-panel`, and the skeleton keeps its background under reduced motion.

**A commit-hygiene note, recorded because the history is otherwise misleading.** `489eab1` ("Act on
the M4 audit") was made with `git add -A` and swept in the first batch of M3 client-state fixes —
the generation guard, `revalidateAll`, `seed`'s staleness refusal, `loadApi`, `+error.svelte` — under
an M4 message. The M3 work is in two commits, not one.

---

## D-037 — The M2 audit: a named control that did not hold

**Decision.** M2, the only milestone never independently audited and the security-critical one, was
finally reviewed. It found one blocking defect and eleven smaller ones. All but one are fixed; the
exception is recorded in `BACKLOG.md` with its reasoning.

### The blocking one: the password gate was bypassable by encoding a single character

`hooks` gated `must_change_password` on `event.url.pathname`, which SvelteKit leaves
**percent-encoded**, while SvelteKit itself routes on a **decoded** copy. So `/%61pi/admin/users`
does not start with `/api/` — and still reaches `/api/admin/users`.

Confirmed against the production build, before and after. Before, from a session belonging to a
bootstrapped admin that had never changed its password:

```
GET  /api/stores          403 PASSWORD_CHANGE_REQUIRED
GET  /%61pi/stores        200
GET  /%61pi/admin/users   200   the full account list
POST /%61pi/admin/users   201   {"temporaryPassword":"…"} — a second admin
```

After: every one of those is `403`, and `POST /api/auth/login`, the password change, and normal
authenticated use are unaffected. §3.2 justifies this gate at length — _"the temporary password an
admin hands out over a chat app stays valid for the full 180-day absolute session TTL as soon as the
member dismisses the prompt"_ — which is exactly what it did, for anyone who encoded one letter.

The fix is to match on `event.route.id`: the pattern SvelteKit actually resolved, already decoded and
already canonical. The general lesson is worth stating plainly, because it will recur: **a security
decision must be made on the value the framework routed with, never on a value the client controls
the spelling of.** `url.pathname` is client-controlled text; `route.id` is the framework's own answer.

The exempt set now also lists the public endpoints. A flagged session hitting `/api/auth/login` was
being told to change its password before it could sign in — harmless today because the client
redirects first, and a trap for the next person.

### The other one that mattered: six guards no test could reach

D-030 exists for this and D-033 made mutation testing an exit criterion, and M2 shipped anyway with
six protections that could be removed or weakened while all 371 tests stayed green:

| Guard                     | Mutation that stayed green                                          |
| ------------------------- | ------------------------------------------------------------------- |
| per-IP login limit        | delete `enforce(limiters.loginByIp, …)`                             |
| passkey assertion limit   | delete `enforce(limiters.passkeyAssertionByIp, …)`                  |
| passkey options limit     | delete `enforce(limiters.passkeyOptionsByIp, …)`                    |
| constant-time compare     | `timingSafeEqual(a, b)` → `a.toString('hex') === b.toString('hex')` |
| session token entropy     | `randomBytes(32)` → `randomBytes(4)`                                |
| temporary-password CSPRNG | `randomInt(n)` → `Math.floor(Math.random() * n)`                    |

Every one is now killed by a test, and each kill was verified by applying the mutation and watching
it fail. Three of them needed a kind of test this project had not written before. The last three are
_functionally identical_ to the correct code — a timing side channel, a shorter secret that still
hashes to 64 hex characters, a predictable stream that satisfies every assertion about length and
alphabet. No assertion on a return value can see any of them. `tests/auth/crypto-primitives.test.ts`
therefore asserts **which primitive was called**, with `node:crypto` mocked in that file alone and
every real implementation kept.

That is a genuine extension of D-033. A property can be real, load-bearing, and invisible to every
black-box test that could ever be written for it; the only honest test is then a structural one.
Reaching for a spy is usually a smell, and here it is the correct tool — the alternative is a
comment claiming the code is constant-time and nothing checking.

### The rest

Fixed: the recovery script now destroys the sessions of the account it resets, matching §3.3 and the
HTTP path it mirrors — it is run precisely when somebody may hold a session they should not; §3.1a's
username charset is enforced against the lowercased form, so a Cyrillic `а` can no longer produce an
account an admin cannot tell from another over the phone; a duplicate credential id is `409` rather
than `500`; the login response carries `no-store`, which it did not because `authenticated` is read
from the _incoming_ session; the rate limiter evicts its least recently touched tenth when a sweep
frees nothing, so a flood of distinct attacker-chosen keys can no longer grow the map without bound;
and `requireSessionId` keeps its unreachable check with a comment saying why a test would be
meaningless — it narrows a type by refusing to launder a null, and costs one comparison.

Deferred, in `BACKLOG.md`: concurrent double login leaves one orphan session.

**Consequence.** 391 tests. The reviewer verdict is in the session record verbatim. Worth recording
alongside D-036: that entry argued the reviewer catches what execution cannot, and this milestone is
the sharpest case — every one of these findings sat under a green suite, and the blocking one sat
under a green suite in the milestone this project treats as its most security-sensitive. The three
sweeps run before it were all run by whoever wrote the code, on the code they had just written.

---

# M6 — claims, visibility, locale and push

Five features asked for by the owner, in one milestone. They are unrelated to each other, and that is
worth saying up front: nothing below is a step towards something else. Each decision stands alone.

## D-038 — Web push: `web-push`, and a VAPID keypair the app generates for itself

`BACKLOG.md` deferred push with a one-line reason: _"Web Push needs VAPID keys and a subscription
table, and iOS requires the PWA to be installed first."_ Two of those three are now paid for; the
third is a fact about iOS and is surfaced in the UI rather than worked around.

**The keypair is generated on first use and stored in `server_keys`, not provisioned.** This is the
first secret this application has ever held, and PROJECT.md §7 said flatly _"There is no application
secret. Nothing to provision, rotate, or leak."_ That sentence is now false as written, so it is
corrected rather than quietly left standing. What made it valuable, though, was never the absence of
bytes — it was the absence of an **operator step**: no `openssl` invocation in a README, no value
pasted into a compose file, nothing to forget when moving the deployment. Generating the keypair
lazily preserves exactly that, and puts the bytes in the one place the deployment already treats as
durable and already backs up.

Rejected: an env var holding the private key (reintroduces the operator step, and puts a secret in a
file that gets copied around); a key file next to the database (a second thing to back up, and the
first time somebody restores only the `.sqlite` every subscription silently stops working).

**`web-push` rather than hand-rolled RFC 8291.** Node 26 has everything needed — P-256 ECDH, HKDF,
AES-128-GCM — and the encryption is perhaps 150 lines. It is also exactly the kind of code that is
wrong in a way no test written by its author will catch, and the failure mode is silent: a
notification that never arrives, or worse, one encrypted under a scheme that a push service accepts
today. The project's own rule about crypto primitives (D-037: some properties are invisible to
black-box tests) argues _against_ writing this ourselves. `web-push` is pure JavaScript, so D-002's
"no native module to compile" survives; it is the first runtime dependency added since M2.

**Consequence for the threat model.** A database disclosure now yields something usable: the VAPID
private key lets the holder send notifications to family devices that already subscribed. That is a
real downgrade from "a database disclosure yields no usable session" (D-004) and it should be stated
plainly rather than buried. It does **not** let them read anything, and it does not authenticate them
to the app. Rotation is `DELETE FROM server_keys WHERE name='vapid'` plus a restart, which
invalidates every existing subscription and asks every member to re-enable — an acceptable recovery
because the population is under ten people.

## D-039 — Anti-spam: a trailing quiet window per store, not a per-notification cooldown

The requirement was _"only send if something new is added and there hasn't been a change for X
minutes."_ Two mechanisms satisfy that sentence and they behave very differently.

A **leading-edge cooldown** ("send now, then suppress for X minutes") delivers instantly and then
throws away everything that follows. The buzz says _"Migros: milk"_ and the four things added
afterwards are never mentioned. It is the same number of interruptions with less information in them.

A **trailing quiet window** — R-21, what is built — holds the batch until the list has stopped
changing, then sends _"Migros: milk, bread and 4 more."_ The message is the interesting one precisely
because it did not exist until the person finished typing. The cost is latency: with the default
five-minute window, a notification arrives five minutes after the last edit. For a shopping list that
is nothing; nobody is dispatched by push.

The clamp matters as much as the window. Without `ZEMBIL_NOTIFY_MAX_DELAY_MINUTES`, one member adding
something every four minutes across an evening starves the batch forever, and the anti-spam
mechanism silently becomes an anti-notification mechanism. Thirty minutes is the ceiling on how far
a batch's deadline can be pushed from when it was armed.

Only **adds** arm a batch; every other write merely extends one that already exists. Ticking a whole
list nobody added to today sends nothing, which is right — the person ticking is standing in the shop
and everyone else already knows what is on the list.

The state is in memory and dies with the process, exactly like D-007's rate-limit buckets. Persisting
it would mean a row written on the add path — the hot path — to protect a notification nobody is yet
waiting for.

## D-040 — Visibility is one nullable column, and there is no admin override

`stores.private_to`: `NULL` is public, non-`NULL` is private to that user. One column rather than a
`visibility` enum beside an `owner_id`, because two columns need a table-level `CHECK` to stay
consistent and **`ALTER TABLE` cannot add one** (measured; §8.1). With one column the inconsistent
state is unwritable rather than merely checked — which is the same reasoning as D-018 and the partial
unique index on `trips`.

**An invisible store 404s, and the 404 is byte-identical to the one a fabricated id produces.** A
`403` would confirm that a store with that id exists and belongs to someone, which is the single fact
the feature exists to hide. This extends to name collisions: `409 STORE_NAME_TAKEN` normally carries
the colliding store's id so the client can offer to un-archive it, and against an invisible store it
must not (R-22).

**Admins are not exempt.** The owner asked for _"ONLY VISIBLE TO THAT SPECIFIC USER"_, and an admin
bypass makes that sentence false — in a household where the admin is a family member, it makes it
false in exactly the case the member cares about. The cost is real and is documented rather than
mitigated: if a member privatises a shared store and stops using the app, **no API call brings it
back**. Recovery is `UPDATE stores SET private_to = NULL WHERE id = …` against the database, which is
in `README.md`. That is an acceptable trade at ten users with shell access to the server; it would not
be at a hundred.

Rejected: a per-store ACL table (multi-user sharing was not asked for, and every store query would
grow a join); reusing `created_by` as the owner (it is `ON DELETE SET NULL` and nullable, so a store
could become private-to-nobody).

## D-041 — A claim belongs to the trip, so nothing has to expire it

_"Not permanently, just for a trip."_ The columns therefore live on `trips`, not on `stores`.

R-6 already opens a fresh trip whenever one closes, and a fresh trip's claim columns are `NULL`. So
the claim expires exactly when the shopping run ends, with **no timer, no TTL and no background
sweep** — the thing that ends it is the thing the member was going to do anyway. This is the same
shape of argument as D-009: put the state where the lifecycle already is.

It also gives history for free. A closed trip keeps its claim, so `GET /api/trips/{id}` can say who
did that shop and what they said they were picking up, without an audit table (which the backlog
rejects for exactly the reason that nothing would read it).

`takeover: true` rather than a silently-stealable claim: a claim you can overwrite without noticing
is not a claim. A plain `POST` against someone else's claim is `409 TRIP_CLAIMED` whose message names
the holder, so the client can offer _"take over anyway"_ in one tap without a second round trip.

The note is 140 characters of plain text. It is a _"I'll only get the milk"_ note, not a message
board — the backlog's rejection of chat features stands.

## D-042 — Locale is a user column, negotiated from `Accept-Language` exactly once

`users.locale`, not a cookie and not a per-request header read.

The forcing constraint is push. A notification is composed **on the server, for a recipient who is
not the person whose action triggered it**, and quite possibly while that recipient's phone is
asleep. There is no request to read a header from and no client available to do the translating. The
recipient's language therefore has to be a fact the server holds about the person, which means a
column.

Reading `Accept-Language` per request would also make the same account render differently on two
devices, and would make push text depend on whichever device last happened to make a request. So the
header is consulted once, when the account is created, to choose a sensible initial value; after that
the column is the only source, and the member changes it on `/you`.

Delivered by the root `load` so the first paint is already in the right language. PROJECT.md §13
records the theme-flash bug of exactly this shape; reproducing it for language would be worse, since
a flash of the wrong _language_ is a flash of an unreadable app.

No i18n library. Three languages and a few hundred strings is a typed object and a `t()`; a library
would add a dependency, a build step or a runtime store to a project whose whole stack argument is
that it has none of those.

## D-043 — The store-edit sheet, built now because visibility needed a home

`PATCH /api/stores/{id}` has implemented and tested rename, recolour, reorder and archive since M1,
and **no screen has ever called any of it** — recorded in PROJECT.md §13, in `BACKLOG.md`, and
independently by the M3 audit. Visibility is a fifth field on that same endpoint and needs somewhere
to live.

Building a sheet that exposes only `visibility` while four tested operations sat next to it unreached
would have been the wrong shape of decision — the cost of the sheet is the sheet, not the fields on
it. Wiring all five closes a documented gap and makes R-14's un-archive promise load-bearing for the
first time, which it has never been: nothing could archive a store, so nothing needed to un-archive
one.

This is the one place in M6 where scope was deliberately widened beyond what was asked for, and it is
recorded here so that is visible rather than discovered later in a diff.

## D-044 — Acting on the M6 audit: scope uniqueness to visibility, and cap what a member can create

The M6 reviewer found one blocking issue and nine others. Three of them changed the design rather than
the code, and those are the ones worth recording.

**Uniqueness must have the same scope as visibility, or the constraint becomes an oracle.**
`stores.name_key` was `UNIQUE` table-wide, so a member could type a name, read
`409 STORE_NAME_TAKEN`, see no such shop in their own list, and conclude that somebody had a _private_
shop called that. R-22 had carefully withheld the store's **id** while the response handed over its
**name**, which is the more sensitive of the two — "Eczane" says something the id never could. The
same table-wide key also meant two members could not both have a shop called Migros if either kept
theirs private, which is a usability bug the family would have hit in the first week.

The fix namespaces the key — `<ownerId> U+001F <name>` for a private store, the bare name for a public
one — rather than replacing the constraint. That is not the tidiest option and it was chosen after the
tidy one turned out to be dangerous: `name_key TEXT NOT NULL UNIQUE` is a **column** constraint, so
SQLite implements it with an implicit index that cannot be dropped, so replacing it needs the
twelve-step table rebuild, so it needs `PRAGMA foreign_keys=OFF` — **which is a no-op inside a
transaction.** The migration runner is transactional by design (D-003), so the rebuild would have run
with foreign keys on, and `DROP TABLE stores` would have performed an implicit delete cascading through
`trips` into `items`. Every shopping list in the database, deleted, to tidy up an index.
`storeName` now rejects control characters so the delimiter cannot be forged.

The same reasoning applies to the **default colour**, which read every active store in the table:
create a store with no colour and the key you are handed says which keys are taken by stores you
cannot see, and past the eighth it leaks their count outright. The comment there previously called the
lack of filtering deliberate, on the grounds that filtering would make two members' palettes drift
apart. That is not a cost for a feature whose entire purpose is that two members see different worlds.

**Anything a member can create needs a bound, and `POST /api/push/subscription` had none.** `endpoint`
is a client-supplied URL and is the row's identity, so every distinct URL was a new row on the `/data`
volume — and `deliverBatch` then makes one serial outbound HTTPS request per row, to hosts the member
chose, on every batch. The reasoning `MAX_ITEMS_PER_TRIP` records in §3.5 applies word for word and had
simply not been carried across to the new endpoint: the stated threat model is that every account
holder is a person who could be careless or compromised. Twelve devices per member, plus a per-actor
token bucket, and both are checked on the create path only so an idempotent re-registration still
works at the limit.

**And one finding was declined, which is also a decision.** A `tripId` belonging to another store
answers `409 TRIP_ALREADY_CLOSED` where an invented one answers `404`, so the two are distinguishable
across the visibility boundary. §8.4 is written as an absolute, so this looks like a hole — but **R-6
step 1 of the frozen §2 mandates that 409 in exactly those words**, reaching it requires guessing a v4
UUID, and it discloses nothing beyond "some trip has this id". The contract is not edited to match an
implementation, and an implementation is not changed out from under a frozen rule on the strength of an
unreachable finding. What was wrong was §8.4's claim to be absolute, so **the correction went into
I-18**, which now names this and the SSE stream as its two carve-outs. An invariant that overstates
what is enforced is worse than one nobody enforces, because it is trusted.

## D-045 — Deleting a store is permanent, cascades through the schema, and is not admin-gated

_(M7. Contract addendum §9.)_

Archiving was built as the answer to "I do not want to see this shop" and it is the right answer to
that question. It is not an answer to "this shop was a mistake, or was for a house we moved out of,
and I want it gone" — the row, its trips and its items stay for ever, and the archived sheet grows a
list of things nobody will ever bring back. So `DELETE /api/stores/{storeId}` exists, and the two
actions sit next to each other with copy that says which is which.

**Three things were decided here, and each had a plausible alternative.**

**The cascade is the schema's, not the application's.** Migration 001 already declared
`trips.store_id` and `items.store_id` as `REFERENCES stores(id) ON DELETE CASCADE`, and `db/index.ts`
already runs `PRAGMA foreign_keys = ON`. Deleting trips and items in application code first would
have worked, would have read as more explicit, and would have been a second copy of a rule the
database enforces atomically — the copy that goes stale the day somebody adds a table. One statement,
and a test that counts rows in all three tables before and after.

**No admin gate, and no owner of a public store.** The alternative — only an admin may delete —
sounds safer and is not, for this brief: the household is fewer than ten people who already trust each
other with every list, and D-007 already refused a mechanism (account lockout) that lets a family lock
itself out of its own app. Restricting deletion would mean the person who created a shop by accident
cannot remove it without finding whoever holds the admin flag. What _is_ enforced is exactly what §8.4
already enforces everywhere else: a store private to somebody else cannot be deleted, **and being an
admin does not change that** (D-040 is unchanged, and now has a DELETE row in its test table).

**The confirmation is in the interface, not in the protocol.** No confirmation token, no
`?really=true`, no "type the shop name". A token in the request would be protocol surface that exists
to compensate for a screen, and it protects nothing an API client could not send twice. What actually
prevents the accident is that the destructive tap is a _second_ tap, on a _different_ button, with
different words, and that the armed state does not survive closing the sheet. That is a UI rule, so
§9.4 states it in the contract as a UI rule and the e2e suite asserts each clause — including that
reopening shop settings does not leave "Delete permanently" one tap away.

**The one non-obvious implementation detail** is the event. A delete cannot bump `stores.rev`, because
the row it would bump is gone, so `store.changed` carries `rev + 1` — a number that store will never
hold. §4's cursor rule drops any hint at or below what the client already has, so anything less would
be silently swallowed and a member standing on `/s/{id}` would go on tapping a list the server has
forgotten. Emitting nothing was the other option, and it is worse for the same reason.

**What is not built:** an undo, a trash, a retention window, a tombstone row. Recovery is the
operator's backup, which is what `scripts/backup.sh` is for and what the README already documents. A
trash would be a second lifecycle to reason about in every store-scoped query — and the reversible
option already exists next to this one, with its own button.

---

## D-046 — Changing a shop's visibility belongs to its creator and to admins, not to everyone who can see it

**Status:** accepted (M8). **Contract:** §10.1.

§8.6 shipped `visibility` as a fifth field on `PATCH /api/stores/{id}` alongside `name`, `color`,
`sortOrder` and `archived`, gated by the same check as the other four: can the caller see the store.
For four of them that is the right gate. For the fifth it is not, and the asymmetry is worth naming:
renaming a shop is a change anybody can see and anybody can undo, while privatising one **removes it
from every other member's world** — and under D-040 the losers cannot even discover where it went,
let alone bring it back. One tap, by anybody, permanent for everybody else.

So the field now takes a principal: the member named by `stores.created_by`, or an admin.

**Why the creator, when D-045 explicitly refused to give a public store an owner.** These are
different questions and it is worth being precise, because the two decisions look contradictory.
D-045 refused an owner for _deletion_, on the grounds that a household of fewer than ten people who
already share every list should not need to hunt for a specific person to undo their own accident —
and deletion is symmetric: whoever does it, everybody loses the shop equally, and everybody can see
that it happened. Privatising is **asymmetric**: one member keeps the shop and the rest cannot tell
it from a shop that never existed. `created_by` is not being introduced as an ownership concept here;
it is the only principal in the row who can be relied on to still see the store afterwards.

**Why admins too, when D-040 is emphatic that admins get no visibility exemption.** Because this is
not a visibility exemption. §8.4 is resolved _first_ and unchanged: an admin who cannot see a store
gets the same byte-identical 404 as anybody else, so the exemption can only ever apply to a store the
admin can already see — a shared one. What it buys is a way to undo a privatisation that should not
have happened, on a shop the whole family was using, without a database prompt. What it explicitly
does not buy is any path into a store private to another member; a test asserts the 404, and it
asserts it _for the admin_.

**Rejected: a 403 that names the store, or a message explaining who the creator is.** The refusal is
`403 FORBIDDEN` with no sibling field, and the client's copy says "the member who created this shop,
or an admin" without naming anybody. §3 keeps user ids off the wire for non-admins, and a display
name here would be an unrequested directory of who created what.

**Rejected: `createdById` on `StoreSummary`.** The client needs to know whether to draw the control,
which is a boolean question, so it gets `canChangeVisibility`. Same reasoning and same shape as
`claimedByMe` (§8.6). The hint is not the control: the server enforces the rule in `updateStore`, in
one place, and a client that ignores the hint gets the 403.

**The implementation detail that mattered.** The check sits inside the transaction and **before** the
name key is recomputed, because migration 003 scopes `name_key` by the owner — so a visibility change
is also a rename, and a guard placed after it would leave a store public with a private key. A body
carrying `{ name, visibility }` from a caller who may do the first but not the second now writes
neither, and the test asserts that by reading the row back rather than by reading the status code.
That is the M6 write-seam lesson applied without having to relearn it.

---

## D-047 — The theme moves from the device to the account, and there are eight of them

**Status:** accepted (M8). **Contract:** §10.2, migration 004.

The Appearance control was Light/Auto/Dark in `localStorage`. It is now eight themes in
`users.theme`, chosen from a dropdown.

**Why the column, and not a cookie or `localStorage`.** Three reasons, and the third is the one that
settled it:

1. A per-device value means the same person meets a different app on their phone than on their
   tablet. Locale was moved to the account in M6 for the same reason (§8.5); this is the same
   argument about the same person.
2. A new browser always started on the OS default, which for a member who had deliberately chosen
   something is a preference that does not survive the thing preferences exist for.
3. **Only a value the server holds can reach the first frame.** `localStorage` cannot be read during
   SSR, so the old control was applied on mount and PROJECT.md §13 recorded the resulting flash as a
   known gap whose "honest fix is a cookie read in the root `load`". A column is that fix without the
   cookie: `hooks.server.ts` substitutes it into `<html data-theme>` exactly as it already
   substitutes `%zembil.lang%`. The inline-script alternative is still refused — it cannot get a hash
   past `kit.csp` (D-026), which is the reason the gap existed.

A cookie would also have worked for (3) and not for (1) or (2), and would have added a second piece
of client state to reason about beside the session. One column, one source.

**`auto` is a value, not an absent attribute.** The old CSS guarded the dark block on
`:root:not([data-theme='light'])`, which worked when there were exactly three options. With eight it
is wrong: `sepia` would be repainted dark after sunset. The guard now names `auto` explicitly, and
`applyTheme` sets the attribute for every value including `auto`.

**Why a dropdown rather than the segmented row.** Eight labels do not fit across 390px, and a native
`<select>` gets the platform's own picker — a wheel on iOS, a sheet on Android — which is larger than
any target we would draw and already knows about VoiceOver. It clears the 44px floor, which the e2e
suite asserts.

**Why these eight.** Three are the ones that existed (`auto`, `light`, `dark`). Two more are the same
paper under different light (`sepia`, `sage`) and stay on the light family's store palette, because
`stores.color` is a _shared_ choice — a shop should look like the same shop to everybody looking at
it. Two are dark (`indigo`, `plum`) and inherit the dark store palette wholesale, grouped in one
selector list so twenty-four palette tokens are not written out three times and left to drift. The
eighth, `contrast`, is not a taste option: it is black borders and black text for a phone in direct
sun, which is the brief's actual operating environment.

**What is not built:** a custom colour picker, a per-store theme, an accent-only override, or a
scheduled day/night switch. `auto` already tracks the OS's own schedule, which is where a member has
configured that once for every app they own.

---

## D-048 — A version number, tied to the milestone, shown behind the session and nowhere else

**Status:** accepted (M8). **Contract:** §11.

The app had no version anywhere except an untouched `"version": "0.1.0"` in `package.json`, seven
milestones after that was true. Three things wanted one: a member saying which build their phone is
on, an operator comparing two containers, and an agent picking the project up cold and needing to
know what "last" means.

**`0.<milestone>.<patch>`, and the minor number _is_ the milestone.** Rejected: semver by
compatibility. Semver's minor/patch distinction describes what a change does to an API's consumers,
and this API has exactly one consumer — its own frontend, shipped in the same image, from the same
commit. There is no version skew to describe, so a scheme built to describe it would be decoration
that still had to be decided milestone by milestone. What the project actually plans, tests, audits
and documents in is the milestone, so that is what the number counts, and `docs/VERSIONS.md` reads
straight off the milestone table.

**Still `0.x`.** The compatibility promise here is `docs/CONTRACT.md`, which is frozen and
addendum-extended; the version number promises nothing to anybody. Calling it `1.0` because the app
is deployed and complete would be borrowing meaning from a convention this project does not use. If
Zembil ever grows a consumer outside the household, that milestone earns the major bump and should
say so in its own D-entry.

**The date is a literal, not a build timestamp.** `RELEASED_ON = '2026-09-03'` rather than
`__BUILD_TIME__`. A timestamp changes on every rebuild, so "as of" would drift while nothing about
the app changed, and an operator comparing two running containers could not tell a rebuild from a
release — which is the one question the date exists to answer. The cost is a constant somebody has to
remember to bump; that is why the bump list is in the contract (§11.2) and why a test compares the
module against `package.json` and against the release log's top heading. Three of the four places
fail loudly if they drift.

**Behind the session, and nowhere in front of it.** This is the part that took the most thought,
because §3.8 already refused to put a version on `GET /api/health` and gave the reason: a health
endpoint reachable from the public internet that reports the build is a free fingerprint for picking
a matching CVE. That reasoning does not stop at `/api/health`. The sign-in screen is the other page a
stranger can reach, so it shows nothing either — and there is no version header and no
`<meta name="version">`, both of which would have been the lazy way to satisfy "show the version".
`/you` is behind the session, so the family learns the build and the internet does not. §11.1 states
it as a rule rather than leaving it to whoever adds the next surface.

Also rejected: **versioning the service-worker cache name with the release number.** It looks tidy
and it would evict every cached shell on a patch that touched no asset. The cache keeps its own
constant.

**Why the account screen's foot, at 11px.** The brief asked for small and subtle, and that is also
what it should be: it is a fact somebody goes looking for, never one they read on the way past. It is
a `<footer>` rather than another `.z-panel` because it is not a setting and nothing in it can be
tapped. The e2e suite asserts the size ceiling, the absence of any control inside it, and that it
sits below the last button — so "subtle" is a testable claim rather than a note in a review.

---

## D-049 — Item authorship surfaced in the detail sheet, not on every row; the claim strip skipped on a private shop

**Status:** accepted (M9). **Contract:** none — no schema or API change.

Two small, owner-requested changes. Neither needed a migration or a contract addendum: `items.created_by`
/ `createdByName` has been on the wire since migration 001 (§1.1, §1.2 I-question of authorship
preservation across carry-over), and `stores.visibility` has been on `StoreSummary` since M6 (§8). Both
changes are the frontend finally reading fields the backend already sent.

**Where "who added this" went, and where it did not.** `design/Zembil.dc.html`'s "Item detail / edit"
artboard already showed "Added by Anne · Tuesday 18:40" under the item name — the canvas had this
designed before the request landed, the frontend just never built it. It is rendered in the item
detail sheet (`editing?.createdByName`, with `relative(editing.createdAt)` for "when", matching the
idiom `you`'s passkey list already uses for "Used 2 minutes ago") rather than as a fourth line on
every `ItemRow`. Rejected: putting it on the row itself. A row is already carrying up to three lines —
name, note, carried-count — inside a deliberately compact 68px tap target (DESIGN.md, the 44px tap-target
rule); a fourth, unconditional line for information that matters occasionally, not on every glance,
would make authorship the busiest thing about the row it sits in. The detail sheet is one tap away (the
edit icon) and already carries the store name as secondary metadata — authorship belongs beside it, not
competing with the checkbox.

Known limitation, not created by this decision but exposed by it: the detail sheet only opens from a
_pending_ row — `ItemRow` shows Undo instead of the edit icon once an item is ticked — so there is
currently no way to see who added an item once it is in the basket. Recorded in PROJECT.md §13 rather
than worked around here, because fixing it means changing what a ticked row's tap targets do, which is
a separate decision from where authorship is displayed.

**Why the claim strip disappears on a private shop, not just its wording.** `stores.private_to` limits
visibility to exactly one member (§8.4) — a private shop's owner is the only person who can ever load
`/s/{storeId}`. The claim strip exists to answer "who is going, so two people don't drive to the same
shop" (§8.6); with one possible reader who is also the only possible claimant, it can only ever be
reporting your own state back to you. The fix removes the whole strip — `{#if store?.visibility !==
'private'}` around the block in the list screen, and the equivalent guard around the read-only line on
the home-screen `StoreCard` — rather than relabelling the button. Rejected: keeping the strip with
different copy for a private shop. That still puts a control on screen whose only purpose most members
would ask about is exactly the one the owner raised — a control that exists for nobody is better absent
than explained. Also rejected: refusing `POST /api/stores/{id}/claim` for a private shop at the API
layer. There is no authorization boundary to close here — §8.4 already gates every store-scoped
endpoint to the owner alone, so a private-shop self-claim is harmless to leave reachable, and this is a
UI-only decision about what is worth showing, not a security one.

---

## D-050 — Reversing D-049: authorship moves onto every row, and is hidden on a private shop

**Status:** accepted (M9 patch, v0.9.1). **Contract:** none — no schema or API change. **Supersedes**
D-049's row-placement reasoning; D-049's claim-strip reasoning stands unchanged.

**This corrects a decision the owner rejected on first use**, not a bug found in testing. D-049 argued
that a fourth unconditional line on `ItemRow` would make authorship "the busiest thing about the row",
and put "Added by …" one edit-tap away in the detail sheet instead. Using the feature as shipped, the
owner reported the actual result of that call: nobody looks at a name they have to tap Edit to see, so
in practice authorship was invisible. That is a real defect in the decision, not a matter of taste — a
feature requested to be "visible somewhere" that requires a deliberate extra tap to ever be seen has
not actually shipped the thing that was asked for. D-049's argument about row density was not wrong on
its own terms; it was answering the wrong question. The row is now the one place this information can
actually do its job, so it goes there, and the sheet's now-duplicate copy is removed rather than kept
alongside it — one place to look, not two that can say different things while a save is in flight.

**Consequence for `ItemRow`.** `showAuthor: boolean` becomes a required prop, computed by the caller
(`store?.visibility !== 'private'`, see below) rather than read from `store` inside the component —
`ItemRow` has no access to the store, only the item, and does not need one. The line renders in both
the pending and ticked `{#each}` blocks, which also closes the PROJECT.md §13 gap D-049 recorded
("a ticked item's authorship is not visible"): that gap existed only because the sheet was reachable
from a pending row alone, and the row itself has never distinguished pending from ticked for this
purpose.

**Why a private shop hides it, not just relocates it.** The owner's second point extends `stores.private_to`'s
consequence (§8.4) one step further than D-049 did. D-049 already reasoned that a private shop's one
possible reader is also its one possible _claimant_, and removed the claim strip on that basis. The
identical fact — one reader, and every store-scoped write requires being that one member (§8.4) — also
makes that reader the shop's only possible _author_. "Added by admin" on a shop only admin can ever add
to is not a fact about the item, it is a restatement of who is looking at the screen. The missed
symmetry was mine, not a new rule the owner invented: D-049 solved this exact shape for the claim strip
and simply was not asked to check whether the same shape recurred elsewhere in the same milestone. It
did.

**Consequence.** `showAuthor` is threaded from `+page.svelte`, which already holds `store.visibility`,
down to both `<ItemRow>` call sites — the same guard shape as the claim strip's
`{#if store?.visibility !== 'private'}`, applied one component lower. No new i18n key: `itemAddedBy`
already existed for the sheet and reads identically on the row.

## D-051 — Suggestions come from bought history; duplicates warn but remain legal

**Status:** accepted (M10). **Contract:** §12.

Recent suggestions use only ticked history from the same shop. This is the least surprising meaning
of “recent”: it offers things the family actually bought, not an item they deleted or one that keeps
carrying because nobody wants it. Names already on the open list are omitted, and Unicode identity is
decided in application code with NFKC, lowercase and whitespace collapse because SQLite `NOCASE` is
not Turkish-aware. Rejected: FTS5, a stored popularity counter, and a new table. Eight suggestions do
not justify any of them for a household database.

The same normalisation powers a compose-time duplicate warning. It is deliberately not a uniqueness
constraint and not a server refusal: “Milk · 1 litre” and “Milk · lactose-free” can both be right.
The warning makes an accidental double-add visible; the explicit second submit preserves the escape
hatch.

Offline localisation stores no authenticated page and no shopping data. The application tells the
service worker one closed-set locale value, which selects one of three public static pages. Rejected:
caching the last rendered page (the privacy boundary §5 forbids), using the device language after the
member chose another, and a locale cookie introduced solely for a worker that already has a message
channel to the signed-in client. Locale-specific manifests are selected in the existing server-side
HTML transform, so install metadata agrees with the member before hydration.
