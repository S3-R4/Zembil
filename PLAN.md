# Zembil — Build Plan

Self-hosted family shopping list. Turkish *zembil*: a woven basket.

Read `docs/CONTRACT.md` before anything else — it is the frozen integration boundary and the only
document an implementing agent needs. `docs/DECISIONS.md` records why each choice was made.
`docs/DESIGN.md` distils the design canvas into tokens and screen specs; the canvas itself is vendored
at `design/Zembil.dc.html`.

---

## 1. Stack

| Layer | Choice | Record |
|---|---|---|
| Framework | SvelteKit 2 / Svelte 5, `adapter-node`, single process | D-001 |
| Database | SQLite (WAL) via built-in `node:sqlite` — **no native dependency** | D-002 |
| Query layer | Hand-written parameterized SQL; numbered forward-only migrations | D-003 |
| Sessions | Opaque 32-byte tokens, stored hashed; no signing key exists | D-004 |
| Passwords | `crypto.scrypt`, N=65536 r=8 p=1 | D-005 |
| Passkeys | `@simplewebauthn` v13, usernameless + password fallback | D-008 |
| Realtime | SSE carrying revalidation hints, not data | D-011 |
| Tests | Vitest on a real SQLite file; Playwright at 390×844 | D-016 |
| Deploy | One container, one `/data` volume, non-root, loopback-bound | D-012 |

---

## 2. Data model at a glance

```
users ──< sessions
      ──< credentials
      ──< webauthn_challenges

stores ──< trips ──< items
                      │
                      └── carried_from_item_id ─┐  lineage across rollovers
                          carried_to_item_id  ──┘  origin_item_id = root of chain
```

A **list is a trip**. Exactly one trip per store is `open` at any moment — enforced by a partial
unique index, not by application code. Closing a trip clones its unticked items onto the successor
trip and marks the originals `carried`. Ticked items stay in the closed trip forever; that is the
history, and the substrate for spending analytics later.

Item states: `pending` → `ticked` (undoable, stays visible, sorts below pending) or `pending` →
`carried` at close (terminal).

Full DDL and the numbered rollover rules R-1…R-14 are in `docs/CONTRACT.md` §1–§2.

---

## 3. API surface

Complete definitions in `docs/CONTRACT.md` §3. Summary:

- **Auth** — `/api/auth/login`, `logout`, `password`, `passkey/{login,register}/{options,verify}`,
  `DELETE /api/auth/passkey/{id}`, `GET /api/me`
- **Admin** — `GET|POST /api/admin/users`, `PATCH /api/admin/users/{id}`,
  `POST …/reset-password`, `DELETE …/passkeys`
- **Stores** — `GET|POST /api/stores`, `PATCH /api/stores/{id}`
- **Lists** — `GET /api/stores/{id}/list`, `POST /api/stores/{id}/items`,
  `PATCH|DELETE /api/items/{id}`, `POST /api/items/{id}/{tick,untick}`,
  `POST /api/stores/{id}/trips/close`
- **History** — `GET /api/stores/{id}/trips`, `GET /api/trips/{id}`
- **Realtime** — `GET /api/events` (SSE)

---

## 4. File ownership

Agents whose ownership overlaps are **never** run concurrently. These sets are disjoint by
construction.

| Agent | Owns |
|---|---|
| `zembil-data` | `src/lib/server/db/**`, `src/lib/server/domain/**`, `src/lib/server/realtime/**`, `src/lib/types.ts`, `src/routes/api/{stores,items,trips,events}/**`, `tests/{db,domain}/**` |
| `zembil-auth` | `src/lib/server/auth/**`, `src/routes/(auth)/**`, `src/routes/api/{auth,admin}/**`, `src/hooks.server.ts`, `src/app.d.ts`, `scripts/bootstrap-admin.*`, `tests/auth/**` |
| `zembil-frontend` | `src/routes/(app)/**`, `src/lib/components/**`, `src/lib/client/**`, `src/app.html`, `src/app.css`, `src/service-worker.ts`, `static/**`, `tests/e2e/**` |
| `zembil-deploy` | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `scripts/{backup,restore,entrypoint}.sh`, `README.md` |
| `zembil-reviewer` | nothing — read-only |
| **orchestrator** | `package.json`, `svelte.config.js`, `vite.config.js`, `tsconfig.json`, `playwright.config.js`, `.gitignore`, `docs/**`, `PLAN.md`, `.claude/agents/**` |

