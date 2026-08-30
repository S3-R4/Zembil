# Zembil

Self-hosted family shopping list. Turkish *zembil*: a woven basket.

Items are grouped by store, so whoever goes to store X sees only X's list. Ticking an item does not
remove it — it sinks below the live items as history, and is undoable. Anything left unticked when a
trip is finished carries over to that store's next trip automatically.

**Status: M0 complete — architecture frozen, no feature code yet.**

| Document | What it is |
|---|---|
| [`PLAN.md`](PLAN.md) | Stack, milestones, file ownership, test strategy |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | **The frozen integration boundary.** Schema, rollover rules, HTTP API, session and env contract |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why each choice was made, and what was rejected |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Design tokens and screen specs, distilled from the canvas |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Deliberately deferred |

Deploy, reverse-proxy, backup and restore instructions land here at M4.
