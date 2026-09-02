# Zembil — Project Guide

**Read this first if you are an agent picking this project up cold.** It is the orientation
document: what Zembil is, why every significant decision went the way it did, what is already
built, what is deliberately not built, how the codebase is organised, and how to extend it without
breaking the things that were expensive to get right.

It does not replace the frozen contract. `docs/CONTRACT.md` is the normative integration boundary;
this file is the map that tells you which part of it you need.

---

## 1. What Zembil is

A self-hosted shopping list for **one family, fewer than ten people**, running on a home server
behind a reverse proxy with HTTPS, reachable from the public internet. *Zembil* is Turkish for a
woven basket — the aesthetic follows from the name.

The three behaviours that make it this app rather than a generic todo list:

1. **Lists are per store.** You do not have "a shopping list"; you have a list for Migros and a list
   for the pharmacy, and you shop them separately.
2. **Ticking does not delete.** A ticked item stays visible, sinks below a divider into an "in the
   basket" section, and can be un-ticked. The tick is a record, not a removal.
3. **Carry-over.** When you finish a trip, anything still unticked automatically lands on the *next*
   list for that store, with its lineage preserved. The milk you keep forgetting keeps following you,
   and the database knows how many times it has followed you.

Everything else — auth, PWA, realtime, deploy — exists to make those three usable by a family on
phones, over the public internet, without a hosting bill.

### The operating context, which drives most of the architecture

- **Almost all usage is mobile browsers.** Desktop is explicitly a nice-to-have.
- **Public internet exposure means actually secure, not demo-secure.** This is why auth got the most
  scrutiny of any milestone and is the only one whose audit found a real bypass.
- **Single family, <10 users.** This is a licence to pick small, boring, single-process technology
  everywhere. Do not "scale" anything. The scale is ten people and a few thousand rows a year.
- **Must come up with a single `docker compose up`**, with a documented data volume and a documented
  first-admin bootstrap.

### Explicitly out of scope — settled, do not re-litigate

Analytics and spending statistics · recipes · barcode scanning · price tracking · budgets · sharing
outside the family · native apps.

Analytics has one standing constraint: **pick a database that will not block them later, build
nothing for them now.** That constraint is honoured — every item row persists per trip with its
author, tick time and carry lineage, and price/quantity/category columns attach to `items` via
`ALTER TABLE ADD COLUMN`, a non-destructive migration. There is no analytics table, column or query
today, and there should not be one until someone asks for the feature.

---

## 2. Current status

**Complete and deployed**, plus **M6**, which added five owner-requested features: batched push
notifications, trip claims, Turkish and German, private shops, and click-to-copy for the one-time
password. Every milestone through M5 was audited and every blocking finding closed.

| Signal | Value |
|---|---|
| Unit/integration tests | **657** (Vitest), green |
| End-to-end specs | **18** (Playwright, Chromium at 390×844), green |
| Type check | `npm run check` clean across **527** files |
| Taps, cold open → first item added | **3** (and 2 for every item after — the add sheet stays open), unchanged by M6 |
| Reviewer audits | M1 ×3, M2, M3, M4, **M6** — all closed, findings acted on |

It is running in production on the owner's home server at `zembil.s3r4.tech`, fronted by a
**Cloudflare Tunnel** (which terminates TLS at the edge, so the `cloudflared` → origin hop is plain
`http://localhost:3000` — a detail the README does not yet document; see §12).

### Milestone history

| Milestone | Content | Outcome |
|---|---|---|
| **M0** Foundation | Contract frozen, DDL verified to execute, agent definitions, decision log | ✅ |
| **M1** Data & domain | Schema, migrations, rollover engine, event bus, `/api/{stores,items,trips}` | ✅ — needed **three** audits |
| **M2** Auth | scrypt, sessions, origin check, rate limiting, passkeys, admin CRUD, bootstrap | ✅ — audit found an authorization bypass under a green suite |
| **M3** Frontend | Whole UI, PWA, service worker, SSE client, optimistic tick | ✅ |
| **M4** Deploy | Dockerfile, compose, entrypoint, healthcheck, backup/restore, README | ✅ |
| **M5** Hardening | Act on all findings, re-verify the done-means checklist against a rebuilt image | ✅ |
| **M6** Five features | Push (batched), trip claims, i18n (en/tr/de), private shops, copy-password | ✅ — schema delta is migration 002; contract addendum is §8 |

---

## 3. Stack, and why each piece

| Layer | Choice | Decision |
|---|---|---|
| Framework | SvelteKit 2 / Svelte 5 runes, `adapter-node`, **one process** | D-001 |
| Database | SQLite (WAL) via the **built-in `node:sqlite`** — no native dependency, no build step | D-002 |
| Query layer | Hand-written parameterised SQL, numbered forward-only migrations. **No ORM.** | D-003 |
| Sessions | Opaque 32-byte random tokens, stored SHA-256-hashed. **No signing key exists anywhere.** | D-004 |
| Passwords | `crypto.scrypt`, N=65536 r=8 p=1, `maxmem` raised to 128 MiB | D-005 |
| CSRF | `SameSite=Lax` **plus a mandatory `Origin` check** | D-006 |
| Rate limiting | In-memory continuous-refill token buckets, deliberately **no account lockout** | D-007 |
| Passkeys | `@simplewebauthn` v13, usernameless (discoverable), always with a password fallback | D-008, D-029 |
| Realtime | SSE carrying **revalidation hints, not data** | D-011 |
| Tests | Vitest against a real SQLite *file*; Playwright at 390×844 | D-016 |
| Push | `web-push` (pure JS), VAPID keypair **generated on first use** into `server_keys` | D-038 |
| Anti-spam | A trailing per-store quiet window, in memory, with a max-delay clamp | D-039 |
| i18n | Three typed catalogues and a `t()`. **No library, no build step.** | D-042 |
| Deploy | One container, one `/data` volume, non-root, loopback-bound | D-012 |

