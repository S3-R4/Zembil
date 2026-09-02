-- ============================================================================
-- Zembil migration 002 — trip claims, store visibility, locale, web push
-- ============================================================================
--
-- Forward-only and additive. Every statement here is an ALTER TABLE ADD COLUMN
-- or a CREATE, so no existing row is rewritten and no existing constraint is
-- relaxed. Verified on this build (node 26 / SQLite): ADD COLUMN accepts both a
-- column-level CHECK and a REFERENCES clause when the default is NULL, and both
-- are enforced afterwards (errcode & 0xff === 19).
--
-- What ADD COLUMN CANNOT add is a TABLE-level CHECK, which is why the paired
-- nullability of the three claim columns is a TEST-bound invariant (I-16) and
-- not a schema-bound one. See CONTRACT.md §1.2.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- users.locale — the member's chosen interface language.
--
-- Owned per user rather than per device: the same person gets Turkish on the
-- phone and on the tablet, and the SERVER needs it too — a push notification is
-- composed on the server, for a recipient who is not the person who triggered
-- it, so it cannot be translated by the client that will display it.
--
-- 'en' is the default because it is what every existing row was written in.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'
      CHECK (locale IN ('en','tr','de'));

-- ---------------------------------------------------------------------------
-- stores.private_to — visibility, as one column rather than two.
--
--   NULL     → public. Every signed-in member sees the store. The default, and
--              what every store created before this migration is.
--   non-NULL → private to exactly that user id. Nobody else may read it, list
--              it, write to it, or learn that it exists — INCLUDING an admin.
--
-- One column, not a `visibility` enum beside an `owner_id`, because two columns
-- would need a table-level CHECK to keep them consistent and ALTER TABLE cannot
-- add one. Here the invariant is unwritable rather than merely checked.
--
-- ON DELETE is deliberately absent, i.e. NO ACTION: deleting a user who owns a
-- private store fails rather than silently republishing their store to the
-- family. There is no endpoint that hard-deletes a user (admins deactivate), so
-- this blocks nothing that exists.
-- ---------------------------------------------------------------------------
ALTER TABLE stores ADD COLUMN private_to TEXT REFERENCES users(id);
CREATE INDEX stores_private_to ON stores (private_to);

-- ---------------------------------------------------------------------------
-- trips.claimed_by / claimed_at / claim_note — "I'm going to Migros."
--
-- The claim lives on the TRIP, not on the store, and that is the whole design:
-- a trip is one shopping run, so the claim expires exactly when the run ends.
-- R-6 opens a fresh trip on close, and a fresh trip's claim columns are NULL,
-- so nothing has to remember to clear anything. There is no expiry timer and no
-- background sweep because there is nothing to sweep.
--
-- claimed_by is ON DELETE SET NULL, matching trips.closed_by and items.ticked_by.
-- A NULL claimed_by is read as "unclaimed" whatever the other two columns say,
-- so a vestigial claimed_at cannot resurrect a claim belonging to nobody.
-- ---------------------------------------------------------------------------
ALTER TABLE trips ADD COLUMN claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE trips ADD COLUMN claimed_at INTEGER;
ALTER TABLE trips ADD COLUMN claim_note TEXT
      CHECK (claim_note IS NULL OR (length(trim(claim_note)) > 0 AND length(claim_note) <= 140));
CREATE INDEX trips_claimed ON trips (claimed_by) WHERE claimed_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- push_subscriptions — one row per browser install that has granted permission.
--
-- endpoint is the push service URL the browser handed us; it is the identity of
-- a subscription and is UNIQUE across the table, not per user. The same browser
-- profile signed in as a different member must move the row, not duplicate it —
-- otherwise the previous member keeps receiving that device's notifications.
--
-- p256dh and auth are the subscription's public key material (base64url), not
-- OUR secret: they encrypt a payload TO the browser. Losing them to a database
-- disclosure lets nobody read anything; it lets an attacker who ALSO holds the
-- VAPID private key send that browser a notification.
--
-- failure_count exists so a subscription that a push service has been rejecting
-- can be dropped. 404/410 from the push service deletes the row immediately;
-- the counter is for everything else.
-- ---------------------------------------------------------------------------
CREATE TABLE push_subscriptions (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT    NOT NULL UNIQUE,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  user_agent      TEXT,                            -- truncated to 256 chars, for the device list
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  CHECK (length(endpoint) > 0 AND length(endpoint) <= 2048),
  CHECK (length(p256dh) > 0   AND length(p256dh) <= 256),
  CHECK (length(auth) > 0     AND length(auth) <= 256),
  CHECK (failure_count >= 0)
) STRICT;
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- server_keys — the VAPID keypair, and nothing else.
--
-- This is the first secret the application has ever held, and it is worth being
-- explicit about why it does not break the "no secret to provision" property
-- (D-004, PROJECT.md §7): the keypair is GENERATED on first use and stored
-- here, so there is still nothing for an operator to create, rotate or leak
-- into a compose file. It lives in the database rather than in a file because
-- the database is the one thing the deployment already backs up and already
-- treats as the durable volume.
--
-- The row name is constrained to a closed set so this table cannot quietly
-- become a general-purpose key/value store.
-- ---------------------------------------------------------------------------
CREATE TABLE server_keys (
  name        TEXT    PRIMARY KEY CHECK (name IN ('vapid')),
  public_key  TEXT    NOT NULL,
  private_key TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  CHECK (length(public_key) > 0  AND length(public_key) <= 512),
  CHECK (length(private_key) > 0 AND length(private_key) <= 512)
) STRICT;
