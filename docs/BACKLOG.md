# Zembil — Backlog

Things worth doing that are deliberately **not** in the MVP. Append here rather than building.

## Out of scope by the brief — settled, do not re-litigate

Analytics and spending statistics · recipes · barcode scanning · price tracking · budgets · sharing
outside the family · native apps.

The database is shaped so the first of these is not blocked: every item row persists per trip with
its author, its tick time and its carry lineage, and price or quantity columns attach to `items` via
`ALTER TABLE ADD COLUMN` — a non-destructive migration. No analytics table, column or query exists
today.

## Deferred from the design canvas

| Item | Why deferred |
|---|---|
| **"Add all again"** from a past trip | A real feature, not a view of existing data. One tap to re-add a whole closed trip's items to the open one. Cheap to add on the existing model. |
| **"Search past items"** | Needs either FTS5 over `items.name` (available — verified present in this SQLite build) or a `LIKE` scan. Trivial at family scale, but it is an addition. |
| **Desktop keyboard shortcuts** (`Enter` add, `Space` tick row) | Desktop is explicitly a nice-to-have. |
| **"Baba shopping now" presence** | The store card shows who is shopping right now. Needs presence tracking over the SSE bus — a real feature, not a view of existing data. |
| **Per-store icons** | Colour spines ship in the MVP (they are the primary visual separator between stores); icons are additive. |

## Deferred by architecture

| Item | Why deferred / note |
|---|---|
| **Argon2id password hashing** | D-005 chose scrypt to avoid a native or WASM dependency. The stored hash format is self-describing, so migration is a transparent rehash at login, not a schema change. |
| **`item_event` audit log** | An append-only log of add/tick/untick/edit/carry would give richer history and a clean analytics substrate. Rejected for the MVP because nothing reads it, and unused write paths rot. |
| **"Carried 4 times" nudge** | `items.carry_count` is already maintained, so this is a UI change alone. Surfacing an item the family keeps failing to buy. |
| **Scheduled or automatic trip close** | Needs a scheduler and can close a list while somebody is standing in the shop. Manual close is the safer default. |
| **Undo a whole rollover** | Closing is currently terminal (R-9). A time-boxed undo would need the close transaction to be reversible. |
| **Rate-limit state surviving restart** | Buckets are in-memory (D-007). Persisting them matters only if restarts become frequent. |
| **Multi-household / tenancy** | The brief is explicit: one family. Every query would need a household boundary; adding it later is a real migration. |
| **Per-user push notifications** | Web Push needs VAPID keys and a subscription table, and iOS requires the PWA to be installed first. |
| **Reordering items by drag** | `items.sort_order` exists and is honoured; only the gesture and the endpoint are missing. |
| **Offline write queue** | The service worker never caches authenticated responses (a hard safety rule). True offline *writes* would need an IndexedDB outbox and replay. The MVP degrades to read-only-stale plus a retry. |
| **Session list with per-device revocation** | `sessions.user_agent` is already captured for the account screen; "sign out everywhere" is the missing endpoint. |
| **Structured request logging / metrics** | Currently level-based logs only. |
| **Automated `VACUUM INTO` on a timer** | Backup is a documented manual script (D-013). A cron sidecar or host timer is the natural next step. |