The through-line: **nothing for an operator to provision, no native module to compile, no second
container, no background process.** The whole system is one Node process, one SQLite file, and a
reverse proxy.

M6 changed one word of that sentence and it is worth being precise about which. The app now holds a
secret — the VAPID keypair — but it **generates it for itself** on first use and stores it in the
database, so there is still no `openssl` line in a README and no value to paste into a compose file.
What that costs is stated plainly in D-038 and in §7 below.

Four decisions never received an adversarial review pass (the multi-agent design workflow was cut
short by a spend limit after 3 of 13 agents). They are marked **[unjudged]** in `docs/DECISIONS.md`:
D-001 (framework), D-003 (no ORM), D-011 (SSE), D-012 (Docker). They have all since been validated by
actually shipping, but if you are revisiting one of them, know it never had its day in court.

---

## 4. Data model

```
users ──< sessions
      ──< credentials          (passkeys)
      ──< webauthn_challenges
      ──< push_subscriptions   (M6: one row per browser that opted in)
      ──  locale               (M6: en | tr | de)

server_keys                    (M6: the VAPID keypair, one row)

stores ──< trips ──< items
   │         │
   │         └── claimed_by / claimed_at / claim_note   (M6: "I'm going to Migros")
   │
   └── private_to              (M6: NULL = public, else visible to that user ALONE)
                      │
                      └── carried_from_item_id ─┐  lineage across rollovers
                          carried_to_item_id  ──┘  origin_item_id = root of chain
```

Complete DDL is `docs/CONTRACT.md` §1.1. Read it before writing any SQL. Highlights that catch people
out:

- **A list *is* a trip.** Exactly one trip per store has `status='open'` at any moment, enforced by
  the partial unique index `trips_one_open_per_store` — **not** by application code. If you are
  tempted to add an application-level check for this, the index already did it, atomically.
- **All tables are `STRICT`.** A string written to an INTEGER column is rejected rather than
  silently coerced by type affinity. This is load-bearing (D-018).
- **Timestamps are integer epoch milliseconds, UTC.** Never ISO text, never local time.
- **All ids are UUIDv4 lowercase hex** from `crypto.randomUUID()`.
- **Booleans are `INTEGER CHECK (x IN (0,1))`,** and `node:sqlite` **cannot bind a JS boolean** —
  `stmt.run(true)` throws. Convert at the repository boundary.
- **Rows come back as null-prototype objects.** `Object.hasOwn(row, k)` works; `row.hasOwnProperty(k)`
  throws.
- **`username_key` / `name_key` / normalisation is owned by the application,** not by SQLite. `COLLATE
  NOCASE` only folds ASCII A–Z, which is wrong for Turkish names. Normalisation is NFKC + lowercase
  (plus whitespace collapse for store names); the database only enforces uniqueness on the result.
- **`items.store_id` is denormalised** from `trips.store_id` so the hot list query and the future
  analytics query never need a join. Maintained by the application, asserted by tests (I-3).

### Item states

`pending` → `ticked` (undoable, stays visible, sorts below pending)
`pending` → `carried` at close (**terminal**; a clone now lives on the next trip)

### Invariants I-1 … I-18

`docs/CONTRACT.md` §1.2 lists thirteen invariants, and **§8.2 adds I-14 … I-18** for M6. Both say,
normatively, **which are enforced by the schema and which only by tests.** That distinction matters: an invariant nobody enforces is a
comment. Schema-bound: I-1, I-4, I-5 (partly), I-10, I-11, I-12, I-14, I-15, I-17. Test-bound: I-2, I-3, I-5
(the "closed trip" half), I-6, I-7, I-8, I-9, I-13, I-16, I-18.

**I-16 is test-bound for a reason worth knowing before you add another invariant to an existing
table**: `ALTER TABLE ADD COLUMN` accepts a column-level `CHECK` and a `REFERENCES` clause (measured
on this build — both are enforced afterwards), but it **cannot add a table-level `CHECK`**. So the
paired nullability of the three claim columns could not be made unwritable the way `items`' pairs
were in migration 001. It is upheld by writing all three in one `UPDATE` and clearing them in one
`UPDATE`, and by readers treating `claimed_by IS NULL` as unclaimed whatever the other two say.

If you add an invariant, say which side it lands on, and if it is test-bound, write a test that
**fails when it is violated** — not merely one that passes today.

---

## 5. The rollover state machine

Rules **R-1 … R-17** in `docs/CONTRACT.md` §2, and **R-18 … R-22 in §8.3** (claims, batched
notifications, and the visibility rule). Each one maps to at least one test assertion. This is
the heart of the app; the ones with sharp edges:

- **R-2 — Add targets the store, not the trip.** The server resolves the open trip *inside* the write
  transaction. A client that started composing an item before a rollover and submitted after it lands
  on the **new** trip rather than failing. (D-010)