The build skeleton is deliberately **not** delegated. `svelte.config.js` carries the CSP that
`CONTRACT.md` §5 makes load-bearing, and `vite.config.js` carries the Vitest pool settings that
`node:sqlite`'s synchronous single-connection model depends on; both are cross-cutting, both were
already unowned once, and an unowned file that four agents need is how a milestone ends with three
conflicting versions of it. An agent that needs a dependency added, or a config changed, **asks the
orchestrator**. It does not edit these.

`src/app.d.ts` goes to `zembil-auth` because `hooks.server.ts` is what populates `App.Locals`, and
the declaration must not drift from the thing that writes it. Its shape is pinned in `CONTRACT.md` §7.

`docs/**` and `PLAN.md` are owned by the orchestrator alone. An agent that believes the contract is
wrong reports it; it does not edit it.

---

## 5. Milestones

Each milestone ends with the app runnable and `npm test` green, followed by a `zembil-reviewer` audit
whose verdict is reported to the user verbatim and acted on before the next milestone starts.

### M0 — Foundation *(complete)*
Repo scaffold, agent definitions, `PLAN.md`, `docs/DECISIONS.md`, `docs/CONTRACT.md`,
`docs/BACKLOG.md`, `docs/DESIGN.md`, design canvas vendored at `design/Zembil.dc.html`.
**Exit:** contract frozen; DDL verified to execute; every schema-bound invariant (I-1, I-4, I-5,
I-10, I-11, I-12) verified to actually reject its violation, and every test-bound invariant listed as
such in `CONTRACT.md` §1.2 rather than assumed. ✅

### M1 — Data and domain — `zembil-data` *(complete)*
SvelteKit skeleton that builds and boots. Database connection with pragmas, migration runner,
migration 001. Domain modules for stores, trips, items, tick, untick and rollover. In-process event
bus. The `/api/{stores,items,trips}` routes. Vitest suite.
**Exit:**
- `npm run build` succeeds and `node build/index.js` serves.
- `npm test` green with at least one assertion per rule **R-1…R-17**.
- A test proves the R-6 step 5 statement order is the only one that works: both two-statement
  orders must raise a constraint error (foreign key, and `items_client_id` respectively). Without
  this the sequence silently "starts working" the day someone drops a constraint. Note that
  `node:sqlite` never reports the string `SQLITE_CONSTRAINT`: it sets `err.code = 'ERR_SQLITE_ERROR'`
  and puts the **extended** result code in `err.errcode`, so the real assertion is
  `(err.errcode & 0xff) === 19`.
- A test proves `POST /items` with a `clientId` whose original was carried over returns `200` with
  the **clone on the successor trip**, not a second item (R-17).
- A concurrency test proves two closes produce exactly one successor trip. §1.1a mandates a single
  synchronous connection, so two closes cannot interleave in-process and a naive sequential test
  would still pass with `BEGIN IMMEDIATE` removed. The test therefore opens a **second
  `DatabaseSync` handle** and asserts both the serialization path and that the loser sees
  `409 TRIP_ALREADY_CLOSED` with the correct `openTripId`.
- A test proves an add committing during a close is never lost, in both orderings.
- A test asserts the §3.0 table: each listed write bumps `rev` and emits exactly the listed events,
  and each idempotent no-op bumps and emits nothing.

### M2 — Auth — `zembil-auth` *(complete)*
scrypt hashing, session lifecycle, `hooks.server.ts` (session resolution, origin check, security
headers), rate limiting, login/logout, password change, admin user CRUD, passkey registration and
login, first-admin bootstrap.
**Exit:**
- Tests: login success and failure, disabled account indistinguishable from unknown username,
  session rotation, idle and absolute expiry, origin rejection, rate limiting, admin routes rejected
  for a non-admin session, `LAST_ADMIN` guard, passkey register and login, bootstrap idempotency.
- A test asserts login timing does not distinguish a known from an unknown username.
- Audited 2026-09-01 (D-037). The blocking finding — the `must_change_password` gate bypassable by
  percent-encoding one character of the path — is fixed and verified against the production build,
  and the six guards the audit found unreachable by any test are each pinned by a test whose kill
  was confirmed by applying the mutation.

