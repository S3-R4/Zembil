# Zembil — Integration Contract (FROZEN)

Status: **frozen at M0.** Every agent builds against this file and nothing else. If something here is
wrong, ambiguous, or missing, stop and report it to the orchestrator. Do not work around it, and do
not edit this file to match your implementation.

Conventions used throughout:

- All timestamps are **integer epoch milliseconds, UTC**. Never store local time, never store ISO text.
- All primary keys are **UUIDv4 as lowercase hex text with dashes**, generated with `crypto.randomUUID()`.
- All booleans are `INTEGER` constrained to `(0,1)`. SQLite has no boolean type.
- All JSON request and response bodies are `application/json; charset=utf-8`.
- "Actor" means the authenticated user attached to the request by `hooks.server.ts`.

---

## 1. Data model

### 1.1 Migration 001 — complete DDL

This is the entire initial schema. It is copy-pasteable and must execute without modification. The
migration runner applies it inside a single transaction and then sets `PRAGMA user_version = 1`.

```sql
-- ============================================================================
-- Zembil migration 001 — initial schema
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users
--   username_key is the normalization used for uniqueness and lookup:
--   NFKC-normalized then lowercased in application code. SQLite's COLLATE
--   NOCASE only folds ASCII A-Z, which is wrong for Turkish names, so the
--   application owns normalization and the database only enforces uniqueness.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                   TEXT    PRIMARY KEY,
  username             TEXT    NOT NULL,          -- display form, as typed at creation
  username_key         TEXT    NOT NULL UNIQUE,   -- NFKC + lowercase, used for all lookups
  display_name         TEXT    NOT NULL,
  password_hash        TEXT    NOT NULL,          -- see 1.3 for the encoded format
  is_admin             INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  webauthn_user_handle BLOB    NOT NULL UNIQUE,   -- 32 random bytes, stable for life of account
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  disabled_at          INTEGER,                   -- set when is_active flips to 0
  CHECK (length(trim(username)) > 0),
  CHECK (length(trim(display_name)) > 0),
  CHECK (length(webauthn_user_handle) = 32),
  CHECK ((is_active = 0) = (disabled_at IS NOT NULL))
) STRICT;

-- ---------------------------------------------------------------------------
-- sessions
--   id is sha256(token) as lowercase hex. The raw token exists only in the
--   user's cookie. A database disclosure therefore yields no usable session.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                  TEXT    PRIMARY KEY,        -- sha256 hex of the cookie token
  user_id             TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_method         TEXT    NOT NULL CHECK (auth_method IN ('password','passkey')),
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  idle_expires_at     INTEGER NOT NULL,           -- slid forward on use
  absolute_expires_at INTEGER NOT NULL,           -- never extended
  user_agent          TEXT,                       -- truncated to 256 chars, for the account screen
  CHECK (absolute_expires_at > created_at)
) STRICT;
CREATE INDEX sessions_user      ON sessions (user_id);
CREATE INDEX sessions_reaping   ON sessions (idle_expires_at);

-- ---------------------------------------------------------------------------
-- credentials — WebAuthn / passkeys
-- ---------------------------------------------------------------------------
CREATE TABLE credentials (
  id            TEXT    PRIMARY KEY,              -- credential ID, base64url text
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BLOB    NOT NULL,                 -- COSE public key bytes, stored raw
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                             -- JSON array of strings, or NULL
  device_label  TEXT    NOT NULL,                 -- user-supplied, e.g. "iPhone — Ayse"
  backed_up     INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0,1)),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  CHECK (length(trim(device_label)) > 0)
) STRICT;
CREATE INDEX credentials_user ON credentials (user_id);

-- ---------------------------------------------------------------------------
-- webauthn_challenges
--   Server-side, single-use, short-lived. user_id is NULL for the usernameless
--   (discoverable credential) login flow.
-- ---------------------------------------------------------------------------
CREATE TABLE webauthn_challenges (
  id         TEXT    PRIMARY KEY,                 -- opaque handle returned to the client
  challenge  TEXT    NOT NULL,                    -- base64url
  user_id    TEXT    REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT    NOT NULL CHECK (purpose IN ('registration','authentication')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  CHECK ((purpose = 'registration') <= (user_id IS NOT NULL))  -- registration requires a user
) STRICT;
CREATE INDEX webauthn_challenges_reaping ON webauthn_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- stores
--   rev is a per-store monotonic revision counter, bumped inside the same
--   transaction as any mutation affecting this store's list. Clients use it to
--   skip redundant refetches after a realtime hint.
-- ---------------------------------------------------------------------------
CREATE TABLE stores (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  name_key    TEXT    NOT NULL UNIQUE,            -- NFKC + lowercase + collapsed whitespace
  -- Palette KEY, never a raw colour. The design gives each store a coloured
  -- spine and a tinted count chip; storing a key rather than a hex value keeps
  -- the value off the CSS path entirely and lets the dark theme remap it.
  color       TEXT    NOT NULL DEFAULT 'terracotta'
              CHECK (color IN ('terracotta','green','violet','blue','amber','rose','teal','slate')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  rev         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  archived_at INTEGER,
  CHECK (length(trim(name)) > 0)
) STRICT;
CREATE INDEX stores_listing ON stores (archived_at, sort_order, name);

-- ---------------------------------------------------------------------------
-- trips — "a list". Exactly one open trip per non-archived store, always.
--   The partial unique index is the real enforcement of that invariant; it is
--   not merely checked in application code.
-- ---------------------------------------------------------------------------
CREATE TABLE trips (
  id        TEXT    PRIMARY KEY,
  store_id  TEXT    NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,                     -- 1-based, contiguous, per store
  status    TEXT    NOT NULL CHECK (status IN ('open','closed')),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by TEXT    REFERENCES users(id) ON DELETE SET NULL,
  CHECK (seq >= 1),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX trips_one_open_per_store ON trips (store_id) WHERE status = 'open';
CREATE UNIQUE INDEX trips_store_seq          ON trips (store_id, seq);
CREATE INDEX        trips_history            ON trips (store_id, seq DESC);

-- ---------------------------------------------------------------------------
-- items
--   state:
--     'pending' — on the list, not yet bought
--     'ticked'  — bought; stays visible, sorts below pending, undoable
--     'carried' — was pending when its trip closed; a clone now lives on the
--                 next trip. Terminal state, kept as history.
--
--   Carry lineage:
--     carried_from_item_id — the item on the previous trip this was cloned from
--     carried_to_item_id   — the clone on the next trip, set when this carried
--     origin_item_id       — root of the chain; equals own id for a fresh item,
--                            so "how long have we been failing to buy milk" is
--                            one indexed query
--
--   client_id makes POST /items idempotent under flaky cellular: a retried
--   request with the same client_id returns the existing row instead of a
--   duplicate.
--
--   store_id is denormalized from trips.store_id so the hot list query and the
--   "all items ever at this store" analytics query never need a join. It is
--   maintained by the application and asserted by tests.
--
--   Future analytics (price, quantity, category) attach here as nullable
--   columns via ALTER TABLE ADD COLUMN — a non-destructive migration. No
--   analytics columns exist today.
-- ---------------------------------------------------------------------------
CREATE TABLE items (
  id                   TEXT    PRIMARY KEY,
  trip_id              TEXT    NOT NULL REFERENCES trips(id)  ON DELETE CASCADE,
  store_id             TEXT    NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  client_id            TEXT,                      -- client-generated UUID for idempotent add
  name                 TEXT    NOT NULL,
  note                 TEXT,                      -- "Quantity or note" in the design
  state                TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (state IN ('pending','ticked','carried')),
  sort_order           INTEGER NOT NULL,
  ticked_at            INTEGER,
  ticked_by            TEXT    REFERENCES users(id) ON DELETE SET NULL,
  carried_from_item_id TEXT    REFERENCES items(id) ON DELETE SET NULL,
  carried_to_item_id   TEXT    REFERENCES items(id) ON DELETE SET NULL,
  origin_item_id       TEXT    NOT NULL,
  carry_count          INTEGER NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  created_by           TEXT    REFERENCES users(id) ON DELETE SET NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  CHECK (length(trim(name)) > 0),
  CHECK (length(name) <= 200),
  CHECK (note IS NULL OR length(note) <= 500),
  CHECK (carry_count >= 0),
  CHECK (version >= 1),
  -- ticked_at is set if and only if the item is ticked
  CHECK ((state = 'ticked') = (ticked_at IS NOT NULL)),
  -- a carried item must point at its clone; a non-carried item must not
  CHECK ((state = 'carried') = (carried_to_item_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX items_client_id   ON items (trip_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX items_list               ON items (trip_id, state, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX items_store_history      ON items (store_id, created_at);
CREATE INDEX items_origin             ON items (origin_item_id);

-- ---------------------------------------------------------------------------
-- Connection pragmas. Applied on every connection open, not stored in the file
-- except journal_mode, which is persistent.
--   journal_mode=WAL       readers never block the writer (persistent in the file)
--   foreign_keys=ON        OFF by default in SQLite; every FK above is inert without it
--   busy_timeout=5000      wait rather than fail on a concurrent writer
--   synchronous=NORMAL     under WAL this cannot corrupt the file; on power loss it
--                          can lose the last transactions. A home server has no UPS,
--                          and losing the last few seconds of a shopping list is
--                          acceptable. Override with ZEMBIL_SYNCHRONOUS=FULL.
--   trusted_schema=OFF     hardening; no extensions are loaded
--   journal_size_limit=67108864
--   wal_autocheckpoint=1000
--   temp_store=MEMORY
--
-- All tables are declared STRICT. Verified on this build: a STRICT table rejects
-- a string written to an INTEGER column instead of silently storing it. Without
-- it, SQLite's type affinity would accept the mistake and the bug would surface
-- as bad data months later.
-- ---------------------------------------------------------------------------
```