- **R-4 — Tick is idempotent.** Re-ticking is a success that bumps nothing and emits nothing.
- **R-6 — Close is one atomic transaction** with a **statement order that is the only order that
  works.** Both alternative two-statement orders raise a constraint error (a foreign key, and
  `items_client_id` respectively), and there is a test that proves it. Without that test the sequence
  would silently "start working" the day someone drops a constraint. (D-024)
- **R-8 — Closed trips are immutable.** Tick, untick, edit and delete against an item in a closed
  trip all fail.
- **R-11 — Concurrent close.** `BEGIN IMMEDIATE` serialises; the loser gets `409 TRIP_ALREADY_CLOSED`
  with the correct `openTripId`.
- **R-15 — `sort_order` is allocated by the server**, `MAX+1000`, never by the client. (D-020)
- **R-16 — `stores.rev` is the revalidation cursor**, bumped by exactly the writes enumerated in §3.0.
- **R-17 — Idempotent add survives a rollover.** `client_id` uniqueness is scoped to the **store**,
  not the trip, and excludes `carried` rows. A trip-scoped index would let a retry that crossed a
  close create a permanent duplicate. (D-019)

**R-18 is the one M6 rule that belongs in this section**, because it is a rollover behaviour rather
than a feature bolted beside one: a claim lives on the **trip**, so R-6 retires it by opening a fresh
one. There is no expiry timer and nothing to sweep — the thing that ends a claim is the thing the
member was going to do anyway. A closed trip keeps its claim, which is how the history can say who
did each shop.

**When you change rollover, you change the thing this app exists for.** Every rule above has a test;
run the whole `tests/domain/` suite, and add a rule number to the contract rather than adding
undocumented behaviour.

---

## 6. HTTP API

Complete definitions in `docs/CONTRACT.md` §3. Summary:

- **Auth** — `POST /api/auth/login`, `logout`, `password`;
  `passkey/{login,register}/{options,verify}`; `DELETE /api/auth/passkey/{id}`; `GET /api/me`
- **Admin** — `GET|POST /api/admin/users`, `PATCH /api/admin/users/{id}`,
  `POST …/reset-password`, `DELETE …/passkeys`
- **Stores** — `GET|POST /api/stores`, `PATCH /api/stores/{id}`
- **Lists** — `GET /api/stores/{id}/list`, `POST /api/stores/{id}/items`,
  `PATCH|DELETE /api/items/{id}`, `POST /api/items/{id}/{tick,untick}`,
  `POST /api/stores/{id}/trips/close`
- **History** — `GET /api/stores/{id}/trips`, `GET /api/trips/{id}`
- **Realtime** — `GET /api/events` (SSE)
- **Claims** (M6) — `POST|DELETE /api/stores/{id}/claim`
- **Push** (M6) — `GET /api/push/key`, `GET|POST|DELETE /api/push/subscription`
- **Locale** (M6) — `PATCH /api/me`
- **Ops** — `GET /api/health`

Cross-cutting rules worth knowing before you add an endpoint:

- **§3.0 enumerates write effects per endpoint** — exactly which writes bump `rev` and which events
  each emits, including that idempotent no-ops bump and emit *nothing*. A test asserts the whole
  table. Add your endpoint to it. (D-021)
- **§3.1 error envelope**: `{ error: { code, message } }`. Only three responses carry a named sibling
  field: `VERSION_CONFLICT` (+`item`), `TRIP_ALREADY_CLOSED` (+`openTripId`), `STORE_NAME_TAKEN`
  (+`storeId`).
- **§3.1a/b/c** pin string charsets, numeric ranges and trimming. Validation is contract, not taste.
- **Responses carry display names, never user ids.** There is no endpoint mapping an id to a user for
  a non-admin, so a member cannot probe the account list. M6 added `claimedByMe` for exactly this
  reason: two members can share a display name, so a client comparing strings cannot safely decide
  whose "release" button it is looking at.
- **Every store-scoped endpoint resolves visibility first** (§8.4). This is a hard rule with its own
  section below; do not add a store-scoped endpoint without reading it.
- **`version` and optimistic tick interact.** Tick/untick bump `items.version`; `PATCH /api/items/{id}`
  requires a matching version. A client that optimistically ticked must adopt the `version` from the
  tick response rather than the one it rendered with. This is the intended cost of optimistic tick.

---

## 7. Auth and security model

This is the most security-sensitive part of the system and the only one whose audit found a real
hole. Treat changes here with corresponding care.

- **Sessions** are opaque 32-byte random tokens. The database stores `sha256(token)` as the primary
  key; the raw token exists only in the cookie. A database disclosure yields **no usable session**.
  There is deliberately no JWT and no signing key. (D-004)
- **Passwords**: `scrypt$N=65536,r=8,p=1$<salt-b64url>$<key-b64url>` — a self-describing format so the
  algorithm can be upgraded by transparent rehash at login, with no schema change. Verification uses
  `timingSafeEqual`; `===` is a defect. (D-005)
- **CSRF** is `SameSite=Lax` **plus** a mandatory `Origin` check against the `ZEMBIL_ORIGIN` constant.
  Both, not either. (D-006, D-023)
- **Rate limiting** is in-memory token buckets, per-username and per-IP, with **no account lockout** —
  lockout on a family app is a denial-of-service against your own household. Buckets do not survive
  restart (backlog). (D-007)