### M3 — Frontend — `zembil-frontend` *(complete)*
Design tokens, layout shell with bottom navigation, login and passkey screens, store list, item list
with optimistic tick and undo, quick-add sheet, item edit, finish-trip confirm, trip history, account
screen, admin screen. PWA manifest, icons, service worker. SSE client with focus/online revalidation.
**Exit:**
- `npm run build` succeeds; Playwright green at 390×844 for login, add, tick, untick, undo, switch
  store, finish trip, offline reload.
- A test asserts the service worker never serves a cached authenticated document.
- Measured tap count from cold open to item added is reported.

### M4 — Deploy — `zembil-deploy` *(complete)*
Dockerfile, compose, entrypoint, healthcheck, graceful shutdown with WAL checkpoint, backup and
restore scripts, README covering deploy, reverse proxy for Caddy/nginx/Traefik, upgrade, backup,
restore, and admin password recovery.
**Exit:** on a clean state, `docker compose up` yields a working app with a bootstrapped admin;
a backup taken while serving is restored successfully and verified; image size reported.

### M5 — Hardening *(complete)*
Act on every accumulated reviewer finding. Full-suite green. Final end-to-end pass against the
"done means" checklist.

**Reviewer status.** Every milestone has now been audited: M1 three times, M2, M3 and M4 once each.
M2 took four attempts — two agents terminated at the account's monthly spend limit and one was
stopped before it reported — and it was worth the wait: it found an authorization bypass in the
milestone this project treats as its most security-sensitive, under a fully green suite (D-037).
Every blocking finding across all four milestones is closed. The one non-blocking finding not fixed
is in `docs/BACKLOG.md` with its reasoning.

D-036 and D-037 together record why the reviewer is not a formality: it finds the class of defect a
mutation sweep provably cannot, because a sweep can only break code that exists, and it is the only
pass in this process not run by whoever wrote the code.

**Done-means checklist**, from the brief. Re-verified end to end on **2026-09-01** against a freshly
built image, after the M2 audit fixes landed — not carried over from the 08-31 run.

| Clause | State |
|---|---|
| Clean-machine `docker compose up` brings it up with a bootstrapped admin | ✅ empty volume → healthy in 8s, the one-time password banner in the logs, login works, `must_change_password` enforced, password change and normal use afterwards. Image 62 MB. |
| Documented volume for data | ✅ `zembil_data`, README "Data and backups" |
| Documented first-admin bootstrap | ✅ README, `.env.example`, CONTRACT.md §3.8 |
| Password login | ✅ unit + e2e |
| Admin-created accounts, disable, reset password | ✅ unit; admin screen exercised by hand against the container |
| Passkey registration and login **over HTTPS** | ⚠️ verified over `http://localhost`, which is a secure context and exercises the identical code path. Not verified against a real TLS host with a real `ZEMBIL_RP_ID`, because this machine has no such host. That gap is configuration, not code, and the README says how to get it wrong. |
| Tick, un-tick and carry-over covered by tests | ✅ unit (M1) + e2e |
| Usable one-handed on a 390px phone | ✅ e2e asserts the 44px floor on every visible control and that the primary action sits below two-thirds of the viewport |
| README covers deploy, reverse proxy, backup and restore | ✅ including the `proxy_buffering off` that SSE needs |
| A backup taken while serving restores and verifies | ✅ live `backup.sh` (integrity_check=ok, 1 account) → a store added → `restore.sh` → container healthy again and the added store gone, the backed-up one present. Plus `tests/deploy/scripts.test.ts`, 7 tests. |
| The M2 audit's bypass cannot be reached through the shipped container | ✅ every path from the audit — `/%61pi/stores`, `/%61pi/admin/users` GET and POST, `/ap%69/admin/users` — is `403` through compose, with login and normal use unaffected (D-037) |

Measured, since the brief asked for it: **3 taps from cold open to an item added**, and **2 taps for
every item after that** — the quick-add sheet stays open. Both are pinned by
`tests/e2e/taps.spec.js`, so a regression that adds a step fails the suite rather than being
noticed a month later.

---

### M6 — Claims, visibility, locale and push

Five features requested by the owner after the app went live. They are independent of each other, and
nothing here is groundwork for anything else.

