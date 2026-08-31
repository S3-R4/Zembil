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

### M1 — Data and domain — `zembil-data`
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

### M2 — Auth — `zembil-auth`
scrypt hashing, session lifecycle, `hooks.server.ts` (session resolution, origin check, security
headers), rate limiting, login/logout, password change, admin user CRUD, passkey registration and
login, first-admin bootstrap.
**Exit:**
- Tests: login success and failure, disabled account indistinguishable from unknown username,
  session rotation, idle and absolute expiry, origin rejection, rate limiting, admin routes rejected
  for a non-admin session, `LAST_ADMIN` guard, passkey register and login, bootstrap idempotency.
- A test asserts login timing does not distinguish a known from an unknown username.

### M3 — Frontend — `zembil-frontend`
Design tokens, layout shell with bottom navigation, login and passkey screens, store list, item list
with optimistic tick and undo, quick-add sheet, item edit, finish-trip confirm, trip history, account
screen, admin screen. PWA manifest, icons, service worker. SSE client with focus/online revalidation.
**Exit:**
- `npm run build` succeeds; Playwright green at 390×844 for login, add, tick, untick, undo, switch
  store, finish trip, offline reload.
- A test asserts the service worker never serves a cached authenticated document.
- Measured tap count from cold open to item added is reported.

### M4 — Deploy — `zembil-deploy`
Dockerfile, compose, entrypoint, healthcheck, graceful shutdown with WAL checkpoint, backup and
restore scripts, README covering deploy, reverse proxy for Caddy/nginx/Traefik, upgrade, backup,
restore, and admin password recovery.
**Exit:** on a clean state, `docker compose up` yields a working app with a bootstrapped admin;
a backup taken while serving is restored successfully and verified; image size reported.

### M5 — Hardening
Act on every accumulated reviewer finding. Full-suite green. Final end-to-end pass against the
"done means" checklist.

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
3. **Node 26 base image tags and non-root volume ownership** — confirm against the registry, on the
   target architecture.