- **Passkeys** are usernameless/discoverable (`residentKey: 'required'`) with `attestationType:
  'none'`, and there is **always** a password fallback: `users.password_hash` is `NOT NULL` (I-10),
  so a passkey-only account cannot exist. (D-008, D-029)
- **`must_change_password` is enforced server-side** — the gate is in the request seam, not the UI.
  (D-027)
- **CSP comes from `kit.csp` in `svelte.config.js`**, and `hooks.server.ts` **must not** set it.
  (D-026)
- **There is exactly one application secret, and the app creates it itself.** The VAPID keypair
  (`server_keys`) is generated on first use and never provisioned, so the property that mattered —
  nothing for an operator to create, rotate or leak into a compose file — still holds. State the cost
  honestly when you touch this: a database disclosure now yields something *usable*, namely the
  ability to send notifications to family devices that already subscribed. It grants no read access
  and no way to sign in. Rotation is `DELETE FROM server_keys WHERE name='vapid'` plus a restart, at
  the price of every member re-enabling notifications once per device. (D-038)

### Store visibility is an authorization boundary, and it is new

`stores.private_to` is `NULL` for public and a user id for private. **A store is visible when
`private_to IS NULL` or `private_to = <the session's user id>`, and nothing else grants visibility —
being an admin does not.** The full table of which endpoint returns which 404 is `docs/CONTRACT.md`
§8.4. Three things about it that are easy to undo by accident:

1. **An invisible store 404s, and the 404 is byte-identical to the one a fabricated id produces** —
   same status, same code, same message, no sibling fields. A `403`, or a message naming the store,
   confirms that a store with that id exists and belongs to somebody, which is the one fact the
   feature hides. A test asserts deep equality between the two responses.
2. **`409 STORE_NAME_TAKEN` drops its `storeId` sibling field when the collision is invisible** (R-22).
   That field normally exists so a client can offer to un-archive; against a private store it is a
   usable id for something the caller must not know exists.
3. **The refusal has to be observable as a refusal.** The M6 mutation sweep removed the visibility
   check from `updateStore` and *no status code changed*: the transaction committed the rename, and
   the closing `getStoreSummary` threw the same 404 on the way out. Every response-shaped assertion
   still passed while a member who could not see a store was renaming it. The tests that kill that
   mutation read the **database**. **A guard on a write is only observable through the write it did
   not perform.**

### The three traps that have already bitten this codebase

These are recorded because each cost real time and each will bite again:

1. **SvelteKit leaves `event.url.pathname` percent-encoded and routes on a decoded copy.**
   The M2 audit found the `must_change_password` gate matched on `url.pathname.startsWith('/api/')`,
   so a request to `/%61pi/admin/users` skipped the gate and still reached the admin endpoint — an
   authorization bypass under a fully green 371-test suite. **Any path-shaped authorization decision
   must match on `event.route.id`, never on `event.url.pathname`.** `event.route.id` is populated
   before `hooks.handle` runs. (D-037)
2. **`node:sqlite` never reports the string `SQLITE_CONSTRAINT`.** It sets
   `err.code = 'ERR_SQLITE_ERROR'` and puts the *extended* result code in `err.errcode`. The only
   reliable constraint test is `(err.errcode & 0xff) === 19`.
3. **`adapter-node` does not bundle `@simplewebauthn/server` into `build/`.** A runtime image with no
   `node_modules` dies with `ERR_MODULE_NOT_FOUND` before any application code runs. The Dockerfile
   ships production `node_modules` from a dedicated `deps` stage for exactly this reason. (D-034)

### `ZEMBIL_RP_ID` is a one-way door

It must be the **full hostname** (`zembil.example.com`), never the registrable domain
(`example.com`). An rpID is a scope: a credential scoped to `example.com` may be requested by *any*
page under `*.example.com`, which on a home server hosting sibling subdomains hands each of them the
ability to log in as a family member. And changing rpID later **invalidates every existing passkey**,
because authenticators key by rpID. Startup asserts the value is the hostname of `ZEMBIL_ORIGIN` or a
suffix of it, and warns loudly on a proper suffix. Leaving it unset (so it defaults to the origin's
hostname) is the correct choice for almost everyone. (D-022)

### `PROTOCOL_HEADER` / `HOST_HEADER` must never be set

They are `adapter-node` variables that make it derive `event.url` from `X-Forwarded-Proto` /
`X-Forwarded-Host`. Setting them would let a client that reaches the app directly control what the
app believes its own origin is. Zembil never needs them: origin, `expectedOrigin` and `expectedRPID`
all come from the `ZEMBIL_ORIGIN` constant.

---

## 8. Frontend and design

`docs/DESIGN.md` is the machine-readable design system; `design/Zembil.dc.html` (22 artboards at
390×844) is the visual source of truth. **When they disagree, the canvas wins.**

Aesthetic: warm woven paper, terracotta accent, **everything primary in the bottom third**.

The rules that are not negotiable because they come from the brief, not from taste:

- **Tap targets are never below 44×44 CSS px.** The list row is 68px precisely so a moving thumb
  cannot tick the wrong row. An e2e test asserts the 44px floor on every visible control and that the
  primary action sits below two-thirds of the viewport.
