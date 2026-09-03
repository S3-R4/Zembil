# Zembil — release log

Newest first. **The top heading is the version the app reports**, and a test asserts that
(`tests/client/version.test.ts`), so this file cannot quietly fall behind the build.

The scheme is `0.<milestone>.<patch>` — the minor number *is* the milestone, because the milestone is
the unit this project plans, tests, audits and documents in. It stays on `0.x` because the frozen
contract is the compatibility promise here, not the version number; a `1.0` would need a D-entry
saying what it is promising and to whom. `src/lib/version.ts` states the full rule.

**When you ship anything, four places move together:** `src/lib/version.ts` (`VERSION` and
`RELEASED_ON`), `version` in `package.json`, the top of this file, and PROJECT.md §2. Each of them is
either asserted by a test or read by an agent picking the project up cold.

Versions before `0.8` are reconstructed from the milestone history and the git log — the scheme did
not exist while they were being built, so their dates are the dates that milestone's work was
committed, not dates anything was cut. M1–M4 all landed on 2026-08-31; they were built in parallel
against a contract frozen first (D-031), which is why four "releases" share a day.

---

## v0.9.1 — 2026-09-03

**Item authorship moved onto the list itself.** (M9 patch)

- "Added by … · …" now renders directly on `ItemRow`, for both pending and ticked items, with no tap
  required — it had shipped in the item detail sheet only, one edit-tap away. Closes the PROJECT.md
  §13 gap about a ticked item's authorship being unreachable, since the row shows it regardless of
  state. D-050.
- Authorship no longer renders at all on a private shop: `stores.private_to` limits a private shop to
  exactly one reader (§8.4), who is also the only member who could ever have added an item to it, so
  naming them is not information. Mirrors the claim strip's own private-shop guard from v0.9. D-050.
- No migration, no contract change — same wire fields as v0.9, read one layer further down.

---

## v0.9 — 2026-09-03

**Who added it, and a claim strip that knows when nobody's listening.** (M9)

- The item detail sheet now shows "Added by … · …" under the fields — `items.created_by` /
  `createdByName` has been on the wire since migration 001, and carry-over already preserved it; the
  frontend just never rendered it. No migration, no contract change. Contract §1.1, §1.2. D-049.
- The "I'm going to this shop" claim strip no longer renders on a private shop — its own owner is the
  only member who could ever see it, so the strip could only ever announce a trip to yourself. Applies
  to the list screen's claim strip and the home screen's `StoreCard` claim line alike. Contract §8.4,
  §8.6. D-049.

---

## v0.8 — 2026-09-03

**Who may change who sees a shop, and a theme that follows the person.** (M8)

- `visibility` on `PATCH /api/stores/{id}` now takes only the member named by `stores.created_by`, or
  an admin — everybody else gets `403 FORBIDDEN`. Any member could previously privatise a shared
  family shop, which under D-040 removed it from everyone else's app with no way back for them.
  Contract §10.1, D-046.
- `StoreSummary` gains `canChangeVisibility`, a per-request boolean, so the shop-settings sheet stops
  offering a control that would 403.
- **Eight themes** — auto, Paper, Night, Linen, Olive, High contrast, Indigo, Mulberry — stored in
  `users.theme` (migration 004, I-19) and written into `<html data-theme>` by the server before the
  first paint. Closes the theme flash that PROJECT.md §13 had listed as a known gap. Contract §10.2,
  D-047.
- `PATCH /api/me` accepts `{ locale?, theme? }`; presence, not truthiness, so `{ theme: null }` is a
  400 rather than a silently dropped field.
- **Versioning itself**: `src/lib/version.ts`, this file, and the version line at the foot of the
  account screen — behind the session, and deliberately absent from `/api/health` and the sign-in
  screen. Contract §11, D-048.
- English dates are formatted as `en-GB`, so a written date is day-first like the rest of the
  interface (DESIGN.md §4).

Tests: 710 unit, 27 e2e. Mutation sweep: 20 mutations over the new guards, 20 killed (one survivor found and closed — `longDate` ignoring its locale argument).

---

## v0.7 — 2026-09-03

**Deleting a shop, permanently.** (M7)

- `DELETE /api/stores/{id}`, cascading through the schema, with the two-tap confirmation living in
  the interface rather than in the protocol. Contract §9, R-23, D-045.
- A cog replaced the sun on the shop-settings control, which had been read as an appearance toggle.
- No migration.

---

## v0.6 — 2026-09-02

**Five owner-requested features.** (M6)

- Batched push notifications, with a trailing per-store quiet window. D-038, D-039.
- Trip claims — "I'm going to Migros", with a note and a take-over path. R-18…R-20.
- Turkish and German, three typed catalogues and no library. D-042.
- Private shops (`stores.private_to`), the visibility rule, and the store-edit sheet that gave it a
  home. D-040, D-043.
- Click-to-copy for the one-time password.
- Migrations 002 and 003; contract addendum §8. Audited: one blocking finding, nine others, all
  closed.

---

## v0.5 — 2026-09-01

**Hardening.** (M5) Every audit finding acted on, and the done-means checklist re-verified against a
rebuilt image.

## v0.4 — 2026-08-31

**Deploy.** (M4) Dockerfile, compose, entrypoint, healthcheck, backup and restore, operator README.

## v0.3 — 2026-08-31

**Frontend.** (M3) The whole interface, the PWA and its service worker, the SSE client, optimistic
tick.

## v0.2 — 2026-08-31

**Auth.** (M2) scrypt, server-side sessions, the origin check, rate limiting, passkeys, admin CRUD,
first-admin bootstrap. The audit found an authorization bypass under a fully green suite — see
PROJECT.md §7.

## v0.1 — 2026-08-31

**Data and domain.** (M1) Schema, the migration runner, the rollover engine, the event bus, and
`/api/{stores,items,trips}`. Needed three audits.

## v0.0 — 2026-08-30

**Foundation.** (M0) The frozen contract, the DDL verified to execute, the agent definitions, and the
decision log.