| # | Feature | Where it lands |
|---|---|---|
| 1 | **Push notifications, batched to avoid spam** | `push_subscriptions` + `server_keys` tables, `src/lib/server/notify/` (the coalescer), `src/lib/server/push/` (VAPID, subscriptions, delivery), `/api/push/*`, service-worker `push`/`notificationclick` handlers, an account-screen control. R-21, D-038, D-039. |
| 2 | **Claim a trip — "I'm going to Migros", with a short note** | `trips.claimed_by/claimed_at/claim_note`, `POST\|DELETE /api/stores/{id}/claim`, header control on the list screen, indicator on the home card. R-18…R-20, D-041. |
| 3 | **Turkish and German** | `users.locale`, `PATCH /api/me`, `src/lib/i18n/{en,tr,de}.ts`, a picker on `/you`. D-042. |
| 4 | **Public and private shops** | `stores.private_to` (NULL = public), a visibility rule applied to every store-scoped endpoint, a store-edit sheet. R-22, I-18, D-040. |
| 5 | **Click-to-copy the one-time password** | The admin screen's reveal sheet. |

Schema delta is **migration 002**, additive only: `users.locale`, `stores.private_to`, three claim
columns on `trips`, and two new tables. `ALTER TABLE ADD COLUMN` was verified on this build to accept
both a column-level `CHECK` and a `REFERENCES` clause defaulting to NULL, and to enforce both; it
cannot add a **table-level** `CHECK`, which is why I-16 is test-bound. Contract addendum: `docs/CONTRACT.md`
**§8**, frozen before implementation started, in the same role §1–§7 played at M0.

Ownership for this milestone, disjoint by construction as §4 requires. `src/lib/types.ts`,
`src/lib/server/db/**`, `src/lib/server/notify/**`, `src/lib/server/auth/config.ts`,
`src/hooks.server.ts`, `package.json` and `docs/**` stayed with the orchestrator, because every one of
them is a seam more than one agent would otherwise have edited:

| Agent | Owns |
|---|---|
| `zembil-data` | `src/lib/server/domain/**`, `src/routes/api/{stores,items,trips}/**`, `tests/{domain,db}/**` |
| `zembil-auth` | `src/lib/server/auth/{users,session,lookup,locale}.ts`, `src/routes/api/{me,admin}/**`, `tests/auth/**` |
| push | `src/lib/server/push/**`, `src/routes/api/push/**`, `tests/{push,notify}/**` |
| `zembil-frontend` | `src/lib/{i18n,client,components}/**`, `src/routes/(app|auth)/**`, `src/service-worker.ts`, `tests/{client,e2e}/**` |

**Exit criteria, and what actually happened against each:**

| Clause | Evidence |
|---|---|
| `npm test` green | ✅ **657** tests, 39 files (398 at M5) |
| `npm run test:e2e` green | ✅ **18** specs (12 at M5); `taps.spec.js` still reports **3** taps cold-open-to-item and **2** per item after |
| `npm run check` clean | ✅ 0 errors across **527** files |
| Mutation sweep over every guard added | ✅ 31 mutations across visibility, claims, push delivery, subscriptions, the coalescer and the audit fixes. **28 killed on the first pass; 3 survived and were closed.** Every sweep re-run after the audit fixes: all 31 killed |
| An EXISTING database upgrades in place | ✅ `tests/db/upgrade.test.ts`: a populated migration-001 database (accounts, shops, a closed trip, carry lineage, a Turkish name) upgraded to 003 — every row byte-identical, existing accounts default to English, existing shops stay public, `integrity_check` ok and `foreign_key_check` clean, and a re-run is a no-op. Every other migration test starts from an empty file, which is the one case that cannot lose anybody's data |
| The image still comes up | ✅ `docker build` + boot on a fresh volume: healthy, `user_version = 2`, `push_subscriptions` and `server_keys` created, `users.locale` / `stores.private_to` / the three claim columns present, and `web-push` resolves inside the runtime stage — the D-034 failure mode for a newly added runtime dependency |
| `zembil-reviewer` audit | ✅ Run and closed. One blocking finding (no cap or rate limit on `POST /api/push/subscription`) and nine others; acted on, or declined with a recorded reason. See D-044 and PROJECT.md §13 |
| Schema delta | Migration **002** (claims, visibility, locale, push) and **003** (name-key namespacing, added by the audit) |

**The mutation that survived on the first sweep, because it is the transferable part.** Removing the visibility check
from `updateStore` changed **no status code**: the transaction committed the rename, and the
function's closing `getStoreSummary` — which resolves visibility for its own reasons — threw the same
`404 STORE_NOT_FOUND` on the way out. Thirty-three tests asserting statuses, codes, messages and body
shapes stayed green while a member who could not see a store was renaming it. The fix is not a bigger
guard, it is a different kind of assertion: **when the guard protects a write, read the row back.**
This is now recorded in PROJECT.md §11 next to the route-seam rule it generalises.