- **Inputs are 18px text, never below 16px**, or iOS zooms on focus.
- **The quick-add sheet stays open after submitting.** Adding is the most frequent action; the second
  item costs one tap, not four. `tests/e2e/taps.spec.js` pins the 3-tap and 2-tap counts, so a
  regression that adds a step fails the suite rather than being noticed a month later.
- **Ticked rows sink below an "In the basket · N" divider and use `--surface-sunk`. They never
  disappear.**
- **`dvh` units and `env(safe-area-inset-bottom)`, never `100vh`.**
- **Fonts are self-hosted woff2** under `static/fonts/` — never Google Fonts, never a CDN. (D-015)
- **Every user-facing string comes from `src/lib/i18n/`.** `Messages` is `typeof en`, so a key missing
  from `tr` or `de` is a compile error and there is no runtime fallback to English — a fallback hides
  the very mistake it covers. The exception, and it is deliberate: **server error messages are shown
  as the server wrote them** (§3.1). A client that re-invents them turns a `409 STORE_NAME_TAKEN`
  into "Something went wrong".
- **The locale reaches the page before first paint.** The root `load` carries it, `hooks.server.ts`
  substitutes `%zembil.lang%` into `<html lang>`, and the root layout also sets
  `document.documentElement.lang` in an effect because an in-app language change re-renders the body
  and not `<html>`. Read `messages()` inside `$derived`, never into a module-level `$state` — that
  singleton is shared across concurrent SSR requests and would serve one member's language to
  another.
- Colour tokens live on `:root`, overridden under `[data-theme="dark"]` *and* under
  `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, so the
  Light/Auto/Dark control wins in both directions.
- **`stores.color` is a palette *key*, never a hex value.** This keeps the value off the CSS path and
  lets the dark theme remap it.

Screens: `/login`, `/` (Shops), `/s/{storeId}` (List), `/trips` (History), `/you` (Account),
`/you/admin` (Admin), plus sheets for quick-add, item detail and finish-trip.

### Service worker

**It never serves a cached authenticated document.** This is a hard safety rule with a test behind
it. The offline story is read-only-stale plus retry; a true offline write queue would need an
IndexedDB outbox and is in the backlog.

M6 added `push` and `notificationclick` handlers and changed none of that: they render a payload the
server already encrypted for this browser and open a URL, writing nothing to the cache. The `push`
handler always shows *something*, even for a payload it cannot parse — every browser that implements
push requires `userVisibleOnly`, and silently swallowing one is how a site loses its push permission
wholesale.

---

## 9. Realtime

SSE at `GET /api/events` carrying **revalidation hints, not data** (D-011). A hint says "store X
changed, its rev is now N"; the client decides whether to refetch. This means the stream can never
leak data across an authorization boundary and can never be stale in a way that matters — the fetch
is the source of truth.

Two measured facts pinned in D-028: chunks flush as enqueued through `adapter-node` (no explicit
flush needed), a client disconnect fires the stream's `cancel` so bus subscriptions do not leak, and
the real teardown bound is `desiredSize` at roughly **2.5 MB per stalled stream**, not a fixed event
count.

**Visibility does not change the realtime design, and that is load-bearing.** Hints are broadcast to
every stream, which stays correct only because they carry no data (D-011): a member who receives a
hint for a store they cannot see refetches and is told 404. Do **not** "fix" this into per-user
filtering that carries store names.

The in-process bus module surface is pinned in `docs/CONTRACT.md` §4.1. There is exactly one process,
so the bus is a plain `EventEmitter`-shaped thing and needs no broker. **Do not add Redis.**

Reverse proxies must not buffer `text/event-stream` — the README's nginx block includes
`proxy_buffering off` for this reason.

---

## 10. Deployment and operations

One service, one volume, non-root, loopback-bound. `docs/CONTRACT.md` §3.8 pins the deployment seam
(health, bootstrap, shutdown) — it was frozen *before* M2 and M4 ran in parallel, which is the only
reason they could run in parallel (D-031).

- **`docker compose up -d --build`.** Compose refuses to start without `ZEMBIL_ORIGIN`, on purpose.
- Published on **`127.0.0.1:3000` only.** Nothing on the LAN or the internet reaches the container
  directly; only whatever terminates TLS on that host.
- Hardened for free: `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, `init: true`, a 16 MB
  tmpfs on `/tmp`, and log rotation at 10 MB × 3 (because the one-time admin password lands there).
- **Migrations run at module load of `src/hooks.server.ts`**, before the server listens, and a
  failure **crashes the process** rather than becoming a 500 while the container reports healthy.
  Nothing else may open the database before that point.
- **Bootstrap is idempotent**: it runs only when `SELECT COUNT(*) FROM users` is zero. A restart with
  the env vars still set never resets an existing admin's password. (D-014)
- **Backup** is `scripts/backup.sh` using `VACUUM INTO` — safe against a live server; verified by
  taking a backup while serving, mutating, restoring, and confirming the mutation was gone.
  **Restore** is an atomic `mv` with a `pre-restore-<stamp>/` snapshot kept as the undo, and uses
  `PRAGMA locking_mode = EXCLUSIVE` as a liveness probe. (D-013)
- **Graceful shutdown checkpoints the WAL.**

Image size: the README reports **264 MB** on disk while `PLAN.md` reports **62 MB**. The two figures
disagree — measure before quoting either.

### Environment variables

`ZEMBIL_ORIGIN` is the **only** required variable. Every other default in `.env.example` is already
the production-correct value; the file ships with exactly one uncommented line by design.