### 1.1a `node:sqlite` binding rules (measured, not recalled)

- **JavaScript booleans cannot be bound.** `stmt.run(true)` throws
  *"Provided value cannot be bound to SQLite parameter"*. Every boolean must be converted to `1`/`0`
  at the repository boundary. This is the single most likely source of a runtime error in the data
  layer, and it fails at the first call rather than silently.
- Rows come back as **null-prototype objects**. `Object.hasOwn(row, k)` works; `row.hasOwnProperty(k)`
  throws. Do not spread a row into something that expects `Object.prototype`.
- `BigInt` is off by default; timestamps as epoch-milliseconds fit comfortably in a JS number.
- `node:sqlite` is **synchronous**, and there is exactly one process, so the event loop is the write
  serializer. Use **one connection** for reads and writes. There is no pool and no interleaving, so
  `SQLITE_BUSY` should never occur in practice — `busy_timeout` is defence in depth, not the design.

### 1.2 Table invariants

Each of these is a testable assertion. The reviewer checks that a test exists for each.

| # | Invariant |
|---|---|
| I-1 | Every non-archived store has exactly **one** trip with `status='open'`. Enforced by `trips_one_open_per_store`. |
| I-2 | `trips.seq` is contiguous from 1 per store. A gap means a bug in close. |
| I-3 | `items.store_id` always equals `trips.store_id` for the item's `trip_id`. |
| I-4 | An item with `state='ticked'` has both `ticked_at` and `ticked_by` set. |
| I-5 | An item with `state='carried'` has `carried_to_item_id` set, `ticked_at` NULL, and belongs to a **closed** trip. |
| I-6 | `origin_item_id` equals `id` for an item that was never carried into, otherwise the root of the chain. It is never NULL. |
| I-7 | `carry_count` equals the length of the `carried_from_item_id` chain back to `origin_item_id`. |
| I-8 | A soft-deleted item (`deleted_at` non-NULL) is never carried and never appears in any list response. |
| I-9 | `sessions.id` is never equal to any value that was ever sent to a client. |
| I-10 | `users.password_hash` is never NULL — a passkey-only account must still have a fallback credential. |

