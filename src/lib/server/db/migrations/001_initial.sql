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