| Name | Default | Note |
|---|---|---|
| `ZEMBIL_ORIGIN` | — | **Required.** Scheme + host, no trailing slash. |
| `ZEMBIL_RP_ID` | hostname of origin | Leave unset. See §7. |
| `ZEMBIL_RP_NAME` | `Zembil` | Cosmetic — the name in the OS passkey prompt. |
| `ZEMBIL_DATA_DIR` | `/data` | |
| `ZEMBIL_TRUST_PROXY` | `1` | Trusted `X-Forwarded-For` hops. `0` disables header trust. |
| `ZEMBIL_BOOTSTRAP_ADMIN_USERNAME` | `admin` | Only when the users table is empty. |
| `ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD` | generated | **Leave unset** — a set value is a credential living in a file. |
| `ZEMBIL_SESSION_IDLE_DAYS` | `30` | |
| `ZEMBIL_SESSION_ABSOLUTE_DAYS` | `180` | |
| `ZEMBIL_LOG_LEVEL` | `info` | **Parsed, validated, and read by nothing.** See §13. |
| `ZEMBIL_SYNCHRONOUS` | `NORMAL` | `FULL` only if the machine is on a UPS. |
| `ZEMBIL_HOST_PORT` | `3000` | |
| `ZEMBIL_PUSH_ENABLED` | `true` | M6. `0`/`false`/`no` turns push off; nothing else does. |
| `ZEMBIL_VAPID_SUBJECT` | origin, when https | M6. `mailto:` or `https:`. `null` on a plain-http origin — see §8.11. |
| `ZEMBIL_NOTIFY_QUIET_MINUTES` | `5` | M6. R-21's quiet window. `0` notifies immediately. |
| `ZEMBIL_NOTIFY_MAX_DELAY_MINUTES` | `30` | M6. The ceiling on it. Must be ≥ the window. |

---

## 11. How this project is built — the working method

These are the process rules the project was built under. They are not decoration; each of them caught
something.

1. **Explore, then write `PLAN.md` and `docs/DECISIONS.md` before feature code.**
2. **Freeze the schema and API contract in a document first.** That document is the integration
   boundary everything else depends on. `docs/CONTRACT.md` says at the top: if something in it is
   wrong, ambiguous or missing, **stop and report it** — do not work around it and do not edit the
   contract to match your implementation.
3. **Small, working increments.** Every milestone ends with the app runnable and tests green.
4. **Do not scope-creep.** Something worth doing later goes in `docs/BACKLOG.md`, not into the code.
5. **Run the reviewer after every milestone**, act on its findings before moving on, and **report its
   verdict verbatim** to the user.

### Subagents and file ownership

Agent definitions live in `.claude/agents/` — narrow tool access, one responsibility each:
`zembil-data`, `zembil-auth`, `zembil-frontend`, `zembil-deploy`, and read-only `zembil-reviewer`.

**Only parallelise agents whose file ownership does not overlap; otherwise sequence them.** The
ownership table is `PLAN.md` §4 and the sets are disjoint by construction. Two rules from that table
that are easy to get wrong:

- **The build skeleton is deliberately not delegated.** `svelte.config.js` carries the CSP that the
  contract makes load-bearing; `vite.config.js` carries the Vitest pool settings that `node:sqlite`'s
  synchronous single-connection model depends on. Both are cross-cutting. An agent that needs a
  dependency added or a config changed **asks the orchestrator** — it does not edit these.
- **`docs/**` and `PLAN.md` belong to the orchestrator alone.** An agent that believes the contract is
  wrong reports it.

**Give each agent the contract document, not a summary of it.** (D-025 exists because cross-agent
seams that are left to convention drift.)

### Testing philosophy

- **Nothing important is mocked.** The database, the session layer and the rollover transaction are
  always real. Each Vitest test migrates into a fresh temporary SQLite **file**, so WAL and
  `busy_timeout` behave as in production. A test that mocks these tests the mock.
- **Playwright runs against the built adapter-node server**, so it exercises the real production
  artefact, at a 390×844 device descriptor.
- **The mutation sweep is a standing exit criterion** for every milestone from M2 on (D-030, D-033,
  D-035). Before calling a milestone done: enumerate its guards — every validator, every `throw`,
  every early return on an idempotent no-op, every CHECK the code leans on — then **break each one and
  run the suite. Anything that stays green is a finding, and the milestone is not done.**

  This is not belt-and-braces. M1 needed three audits and each found the same shape of defect: a guard
  that was correctly written, accurately commented, and covered by a test that **could not reach it**.
  Reading the tests found none of them; mutating the code found all of them in one pass. A green suite
  is evidence only about the mutations someone tried.

  **The route seam deserves its own pass**: a guard reachable only through a query string, a path
  parameter or a raw JSON body will not be exercised by any domain-level test, however thorough.

  **And the write seam deserves one too — M6's addition to this rule.** Removing the visibility check
  from `updateStore` changed no status code: the transaction committed the rename and the function's
  closing `getStoreSummary` threw the same 404 on the way out. Thirty-three tests asserting statuses,
  codes, messages and body shapes all stayed green while a member who could not see a store was
  renaming it. **When the guard you are testing protects a write, assert the write did not happen —
  read the row back.** A guard on a write is only observable through the write it did not perform.