### 1.3 Password hash encoding

`password_hash` is a single text column holding all parameters, so the algorithm can be upgraded
without a schema change:

```
scrypt$N=65536,r=8,p=1$<salt-base64url>$<derived-key-base64url>
```

- Salt: 16 bytes from `crypto.randomBytes`. Derived key: 32 bytes.
- `N=65536, r=8, p=1` needs ~64 MiB per verification. `maxmem` must be raised accordingly (128 MiB)
  or `crypto.scrypt` throws.
- Verification uses `crypto.timingSafeEqual`. Comparing with `===` is a defect.
- On successful login, if the stored parameters are weaker than the current target, transparently
  rehash and update.

---

## 2. Rollover state machine

Each numbered rule below must become at least one test assertion.

**R-1 — Store creation.** Creating a store creates the store row and its `seq=1`, `status='open'`
trip in the **same transaction**. A store never exists without an open trip.

**R-2 — Add targets the store, not the trip.** Items are added via the store, and the server resolves
the store's currently-open trip inside the write transaction. This is deliberate: a client that began
composing an item before a rollover and submitted after it lands the item on the **new** trip rather
than failing or landing on a closed one.

**R-3 — Tick.** Sets `state='ticked'`, `ticked_at=now`, `ticked_by=actor`, bumps `version` and
`updated_at`. The item stays in its trip. Ticking is allowed only while the trip is open.

