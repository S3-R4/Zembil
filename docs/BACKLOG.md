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

## Found while building M2–M5

| Item | Why deferred / note |
|---|---|
| **Store rename, recolour, reorder and archive UI** | `PATCH /api/stores/{id}` implements all four and is tested, but no screen calls it. Archiving is the one that matters: R-14 promises un-archiving is reachable via `?includeArchived=true`, and today nothing can archive a store in the first place, so the promise is not yet load-bearing. A store-edit sheet on the list header is the natural home. |
| **Theme flash for an explicit Light or Dark override** | `Appearance` is applied on mount, so a member who overrides their OS setting sees one frame of the other theme. Fixing it needs the choice available before first paint — an inline script (which `kit.csp` in hash mode will not admit from `app.html`) or a cookie read in the root `load`. The cookie is the honest fix; it was not worth a round trip's worth of complexity during M3. |
| **Playwright on WebKit and Firefox** | The suite runs on Chromium because that is the only engine installed here, and the WebAuthn virtual authenticator is a Chrome DevTools Protocol feature with no cross-engine equivalent. Mobile Safari is the single most likely target for this app, so a WebKit run is the highest-value addition to the suite. |
| **A real HTTPS passkey run** | Passkeys are verified over `http://localhost`, which is a secure context and exercises the identical code path. What is untested is a deployment where `ZEMBIL_RP_ID` does not match the host — a configuration failure the README warns about and nothing currently catches at startup beyond the suffix assertion. A boot-time self-check against the live origin could close it. |
| **A reviewer pass over M2, M3 and M4** | Not deferred by choice: the reviewer agents terminated at the account's spend limit. Tracked in `PLAN.md` §5 M5 rather than here, because it is a milestone exit criterion and not a feature. |

## Found by the M2/M3/M4 audits

| Item | Why deferred / note |
|---|---|
| **Automatic pre-migration snapshot** | D-013's third bullet promises every migration takes a `pre-migration-<from>-to-<to>.sqlite` snapshot first and refuses to proceed if it fails. `src/lib/server/db/migrations.ts` mentions it in a comment and does not do it; `README.md` tells the operator to take one by hand. The in-process `backup()` D-013 measured is the right mechanism. This is the largest unkept promise in `DECISIONS.md`. |
| **`ZEMBIL_LOG_LEVEL` actually filtering** | It is parsed and validated at startup (`config.ts`) and nothing reads it. `.env.example` and `README.md` now say so plainly rather than describing behaviour that does not exist. A `log(level, …)` helper used by the non-critical call sites is an hour's work; the bootstrap banner must stay unconditional at `warn`. |
| **`pre-restore-<stamp>/` retention** | Each restore roughly doubles the volume's size and nothing removes the old ones. Deliberate — they are the undo — but the README now documents cleaning them up, and a `--keep N` flag on `restore.sh` would be better than a documented `rm -rf`. |
| **Store-edit UI** | Already listed above; the M3 audit independently reached the same conclusion about R-14's un-archive promise. |