- **Some properties are invisible to any black-box test and need structural tests** (D-037). Example:
  "login compares with `timingSafeEqual`" and "the temporary password uses `crypto.randomInt`, not
  `Math.random`" cannot be observed from outside. `tests/auth/crypto-primitives.test.ts` asserts them
  with spies — `vi.hoisted` plus `vi.mock('node:crypto', importOriginal)` returning
  `{ ...actual, default: actual, timingSafeEqual: spy, randomInt: spy }` — keeping every real
  implementation while proving which primitive was called.

- **The reviewer is not a formality.** D-036 and D-037 record why: it finds the class of defect a
  mutation sweep provably cannot, because a sweep can only break code that *exists*, and it is the
  only pass in this process not run by whoever wrote the code. The M2 audit is the proof — an
  authorization bypass, in the most security-sensitive milestone, under a fully green suite.

---

## 12. Document map

| File | What it is | Authority |
|---|---|---|
| `docs/CONTRACT.md` | **FROZEN.** Complete DDL, invariants, rollover rules R-1…R-17, full API, error envelope, validation rules, session/cookie contract, security headers, SSE, deployment seam, env vars, shared types — **plus §8, the M6 addendum** (migration 002, I-14…I-18, R-18…R-22, the visibility rule, claims, locale, push, the §3.0 delta). | Normative. Build against this. |
| `docs/DECISIONS.md` | D-001 … **D-043**, each with the reasoning and what was rejected. | Why things are the way they are. |
| `PLAN.md` | Stack, data model at a glance, file ownership, milestones with exit criteria, test strategy, known gaps. | Process record. |
| `docs/DESIGN.md` | Colour tokens, type scale, metrics, screen list, layout rules. | Distilled from the canvas. |
| `design/Zembil.dc.html` | 22 artboards at 390×844. | **Visual source of truth** — beats `DESIGN.md`. |
| `docs/BACKLOG.md` | Everything deliberately not built, with the reason. | Append here instead of building. |
| `README.md` | Operator documentation: deploy, reverse proxy (Caddy/nginx/Traefik), bootstrap, accounts, passkeys, backup, restore, recovery, configuration. | For humans running it. |
| `PROJECT.md` | This file. | Orientation. |

---

## 13. Known gaps, unkept promises and honest caveats

Read this section before you trust a claim made elsewhere in the docs.

- **`ZEMBIL_LOG_LEVEL` does nothing.** It is parsed and validated at startup in `config.ts` and
  **nothing reads it**. `.env.example` and `README.md` now say so plainly rather than describing
  behaviour that does not exist. A `log(level, …)` helper is about an hour's work; the bootstrap
  banner must stay unconditional at `warn`.
- **Automatic pre-migration snapshots do not happen.** D-013's third bullet promises every migration
  takes a `pre-migration-<from>-to-<to>.sqlite` snapshot first and refuses to proceed if it fails.
  `src/lib/server/db/migrations.ts` mentions it in a comment and does not do it; the README tells the
  operator to take one by hand. **This is the largest unkept promise in `DECISIONS.md`** and the
  highest-value thing to close.
- **Passkeys have never been verified over real TLS.** They are verified over `http://localhost`,
  which is a secure context and exercises the identical code path. What is untested is a deployment
  where `ZEMBIL_RP_ID` does not match the host — a configuration failure the README warns about and
  nothing catches at startup beyond the suffix assertion. A boot-time self-check against the live
  origin would close it.
- **Playwright runs on Chromium only.** WebKit and Firefox are not installed here, and the WebAuthn
  virtual authenticator is a Chrome DevTools Protocol feature with no cross-engine equivalent. **Mobile
  Safari is the single most likely target for this app**, so a WebKit run is the highest-value
  addition to the suite.
- **Concurrent double login leaves one orphan session.** Two logins racing on the same browser both
  read the same `locals.sessionId`, both destroy it, and both create a row; the cookie keeps whichever
  wrote last and the other lives out its idle TTL. Bounded, same-user, same-browser. Deferred because
  the honest fix (destroy by `(user_id, created_before)`, or make login idempotent per request) is
  more invasive than the leftover justifies.
- **`pre-restore-<stamp>/` directories are never cleaned up.** Each restore roughly doubles the
  volume's size. Deliberate — they are the undo — but a `--keep N` flag on `restore.sh` would beat a
  documented `rm -rf`.
- **Rate-limit buckets do not survive a restart.** In-memory by design (D-007); only matters if
  restarts become frequent.
- **The README documents Caddy, nginx and Traefik but not Cloudflare Tunnel**, which is what the live
  deployment actually uses. The shape that works: the tunnel service target is
  **`http://localhost:3000`** — plain HTTP, because Cloudflare terminates TLS at the edge — while
  `ZEMBIL_ORIGIN` stays `https://…` because it describes what the *browser* sees. A tunnel is also
  potentially a second proxy hop, so `ZEMBIL_TRUST_PROXY=1` may be wrong for it; the failure mode
  either way is a **shared rate-limit bucket, not an auth bypass**, so it is worth measuring rather
  than guessing.
- **Backups are a manual script.** Nothing runs `backup.sh` on a timer. A cron entry is the difference
  between having backups and having a backup script.