**And the thing the sweep could not find, which the audit did.** §8.9's *Notifies* column had no test
coverage at all: `noteItemAdded` and `noteStoreActivity` were exercised only where they are called
directly, so deleting either call from the domain layer left the whole suite green and push silently
never fired again. No sweep finds that, because a sweep breaks code that exists and what was missing
was a test. `tests/domain/notify-effects.test.ts` now drives every §8.9 row through its route with a
recording sink installed. This is D-036's argument, demonstrated once more.

---

## 6. Test strategy

- **Unit and integration (Vitest).** Each test runs migrations into a fresh temporary database *file*
  so WAL and `busy_timeout` behave as in production. The rollover suite is the centrepiece: every
  rule in `docs/CONTRACT.md` §2 maps to at least one assertion, including the concurrent cases.
- **End-to-end (Playwright).** A 390×844 device descriptor, run against the built adapter-node server
  so the test exercises the real production artefact.
- **Not mocked.** The database, the session layer and the rollover transaction are always real. A
  test that mocks them tests the mock.
- **Mutation sweep — a standing exit criterion for every milestone from M2 on.** Before a milestone
  is called done, enumerate its guards — every validator, every `throw`, every early return on an
  idempotent no-op, every CHECK the code leans on as a backstop — then break each one and run the
  suite. Anything that stays green is a finding, and the milestone is not done.

  This is not belt-and-braces. M1 needed three audits, and each one found the same thing: a guard
  that was correctly written, accurately commented, and covered by a test that could not reach it.
  `itemVersion` was unreachable because the test that named it omitted a required sibling field, so
  an earlier guard fired first. `beforeSeq` and `readJson`'s body-shape check were unreachable
  because they sit at the route layer, where domain-level tests structurally cannot go. Reading the
  tests found none of these; mutating the code found all of them in one pass. A green suite is
  evidence only about the mutations someone tried.

  The route seam deserves its own pass: a guard reachable ONLY through a query string, a path
  parameter, or a raw JSON body will not be exercised by any domain-level test, however thorough.

---

## 7. Known gaps

The multi-agent design workflow was cut short by an account spend limit after 3 of 13 agents
finished; the judge panel and synthesis never ran. Decisions marked **[unjudged]** in
`docs/DECISIONS.md` did not receive their adversarial pass — D-001 (framework), D-003 (no ORM),
D-011 (SSE) and D-012 (Docker). Three probes that were meant to verify assumptions empirically were
cancelled, so the implementing agents must verify these themselves rather than trust recall:

1. ~~**`@simplewebauthn` v13's exact API** — read the shipped `.d.ts` files; this API changed
   materially across v9, v10, v11 and v13.~~
   **Closed 2026-08-31.** Read out of the installed v13.3.3 types and pinned in D-029. The nested
   `registrationInfo.credential` shape, the `credential:` (not `authenticator:`) parameter and the
   now-required `expectedRPID` are all recorded there, as is the `residentKey: 'required'` ruling
   that keeps usernameless login working. The §1.1 `credentials` DDL needed no change.
2. ~~**SSE through `adapter-node`** — confirm nothing compresses or buffers `text/event-stream`.~~
   **Closed 2026-08-31.** Probed against `setResponse` on Node 26.1.0: chunks flush as enqueued (no
   explicit flush call needed), and a client disconnect fires the stream's `cancel`, so bus
   subscriptions do not leak. The same probe measured the `desiredSize` teardown bound at ~2.5 MB per
   stalled stream rather than 64 events — see D-028. Reverse-proxy buffering (`proxy_buffering off`)
   is untested and stays with M4.
3. ~~**Node 26 base image tags and non-root volume ownership** — confirm against the registry, on
   the target architecture.~~
   **Closed 2026-08-31.** `docker manifest inspect node:26-alpine` lists `linux/amd64` and
   `linux/arm64/v8`; the tag currently runs Node v26.8.1. On a fresh named volume `/data` ends up
   `node:node`-owned with no entrypoint-side chown. The same pass found the real defect this probe
   existed to catch, which was not the one it was aimed at: `adapter-node` does **not** bundle
   `@simplewebauthn/server` into `build/`, so a runtime stage with no `node_modules` died with
   `ERR_MODULE_NOT_FOUND` before any application code ran. See D-034.