**R-4 — Tick is idempotent.** Ticking an already-ticked item is a success, not an error. It does
**not** overwrite the original `ticked_at`/`ticked_by`. Two family members ticking the same item at
the same moment both see success; the first writer is recorded.

**R-5 — Untick.** Sets `state='pending'`, `ticked_at=NULL`, `ticked_by=NULL`, bumps `version`.
Idempotent in the same way. Allowed only while the trip is open.

**R-6 — Close is one atomic transaction.** `POST /api/stores/{storeId}/trips/close` runs entirely
inside `BEGIN IMMEDIATE … COMMIT`, in this order:

1. Re-read the trip `FOR` the given `tripId`. If its `status` is not `'open'`, or its `store_id` does
   not match, `ROLLBACK` and return `409 TRIP_ALREADY_CLOSED` including the store's current open trip
   id so the client can simply navigate.
2. If the trip has **zero** non-deleted items, `ROLLBACK` and return `409 TRIP_EMPTY`. Closing an
   empty trip would write a meaningless entry into history.
3. Set the trip `status='closed'`, `closed_at=now`, `closed_by=actor`.
4. Insert the successor trip: same store, `seq = closed.seq + 1`, `status='open'`, `opened_at=now`.
   This must happen **after** step 3 or `trips_one_open_per_store` rejects the insert.
5. For each non-deleted item in the closed trip with `state='pending'`, ordered by `sort_order, created_at`:
   - insert a clone into the successor trip with a new `id`, the same `name`, `note`, `sort_order`
     and `created_by` (the original author is preserved — carry-over is not authorship),
     `state='pending'`, `client_id=NULL`, `carried_from_item_id = original.id`,
     `origin_item_id = original.origin_item_id`, `carry_count = original.carry_count + 1`,
     `version=1`, `created_at=now`, `updated_at=now`;
   - update the original to `state='carried'`, `carried_to_item_id = clone.id`, bump `version`.
6. Bump `stores.rev`.
7. `COMMIT`, then emit one `store.changed` event.

**R-7 — Ticked items never carry.** An item with `state='ticked'` when its trip closes stays exactly
as it is, in the closed trip, forever. That is the purchase history.

**R-8 — Closed trips are immutable.** Tick, untick, edit, delete and add against an item or trip whose
trip is closed all return `409 TRIP_CLOSED`. The only writes a closed trip ever receives are those in
R-6 step 5.

**R-9 — Undo after rollover.** Undo is scoped to the open trip. A user who ticked an item and then
closed the trip cannot un-tick it. Nothing is lost: the item is visible in trip history, and
re-adding it is one tap from the history screen. This is a deliberate boundary, not an omission.

**R-10 — Delete.** Delete is a soft delete (`deleted_at=now`). A pending item deleted before close is
**not** carried. Deleting is idempotent — deleting an already-deleted item returns success.

**R-11 — Concurrent close.** Two simultaneous close requests for the same trip: `BEGIN IMMEDIATE`
serializes them, the second fails its status re-read at step 1, and returns `409 TRIP_ALREADY_CLOSED`.
Exactly one successor trip is ever created. Never two.

**R-12 — Add racing close.** An add committing before the close carries over per R-6. An add
committing after it lands on the successor trip per R-2. Both orderings are correct and neither
loses the item.

**R-13 — Ordering within a list.** Pending items sort by `sort_order ASC, created_at ASC`. Ticked
items sort **below all pending items**, by `ticked_at DESC` — most recently ticked at the top of the
ticked group, so undo is always reachable near the boundary. `carried` items never appear in an open
list.

