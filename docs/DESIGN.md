# Zembil — Design System

Distilled from `design/Zembil.dc.html` (the Claude Design canvas, 22 artboards at 390×844). The
canvas is the visual source of truth; this file is the machine-readable summary. When they disagree,
the canvas wins — read it.

Aesthetic: warm woven paper, terracotta accent, **everything primary in the bottom third**.

---

## 1. Colour tokens

Defined as CSS custom properties on `:root`, overridden under `[data-theme="dark"]` and under
`@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` so the Appearance
control (Light / Auto / Dark) wins in both directions.

### Light

| Token | Value | Use |
|---|---|---|
| `--bg` | `#F4F0E8` | app background |
| `--surface` | `#FFFCF6` | cards, bottom nav, sheets |
| `--surface-sunk` | `#F6F0E6` | ticked ("in the basket") rows |
| `--surface-muted` | `#EFE7D8` | avatar, secondary button |
| `--border` | `#E6DECE` | card border |
| `--border-strong` | `#DED6C6` | avatar, input border |
| `--border-dashed` | `#CFC5B1` | empty store card |
| `--rule` | `#E2DACA` | nav top border, dividers |
| `--text` | `#191510` | primary |
| `--text-2` | `#3E382E` | secondary button label |
| `--text-3` | `#6E6559` | card subtitle |
| `--text-muted` | `#8B8272` | eyebrow, inactive nav |
| `--text-faint` | `#9A917F` | placeholder, empty state |
| `--text-disabled` | `#BCB2A0` | disabled control |
| `--accent` | `#B15A2B` | primary button, active spine |
| `--accent-deep` | `#8E4520` | accent text on tint |
| `--accent-tint` | `#F6E3D6` | active nav pill, count chip |
| `--on-accent` | `#FFFCF6` | label on `--accent` |
| `--danger` | `#71241B` | destructive label |

### Dark

| Token | Value |
|---|---|
| `--bg` | `#0F0D0B` |
| `--surface` | `#191613` |
| `--surface-sunk` | `#161311` |
| `--text` | `#F0EBE1` |
| `--text-3` | `#A29788` |
| `--text-muted` | `#8A8072` |
| `--text-disabled` | `#4C453C` |
| `--accent` | `#E08A54` |

### Store palette

`stores.color` is a **key**, never a hex value (see `docs/CONTRACT.md` §1). Each key resolves to a
spine colour, a chip background and a chip text colour, per theme:

| Key | Spine (light) | Chip bg | Chip text |
|---|---|---|---|
| `terracotta` | `#B15A2B` | `#F6E3D6` | `#8E4520` |
| `green` | `#4C7A4E` | `#E2EDE1` | `#345C36` |
| `violet` | `#7A6EA8` | `#E7E4F0` | `#4C4373` |
| `blue`, `amber`, `rose`, `teal`, `slate` | extend the same triple in the canvas's register | | |

Dark-theme equivalents brighten the spine and darken the chip: green becomes `#7FB183` on `#1B241B`
with `#CFE4CF` text.

---

## 2. Type

| Role | Font | Size / weight | Tracking |
|---|---|---|---|
| Display | Bricolage Grotesque 700 | 34px | `-0.02em` |
| Screen title | DM Sans 700 | 30px | `-0.02em` |
| Card title | Bricolage Grotesque 700 | 22px | `-0.01em` |
| Store name | DM Sans 700 | 21px | `-0.01em` |
| **Item name** | DM Sans 600 | **19px — the floor for list rows** | — |
| Body | DM Sans 400 | 17px | — |
| Input | DM Sans 400/500 | **18px — never below 16px, or iOS zooms on focus** | — |
| Subtitle / meta | DM Sans 400 | 14px | — |
| Eyebrow | DM Sans 700 uppercase | 11px | `0.14em` |
| Nav label | DM Sans 600/700 | 12px | — |

Fonts are **self-hosted woff2** under `static/fonts/` (D-015) — never Google Fonts. Every stack ends
in `system-ui, sans-serif`.

---

## 3. Metrics

| Element | Height | Radius | Notes |
|---|---|---|---|
| Primary button | 68px | 22px | e.g. "Add an item", full width |
| Large button | 64px | 20px | padding `0 26px` |
| Secondary button | 58px | 18px | `--surface-muted`, `--text-2` |
| Tertiary button | 48px | 16px | |
| Chip | 44px | 14px | min-width 44px, padding `0 12px` |
| Input | 60px | 16px | 18px text; focus = 2px `--accent` ring |
| Item row | 68px | 20px | padding `0 8px 0 18px` |
| Store card | auto | 22px | padding `18px 20px`, 1px `--border` |
| Card / sheet | auto | 24px | padding `28px 28px 32px` |
| Avatar | 48px | 16px | |
| Bottom nav | 82px | — | 1px `--rule` top border, `--surface` |
| Nav tab pill | 60px | 16px | active: `--accent-tint` |
| Store spine | 56px × 8px | 4px | store palette colour |
| Checkbox | 24–26px | 8px | 2.5px border |

**Tap targets are never below 44×44 CSS px.** The list row is 68px precisely so a moving thumb cannot
tick the wrong thing.

---

## 4. Screens

| Screen | Route | Notes |
|---|---|---|
| Password login | `/login` | Name, Password with a Show toggle, Sign in |
| Passkey login | `/login` | "This phone remembers you" → "Use password instead" fallback |
| Shops | `/` | eyebrow "Our lists" + title "Shops"; store cards; "Add an item"; bottom nav |
| List | `/s/{storeId}` | pending rows, then an "In the basket · N" divider, then ticked rows with Undo; "Finish trip · N bought" |
| Empty list | `/s/{storeId}` | "The basket is empty" |
| Quick add | sheet over list | **stays open for the next item**; "Add to Migros" |
| Item detail | sheet | Item, Quantity or note, Store, Delete, Save |
| Finish trip | confirm sheet | Bought / Left on the list / Keep shopping |
| Trips | `/trips` | history; "See 8 items"; per-trip item preview |
| Account | `/you` | passkeys with "Used 2 minutes ago" + Remove, Appearance Light/Auto/Dark, Sign out |
| Admin | `/you/admin` | "Active · 2 passkeys", "Active · password only", "Disabled 4 Aug" + Enable; New user; Reset password; Remove all passkeys; Disable user |

Offline state: the store list shows "No signal" with a **Retry**; rows pending sync show
"Waiting to sync".

---

## 5. Layout rules

- **Bottom third is sacred.** Primary action sits directly above the bottom nav, over a
  `linear-gradient(180deg, transparent, var(--bg) 40%)` scrim so the list scrolls under it.
- Screen padding is `20px` horizontal for lists, `24px` for headers.
- Use `env(safe-area-inset-bottom)` on the nav and `dvh` units, never `100vh`.
- The quick-add sheet stays open after submitting — adding is the most frequent action, and the
  second item should cost one tap, not four.
- Ticked rows sink below the divider and use `--surface-sunk`; they never disappear.
- Tick animation `zTick` (scale 1 → 0.86 → 1) and skeleton `zShimmer` are defined in the canvas.
  Both are wrapped in `@media (prefers-reduced-motion: no-preference)`.