- **The image size figures disagree** (264 MB in README vs 62 MB in PLAN.md).
- **M6's audit is closed, and it found things.** One blocking (`POST /api/push/subscription` had no
  row cap and no rate limit — unbounded rows plus one outbound HTTPS request per row per batch) and
  nine others. Acted on: the device cap and bucket, the store-name namespace (migration 003, which
  closed a **private-store name** oracle that R-22 had accidentally created while carefully hiding the
  id), the default-colour palette leak, the duplicated visibility predicate, and `claimed_at` no longer
  restarting when the holder edits their note. Declined deliberately, with reasons in D-044: the
  foreign-store `tripId` 409, which the frozen §2 mandates. Two carve-outs are now named in I-18 rather
  than left as a false absolute. **The most useful finding was a test gap, not a code defect**: §8.9's
  *Notifies* column had no coverage at all, so deleting `noteItemAdded` from the domain layer left the
  suite green and push silently never fired again. `tests/domain/notify-effects.test.ts` closes it.
- **`static/offline.html` and the PWA manifest are English only.** Everything rendered by the app is
  translated; these two are not, because the service worker that serves the offline page has no idea
  who is signed in — the locale is on the server, and the page exists for the case where the server
  cannot be reached. See `BACKLOG.md`.
- **Notification batches do not survive a restart.** In memory, like the rate-limit buckets. A restart
  inside a quiet window drops that batch; the next add arms a new one.
- **Push has never been delivered to a real device.** The whole path is tested against a real database
  with the outbound HTTPS call stubbed, so payload composition, recipient selection and 404/410
  pruning are all real — what is untested is `web-push` actually reaching Apple, Google or Mozilla,
  and iOS Safari actually showing one. Given §13's existing note that passkeys have never run over
  real TLS, this is the same shape of gap.
- **A private shop cannot be recovered through the API.** Deliberate (D-040), documented in the README,
  and asserted by a test so nobody "fixes" it into an admin exemption by accident. Recovery is one
  `UPDATE`.
- **Theme flash on an explicit Light/Dark override.** `Appearance` is applied on mount, so a member
  who overrides their OS setting sees one frame of the other theme. The honest fix is a cookie read
  in the root `load` — an inline script will not pass `kit.csp` in hash mode.

---

## 14. How to extend it

### Before you write anything

1. Read `docs/CONTRACT.md` for the area you are touching. Not a summary of it — it.
2. Check `docs/BACKLOG.md`. If your idea is there, the reason it is deferred is there too, and it may
   already have a chosen approach.
3. Check `docs/DECISIONS.md` for the relevant D-number. If you are reversing a decision, add a new
   D-entry that says so and why; do not silently edit the old one.

### While you write

- Match the surrounding code. It is hand-written parameterised SQL, small modules, and comments that
  explain *why* rather than *what*.
- If you add a write endpoint, add it to the §3.0 effects table and to the test that asserts that
  table.
- If you add a rollover behaviour, give it an R-number in the contract.
- If you add an invariant, say whether the schema or a test enforces it.
- Convert booleans to `1`/`0` at the repository boundary.
- Never make an authorization decision from `event.url.pathname`.

### Before you call it done

- `npm test` (Vitest, 398) and `npm run test:e2e` (Playwright, 12) green.
- `npm run check` clean.
- **Run a mutation sweep over the guards you added.** Break each one; anything that stays green is a
  finding.
- Run `zembil-reviewer` over the change and act on the findings.

### The highest-value things to do next, in order

1. **A WebKit Playwright run.** Mobile Safari is the primary target and is completely untested — and
   it is now also the browser where push is most likely to behave differently, since iOS only offers
   it to an installed PWA.
2. **Automatic pre-migration snapshots.** The largest unkept promise in the decision log; the
   in-process `backup()` D-013 measured is the right mechanism.
3. **A scheduled backup.** A host cron or a compose sidecar calling `backup.sh`.
4. **A boot-time `ZEMBIL_RP_ID` self-check against the live origin.** Closes the one done-means clause
   still marked ⚠️.
5. **`ZEMBIL_LOG_LEVEL` actually filtering.** An hour, and it removes a lie from the config file.
6. **Document the Cloudflare Tunnel shape in the README**, since that is what the live deployment
   uses.
7. **"Add all again" from a past trip.** The most-wanted deferred feature from the design canvas, and
   cheap on the existing model.

*(The store-edit UI that used to sit at position 5 was built in M6 — D-043 explains why it came along
with store visibility rather than waiting its turn.)*

### Things not to do

- Do not add an ORM, a second container, a message broker, a background worker, or a connection pool.
  There are ten users and one process. (D-002, D-003, D-011, D-012)
- Do not build analytics. Keep the schema from blocking it; build nothing.
- Do not add multi-household tenancy. The brief is explicit: one family. Every query would need a
  household boundary.
- Do not set `PROTOCOL_HEADER` or `HOST_HEADER`.
- Do not change `ZEMBIL_RP_ID` on a live deployment — it invalidates every passkey.
- Do not edit `docs/CONTRACT.md` to match an implementation. Report the mismatch.
- Do not cache an authenticated document in the service worker.
- Do not add an admin override for private stores. It is not an oversight (D-040), and a test asserts
  its absence.
- Do not make an authorization decision about a store anywhere except `requireVisibleStore` /
  `isVisibleTo`. Nothing else may read `stores.private_to` to decide something.
- Do not read the locale from a request header after account creation, and do not put the current
  locale in a module-level `$state` — SSR shares module state across concurrent requests.
- Do not translate a server error message on the client.