**R-14 — Archiving a store.** Sets `archived_at`. The open trip is left open and untouched. An
archived store is hidden from the store list and rejects writes with `409 STORE_ARCHIVED`.
Un-archiving restores it intact. Stores are never hard-deleted; that would cascade away history.

---

## 3. HTTP API

Auth levels: **public** (no session), **session** (any active user), **admin** (active user with
`is_admin=1`). Every non-public endpoint is checked server-side on every request. Rendering an admin
page is not an authorization check.

All mutating requests (`POST`, `PATCH`, `DELETE`) additionally require a valid `Origin` header
matching `ZEMBIL_ORIGIN`. A missing `Origin` on a mutation is **rejected**, never allowed through.

### 3.1 Error envelope

Every non-2xx response is exactly:

```json
{ "error": { "code": "ITEM_NOT_FOUND", "message": "Item not found." } }
```

`message` is safe to show a user and never leaks internals. Diagnostic detail goes to the server log
only. Shared codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`ORIGIN_MISMATCH` (403), `VALIDATION_FAILED` (400), `RATE_LIMITED` (429), `CONFLICT` (409),
`INTERNAL` (500).

### 3.2 Authentication

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | Password login |
| POST | `/api/auth/logout` | session | Destroy the current session |
| POST | `/api/auth/password` | session | Change own password |
| POST | `/api/auth/passkey/login/options` | public | Begin usernameless passkey login |
| POST | `/api/auth/passkey/login/verify` | public | Finish passkey login |
| POST | `/api/auth/passkey/register/options` | session | Begin passkey registration |
| POST | `/api/auth/passkey/register/verify` | session | Finish passkey registration |
| DELETE | `/api/auth/passkey/{credentialId}` | session | Remove one of **own** passkeys |
| GET | `/api/me` | session | Current user + own passkeys |

**`POST /api/auth/login`**
Request `{ "username": string, "password": string }`.
`200` → `{ "user": User, "mustChangePassword": boolean }` and sets the session cookie.
`401 INVALID_CREDENTIALS` for wrong username, wrong password, **and disabled account** — one code,
one message, one response shape, and the same amount of work done in all three cases. A disabled
account must not be distinguishable from a non-existent one. On an unknown username the server still
performs a dummy scrypt verification against a fixed hash so the timing does not differ.
`429 RATE_LIMITED` per §3.7.

**`POST /api/auth/password`**
Request `{ "currentPassword": string, "newPassword": string }`. `newPassword` minimum 12 characters,
maximum 256, no other composition rules. `204` on success, and **all other sessions for that user are
destroyed** while the current one is rotated. `401 INVALID_CREDENTIALS` if `currentPassword` is wrong.

**`POST /api/auth/passkey/login/options`**
Request `{}` — no username. `200` → `{ "options": PublicKeyCredentialRequestOptionsJSON, "challengeId": string }`.
Uses discoverable credentials, so `allowCredentials` is empty. This is what makes the flow
enumeration-safe: the response is identical regardless of who exists.

**`POST /api/auth/passkey/login/verify`**
Request `{ "challengeId": string, "response": AuthenticationResponseJSON }`.
`200` → `{ "user": User }` and sets the session cookie with `auth_method='passkey'`.
`401 INVALID_CREDENTIALS` if verification fails, the challenge is expired or already used, the
credential is unknown, or the owning account is disabled.
The challenge row is deleted on **first** use, success or failure. A zero signature counter is
accepted — most platform authenticators report zero and rejecting them breaks passkeys entirely. If
the stored counter and the returned counter are both non-zero and the returned one is not greater,
the assertion is rejected as a possible clone.

**`POST /api/auth/passkey/register/options`** → `{ "options": PublicKeyCredentialCreationOptionsJSON, "challengeId": string }`.
`user.id` is the account's `webauthn_user_handle`, base64url-encoded — never the username, never a
sequential integer. `excludeCredentials` lists the user's existing credentials.

**`POST /api/auth/passkey/register/verify`**
Request `{ "challengeId": string, "response": RegistrationResponseJSON, "label": string }`.
`201` → `{ "passkey": Passkey }`. `label` is 1–64 characters.

