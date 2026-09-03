# Zembil — Integration Contract (FROZEN)

Status: **frozen at M0.** Every agent builds against this file and nothing else. If something here is
wrong, ambiguous, or missing, stop and report it to the orchestrator. Do not work around it, and do
not edit this file to match your implementation.

**§8 is an addendum, frozen at the start of M6**, adding trip claims, store visibility, per-user
locale and web push. §1–§7 are unchanged and still normative. If you are touching stores, items,
trips, `/api/me` or notifications, read §8 as well — it adds invariants I-14…I-18, rules R-18…R-22, an
authorization rule that applies to **every** store-scoped endpoint (§8.4), and rows to the §3.0
write-effects table (§8.9).

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
  CHECK (length(trim(username)) > 0     AND length(username) <= 32),
  CHECK (length(trim(display_name)) > 0 AND length(display_name) <= 60),
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
  user_agent          TEXT,                       -- truncated to 256 chars. Written but not read in
                                                  -- the MVP: the session list that would show it is in
                                                  -- BACKLOG.md. Kept because it costs nothing now and
                                                  -- cannot be backfilled for sessions already created.
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
  CHECK (length(trim(device_label)) > 0 AND length(device_label) <= 64)
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
  CHECK (length(trim(name)) > 0 AND length(name) <= 60)
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
--   duplicate. Scope is the STORE, not the trip, and it survives a rollover:
--   a clone keeps the original's client_id and the original moves to 'carried',
--   so at most one non-carried, non-deleted row per (store_id, client_id) is
--   ever live. A trip-scoped index would let a retry that crossed a close
--   create a permanent duplicate (the carried clone plus the retry).
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
  -- ticked_at and ticked_by are set if and only if the item is ticked
  CHECK ((state = 'ticked') = (ticked_at IS NOT NULL)),
  CHECK ((state = 'ticked') = (ticked_by IS NOT NULL)),
  -- a carried item must point at its clone; a non-carried item must not
  CHECK ((state = 'carried') = (carried_to_item_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX items_client_id   ON items (store_id, client_id)
       WHERE client_id IS NOT NULL AND state <> 'carried' AND deleted_at IS NULL;
CREATE UNIQUE INDEX items_trip_order  ON items (trip_id, sort_order) WHERE deleted_at IS NULL;
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
| I-11 | At most **one** live row (`state <> 'carried'`, `deleted_at IS NULL`) exists per `(store_id, client_id)`. Enforced by `items_client_id`. |
| I-12 | Within one trip, `sort_order` is unique across non-deleted items. Allocation is `MAX+1000` per R-15, and nothing else writes it. |
| I-13 | `stores.rev` is strictly increasing per store and is bumped by exactly the writes listed in §3.0. |

**Which of these the schema enforces, and which only tests do.** The distinction is normative — an
invariant nobody enforces is a comment.

| Bound by the schema | I-1 (`trips_one_open_per_store`), I-4 (two `CHECK`s), I-5 partially (the `carried`/`carried_to_item_id` `CHECK`), I-10 (`NOT NULL`), I-11 (`items_client_id`), I-12 (`items_trip_order`) |
| Bound only by tests | I-2, I-3, I-5 (the "closed trip" half), I-6, I-7, I-8, I-9, I-13 |

I-3 (`items.store_id` matches its trip's store) is deliberately test-bound rather than trigger-bound:
a trigger would fire on every insert on the hot path to catch a bug that a single application-level
helper — one function that resolves the open trip and returns both ids together — makes unwritable.
The M1 exit criterion is that each test-bound invariant has a test that fails when the invariant is
violated, not merely one that passes today.

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

1. Re-read the trip for the given `tripId`. If **no such trip exists**, `ROLLBACK` and return
   `404 TRIP_NOT_FOUND` — trips are never deleted, so a `tripId` that has never existed is a client
   bug or a guess, not stale state, and answering it with a recoverable `409` hides that the same way
   a `409` on a malformed body would (§3.5). If the trip exists but its `status` is not `'open'`, or
   its `store_id` does not match, `ROLLBACK` and return `409 TRIP_ALREADY_CLOSED` including the
   store's current open trip id so the client can simply navigate.
2. If the trip has **zero** non-deleted items, `ROLLBACK` and return `409 TRIP_EMPTY`. Closing an
   empty trip would write a meaningless entry into history.
3. Set the trip `status='closed'`, `closed_at=now`, `closed_by=actor`.
4. Insert the successor trip: same store, `seq = closed.seq + 1`, `status='open'`, `opened_at=now`.
   This must happen **after** step 3 or `trips_one_open_per_store` rejects the insert.
5. For each non-deleted item in the closed trip with `state='pending'`, ordered by
   `sort_order, created_at, id`, and **in this statement order**:
   - generate the clone's `id` in application code first;
   - **insert** the clone into the successor trip with the same `name`, `note`, `sort_order` and
     `created_by` (the original author is preserved — carry-over is not authorship), but
     **`client_id = NULL` for now**, `state='pending'`, `carried_from_item_id = original.id`,
     `origin_item_id = original.origin_item_id`, `carry_count = original.carry_count + 1`,
     `version=1`, `created_at=now`, `updated_at=now`;
   - **update** the original to `state='carried'`, `carried_to_item_id = <clone id>`, bump `version`;
   - **update** the clone to `client_id = original.client_id`.

   The order is not stylistic and it is **three statements, not two**. `client_id` is carried, not
   nulled (I-11, R-17), so the original must leave the `items_client_id` partial predicate before the
   clone enters it — but `carried_to_item_id` is a self-referencing foreign key, SQLite checks
   foreign keys **immediately** unless they are declared deferred, and this one is not. So neither
   two-statement order works. Measured on Node 26.1.0 / SQLite 3.53.0 against the §1.1 DDL with
   `foreign_keys=ON`:

   | Sequence | Result |
   |---|---|
   | update original to `carried` first, then insert clone | `FOREIGN KEY constraint failed` — the clone does not exist yet |
   | insert clone first, then update original | `UNIQUE constraint failed: items.store_id, items.client_id` |
   | insert clone with `client_id=NULL`, update original, then set the clone's `client_id` | **commits** |

   The three-statement form is the one to implement. It is preferred over declaring the FK
   `DEFERRABLE INITIALLY DEFERRED` because deferring it would suspend that check for every
   transaction in the application to buy one saved `UPDATE` on a path that runs once per shopping
   trip. A test asserts that both two-statement orders raise `SQLITE_CONSTRAINT`, so this cannot
   quietly regress into a scheme that happens to work only because a constraint was dropped.
6. Bump `stores.rev`.
7. `COMMIT`, then emit one `store.changed` event carrying the new `rev`.

**R-7 — Ticked items never carry.** An item with `state='ticked'` when its trip closes stays exactly
as it is, in the closed trip, forever. That is the purchase history.

**R-8 — Closed trips are immutable.** Tick, untick, edit and delete against an item whose trip is
closed all return `409 TRIP_CLOSED`. There is deliberately no such case for **add**: R-2 makes add
store-scoped, so it resolves the store's currently-open trip and can never target a closed one. Do
not write a test for adding to a closed trip; the endpoint to reach it does not exist. The only writes a closed trip ever receives are those in
R-6 step 5.

**R-9 — Undo after rollover.** Undo is scoped to the open trip. A user who ticked an item and then
closed the trip cannot un-tick it. Nothing is lost: the item is visible in trip history, and
re-adding it is one tap from the history screen. This is a deliberate boundary, not an omission.

**R-10 — Delete.** Delete is a soft delete (`deleted_at=now`). A pending item deleted before close is
**not** carried. Deleting is idempotent — deleting an already-deleted item returns success.

Where R-10 meets R-8 and R-14, **idempotency wins**: deleting an already-deleted item returns `200`
even if its trip has since closed or its store has been archived, where a *first* delete would return
`409`. The rules genuinely conflict and the code must not be left to pick silently. This precedence is
the right one because the alternative punishes a client for a retry it could not know was
unnecessary — the delete already happened, nothing is written, no `rev` is bumped and no event is
emitted, so answering `409` would report a failure for an operation whose effect is already in place.

**R-11 — Concurrent close.** Two simultaneous close requests for the same trip: `BEGIN IMMEDIATE`
serializes them, the second fails its status re-read at step 1, and returns `409 TRIP_ALREADY_CLOSED`.
Exactly one successor trip is ever created. Never two.

**R-12 — Add racing close.** An add committing before the close carries over per R-6. An add
committing after it lands on the successor trip per R-2. Both orderings are correct and neither
loses the item.

**R-13 — Ordering within a list.** Pending items sort by `sort_order ASC, created_at ASC, id ASC`.
The `id` tiebreak is mandatory: without a total order, two rows sharing a key render in whatever
order SQLite happens to return and the list visibly reshuffles between refetches. Ticked
items sort **below all pending items**, by `ticked_at DESC, id ASC` — most recently ticked at the top
of the ticked group, so undo is always reachable near the boundary. The `id` tiebreak is there for the
same reason as above: two items ticked in the same millisecond must not reshuffle between refetches. `carried` items never appear in an open
list.

**R-14 — Archiving a store.** Sets `archived_at`. The open trip is left open and untouched. An
archived store is hidden from the default store list and rejects writes with `409 STORE_ARCHIVED`.
"Writes" is exhaustively: `POST /stores/{id}/items`, `PATCH /items/{id}`, `DELETE /items/{id}`,
`tick`, `untick` and `POST /stores/{id}/trips/close`. **Reads are not rejected** — `GET
/stores/{id}/list` and the history endpoints work on an archived store, because the un-archive action
is reached from that store's own screen and rejecting the read would make R-14's "un-archiving
restores it intact" unreachable. `PATCH /stores/{id}` is likewise never rejected; it is the endpoint
that un-archives.
Un-archiving restores it intact. Stores are never hard-deleted; that would cascade away history.

**R-15 — `sort_order` allocation.** `sort_order` is assigned by the server and never by the client.

- A new item: `sort_order = COALESCE(MAX(sort_order), 0) + 1000` over **all** rows (deleted included)
  of the target trip, computed inside the same write transaction as the insert.
- A clone in R-6 step 5: **inherits** the original's `sort_order` verbatim. The successor trip is
  empty at that moment, so the inherited values are already distinct and carry-over preserves the
  list order the family last saw. Adds after the close continue from `MAX+1000` and therefore land
  below every carried item.
- A new store: `sort_order = COALESCE(MAX(sort_order), 0) + 1000` over all stores, archived included.
- `PATCH /api/stores/{storeId}` with `sortOrder` writes the client-supplied integer directly; the
  store list is small and hand-ordered. Items have no reorder endpoint in the MVP.

The 1000 gap is headroom for a future drag-to-reorder that inserts between two neighbours without
rewriting the whole list.

**R-16 — `stores.rev` is the revalidation cursor.** `rev` starts at 0 and is bumped by exactly one on
each committed write that changes what `GET /api/stores/{storeId}/list` would return. §3.0 is the
authoritative list. It is bumped **inside** the write transaction; the event announcing it is emitted
**after** commit. A client that has already fetched `rev >= event.rev` skips the refetch.

**R-17 — Idempotent add survives a rollover.** `POST /api/stores/{storeId}/items` resolves `clientId`
against the **store**, not the trip:
`WHERE store_id = ? AND client_id = ? AND state <> 'carried' AND deleted_at IS NULL`. A retry whose
original committed before a close therefore resolves to the **clone on the successor trip** and
returns `200` with it, rather than creating a second item. If the match is absent because the item was
deleted in the meantime, the retry creates a fresh item; that is a double fault (retry plus a delete
in the gap) whose worst outcome is one extra item, and it is preferred over resurrecting something the
user explicitly removed.

---

## 3. HTTP API

Auth levels: **public** (no session), **session** (any active user), **admin** (active user with
`is_admin=1`). Every non-public endpoint is checked server-side on every request. Rendering an admin
page is not an authorization check.

All mutating requests (`POST`, `PATCH`, `DELETE`) additionally require a valid `Origin` header
matching `ZEMBIL_ORIGIN`. A missing `Origin` on a mutation is **rejected**, never allowed through.

This check is implemented **in `hooks.server.ts`, for every mutating method and every content type**,
and it is the control. SvelteKit's built-in `kit.csrf.checkOrigin` is left enabled but must not be
relied on: it only inspects requests whose `Content-Type` is one of the three form types
(`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`). Zembil's API is
`application/json`, which that check ignores entirely — a same-site-lax cookie plus a JSON POST from
another origin would otherwise be uncovered. Both layers must exist; only ours is load-bearing.

### 3.0 Write effects — `rev` bumps and events

Normative. A write not listed here bumps nothing and emits nothing. Every listed effect happens
**after** the transaction commits, exactly once, even when the endpoint returned an idempotent no-op
response — see the last column. An endpoint that returns `200` because nothing actually changed
(R-4, R-5, R-10 idempotent repeats) must **not** bump `rev` and must **not** emit.

| Endpoint | Bumps | Emits | Notes |
|---|---|---|---|
| `POST /api/stores` | — | `stores.changed` | New store; there is no prior `rev` to bump. |
| `PATCH /api/stores/{id}` (name, color, sortOrder, archived) | `stores.rev` | `stores.changed` **and** `store.changed` | The header on the list screen shows the name and colour. |
| `POST /api/stores/{id}/items` (**new** row) | `stores.rev` | `store.changed` | |
| `POST /api/stores/{id}/items` (idempotent hit, R-17) | — | — | Nothing changed. |
| `PATCH /api/items/{id}` | `stores.rev` | `store.changed` | |
| `DELETE /api/items/{id}` (first delete) | `stores.rev` | `store.changed` | |
| `DELETE /api/items/{id}` (already deleted) | — | — | |
| `POST /api/items/{id}/tick` (state changed) | `stores.rev` | `store.changed` | |
| `POST /api/items/{id}/tick` (already ticked, R-4) | — | — | |
| `POST /api/items/{id}/untick` (state changed) | `stores.rev` | `store.changed` | |
| `POST /api/items/{id}/untick` (already pending, R-5) | — | — | |
| `POST /api/stores/{id}/trips/close` | `stores.rev` | `store.changed` **and** `stores.changed` | The home screen's counts and `openTripId` both change. |
| `POST /api/admin/users` | — | — | No shopping state changed. |
| `PATCH /api/admin/users/{id}` with `isActive:false` | — | `session.revoked` **to that user's streams only** | Then the streams are closed. |
| `POST /api/admin/users/{id}/reset-password` | — | `session.revoked` to that user's streams only | |
| `POST /api/auth/logout` | — | — | The client already knows. |

`store.changed` always carries the post-commit `stores.rev`. The two store-level events are separate
because they invalidate different screens: `stores.changed` invalidates the home list, `store.changed`
invalidates one store's item list. A close emits both.

Rows in this table are the acceptance criteria for the realtime tests. The frontend agent may assume
nothing beyond it.

### 3.1 Error envelope

Every non-2xx response carries an `error` object of exactly this shape:

```json
{ "error": { "code": "ITEM_NOT_FOUND", "message": "Item not found." } }
```

**Three** responses add a **named sibling field** next to `error`, and only these three: `409
VERSION_CONFLICT` adds `item: Item`, `409 TRIP_ALREADY_CLOSED` adds `openTripId: string`, and `409
STORE_NAME_TAKEN` adds `storeId: string`. Each exists so the client can recover without a second
round trip, and all three are typed in §7. No other
error response adds anything, and no error response ever nests recovery data *inside* `error`.

**The request body of any mutating endpoint must be a JSON object.** A body that parses as valid
JSON but is `null`, an array, a string or a number is `400 VALIDATION_FAILED` with the message
`Request body must be a JSON object.`; a body that does not parse at all is `400 VALIDATION_FAILED`
with `Request body must be JSON.`. An **empty** body is the one exception — it is read as `{}`, so
endpoints whose fields are all optional can be called with no body at all.

These two messages are pinned, not incidental. Without the object check, `null` reaches a field
access and becomes a `500`, and an array or string silently presents every field as `undefined` — at
which point the field validators produce a `400` for their own reasons and the body-shape rule looks
covered when nothing is enforcing it. Pinning the message is what makes a test able to tell the two
apart.

`message` is safe to show a user and never leaks internals. Diagnostic detail goes to the server log
only. Shared codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`ORIGIN_MISMATCH` (403), `VALIDATION_FAILED` (400), `RATE_LIMITED` (429), `CONFLICT` (409),
`PASSWORD_CHANGE_REQUIRED` (403), `INTERNAL` (500).

### 3.1a String input validation

Normative for every string field in every request body. Applied **before** any database write, so a
`CHECK` constraint is never the thing that rejects user input — a constraint violation surfacing to a
user is a `500`, and a `500` on a 250-character paste into the add sheet is a defect, not validation.

| Field | Endpoint | Rule |
|---|---|---|
| item `name` | `POST /items`, `PATCH /items/{id}` | trim; 1–200 chars after trimming |
| item `note` | same | trim; `null` or empty-after-trim is stored as `NULL`; max 500 |
| store `name` | `POST /stores`, `PATCH /stores/{id}` | trim; 1–60; **no control characters** (added by M6 — see §8.4a) |
| passkey `label` | `passkey/register/verify` | trim; 1–64 |
| `username` | `POST /admin/users` | trim; 1–32; `[a-z0-9._-]+` after lowercasing; `username_key` is the lowercased form |
| `displayName` | `POST`/`PATCH /admin/users` | trim; 1–60 |
| `password` / `newPassword` | login, password change | **not** trimmed — leading and trailing spaces are part of the secret; 12–256 |
| `clientId` | `POST /items` | must parse as a UUID; rejected otherwise |

### 3.1b Numeric input validation

`Number.isInteger` is **not** sufficient and must not be used to validate an integer that will be
written. It returns `true` for `1e300` and for `9007199254740993`, and both reach the database:

| Input | Outcome |
|---|---|
| `1e300` | STRICT rejects the bind — `cannot store REAL value in INTEGER column` — and the user gets a `500`, exactly the §3.1a failure mode |
| `9007199254740993` | **commits**, as `9007199254740992`. `node:sqlite` has BigInt off (§1.1a), so every later read of that row throws `RangeError [ERR_OUT_OF_RANGE]` |

The second is the dangerous one and it was reproduced end to end: one `PATCH /api/stores/{id}` body
from any authenticated family member poisons `stores.sort_order`, and from that moment `GET
/api/stores`, `POST /api/stores` and that store's `GET /list` are `500` for **everyone**, permanently,
with no way back through the API — only direct database surgery. A single request, one low-privilege
session, unrecoverable.

Therefore, for every numeric field in every request body:

| Field | Rule |
|---|---|
| `sortOrder` | `Number.isSafeInteger`, and within `[-2147483648, 2147483647]` |
| `version` | `Number.isSafeInteger`, `>= 1` |
| `before` (trip history cursor) | `Number.isSafeInteger`, `>= 1` |
| `limit` | integer 1–50 (§3.6) |

`Number.isSafeInteger` is the floor for anything that will be **written**; a range bound on top of it
is required wherever the contract says a client-supplied integer is stored directly, which today is
`sortOrder` alone (R-15). Anything failing is `400 VALIDATION_FAILED`. This rule exists because
"validate before the write" (§3.1a) is not enough on its own when the validator itself accepts values
the driver cannot round-trip.

### 3.1c Trimming

Trim means Unicode whitespace, and the trimmed value is what is stored. Anything failing a rule is
`400 VALIDATION_FAILED`. The DDL's length `CHECK`s are set at the same numbers and exist as the
backstop that catches a route that forgot to validate, in tests rather than in production.

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

**Registration options are pinned, never left to the library's defaults.**
`generateRegistrationOptions` is called with
`authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }`.
`@simplewebauthn/server` v13 defaults `residentKey` to `'preferred'`, under which an authenticator
is free to create a **non-discoverable** credential. The registration then succeeds, the account
screen shows the new passkey, and the usernameless login flow above — which sends an empty
`allowCredentials` — can never find it. The member has a passkey that verifiably exists and cannot
log them in. `'required'` makes the authenticator refuse at registration time instead, which is a
visible failure rather than a silent one. `userVerification` stays `'preferred'`: this deployment
has a password fallback and fewer than ten known users, and `'required'` locks out authenticators
with no UV capability for no gain here.

**`POST /api/auth/passkey/register/verify`**
Request `{ "challengeId": string, "response": RegistrationResponseJSON, "label": string }`.
`201` → `{ "passkey": Passkey }`. `label` is 1–64 characters.

**`GET /api/me`** → `{ "user": User, "passkeys": Passkey[] }`. `passkeys` is the caller's own,
ordered `created_at ASC`. Never another user's, at any privilege level.

**A successful assertion writes back.** In the same transaction that creates the session,
`passkey/login/verify` updates the credential's `counter` to the value the authenticator returned and
sets `last_used_at = now`. Without the counter write the clone check in the paragraph above compares
every future assertion against a permanently-zero stored value and can never fire, and
`Passkey.lastUsedAt` — which the account screen renders as "Used 2 minutes ago" — stays null forever.

**`must_change_password` is enforced server-side, not by the client.** While the flag is set, every
endpoint returns `403 PASSWORD_CHANGE_REQUIRED` **except** `GET /api/me`, `POST /api/auth/password`
and `POST /api/auth/logout`. The flag is cleared by a successful password change. It is surfaced on
`User.mustChangePassword` so a reload does not lose it — login's `mustChangePassword` field is a
convenience, not the only carrier. Without this the temporary password an admin hands out over a chat
app stays valid for the full 180-day absolute session TTL as soon as the member dismisses the prompt
once, which is the whole reason the flag exists.

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
Setting `isActive:false` sets `is_active=0, disabled_at=now` and **destroys every session and
terminates every open SSE stream for that user immediately**. Setting `isActive:true` sets
`is_active=1, disabled_at=NULL` **in the same statement** — the `CHECK ((is_active = 0) = (disabled_at
IS NOT NULL))` constraint means writing `is_active=1` alone aborts, so the admin screen's Enable
button would return `500`. Guards, each `409`:
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

`GET /api/stores?includeArchived=true` → `{ "stores": StoreSummary[] }`. The parameter defaults to
`false`, which is the home screen. `true` additionally returns archived stores, each with
`archivedAt` set, and is how un-archiving is reachable at all — R-14 promises it and there is no
other endpoint that yields an archived store's id. `409 STORE_NAME_TAKEN` also returns the colliding
store's id (`{ "error": {...}, "storeId": string }`) so a name clash against something archived leads
straight to the un-archive action rather than a dead end.

Response shape:

```ts
type StoreSummary = {
  id: string; name: string; color: StoreColor; sortOrder: number; rev: number;
  openTripId: string;
  pendingCount: number;      // drives "Nothing needed" vs a count in the design
  tickedCount: number;
  lastClosedTripAt: number | null;
  archivedAt: number | null;
}
```

`POST /api/stores` request `{ "name": string, "color"?: StoreColor }` (name 1–60 chars per §3.1a; `color`
defaults to the first palette key not already used by an active store, or — once all eight are in
use — to the key at index `(count of active stores) % 8`, so store nine gets a colour rather than a
`NOT NULL` violation and a `500`). `201 → { "store": StoreSummary }`.
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
`clientId` is a client-generated UUID (v4, lowercase, with dashes) and is **required**: a retry after
a timeout on flaky cellular must not create a duplicate. The lookup is **store-scoped and
rollover-safe** per R-17 — `store_id = ? AND client_id = ? AND state <> 'carried' AND deleted_at IS
NULL`. On a hit, return `200` with that item (which may live on a **later** trip than the caller
expected) instead of `201`. `201 → { "item": Item }`. The client generates one `clientId` per compose,
reuses it across every retry of that compose, and generates a fresh one only for a new item.
`409 STORE_ARCHIVED` if archived. `sort_order` is assigned per R-15.

**At most 2000 non-deleted items per trip.** Beyond that, `409 TRIP_ITEM_LIMIT`. A family shopping
list reaches a few dozen; the cap exists because `GET /stores/{id}/list` and `GET /trips/{id}` return
every item with no pagination, and one authenticated member — the stated threat model is that every
account holder is a person who could be careless or compromised — should not be able to make a
response unbounded, or the database unbounded, by looping an endpoint. It is high enough that no real
list will ever meet it and low enough that meeting it cannot hurt.

**Every item-mutating response carries `rev`.** `POST /items`, `PATCH /items/{id}`,
`DELETE /items/{id}`, `tick` and `untick` all return `{ "item": Item, "rev": number }` (delete returns
`{ "item": Item, "rev": number }` with the soft-deleted item), where `rev` is the store's `rev`
**after** the write — the same value the `store.changed` event will carry. Without it a phone's
`known.rev` is stale by exactly one after its own write, its own echoed event always satisfies
`event.rev > known.rev`, and every add and every tick costs a pointless second full list fetch. The
whole point of the §4 cursor is to suppress the self-echo, and it cannot without this field. On an
idempotent no-op (R-4, R-5, R-10, R-17) `rev` is the store's current unchanged value.

**`POST /api/items/{itemId}/tick`** and **`/untick`** — request body `{}`.
Idempotent per R-4 and R-5. `409 TRIP_CLOSED` if the item's trip is closed. `404 ITEM_NOT_FOUND`
if the item does not exist **or** is soft-deleted.

**`PATCH /api/items/{itemId}`** — request `{ "name"?: string, "note"?: string | null, "version": number }`.
`409 VERSION_CONFLICT` if `version` does not match, with the current item in the response so the
client can reconcile: `{ "error": {...}, "item": Item }`. Tick and untick deliberately do **not**
take a version — a concurrent tick is not a conflict, it is agreement.

**`POST /api/stores/{storeId}/trips/close`** — request `{ "tripId": string }`.
`200` → `{ "closedTrip": Trip, "newTrip": Trip, "boughtCount": number, "carriedCount": number }`.
`409 TRIP_ALREADY_CLOSED` → `{ "error": {...}, "openTripId": string }`. `409 TRIP_EMPTY` per R-6.2.
A **missing or non-string** `tripId` is `400 VALIDATION_FAILED`, not a `409`. The `409` means "your
view of the world is stale and here is the current trip"; a malformed body means the client is
broken, and answering it with a recoverable-looking `409` hides that bug behind a retry loop that
appears to work.

### 3.6 Trip history

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/stores/{storeId}/trips` | session | Closed trips, newest first |
| GET | `/api/trips/{tripId}` | session | One trip with its items |

`GET /api/trips/{tripId}` → `{ "trip": TripSummary, "items": Item[] }`. Items are ordered
**bought first, then left behind** —
`CASE state WHEN 'ticked' THEN 0 WHEN 'carried' THEN 1 ELSE 2 END, sort_order ASC, id ASC` — and
**include `carried` items**. Note the explicit `CASE`: a plain `state ASC` sorts alphabetically, which
puts `carried` above `ticked` and renders the history screen with what you failed to buy at the top
and what you actually bought below it. That is backwards. Carried items are included because the
history screen's "left on the list" count is meaningless without them, and R-13's exclusion of `carried` applies to the open
list only. Soft-deleted items are excluded per I-8. Works for open and closed trips alike.

`GET /api/stores/{storeId}/trips?limit=20&before={seq}` →
`{ "trips": TripSummary[], "nextBefore": number | null }` where `TripSummary` adds `boughtCount` and
`carriedCount` to `Trip`. `limit` is 1–50, default 20.

### 3.7 Rate limiting

In-process token buckets, keyed independently and both checked:

| Bucket | Key | Limit |
|---|---|---|
| Password login | `username_key` | 10 per 15 min |
| Password login | client IP | 300 per 15 min |
| Passkey assertion | client IP | 300 per 15 min |
| Passkey **options** (`login/options` + `register/options`) | client IP | 300 per 15 min |
| Admin user creation | actor `user_id` | 20 per hour |

The per-IP limits are deliberately loose. **The whole family shares one home WAN IP**, and behind the
reverse proxy every request may present that single address; a tight per-IP bucket would let one
member's fat-fingered morning lock out everyone else — reintroducing by the back door exactly the
denial-of-service that "no account lockout" exists to prevent. Per-IP is a coarse brake on a bot
hammering the endpoint, nothing more. **The per-`username_key` bucket is the real credential-stuffing
control**, and it is the one to tighten if abuse ever appears.

Exceeding a bucket returns `429 RATE_LIMITED` with a `Retry-After` header. There is deliberately **no
account lockout**: a lockout on a family app is a denial-of-service any anonymous visitor can inflict
on a family member. Buckets are in-memory and reset on restart, which is acceptable because the
restart requires host access.

`passkey/login/options` is public and **writes a `webauthn_challenges` row**, so without its own
bucket an internet scanner can POST `{}` in a loop and grow the database until `/data` is full and
every write in the app fails. The bucket is the brake; the reaper below is the cleanup.

**Expiry reaping.** Two tables accumulate rows that nothing else deletes. A single timer started at
boot runs every 10 minutes and deletes `webauthn_challenges` past `expires_at` and `sessions` past
either `idle_expires_at` or `absolute_expires_at`; both `options` endpoints also reap expired
challenges opportunistically before inserting. An expired row is never accepted by a verify call
regardless of whether the reaper has run yet — expiry is checked on read, and the reaper exists to
bound disk, not to enforce security.

**Client IP is derived only from the `ZEMBIL_TRUST_PROXY` setting.** Let `N = ZEMBIL_TRUST_PROXY` and
let `parts` be `X-Forwarded-For` split on commas and trimmed. The client IP is
`parts[parts.length - N]` — for `N = 1` that is the **last** entry, the address the single trusted
proxy actually observed the connection from. Worked example, which is normative:

| `X-Forwarded-For` | `ZEMBIL_TRUST_PROXY` | Client IP |
|---|---|---|
| `1.2.3.4, 203.0.113.9` | `1` | `203.0.113.9` |
| `1.2.3.4, 203.0.113.9` | `0` | the socket peer address — the header is ignored entirely |
| `203.0.113.9` | `2` | the socket peer address — fewer entries than trusted hops |
| absent | `1` | the socket peer address |

Everything to the left of the trusted hops is client-supplied and must never be read. An off-by-one
here — `parts[parts.length - 1 - N]` is the natural-looking transcription and is **wrong** — hands
every visitor control of their own rate-limit identity, which is the defect D-007 exists to avoid.
Falling back to `undefined` or to `parts[0]` when the header is short or missing is equally a defect;
the fallback is always the socket address.

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

**Wire format — normative.** Every event is an **unnamed** (default `message`) event whose `data` is
the JSON object above on a **single line**, so the client uses `es.onmessage` and never
`addEventListener('store.changed', …)`. No `event:` field is sent. No `id:` field is sent, so the
browser never replays `Last-Event-ID`; recovery is by refetch, which is the whole point of hints.
One blank line terminates each event. On the wire:

```
data: {"v":1,"type":"store.changed","storeId":"0f1c…","rev":42}

: ping

data: {"v":1,"type":"stores.changed"}

```

The client dispatches on the parsed `type`. An event with an unrecognised `type`, or with `v !== 1`,
is **ignored silently** — that is the forward-compatibility hinge, and a client that throws on an
unknown type cannot be upgraded without a flag day. On connect the server sends nothing; the client
does a full fetch on mount regardless.

- A `:ping` comment every 25 seconds keeps intermediaries from timing the connection out.
- The client tracks the last `rev` it fetched per store and skips a refetch when
  `event.rev <= known.rev`.
- Events are emitted **after** the write transaction commits, never inside it. Emitting inside means
  a client can refetch and read pre-commit state.
- The stream is torn down immediately when the session is destroyed or the account is disabled. A
  live SSE connection must never outlive its session.
- **The client revalidates on the `EventSource` `open` event**, not only on mount. `EventSource`
  reconnects by itself, and a reverse proxy that drops an idle stream at 60 seconds produces a
  reconnect with no `mount`, no `visibilitychange`, no `focus` and no `online` — the network never
  went down. A tablet left face-up on the kitchen counter would otherwise miss every change made
  during the gap, indefinitely. Revalidating on `open` covers reconnects by construction, and it also
  covers the first connect, so no separate mount-fetch rule is needed.
- Belt and braces: the client also revalidates on `visibilitychange`, `focus`, and `online`. A phone
  that was in a pocket for an hour resolves on unlock even if the stream silently died.
- **At most 4 concurrent streams per session**, oldest closed first when a fifth opens. One process,
  one event loop: without a cap, a single authenticated account — and every account here is a family
  member's, which is exactly the stated threat model for an app on the public internet — can open
  connections until the process runs out of file descriptors and the app stops serving everyone.

---

### 4.1 The in-process bus — module surface

`src/lib/server/realtime/bus.ts` is owned by **zembil-data** and **imported** by zembil-auth. The
export surface below is part of the frozen contract for exactly the same reason the wire format is:
pinning the bytes on the wire is worthless if the two agents disagree about the function that puts
them there, and these two agents never see each other's files.

```ts
/** Fan out to every stream. Call AFTER the write transaction commits. */
export function emitStoreChanged(storeId: string, rev: number): void;
export function emitStoresChanged(): void;

/** Auth-owned flows call these. Each sends `session.revoked` to the matching
 *  streams and then closes them. Both are no-ops when nothing matches. */
export function revokeSession(sessionId: string): void;
export function revokeUserStreams(userId: string): void;

/** Registration, called by the GET /api/events route only. Returns an
 *  unsubscribe function the route calls on client disconnect.
 *
 *  `close` is how the bus tears a stream down from its own side — required by
 *  the per-session stream cap in §4 (closing the oldest when a fifth opens) and
 *  by revokeSession/revokeUserStreams. `send` alone cannot end a stream. It is
 *  optional so that a three-argument call still compiles; the events route is
 *  the only caller and it always passes four.
 *
 *  Implementation note: write it as `close: () => void = () => {}`, a DEFAULTED
 *  parameter, not `close?: () => void`. Both are `close?: () => void` at every
 *  call site and in the emitted .d.ts, but an optional parameter still counts
 *  toward Function.length while a defaulted one does not — and a test pins
 *  `subscribe.length === 3` as the guarantee that zembil-auth's three-argument
 *  call keeps working. Do not "simplify" this back to `close?:`. */
export function subscribe(
  userId: string,
  sessionId: string,
  send: (event: ZembilEvent) => void,
  close?: () => void
): () => void;
```

`revokeSession` is called on logout and on password change (which destroys the user's other
sessions); `revokeUserStreams` is called when an admin disables an account or resets its password.
Without these two, "disabling an account means *now*" — the entire reason D-004 chose server-side
sessions over JWTs — is silently unimplemented, and a disabled member keeps a live stream.

---

## 5. Session and cookie contract

| Property | Value |
|---|---|
| Name | `__Host-zembil_session` over HTTPS, `zembil_session` when `ZEMBIL_ORIGIN` is `http://` (dev only) |
| Value | 32 random bytes from `crypto.randomBytes`, base64url — **the raw token, stored only here** |
| `HttpOnly` | yes |
| `Secure` | yes — **written literally**, never left implicit. `__Host-` *requires* the attribute; a browser silently rejects a `__Host-` cookie without it and login fails with no error anywhere |
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

### Security headers

**CSP is produced by `kit.csp` in `svelte.config.js`, and by nothing else.** `hooks.server.ts` sets
the other four headers and **must not set `Content-Security-Policy`**. SvelteKit emits an inline
hydration script and injects its own `'sha256-…'` into the CSP it generates; a static header set in
hooks either replaces that one and loses the hash, or is sent as a second header — and a browser
enforces the *intersection* of multiple CSP headers, which loses the hash too. Either way
`script-src 'self'` blocks SvelteKit's own hydration payload, so the app renders, never hydrates, and
does it **in the production build only**. This is the single easiest way to ship a broken app that
passes every dev-mode check.

`svelte.config.js` declares:

```js
csp: {
  mode: 'hash',
  directives: {
    'default-src': ['self'], 'script-src': ['self'], 'style-src': ['self', 'unsafe-inline'],
    'img-src': ['self', 'data:'], 'font-src': ['self'], 'connect-src': ['self'],
    'base-uri': ['none'], 'form-action': ['self'], 'frame-ancestors': ['none'],
    'object-src': ['none']
  }
}
```

`style-src` carries `'unsafe-inline'` and `script-src` does not. That asymmetry is deliberate: a
single `style="width: 40%"` anywhere in the frontend — and a progress bar or a swipe transform will
produce one — is blocked by a strict `style-src`, while the injection risk from inline *styles* on a
same-origin app with no user-supplied HTML is negligible next to the risk from inline scripts. If
`style-src-attr 'unsafe-inline'` alone proves sufficient once the UI exists, narrow it then;
`script-src` stays strict either way and `'unsafe-inline'` must never appear there.

Set in `hooks.server.ts` for every response:

```
Referrer-Policy: same-origin
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(),
  publickey-credentials-get=(self), publickey-credentials-create=(self)
```

And for every response to an **authenticated** request, HTML and JSON alike:

```
Cache-Control: no-store
```

Not only the SSE stream. The app ships a service worker, and a shopping list carrying family members'
names must never be written to a shared or intermediary cache. The service worker's own rule — cache
the app shell, never an `/api/` response — is stated in `PLAN.md`, but the header is the part that
does not depend on any agent remembering.
`Permissions-Policy` must explicitly allow the two `publickey-credentials-*` features or passkeys
break. HSTS is set by the reverse proxy and documented in the README, not by the app.

---

### 3.8 Health, bootstrap and shutdown — the deployment seam

These three are normative because `zembil-auth` implements them and `zembil-deploy` depends on them.

**`GET /api/health`** — the ONLY unauthenticated endpoint in the application, and the only one exempt
from the `Origin` check. `200` → `{ "status": "ok" }` when a trivial query (`SELECT 1`) answers;
`503` → `{ "status": "unavailable" }` when it does not. `Cache-Control: no-store`.

It returns those two words and nothing else — no version, no uptime, no migration number, no user
count, no error text. This endpoint is reachable from the public internet by anyone who finds the
hostname, and a health endpoint that reports the build is a free fingerprint for picking a matching
CVE. Diagnostic detail goes to the log, where an operator can already read it.

The `503` is what makes it worth having: the container must report unhealthy when the database is
gone, or Docker restarts nothing while every real request 500s.

**Bootstrap runs in-process**, in `src/hooks.server.ts`, immediately after migrations and before the
server listens — not from the entrypoint, and not from a separate container. The brief requires the
app to come up with a single `docker compose up`, so first-admin creation cannot be a step an
operator has to know to run. It is idempotent per §6: it acts only when `SELECT COUNT(*) FROM users`
returns zero.

When `ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD` is unset, the generated password is logged **once**, at
`warn`, as the only copy that will ever exist — with `must_change_password` set on the account, so it
is a handoff credential and not a standing one. `scripts/bootstrap-admin.*` exists for the separate
case of an operator who has locked themselves out; it is never part of normal startup.

**Graceful shutdown.** On `SIGTERM` the process stops accepting connections, closes every open SSE
stream (clients reconnect and revalidate on `open`, per §4), runs `PRAGMA wal_checkpoint(TRUNCATE)`,
closes the database, and exits 0. A container killed mid-checkpoint leaves a `-wal` file that is
recoverable but makes a file-copy backup inconsistent, which is precisely when an operator discovers
their backups were never any good.

---

## 6. Environment variables

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ZEMBIL_ORIGIN` | URL | **yes** | — | e.g. `https://zembil.example.com`. Drives CSRF origin checks and WebAuthn `expectedOrigin`. Startup fails if unset or unparseable. |
| `ZEMBIL_RP_ID` | hostname | no | **full hostname** of `ZEMBIL_ORIGIN` | WebAuthn relying-party ID. See the note below — this is the **full hostname**, not the registrable domain. |
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

**`ZEMBIL_RP_ID` must be the full hostname** (`zembil.example.com`), never the registrable domain
(`example.com`). An rpID is a scope, and a credential scoped to `example.com` may be requested by
**any** page under `*.example.com`. On a home server that also hosts other services on sibling
subdomains, the registrable-domain form hands every one of them the ability to log in as a family
member. It is also a one-way door: changing rpID later invalidates every existing passkey, because
the authenticator keys them by rpID. Startup asserts that `ZEMBIL_RP_ID` is either exactly the
hostname of `ZEMBIL_ORIGIN` or a suffix of it, and **warns loudly** if it is a proper suffix.

**`PROTOCOL_HEADER` and `HOST_HEADER` must not be set.** These are `@sveltejs/adapter-node`
variables that make it derive `event.url` from `X-Forwarded-Proto` / `X-Forwarded-Host`. Zembil never
needs them: the origin check compares against `ZEMBIL_ORIGIN`, a constant, and WebAuthn's
`expectedOrigin` and `expectedRPID` come from that same constant. Setting them would let a client
that reaches the app directly control what the app believes its own origin is. The compose file must
not define them and the README must say so.

There is **no application secret key**. Sessions are opaque random tokens stored hashed, so nothing
needs signing — one less secret to provision, rotate, or leak.

**Migrations run at module load of `src/hooks.server.ts`**, which `zembil-auth` owns and which
SvelteKit imports once at process start, before the server listens. It calls `getDb()` eagerly and
lets any failure throw. This is deliberate: a migration that fails must **crash the process**, not be
discovered lazily by whichever request happens to arrive first and turned into a `500` while the
container reports itself healthy. Nothing else may open the database before this point.

**Bootstrap is idempotent**: it runs only when `SELECT COUNT(*) FROM users` is zero. A restart with
the env vars still set never resets an existing admin's password.

---

## 7. Shared types

These cross the client/server boundary. `src/lib/types.ts` is the single definition; the frontend
imports from there and does not redeclare them.

```ts
/**
 * Set by hooks.server.ts (zembil-auth) and read by every route (zembil-data).
 * This is the actor seam referenced throughout §2 and §3. It is normative:
 * `locals.user`, nullable, and `locals.sessionId`, the session row id and never
 * the raw token. Declared in src/app.d.ts, which zembil-auth owns.
 */
declare namespace App {
  interface Locals {
    user: User | null;
    sessionId: string | null;
  }
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
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
  archivedAt: number | null;   // always accurate. The ?includeArchived=true listing is the only
                               // place a non-null value appears in the store LIST; an embedded
                               // summary (e.g. GET /stores/{id}/list) always reports the truth.
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

/** The only two error responses with a named sibling field — see §3.1. */
export interface VersionConflictError extends ApiError { item: Item; }
export interface TripAlreadyClosedError extends ApiError { openTripId: string; }
export interface StoreNameTakenError extends ApiError { storeId: string; }

/** Every item-mutating endpoint returns this — see §3.5. `rev` is the store's
 *  rev AFTER the write, and is what lets a client suppress its own echo. */
export interface ItemMutation { item: Item; rev: number; }
```

A note on `version`: `tick` and `untick` bump `items.version` (R-3, R-5) while `PATCH /api/items/{id}`
requires a matching `version`. A client that optimistically ticked and then opened the edit sheet from
its pre-tick state would send a stale `version` and get a spurious `409 VERSION_CONFLICT`. The tick
and untick responses carry the updated `Item`, so the client must adopt that `version` rather than
keeping the one it rendered with. This is the intended cost of optimistic tick, not a bug to design
around.

Note on identifiers: item and trip responses carry **display names**, not user ids. There is no
endpoint that maps an id to a user for a non-admin, so no id is exposed that a member could use to
probe the account list.

---

## 8. Addendum 2 — claims, visibility, locale and push (migration 002)

Status: **frozen at the start of this milestone (M6).** §1–§7 above are unchanged and still normative;
this section is additive and is normative for everything it names. Where a shape in §7 gained a field,
the authoritative TypeScript is `src/lib/types.ts`, and the field is listed here.

Same rule as the header: if something here is wrong, ambiguous or missing, **stop and report it**.

### 8.1 Migration 002 — the DDL delta

Complete file: `src/lib/server/db/migrations/002_claims_visibility_locale_push.sql`. Every statement is
additive; no existing column, index or constraint is altered or dropped.

| Change | Shape |
|---|---|
| `users.locale` | `TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','tr','de'))` |
| `stores.private_to` | `TEXT REFERENCES users(id)` — **NULL means public**. `ON DELETE` is absent (NO ACTION) on purpose. |
| *(migration 003)* `stores.name_key` | Re-keyed for existing private stores: `private_to \|\| char(31) \|\| name_key`. See §8.4a. |
| `trips.claimed_by` | `TEXT REFERENCES users(id) ON DELETE SET NULL` |
| `trips.claimed_at` | `INTEGER` |
| `trips.claim_note` | `TEXT CHECK (claim_note IS NULL OR (length(trim(claim_note)) > 0 AND length(claim_note) <= 140))` |
| `push_subscriptions` | new table, see the DDL. `endpoint` is `UNIQUE` **table-wide**, not per user. |
| `server_keys` | new table, `name` constrained to `('vapid')`. |

Measured on this build before the migration was written: `ALTER TABLE … ADD COLUMN` accepts a
column-level `CHECK` and a `REFERENCES` clause whose default is `NULL`, and both are enforced
afterwards (`err.errcode & 0xff === 19`). What it **cannot** add is a **table-level** `CHECK`. That is
why I-16 below is test-bound rather than schema-bound; it is a limitation of `ALTER TABLE`, not a
choice.

### 8.2 Invariants I-14 … I-18

Following §1.2's convention, each says who enforces it.

- **I-14 (schema).** `users.locale` is one of `en`, `tr`, `de`. Enforced by `CHECK`.
- **I-15 (schema).** `stores.private_to` is either `NULL` or an existing `users.id`. Enforced by the
  foreign key. A user row that a private store points at cannot be deleted.
- **I-16 (test).** A trip is claimed **iff** `claimed_by IS NOT NULL`. `claimed_at` is non-NULL whenever
  `claimed_by` is, and all three claim columns are written by one `UPDATE` and cleared by one `UPDATE`.
  Test-bound because `ALTER TABLE` cannot add a table-level `CHECK` (8.1). **Readers must treat
  `claimed_by IS NULL` as unclaimed regardless of the other two columns** — that is what keeps a
  vestigial `claimed_at` left behind by `ON DELETE SET NULL` from resurrecting a claim owned by nobody.
- **I-17 (schema).** At most one `push_subscriptions` row per `endpoint`, across all users. Enforced by
  `UNIQUE`. Re-registering an endpoint that belongs to another user **moves** it (§8.7).
- **I-18 (test).** Every store-scoped read and write is filtered by visibility (§8.4) before anything
  else happens. No endpoint discloses a private store's **id, name, colour or contents** to a member
  who does not own it, and the 404 it produces is byte-identical to the 404 for a store that never
  existed.

  **Corrected after the M6 audit, which found this invariant asserted more than the system delivers.**
  The original wording — "not a name collision" — was false: `stores.name_key` was UNIQUE table-wide,
  so typing a private store's name returned `409 STORE_NAME_TAKEN` and revealed the name. That is now
  fixed in the code rather than excused in the text (migration 003, §8.4a), and the invariant is true
  as it stands. Two carve-outs remain, and they are stated rather than hidden:

  1. **The SSE stream reveals that *some* store changed, and when.** Hints are broadcast to every
     stream (§8.4, "Realtime"), so a member receives `store.changed` for a store they cannot see, and
     may infer that one exists and is being edited. The id in the hint is a v4 UUID that is useless to
     them — every endpoint answers 404 — and per-user filtering would mean the stream carrying data,
     which D-011 rejects for stronger reasons. **Existence and edit timing are observable; id, name,
     colour and contents are not.**
  2. **A `tripId` from another store is `409`, not `404`** — mandated verbatim by R-6 step 1 of the
     frozen §2, and reachable only by guessing a v4 UUID. §8.4's table is otherwise absolute; this is
     the one documented exception to it.

  An invariant nobody enforces is a comment (§1.2). An invariant that overstates what is enforced is
  worse, because it is trusted.

### 8.3 Rollover rules R-18 … R-22

- **R-18 — a claim belongs to a trip, and dies with it.** `POST /api/stores/{id}/claim` writes
  `claimed_by`, `claimed_at` and `claim_note` on the store's **open** trip. R-6 opens a fresh trip on
  close and a fresh trip's claim columns are `NULL`, so a claim expires exactly when the shopping run
  ends. Nothing clears a claim on a timer, and closing a trip does not "release" anything — the claim
  stays on the closed trip as history, which is how `GET /api/trips/{id}` can say who did the shopping.
- **R-19 — claiming is not exclusive by accident.** Claiming a trip that is already claimed by someone
  else is `409 TRIP_CLAIMED`, unless the request carries `takeover: true`, which overwrites the claim.
  The same member re-claiming their own trip is **not** a conflict: it updates the note. A claim taken
  over is not recorded anywhere; the previous holder simply stops being the holder.
- **R-20 — releasing is the holder's, and only the holder's.** `DELETE /api/stores/{id}/claim` clears
  the three columns. Only the current holder may call it; anyone else gets `403 FORBIDDEN`. Releasing
  an unclaimed trip is an idempotent success that bumps nothing and emits nothing.
- **R-21 — added items notify once the list goes quiet.** An add arms a per-store batch. Any further
  write to that store (add, tick, untick, edit, delete, claim, release, close) pushes the batch's
  deadline out by `ZEMBIL_NOTIFY_QUIET_MINUTES`, clamped so the deadline is never later than
  `armedAt + ZEMBIL_NOTIFY_MAX_DELAY_MINUTES`. When the deadline passes, **one** notification is sent
  describing everything added during the window. Only adds arm a batch; a write to a store with no
  armed batch notifies nothing. Module surface: §8.8.
- **R-22 — a private store is invisible, not merely read-protected.** Setting `stores.private_to`
  removes the store from every other member's world in one step: it disappears from `GET /api/stores`,
  its list and trips return `404 STORE_NOT_FOUND`, and its items return `404 ITEM_NOT_FOUND`. Items
  already on it stay on it. Making it public again restores it, unchanged, to everyone.

  **A private store reserves nothing in anybody else's namespace.** Its name is not taken from them,
  and its colour is not taken from their palette (§8.4a). Making a store private, or public again, can
  therefore fail with `409 STORE_NAME_TAKEN` if the name is already in use in the namespace it is
  moving *into* — the transition is refused whole and the row is left exactly as it was.

  **Superseded clause, recorded rather than deleted.** R-22 originally said a collision against an
  invisible store was `409 STORE_NAME_TAKEN` *without* the `storeId` sibling field. The M6 audit
  pointed out that this still discloses the private store's **name**, which is a worse leak than the
  id being withheld, and that it contradicted I-18 outright. §8.4a fixes the cause; the clause is now
  unreachable because an invisible collision cannot occur.

### 8.4 Visibility — the authorization rule, stated once

> A store is **visible** to a member when `stores.private_to IS NULL` **or** `stores.private_to = <the
> session's user id>`. Nothing else grants visibility. **Being an admin does not.**

Every store-scoped endpoint resolves visibility from `locals.user.id` and nothing else, **before** any
other check, and an invisible store is reported exactly as a non-existent one:

| Endpoint | On an invisible store |
|---|---|
| `GET /api/stores` | The row is absent from the array. |
| `PATCH /api/stores/{id}` | `404 STORE_NOT_FOUND` |
| `GET /api/stores/{id}/list` | `404 STORE_NOT_FOUND` |
| `POST /api/stores/{id}/items` | `404 STORE_NOT_FOUND` |
| `POST /api/stores/{id}/trips/close` | `404 STORE_NOT_FOUND` |
| `GET /api/stores/{id}/trips` | `404 STORE_NOT_FOUND` |
| `POST|DELETE /api/stores/{id}/claim` | `404 STORE_NOT_FOUND` |
| `PATCH|DELETE /api/items/{id}`, `tick`, `untick` | `404 ITEM_NOT_FOUND` |
| `GET /api/trips/{id}` | `404 TRIP_NOT_FOUND` |

`404`, never `403`: a `403` on a private store tells the caller a store with that id exists and belongs
to somebody, which is the one fact the feature is for hiding. The `404` an invisible store produces is
byte-identical to the `404` a fabricated id produces.

**Realtime (§4) obeys the same rule.** `store.changed` and `stores.changed` are broadcast to every
stream, and this stays correct only because they are hints and carry no data (D-011): a member who
receives a hint for a store they cannot see refetches and is told `404`, or simply does not find the
store in `GET /api/stores`. A `storeId` in a hint is not a disclosure of anything a member could not
have guessed. **Do not "optimise" this into per-user filtering that carries store names.**

### 8.4a Name and colour namespaces (migration 003)

Uniqueness has to have the **same scope as visibility**, or the `UNIQUE` constraint becomes an oracle.

`stores.name_key` is therefore namespaced by the owner for a private store:

| Visibility | `name_key` |
|---|---|
| public | `<normalized name>` |
| private to `U` | `U` + `U+001F` + `<normalized name>` |

so public names stay unique among public stores, each member's private names stay unique to that
member, and the two spaces never meet. `name_key` remains `UNIQUE` table-wide — a partial index would
need the column constraint dropped, which needs a table rebuild, which needs `PRAGMA foreign_keys=OFF`,
which is a **no-op inside a transaction**; the migration runner is transactional by design, so the
rebuild would run with foreign keys on and `DROP TABLE stores` would cascade every trip and item away.
Namespacing needs no rebuild.

**`storeName` therefore rejects control characters** (an addition to §3.1a's row for store `name`):
`U+001F` is the delimiter, and a name carrying one could be crafted to land in another member's key
space. `400 VALIDATION_FAILED`.

`name` and `visibility` are resolved **together** in `PATCH /api/stores/{id}`: changing either changes
the key, and the collision check runs on the key the row is about to hold.

**The default colour is scoped the same way.** `POST /api/stores` picks the first palette key not in
use by an active store **visible to the caller**. Unscoped, it is an existence oracle — create a store
with no colour and the key you are handed says which keys stores you cannot see are using, and past the
eighth it leaks their count. Two members' palettes drifting apart is the correct behaviour for a
feature whose purpose is that they see different worlds.

**There is no admin escape hatch, by design and with a cost.** If a member makes a shared store private
and then stops using the app, no API call any other member or admin can make will bring it back;
recovery is `UPDATE stores SET private_to = NULL WHERE id = …` against the database. This is documented
in `README.md` and is the deliberate price of "only visible to that specific user" meaning it.

### 8.5 Locale — §3.2 delta

| Method | Path | Auth | Purpose |
|---|---|---|---|
| PATCH | `/api/me` | session | Set the caller's own interface language |

`PATCH /api/me` request `{ "locale": "en" | "tr" | "de" }` → `200 { "user": User }`. An unknown value is
`400 VALIDATION_FAILED`. It sets the **caller's own** locale and reads the target id from the session;
there is no path or body parameter naming a user, at any privilege level.

`GET /api/me` and every other `User` in a response now carry `locale`. §3.0: this write bumps nothing
and emits nothing — no shopping state changed, and the only client that cares is the one that made it.

The gate in §3.2 is unchanged: `PATCH /api/me` is on the same route id as `GET /api/me` and therefore
inherits its `PASSWORD_GATE_EXEMPT` entry.

`users.locale` is the **server's** copy and the one that matters: push notification text (§8.7) is
composed on the server for a recipient who is not the person who triggered it, so it cannot be
translated by the client that displays it. The client renders from the same catalogues.

**The locale is delivered by the root `load`, and the document is labelled with it.** `app.html`
carries `lang="%zembil.lang%"`, substituted per request in `hooks.server.ts` via `transformPageChunk`,
so the SSR'd document is already in the right language on the first paint — the theme-flash bug
recorded in PROJECT.md §13 has exactly this shape and a flash of the wrong *language* is worse. A
language change made inside the app is a client-side navigation, which re-renders the body but not
`<html>`, so the root layout also sets `document.documentElement.lang` in an effect. Both halves are
required; either alone leaves the attribute disagreeing with the text under it.

**Locale never comes from a header at request time.** `Accept-Language` is consulted exactly once, when
a member's account is created, to pick the initial value; after that the column is the only source. A
per-request header would make the same account render differently on two devices and would make the
push text depend on whichever device last made a request.

### 8.6 Claims — §3.4 delta

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/stores/{storeId}/claim` | session | "I'm going to this shop" |
| DELETE | `/api/stores/{storeId}/claim` | session | Release it |

`POST` request `{ "tripId": string, "note"?: string | null, "takeover"?: boolean }`.

- `tripId` is **required** and is the same staleness guard as `trips/close` (§3.5): a missing or
  non-string `tripId` is `400 VALIDATION_FAILED`; a well-formed `tripId` that is not the store's open
  trip is `409 TRIP_ALREADY_CLOSED` with the `openTripId` sibling field. A `tripId` that never existed
  is `404 TRIP_NOT_FOUND`.
- `note` is optional free text, **1–140 characters** after §3.1c trimming, `null` or empty-after-trim
  clears it. It is plain text and is rendered as plain text; it is never HTML and never a link.
- **Editing your own note preserves `claimed_at`.** "Ayşe has been shopping since 18:04" is the fact
  worth keeping, and rewriting the timestamp on a note edit silently moves it. A fresh claim and a
  takeover both start the clock; only the holder editing their own note does not. All three columns
  are still written by one `UPDATE` (I-16).
- `takeover` defaults to `false`. Claiming a trip held by **someone else** without it is
  `409 TRIP_CLAIMED`, whose `message` names the current holder (a display name, never an id) so the
  client can offer "take over anyway" without a second round trip. With `takeover: true` the claim is
  overwritten. Re-claiming a trip **you already hold** is never a conflict — it updates the note.
- `200 → { "store": StoreSummary, "trip": Trip }`.

**A note on both claim endpoints and `PATCH /api/stores/{id}`:** the `{ store, trip }` they return is
read **after** the transaction commits, so if another member privatises the store in that window the
caller receives `404 STORE_NOT_FOUND` for a write that actually landed. On a single-process,
synchronous-SQLite deployment the window is one event-loop turn and the client refetches anyway. It is
recorded because the failure reads backwards: "you were told it did not happen, and it did".

`DELETE` takes no body. Only the current holder may release: anyone else gets `403 FORBIDDEN`.
Releasing an already-unclaimed trip is `200` and, per §3.0, bumps nothing and emits nothing.
`200 → { "store": StoreSummary, "trip": Trip }`.

`StoreSummary` and `Trip` both gain the four `Claim` fields:

```ts
type Claim = {
  claimedByName: string | null;   // display name, never a user id
  claimedByMe: boolean;           // computed per request from the session
  claimedAt: number | null;
  claimNote: string | null;
}
```

`claimedByMe` exists because §3's "responses carry display names, never user ids" leaves the client no
safe way to decide whether the release button is its to press — two members can share a display name.

`StoreSummary` also gains `visibility: 'public' | 'private'`.

`PATCH /api/stores/{storeId}` gains one field: `{ "visibility"?: "public" | "private" }`. Setting
`private` sets `private_to` to the **caller's** id; setting `public` sets it to `NULL`. A store that is
already private may only be patched at all by its owner (§8.4 makes it a `404` for everyone else), so
the "who may republish it" question answers itself. Any member may privatise any store they can see.

### 8.7 Web push — §3.9

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/push/key` | session | The VAPID public key, base64url |
| GET | `/api/push/subscription` | session | Is this browser registered? |
| POST | `/api/push/subscription` | session | Register this browser |
| DELETE | `/api/push/subscription` | session | Unregister this browser |

- `GET /api/push/key` → `{ "publicKey": string }`. The keypair is **generated on first use** and stored
  in `server_keys`, so there is still nothing for an operator to provision (D-038). When
  `ZEMBIL_PUSH_ENABLED` is off this is `503 PUSH_DISABLED`.
- **At most 12 subscriptions per member.** Beyond that, `409 PUSH_DEVICE_LIMIT`. `endpoint` is a
  client-supplied URL and is the row's identity, so without a cap one authenticated member can create
  unbounded rows on the `/data` volume — and `deliverBatch` then makes one serial outbound HTTPS
  request per row, to hosts that member chose, on every batch. This is `MAX_ITEMS_PER_TRIP`'s reasoning
  verbatim (§3.5) and was missing until the M6 audit found it. The cap is checked on the **create**
  path only, so a repeat registration of an endpoint already held still succeeds at the limit, exactly
  as R-17's idempotent add does.
- **`POST` is rate limited** per actor (§3.7): 30 per hour, bucket `pushSubscribeByActor`. A real
  browser registers once per install. A `429` carries `Retry-After`, so this route uses `handleAuth`
  rather than `handle`.
- `POST /api/push/subscription` request `{ "endpoint": string, "keys": { "p256dh": string, "auth": string } }`
  — exactly what `PushSubscription.toJSON()` produces, narrowed. `endpoint` must parse as an `https:`
  URL and be ≤ 2048 characters; `p256dh` and `auth` must be non-empty base64url ≤ 256 characters.
  Anything else is `400 VALIDATION_FAILED`. `201` on a new row, `200` when the endpoint was already
  registered. **An endpoint already registered to another user is MOVED to the caller** (I-17): the same
  browser profile signed in as a different member must not leave the previous member receiving that
  device's notifications.
- `DELETE /api/push/subscription` request `{ "endpoint": string }` → `200`, idempotent. It deletes only
  a row belonging to the caller; an endpoint belonging to someone else is a `200` that deletes nothing,
  because reporting the difference would let a member probe for another member's devices.
- `GET /api/push/subscription?endpoint=…` → `{ "subscribed": boolean, "deviceCount": number }`, both
  scoped to the caller.

None of these bumps `rev` or emits an event.

**Recipients.** When a batch fires for store S, the recipients are every **active** user who
(a) is not among the batch's contributors, (b) can see S under §8.4, and (c) has at least one
subscription row. Note what (b) means in practice: a **private store notifies nobody**, because its only
viewer is its owner and the owner is the one adding.

**Payload.** The notification is composed **server-side, per recipient, in that recipient's
`users.locale`**, and carries the store name, up to five item names and a count. It carries no user
ids, no item ids and no note text. The `data.url` is `/s/{storeId}` so the click opens that list.

**Delivery is skipped entirely** — before any recipient is resolved — when push is disabled or no VAPID
subject could be derived (§8.11). `DeliveryReport.skipped` names which: `'disabled'`,
`'no-vapid-subject'`, `'store-gone'` or `'no-recipients'`.

**Delivery failures.** A `404` or `410` from the push service deletes the subscription row immediately —
that is the push service telling us the browser is gone. Any other failure increments `failure_count`
and leaves the row. A push failure is never visible to the person whose write triggered it.

### 8.8 The notifier — module surface

`src/lib/server/notify/index.ts`, pinned the way §4.1 pins the bus, because two agents meet here and
never see each other's code (D-025):

```ts
export interface AddedItem { storeId: string; actorId: string; itemName: string; }
export interface NotificationBatch {
  storeId: string; armedAt: number; count: number; names: string[]; actorIds: string[];
}
export type NotificationSink = (batch: NotificationBatch) => void | Promise<void>;

export function noteItemAdded(added: AddedItem): void;      // after the add commits
export function noteStoreActivity(storeId: string): void;   // after any other store write commits
export function setNotificationSink(sink: NotificationSink | null): void;  // startup wiring
export function configureNotifier(o: { quietMs: number; maxDelayMs: number }): void;
export function flushNotifications(): void;                 // test seam only — see below
```

The domain layer calls the first two and knows nothing else about notifications. It calls them **after
the transaction commits**, in the same place and under the same conditions as `emitStoreChanged` — an
idempotent no-op that emits nothing also notifies nothing. `noteItemAdded` and `noteStoreActivity`
never throw.

The sink is installed by `hooks.server.ts`. With no sink installed nothing is even accumulated, which is
what `ZEMBIL_PUSH_ENABLED=0` produces.

Batches live in memory and **do not survive a restart**, exactly like the rate-limit buckets (D-007).
`flushNotifications()` is a test seam and is deliberately **not** wired into §3.8's shutdown: `shutdown()`
calls `process.exit(0)` synchronously after closing the database, so flushing there would start HTTPS
requests the process is about to abandon. A batch lost to a restart is one missed notification, and the
next add arms a new one.

### 8.9 §3.0 write-effects delta

Additional rows for the §3.0 table. Same rule: a write not listed bumps nothing and emits nothing, and
an idempotent no-op does neither.

| Endpoint | Bumps | Emits | Notifies |
|---|---|---|---|
| `POST /api/stores/{id}/items` (**new** row) | `stores.rev` | `store.changed` | `noteItemAdded` |
| `POST /api/stores/{id}/items` (idempotent hit, R-17) | — | — | — |
| `PATCH /api/items/{id}` | `stores.rev` | `store.changed` | `noteStoreActivity` |
| `DELETE /api/items/{id}` (first delete) | `stores.rev` | `store.changed` | `noteStoreActivity` |
| `POST /api/items/{id}/{tick,untick}` (state changed) | `stores.rev` | `store.changed` | `noteStoreActivity` |
| `POST /api/items/{id}/{tick,untick}` (no change, R-4/R-5) | — | — | — |
| `POST /api/stores/{id}/trips/close` | `stores.rev` | `store.changed` **and** `stores.changed` | `noteStoreActivity` |
| `PATCH /api/stores/{id}` (incl. `visibility`) | `stores.rev` | `stores.changed` **and** `store.changed` | `noteStoreActivity` |
| `POST /api/stores/{id}/claim` (claim changed) | `stores.rev` | `stores.changed` **and** `store.changed` | `noteStoreActivity` |
| `POST /api/stores/{id}/claim` (same holder, same note) | — | — | — |
| `DELETE /api/stores/{id}/claim` (was claimed) | `stores.rev` | `stores.changed` **and** `store.changed` | `noteStoreActivity` |
| `DELETE /api/stores/{id}/claim` (was unclaimed) | — | — | — |
| `PATCH /api/me` | — | — | — |
| `POST|DELETE /api/push/subscription` | — | — | — |

A claim emits **both** store events for the same reason a close does: the home screen card shows the
claim, and so does the list header.

### 8.10 Error codes added

`TRIP_CLAIMED` (409) · `PUSH_DISABLED` (503) · `PUSH_DEVICE_LIMIT` (409). None carries a sibling
field; §3.1's rule that exactly three responses carry one is unchanged.

### 8.11 Environment variables added — §6 delta

| Name | Default | Note |
|---|---|---|
| `ZEMBIL_PUSH_ENABLED` | `true` | `0`/`false`/`no` turns push off. Nothing else is off. |
| `ZEMBIL_VAPID_SUBJECT` | `ZEMBIL_ORIGIN`, **when it is https** | VAPID `sub` claim; `mailto:` or `https://`. See below. |
| `ZEMBIL_NOTIFY_QUIET_MINUTES` | `5` | R-21's quiet window. `0` delivers immediately. |
| `ZEMBIL_NOTIFY_MAX_DELAY_MINUTES` | `30` | R-21's ceiling. Must be ≥ the quiet window. |

`ZEMBIL_ORIGIN` remains the only required variable.

**Correction, found in implementation.** RFC 8292 admits only a `mailto:` or `https:` contact URI and
`web-push` enforces it, so "defaults to the origin" cannot hold for a plain-`http:` origin — which is
the local development case (`http://localhost:5173`). An explicitly set value is always validated and
a bad one crashes the process per §6's standard; the DERIVED default is the origin when it is
`https:` and **`null` otherwise**. A null subject makes delivery skip with one log line rather than
fabricate a contact URI, and nothing is lost that was ever going to work: a browser cannot receive
real web push against a non-HTTPS deployment. `AuthConfig.vapidSubject` is therefore
`string | null`, and `DeliveryReport.skipped` gains `'no-vapid-subject'`.

---

## 9. Addendum 3 — deleting a store (M7, no migration)

Status: **frozen at the start of this milestone (M7).** §1–§8 are unchanged and still normative; this
section is additive and normative for everything it names. There is **no schema delta** — the whole
feature is one endpoint over a cascade migration 001 already declared.

Same rule as the header: if something here is wrong, ambiguous or missing, **stop and report it**.

### 9.1 `DELETE /api/stores/{storeId}`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| DELETE | `/api/stores/{storeId}` | session | Delete a store and everything on it, permanently |

Request: no body (any body is ignored). `200 → { "deleted": StoreDeletion }`:

```ts
interface StoreDeletion {
  storeId: string;
  name: string;   // the name it had when it went, so a screen can say what it deleted
  trips: number;  // rows removed from trips
  items: number;  // rows removed from items, carried clones included
}
```

Normative behaviour:

1. **Visibility is resolved first (§8.4).** A store that does not exist and a store private to
   somebody else produce the identical `404 STORE_NOT_FOUND` — same status, same code, same message,
   no sibling fields. **Being an admin does not grant visibility here either** (D-040 is unchanged).
2. **R-14 does not apply.** An archived store is deletable; archiving is not a precondition and not a
   protection. `409 STORE_ARCHIVED` is never returned by this endpoint.
3. **The cascade is the schema's.** `trips.store_id` and `items.store_id` are
   `REFERENCES stores(id) ON DELETE CASCADE` (§1.1) and the connection runs with
   `PRAGMA foreign_keys = ON`, so one `DELETE FROM stores WHERE id = ?` removes every trip and every
   item, including `carried` rows and closed trips. The endpoint must **not** delete children in
   application code: a second copy of a rule the database already enforces atomically is the copy
   that rots.
4. **The counts are read inside the same transaction, before the delete**, and are reported only so
   the client can say what went. They are not a precondition and nothing branches on them.
5. **It is not idempotent, and does not pretend to be.** A second delete of the same id is
   `404 STORE_NOT_FOUND`, which is also what a fabricated id gets — consistent with rule 1, and the
   reason no "already deleted" code exists.
6. **Any member the store is visible to may delete it.** There is no owner of a public store, no
   admin-only gate, and no confirmation token in the request: the confirmation is a UI affordance
   (§9.4), not a protocol field. See D-045.

No new error code. The endpoint returns `401 UNAUTHENTICATED`, `403` from the origin check per §3.2's
CSRF rule (it is a mutating method), `404 STORE_NOT_FOUND`, or `200`.

### 9.2 R-23 — the rollover rule for deletion

**R-23.** Deleting a store ends everything on it at once: its open trip, its closed trips, its items
and its claim (R-18). There is no carry-over, no successor trip, and no soft-delete tombstone at store
level — `items.deleted_at` is a soft delete because an item is undone by a person changing their mind,
and a store is not.

R-6's statement order (D-024) is untouched: a delete is a single statement against `stores`, so no
ordering question arises. R-11's `BEGIN IMMEDIATE` serialisation covers the delete-versus-close race —
whichever commits first wins, and the loser sees `404 STORE_NOT_FOUND` or `409 TRIP_ALREADY_CLOSED`
respectively, both of which are already contract.

### 9.3 §3.0 delta — write effects

| Endpoint | Bumps | Emits | Notes |
|---|---|---|---|
| `DELETE /api/stores/{id}` (deleted) | — (the row is gone) | `stores.changed` **and** `store.changed` | `store.changed` carries `rev + 1`: a rev the row will never hold. |
| `DELETE /api/stores/{id}` (refused) | — | — | A 404 emits nothing. |

The `rev + 1` is normative, not incidental. A member standing on `/s/{id}` holds `rev` as their
revalidation cursor and §4's rule is that a hint at or below the cursor is not worth a fetch. Only a
strictly higher hint makes them refetch, receive the 404, and learn the shop is gone; emitting nothing
would leave them tapping a list that no longer exists.

**Notifications (§8.9 delta).** Deleting a store discards any pending batch armed for it — a batch
describing a list that no longer exists notifies nobody about nothing. `deliver()` already tolerates a
store that vanished mid-window (`skipped: 'store-gone'`); the discard is the tidier fact, not the
safety net.

### 9.4 The confirmation is a UI rule, not a protocol one

The API takes no confirmation token, and must not grow one. The protection is in the interface and it
is stated here because it is testable:

- Deleting is **two taps on two different buttons with different words**. The first arms; the second,
  which was not under the thumb, destroys.
- The armed state **does not survive closing the sheet**. Reopening shop settings must not put
  "Delete permanently" one tap away from a member who came back to rename something.
- The copy on Archive and on Delete each says which is which **before** the tap: archiving says
  nothing is deleted, deleting says what goes and that it does not come back.
- Both controls clear the 44px floor (DESIGN.md §3), including the armed pair side by side.

### 9.5 What deletion does not change

- **No new invariant.** The cascade is I-1's referential shape doing what it was declared to do.
- **No admin exemption anywhere.** D-040 stands: an admin cannot see, patch or delete a store private
  to another member, and the tests that assert its absence now cover DELETE too.
- **No recovery path.** There is no undo and no trash. Recovery is the operator's backup
  (`scripts/backup.sh`, §3.8 and the README), which is exactly what it is for.

---

## 10. Addendum 4 — who may change visibility, and the interface theme (M8, migration 004)

Two changes, unrelated to each other except in that both are about a member's own control over what
they see. §8 (the visibility rule) and §8.5 (locale) are the sections they extend; neither is
rewritten.

### 10.1 §8.4a — visibility is a power, and not everyone who can see a store holds it

§8.4 says who may **see** a store. It said nothing about who may decide who sees it, and the answer
that fell out of §8.6 was "anybody who can see it" — so any member could privatise a shared family
shop, which under D-040 takes it away from everyone else with no way back for them, in one tap.
Seeing a list and deciding who else may see it are different powers.

**The rule.** `PATCH /api/stores/{storeId}` accepts the `visibility` field **only** from:

- the member named by `stores.created_by`, or
- an admin (`users.is_admin = 1`).

Anything else is **`403 FORBIDDEN`**, with §3.1's envelope and no sibling field.

Six things about it that are normative:

1. **§8.4 is resolved first and still wins.** A caller who cannot see the store gets the
   byte-identical `404 STORE_NOT_FOUND` — including an admin, who under D-040 cannot see another
   member's private store. A `403` there would confirm the store exists and belongs to somebody. In
   practice this means the admin exemption only ever applies to a store the admin can already see,
   which is the intended scope: it is a way to undo a privatisation on a *shared* shop, not a
   back door into a private one. **D-040 is untouched.**
2. **The refusal takes the whole PATCH with it.** The check runs inside the write transaction and
   before the name key is recomputed (migration 003 scopes `name_key` by the owner, so a visibility
   change is also a rename). A body carrying `{ name, visibility }` from a caller who may do the
   first but not the second writes **neither**. Asserted by reading the row back, per the write-seam
   rule.
3. **Nothing else on the endpoint is restricted.** `name`, `color`, `sortOrder` and `archived` remain
   open to any member the store is visible to, exactly as before.
4. **`created_by` is never a request field.** `visibility: 'private'` still means "private to the
   caller" (§8.6), at every privilege level. There is no way to hand a store to somebody else or to
   take one on their behalf.
5. **A store whose creator's account was deleted** (`created_by IS NULL`, `ON DELETE SET NULL`) is
   admin-only for this field. Null matches no actor id; it must not read as "everybody's".
6. **`Actor.isAdmin` grants this and nothing else.** It is read from `locals.user.isAdmin` by
   `actorOf` and from nowhere else, and it is **not** an input to `isVisibleTo`.

**`StoreSummary` gains `canChangeVisibility: boolean`** (§7 delta) — true for the creator and for an
admin, computed per request. It is a **rendering hint, not the control**: a client that ignores it
and sends the PATCH anyway gets the 403. It is a boolean rather than a creator id for the same reason
`claimedByMe` is: §3 keeps user ids off the wire for non-admins, and a `createdById` field would turn
every shop into a record of who made it.

**§3.0 delta.** `PATCH /api/stores/{id}` refused with `403` bumps nothing and emits nothing, like
every other refusal.

### 10.2 §10.2 — `users.theme`, and why the theme moved to the server

Migration 004 adds one column:

```sql
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'auto'
      CHECK (theme IN ('auto','light','dark','sepia','sage','contrast','indigo','plum'));
```

**I-19 (schema-bound).** `users.theme` is one of those eight strings. Enforced by the CHECK, and by
`validateTheme` at the request seam so a bad value is a `400` rather than a `500`.

The value is a **theme key, never a colour** — the same rule as `stores.color` (D-017). It indexes a
token block in `app.css`; no hex ever reaches the database.

It replaces a `localStorage` value, and the move is the point:

- **A member's phone and tablet now agree.** The old per-device value meant the same person met a
  different app depending on which screen they picked up.
- **It can be read during SSR.** `hooks.server.ts` substitutes it into `<html data-theme="…">` the
  way it already substitutes `%zembil.lang%` (§8.5), so the first frame is correct. This closes the
  theme flash PROJECT.md §13 listed as a known gap: the old value could only be read after mount, and
  an inline script — the other obvious fix — cannot get a hash past `kit.csp` (D-026).

**`auto` is a value, not an absent attribute.** With eight themes, "no attribute" can no longer stand
in for "follow the OS": the `prefers-color-scheme` block is guarded on `:root:not([data-theme]),
:root[data-theme='auto']`, so an explicit light-family theme survives an OS in dark mode. A signed-out
document renders `auto`.

**`PATCH /api/me` delta (§8.5).** The body is `{ locale?, theme? }`, and at least one must be
**present** — presence, not truthiness, so `{ theme: null }` is a `400` rather than a silently
dropped field. Both are validated before the `UPDATE`, so a half-valid body writes nothing. An empty
body is `400 VALIDATION_FAILED`, unchanged. It bumps nothing and emits nothing (§8.9), and there is
still no parameter naming a user, at any privilege level.

**`User` gains `theme: Theme`** (§7 delta), carried by `GET /api/me`, by `locals.user`, and by the
root `load`.

---

## 11. Addendum 5 — versioning (M8, no schema change)

### 11.1 The version is shown to members, and to nobody else

`src/lib/version.ts` holds `VERSION` (`0.<milestone>.<patch>`) and `RELEASED_ON` (`YYYY-MM-DD`, UTC).
`package.json`'s `version`, the top heading of `docs/VERSIONS.md` and PROJECT.md §2 carry the same
value, and a test asserts the first two agree with the module.

**Where it appears.** The foot of `/you`, as one line: `Zembil v0.8 · as of 3 September 2026`. It is
rendered from `users.locale` like every other string on that screen, and the patch segment is dropped
when it is zero — `v0.8` for a release, `v0.8.1` for a patch on top of one.

**Where it must not appear**, and this is the normative half:

- **`GET /api/health` still reports `{ "status": "ok" }` and nothing else.** §3.8 is unchanged and
  its reasoning is unchanged: that endpoint is reachable from the public internet by anyone who finds
  the hostname, and a health check that reports the build is a free fingerprint for picking a
  matching CVE. Do not add a version, an uptime or a migration number to it.
- **The sign-in screen shows no version**, for the same reason — it is the other page a stranger can
  reach.
- **No `X-Zembil-Version` header, no `<meta name="version">`, no version in the service-worker cache
  name.** The cache name is versioned by its own constant on purpose; coupling it to the release
  number would evict every cached shell on a patch that touched no asset.

So the rule is: **the build is a fact for the family, not for the internet.** Anything behind the
session may show it; anything in front of the session may not.

### 11.2 Bumping it

The minor number *is* the milestone. Shipping M9 makes it `0.9.0` whether M9 was large or small,
because the milestone is the unit this project plans, tests, audits and documents in. A fix between
milestones takes the patch. It stays on `0.x` until something makes a compatibility promise to
somebody outside this household — the frozen contract is that promise today, and a `1.0` would need a
D-entry saying what it means and to whom.

Four places move together, and each is asserted or read by something:

1. `src/lib/version.ts` — `VERSION` and `RELEASED_ON`
2. `package.json` — `version`
3. `docs/VERSIONS.md` — a new entry at the top
4. `PROJECT.md` §2 — the current-version row

`RELEASED_ON` is a literal, not a build timestamp. A build timestamp would move every time the image
is rebuilt, so "as of" would drift with no change to the app, and an operator comparing two
containers could not tell a rebuild from a release.
