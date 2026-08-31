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

| Sequence | Result |
|---|---|
| update original, then insert clone | `FOREIGN KEY constraint failed` |
| insert clone, then update original | `UNIQUE constraint failed: items.store_id, items.client_id` |
| insert with `client_id=NULL`, update original, set clone's `client_id` | commits |

Deferring the FK would also work and would save one `UPDATE`. It is the wrong trade: `DEFERRABLE
INITIALLY DEFERRED` suspends that check for **every** transaction in the application, forever, to buy
one statement on a path that runs once per shopping trip. The three-statement form is local to close,
costs nothing at family scale, and leaves the constraint doing its job everywhere else.

**Consequence.** Close is the one place in the codebase where statement order is load-bearing, so a
test asserts that *both* wrong orders raise `SQLITE_CONSTRAINT`. Without that test the sequence would
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
the function to call — so "disabling an account means *now*", the entire rationale for choosing
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

**Rationale.** §5 previously required a static CSP header set in hooks *and* `kit.csp` hash mode. Both
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
`controller.desiredSize <= -64`. That bound stays, but it is documented as an *eventual* bound, not a
64-event one: the measured ceiling per stalled stream is roughly **2.5 MB**, not 64 chunks.

**Rationale.** Measured, not reasoned, against `@sveltejs/kit/node`'s `setResponse` on Node 26.1.0
with a client that opens the stream and never reads a byte (a paused TCP socket, which is what a
suspended phone or a deliberate stall actually looks like):

| probe | result |
| --- | --- |
| chunks flush as enqueued, nothing buffers to EOF | headers at 29 ms, chunks at 30/47/68 ms — **pass** |
| client disconnect fires the stream's `cancel` | fires — the route's unsubscribe is reachable, **pass** |
| `desiredSize` falls for a consumer that stops reading | falls, but only after **27,749 events / 2.51 MB** |

The reason for the gap is that `setResponse` pipes the web stream into the Node response, and the
kernel and libuv socket buffers absorb everything until they are full. Until then the reader keeps
pulling and `desiredSize` sits at 1, so the queue bound cannot see a stalled client at all. Only once
the socket stalls does backpressure reach the `ReadableStream` queue, and then the bound fires
immediately.

**Consequence.** Worst case is ~2.5 MB per stalled stream, ×4 streams per session (§4) × fewer than
ten users — bounded, and acceptable for this deployment. It is *not* the tight bound the constant's
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

| | v13.3.3 |
| --- | --- |
| `verifyRegistrationResponse` → | `registrationInfo.credential: { id: Base64URLString, publicKey: Uint8Array, counter, transports? }` |
| | **not** the flat `credentialID` / `credentialPublicKey` / `counter` of v9–v10 |
| `verifyAuthenticationResponse` takes | `credential: WebAuthnCredential` (**not** `authenticator:`) |
| | and `expectedRPID` is **required**, not optional |
| `generateRegistrationOptions` takes | `userID?: Uint8Array`, `userName`, `rpName`, `rpID` |
| `verifyAuthenticationResponse` → | `authenticationInfo.newCounter` |

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

| round | guard | why the test could not reach it |
| --- | --- | --- |
| 1 | `Number.isInteger` on `sortOrder` | the check itself was wrong; the test asserted the 400 and never read the store list back |
| 2 | `itemVersion` | the test omitted `name`, so `updateItem`'s "nothing to update" guard fired first |
| 2 | `beforeSeq` | no test of any kind; it is reachable only through a query string |
| 3 | `readJson`'s body-shape check | route layer — structurally unreachable from any domain-level test |
| 3 | `handle()`'s generic-message promise | nothing ever forced a non-`DomainError` through a route |

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
D-030 did not anticipate as a category distinct from *vacuous*.

| Guard | Why no test can kill it |
|---|---|
| `clientIp`'s `if (trustProxy <= 0) return socketAddress` | With `N = 0` the index is `parts[parts.length]`, always `undefined`, which falls through to the same socket address. Deleting the line changes no behaviour. |
| `verification.verified` alongside `!info` in `verifyRegistration` | `@simplewebauthn` v13 throws rather than returning `{verified:false}` with a `registrationInfo`, so the two halves are never separately reachable. |
| `Number.isSafeInteger` in `config.parseIntEnv` | Every current caller passes a `max` small enough (20, 3650) to reject `1e300` and `9007199254740993` anyway. |

**Rationale.** A vacuous guard and a redundant one look identical from the sweep — both stay green —
and treating them the same way produces one of two bad outcomes: deleting a correct guard, or
writing a test that asserts something the code does not actually decide. The distinction is whether
the *protection* is missing (vacuous: the property is unenforced, and the sweep has found a hole) or
merely *duplicated* (redundant: the property holds through another path, and the guard is insurance
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
finding, and closing it means *either* a test that kills it *or* a written argument that the
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