### 3.3 Admin

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/users` | admin | List all accounts |
| POST | `/api/admin/users` | admin | Create an account |
| PATCH | `/api/admin/users/{userId}` | admin | Rename, grant/revoke admin, enable/disable |
| POST | `/api/admin/users/{userId}/reset-password` | admin | Issue a new temporary password |
| DELETE | `/api/admin/users/{userId}/passkeys` | admin | Remove **all** of that user's passkeys |

**`POST /api/admin/users`** — request `{ "username": string, "displayName": string, "isAdmin": boolean }`.
`201` → `{ "user": User, "temporaryPassword": string }`. The server generates the password (20
characters, unambiguous alphabet), returns it **once**, never stores it in plaintext, and sets
`must_change_password=1`. `409 USERNAME_TAKEN` if `username_key` collides.

**`PATCH /api/admin/users/{userId}`** — request `{ "displayName"?, "isAdmin"?, "isActive"? }`.
Setting `isActive:false` sets `disabled_at` and **destroys every session and terminates every open SSE
stream for that user immediately**. Guards, each `409`:
`CANNOT_DISABLE_SELF`, `CANNOT_DEMOTE_SELF`, and `LAST_ADMIN` — the system must never reach zero
active admins.

**`POST /api/admin/users/{userId}/reset-password`** → `200 { "temporaryPassword": string }`, sets
`must_change_password=1`, and destroys every session for that user.

### 3.4 Stores

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/stores` | session | Store list for the home screen |
| POST | `/api/stores` | session | Create a store (+ its first trip) |
| PATCH | `/api/stores/{storeId}` | session | Rename, reorder, archive, un-archive |

`GET /api/stores` → `{ "stores": StoreSummary[] }` where

```ts
type StoreSummary = {
  id: string; name: string; color: StoreColor; sortOrder: number; rev: number;
  openTripId: string;
  pendingCount: number;      // drives "Nothing needed" vs a count in the design
  tickedCount: number;
  lastClosedTripAt: number | null;
}
```

`POST /api/stores` request `{ "name": string, "color"?: StoreColor }` (name 1–60 chars; `color`
defaults to the first palette key not already used by an active store). `201 → { "store": StoreSummary }`.
`PATCH /api/stores/{storeId}` accepts `{ "name"?, "color"?, "sortOrder"?, "archived"? }`. An
unrecognised `color` is `400 VALIDATION_FAILED` — the value reaches a CSS class name, so it is
validated against the enum server-side and never interpolated.
`409 STORE_NAME_TAKEN` on a `name_key` collision, including against an archived store — the correct
action there is to un-archive.

### 3.5 Lists and items

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/stores/{storeId}/list` | session | The open list for one store |
| POST | `/api/stores/{storeId}/items` | session | Add an item |
| PATCH | `/api/items/{itemId}` | session | Edit name or note |
| DELETE | `/api/items/{itemId}` | session | Soft-delete |
| POST | `/api/items/{itemId}/tick` | session | Mark bought |
| POST | `/api/items/{itemId}/untick` | session | Undo |
| POST | `/api/stores/{storeId}/trips/close` | session | Finish the trip, roll over |

**`GET /api/stores/{storeId}/list`** → `{ "store": StoreSummary, "trip": Trip, "items": Item[] }`,
items already ordered per **R-13**. Never includes soft-deleted or `carried` items.

**`POST /api/stores/{storeId}/items`** — request `{ "name": string, "note"?: string, "clientId": string }`.
`clientId` is a client-generated UUID and is **required**: a retry after a timeout on flaky cellular
must not create a duplicate. If `(trip_id, client_id)` already exists, return `200` with the existing
item instead of `201`. `201 → { "item": Item }`. `409 STORE_ARCHIVED` if archived.

**`POST /api/items/{itemId}/tick`** and **`/untick`** — request body `{}`. `200 → { "item": Item }`.
Idempotent per R-4 and R-5. `409 TRIP_CLOSED` if the item's trip is closed. `404 ITEM_NOT_FOUND`
if the item does not exist **or** is soft-deleted.

**`PATCH /api/items/{itemId}`** — request `{ "name"?: string, "note"?: string | null, "version": number }`.
`409 VERSION_CONFLICT` if `version` does not match, with the current item in the response so the
client can reconcile: `{ "error": {...}, "item": Item }`. Tick and untick deliberately do **not**
take a version — a concurrent tick is not a conflict, it is agreement.

**`POST /api/stores/{storeId}/trips/close`** — request `{ "tripId": string }`.
`200` → `{ "closedTrip": Trip, "newTrip": Trip, "boughtCount": number, "carriedCount": number }`.
`409 TRIP_ALREADY_CLOSED` → `{ "error": {...}, "openTripId": string }`. `409 TRIP_EMPTY` per R-6.2.

### 3.6 Trip history

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/stores/{storeId}/trips` | session | Closed trips, newest first |
| GET | `/api/trips/{tripId}` | session | One trip with its items |

`GET /api/stores/{storeId}/trips?limit=20&before={seq}` →
`{ "trips": TripSummary[], "nextBefore": number | null }` where `TripSummary` adds `boughtCount` and
`carriedCount` to `Trip`. `limit` is 1–50, default 20.

### 3.7 Rate limiting

In-process token buckets, keyed independently and both checked:

| Bucket | Key | Limit |
|---|---|---|
| Password login | `username_key` | 10 per 15 min |
| Password login | client IP | 30 per 15 min |
| Passkey assertion | client IP | 30 per 15 min |
| Admin user creation | actor `user_id` | 20 per hour |

Exceeding a bucket returns `429 RATE_LIMITED` with a `Retry-After` header. There is deliberately **no
account lockout**: a lockout on a family app is a denial-of-service any anonymous visitor can inflict
on a family member. Buckets are in-memory and reset on restart, which is acceptable because the
restart requires host access.

**Client IP is derived only from the `ZEMBIL_TRUST_PROXY` setting** — take the Nth-from-the-right
entry of `X-Forwarded-For`, where N is the configured hop count. Reading the leftmost entry, or
trusting the header when `ZEMBIL_TRUST_PROXY=0`, lets any client forge its own identity and is a
defect.

---

## 4. Realtime (SSE)

**`GET /api/events`** — auth **session**. `Content-Type: text/event-stream`, `Cache-Control: no-store`,
`X-Accel-Buffering: no`, `Connection: keep-alive`.

Events are **hints, not data**. The client refetches; it never patches state from an event payload.
This is deliberate: hints are immune to out-of-order delivery and to gaps across a reconnect, and at
fewer than ten users the extra fetch costs nothing.

```ts
type ZembilEvent =
  | { v: 1; type: 'store.changed';  storeId: string; rev: number }
  | { v: 1; type: 'stores.changed' }                    // a store was created, renamed or archived
  | { v: 1; type: 'session.revoked' }                   // this session specifically; client logs out
```

- A `:ping` comment every 25 seconds keeps intermediaries from timing the connection out.
- The client tracks the last `rev` it fetched per store and skips a refetch when
  `event.rev <= known.rev`.
- Events are emitted **after** the write transaction commits, never inside it. Emitting inside means
  a client can refetch and read pre-commit state.
- The stream is torn down immediately when the session is destroyed or the account is disabled. A
  live SSE connection must never outlive its session.
- Belt and braces: the client also revalidates on `visibilitychange`, `focus`, and `online`. A phone
  that was in a pocket for an hour resolves on unlock even if the stream silently died.

---

## 5. Session and cookie contract

| Property | Value |
|---|---|
| Name | `__Host-zembil_session` over HTTPS, `zembil_session` when `ZEMBIL_ORIGIN` is `http://` (dev only) |
| Value | 32 random bytes from `crypto.randomBytes`, base64url — **the raw token, stored only here** |
| `HttpOnly` | yes |
| `Secure` | yes (implied by the `__Host-` prefix) |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Domain` | never set (required by `__Host-`) |
| `Max-Age` | matches `idle_expires_at` |

- Idle TTL 30 days, absolute TTL 180 days. Both are enforced server-side; the cookie's own expiry is a
  convenience, never the authority.
- `last_seen_at` and `idle_expires_at` are slid forward at most once per hour to avoid a write on
  every request.
- The session token is **rotated** (new row, old row deleted) on login and on password change.
- Session identifiers never appear in a URL, a log line, or the client bundle.

### Security headers (set for every response in `hooks.server.ts`)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none';
  form-action 'self'; frame-ancestors 'none'; object-src 'none'
Referrer-Policy: same-origin
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(),
  publickey-credentials-get=(self), publickey-credentials-create=(self)
```

Inline styles and scripts use SvelteKit's `kit.csp` hash mode — `'unsafe-inline'` must not appear.
`Permissions-Policy` must explicitly allow the two `publickey-credentials-*` features or passkeys
break. HSTS is set by the reverse proxy and documented in the README, not by the app.

---

## 6. Environment variables

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ZEMBIL_ORIGIN` | URL | **yes** | — | e.g. `https://zembil.example.com`. Drives CSRF origin checks and WebAuthn `expectedOrigin`. Startup fails if unset or unparseable. |
| `ZEMBIL_RP_ID` | hostname | no | hostname of `ZEMBIL_ORIGIN` | WebAuthn relying-party ID. Registrable domain, no scheme, no port. |
| `ZEMBIL_RP_NAME` | string | no | `Zembil` | Shown in the OS passkey prompt. |
| `ZEMBIL_DATA_DIR` | path | no | `/data` | Holds `zembil.db` and its `-wal`/`-shm` sidecars. |
| `PORT` | int | no | `3000` | |
| `HOST` | string | no | `0.0.0.0` | Inside the container only; compose binds to loopback. |
| `ZEMBIL_TRUST_PROXY` | int | no | `1` | Trusted `X-Forwarded-For` hops. `0` disables header trust entirely. |
| `ZEMBIL_BOOTSTRAP_ADMIN_USERNAME` | string | no | `admin` | Used only when the users table is empty. |
| `ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD` | string | no | generated | If unset, a random password is generated and logged **once**. |
| `ZEMBIL_SESSION_IDLE_DAYS` | int | no | `30` | |
| `ZEMBIL_SESSION_ABSOLUTE_DAYS` | int | no | `180` | |
| `ZEMBIL_LOG_LEVEL` | enum | no | `info` | `debug\|info\|warn\|error` |

There is **no application secret key**. Sessions are opaque random tokens stored hashed, so nothing
needs signing — one less secret to provision, rotate, or leak.

**Bootstrap is idempotent**: it runs only when `SELECT COUNT(*) FROM users` is zero. A restart with
the env vars still set never resets an existing admin's password.

---

## 7. Shared types

These cross the client/server boundary. `src/lib/types.ts` is the single definition; the frontend
imports from there and does not redeclare them.

```ts
export type UserRole = 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: number;
}

/** Admin listing only — never sent to a non-admin. */
export interface AdminUser extends User {
  passkeyCount: number;
  disabledAt: number | null;
  mustChangePassword: boolean;
  lastSeenAt: number | null;
}

export interface Passkey {
  id: string;
  deviceLabel: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

export type StoreColor =
  | 'terracotta' | 'green' | 'violet' | 'blue' | 'amber' | 'rose' | 'teal' | 'slate';

export interface StoreSummary {
  id: string;
  name: string;
  color: StoreColor;
  sortOrder: number;
  rev: number;
  openTripId: string;
  pendingCount: number;
  tickedCount: number;
  lastClosedTripAt: number | null;
}

export type TripStatus = 'open' | 'closed';

export interface Trip {
  id: string;
  storeId: string;
  seq: number;
  status: TripStatus;
  openedAt: number;
  closedAt: number | null;
  closedByName: string | null;
}

export interface TripSummary extends Trip {
  boughtCount: number;
  carriedCount: number;
}

export type ItemState = 'pending' | 'ticked' | 'carried';

export interface Item {
  id: string;
  tripId: string;
  storeId: string;
  name: string;
  note: string | null;
  state: ItemState;
  sortOrder: number;
  tickedAt: number | null;
  tickedByName: string | null;   // display name, never the user id — no id leakage to the client
  carryCount: number;
  version: number;
  createdAt: number;
  createdByName: string | null;
}

export interface ApiError {
  error: { code: string; message: string };
}
```

Note on identifiers: item and trip responses carry **display names**, not user ids. There is no
endpoint that maps an id to a user for a non-admin, so no id is exposed that a member could use to
probe the account list.
