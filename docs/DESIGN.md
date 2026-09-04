# Zembil — Design System

Distilled from `design/Zembil.dc.html` (the Claude Design canvas, 22 artboards at 390×844). The
canvas is the visual source of truth; this file is the machine-readable summary. When they disagree,
the canvas wins — read it.

Aesthetic: warm woven paper, terracotta accent, **everything primary in the bottom third**.

---

## 1. Colour tokens

Defined as CSS custom properties on `:root`, overridden under `[data-theme="…"]` and under
`@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme]), :root[data-theme="auto"]`
so the Theme control wins in both directions.

**M8: eight themes, and `auto` is a value.** `auto`, `light`, `dark`, `sepia`, `sage`, `contrast`,
`indigo`, `plum` — stored in `users.theme` and written onto `<html>` by the server before the first
paint (CONTRACT.md §10.2). The guard names `auto` explicitly rather than excluding `light`, because
with eight themes "no attribute" can no longer stand in for "follow the OS": under the old
`:not([data-theme="light"])` guard, `sepia` would be repainted dark after sunset.

`sepia`, `sage` and `contrast` sit on `:root`'s light tokens and leave the eight **store** colours
alone — `stores.color` is a shared choice, and a shop should look like the same shop to everybody.
`indigo` and `plum` are grouped into the `[data-theme="dark"]` selector list, inheriting the dark
store palette wholesale, and then override the neutrals and the accent.

### Light

| Token             | Value     | Use                           |
| ----------------- | --------- | ----------------------------- |
| `--bg`            | `#F4F0E8` | app background                |
| `--surface`       | `#FFFCF6` | cards, bottom nav, sheets     |
| `--surface-sunk`  | `#F6F0E6` | ticked ("in the basket") rows |
| `--surface-muted` | `#EFE7D8` | avatar, secondary button      |
| `--border`        | `#E6DECE` | card border                   |
| `--border-strong` | `#DED6C6` | avatar, input border          |
| `--border-dashed` | `#CFC5B1` | empty store card              |
| `--rule`          | `#E2DACA` | nav top border, dividers      |
| `--text`          | `#191510` | primary                       |
| `--text-2`        | `#3E382E` | secondary button label        |
| `--text-3`        | `#6E6559` | card subtitle                 |
| `--text-muted`    | `#8B8272` | eyebrow, inactive nav         |
| `--text-faint`    | `#9A917F` | placeholder, empty state      |
| `--text-disabled` | `#BCB2A0` | disabled control              |
| `--accent`        | `#B15A2B` | primary button, active spine  |
| `--accent-deep`   | `#8E4520` | accent text on tint           |
| `--accent-tint`   | `#F6E3D6` | active nav pill, count chip   |
| `--on-accent`     | `#FFFCF6` | label on `--accent`           |
| `--danger`        | `#71241B` | destructive label             |

### Dark

| Token             | Value     |
| ----------------- | --------- |
| `--bg`            | `#0F0D0B` |
| `--surface`       | `#191613` |
| `--surface-sunk`  | `#161311` |
| `--text`          | `#F0EBE1` |
| `--text-3`        | `#A29788` |
| `--text-muted`    | `#8A8072` |
| `--text-disabled` | `#4C453C` |
| `--accent`        | `#E08A54` |

### Store palette

`stores.color` is a **key**, never a hex value (see `docs/CONTRACT.md` §1). Each key resolves to a
spine colour, a chip background and a chip text colour, per theme:

| Key                                      | Spine (light)                                   | Chip bg   | Chip text |
| ---------------------------------------- | ----------------------------------------------- | --------- | --------- |
| `terracotta`                             | `#B15A2B`                                       | `#F6E3D6` | `#8E4520` |
| `green`                                  | `#4C7A4E`                                       | `#E2EDE1` | `#345C36` |
| `violet`                                 | `#7A6EA8`                                       | `#E7E4F0` | `#4C4373` |
| `blue`, `amber`, `rose`, `teal`, `slate` | extend the same triple in the canvas's register |           |           |

Dark-theme equivalents brighten the spine and darken the chip: green becomes `#7FB183` on `#1B241B`
with `#CFE4CF` text.

---

## 2. Type

| Role            | Font                    | Size / weight                                      | Tracking  |
| --------------- | ----------------------- | -------------------------------------------------- | --------- |
| Display         | Bricolage Grotesque 700 | 34px                                               | `-0.02em` |
| Screen title    | DM Sans 700             | 30px                                               | `-0.02em` |
| Card title      | Bricolage Grotesque 700 | 22px                                               | `-0.01em` |
| Store name      | DM Sans 700             | 21px                                               | `-0.01em` |
| **Item name**   | DM Sans 600             | **19px — the floor for list rows**                 | —         |
| Body            | DM Sans 400             | 17px                                               | —         |
| Input           | DM Sans 400/500         | **18px — never below 16px, or iOS zooms on focus** | —         |
| Subtitle / meta | DM Sans 400             | 14px                                               | —         |
| Eyebrow         | DM Sans 700 uppercase   | 11px                                               | `0.14em`  |
| Nav label       | DM Sans 600/700         | 12px                                               | —         |

Fonts are **self-hosted woff2** under `static/fonts/` (D-015) — never Google Fonts. Every stack ends
in `system-ui, sans-serif`.

---

## 3. Metrics

| Element           | Height               | Radius                  | Notes                                                                                                               |
| ----------------- | -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Primary button    | 68px                 | 22px                    | e.g. "Add an item", full width                                                                                      |
| Large button      | 64px                 | 20px                    | padding `0 26px`                                                                                                    |
| Secondary button  | 58px                 | 18px                    | `--surface-muted`, `--text-2`                                                                                       |
| Tertiary button   | 48px                 | 16px                    |                                                                                                                     |
| Chip              | 44px                 | 14px                    | min-width 44px, padding `0 12px`                                                                                    |
| Input             | 60px                 | 16px                    | 18px text; focus = 2px `--accent` ring                                                                              |
| Item row          | 68px                 | 20px                    | padding `0 8px 0 18px`                                                                                              |
| Store card        | auto                 | 22px                    | padding `18px 20px`, 1px `--border`                                                                                 |
| Card / sheet      | auto                 | 24px                    | padding `28px 28px 32px`                                                                                            |
| Avatar            | 48px                 | 16px                    |                                                                                                                     |
| Bottom nav        | 82px                 | —                       | 1px `--rule` top border, `--surface`                                                                                |
| Nav tab pill      | 60px                 | 16px                    | active: `--accent-tint`                                                                                             |
| Store spine       | 56px × 8px           | 4px                     | store palette colour                                                                                                |
| Checkbox          | 24–26px              | 8px                     | 2.5px border                                                                                                        |
| Claim strip       | auto (≥44px control) | 18px                    | M6. `--surface-muted`; sits under the list header, above the items                                                  |
| Segmented control | 44px per button      | 16px outer / 12px inner | M6. Language, and Who-can-see-this-shop, use it. M8: Appearance became the Theme dropdown                           |
| Theme dropdown    | 60px (`.z-field`)    | 16px                    | M8. A native `<select>`: eight labels do not fit across 390px, and the platform picker beats anything we would draw |
| Colour swatch     | 44px                 | 14px                    | M6. A swatch is a tap target like any other — not the 24px dot it looks like                                        |
| Settings gear     | 44px                 | 14px                    | M6. List header, right-aligned, `--text-2`                                                                          |

**Tap targets are never below 44×44 CSS px.** The list row is 68px precisely so a moving thumb cannot
tick the wrong thing. This applies to everything M6 added, including a colour swatch — the visible dot
is 24px and the target around it is 44px.

---

## 4. Screens

| Screen         | Route           | Notes                                                                                                                                                                                                                                                                                     |
| -------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password login | `/login`        | Name, Password with a Show toggle, Sign in                                                                                                                                                                                                                                                |
| Passkey login  | `/login`        | "This phone remembers you" → "Use password instead" fallback                                                                                                                                                                                                                              |
| Shops          | `/`             | eyebrow "Our lists" + title "Shops"; store cards; "Add an item"; bottom nav                                                                                                                                                                                                               |
| List           | `/s/{storeId}`  | pending rows, then an "In the basket · N" divider, then ticked rows with Undo; "Finish trip · N bought"                                                                                                                                                                                   |
| Empty list     | `/s/{storeId}`  | "The basket is empty"                                                                                                                                                                                                                                                                     |
| Quick add      | sheet over list | **stays open for the next item**; “Add to Migros”; up to eight recently bought chips when empty; a same-name item warns on the first submit and offers “Add another anyway” on the second                                                                                                 |
| Item detail    | sheet           | Item, Quantity or note, Store, Delete, Save                                                                                                                                                                                                                                               |
| Finish trip    | confirm sheet   | Bought / Left on the list / Keep shopping                                                                                                                                                                                                                                                 |
| Trips          | `/trips`        | history; "See 8 items"; per-trip item preview                                                                                                                                                                                                                                             |
| Account        | `/you`          | passkeys with "Used 2 minutes ago" + Remove; Notifications; Language; Theme (M8: a dropdown of eight, saved to the account); Sign out; **the version line** (M8: `<footer>`, 11px, `--text-faint`, centred, below Sign out — a fact people look for, never one they read on the way past) |
| Admin          | `/you/admin`    | "Active · 2 passkeys", "Active · password only", "Disabled 4 Aug" + Enable; New user; Reset password; Remove all passkeys; Disable user                                                                                                                                                   |

### Added in M6

| Screen            | Route                 | Notes                                                                                                                                                                                                                                                                              |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim strip       | on `/s/{storeId}`     | "Nobody is going yet." / "Ayşe is shopping here." + her note; the action is "I'm going to this shop", "Change my note" or "Take over". Status first, control second — the common case is reading it                                                                                |
| Claim             | sheet over list       | one optional note, 140 chars, live countdown. After a `409 TRIP_CLAIMED` the same sheet becomes "Take over anyway" and names who is already going                                                                                                                                  |
| Shop settings     | sheet over list       | rename, recolour, **Who can see this shop** (Everyone / Only me), archive, delete. Opened from the gear in the list header. M8: the Everyone/Only me pair is drawn only for the shop's creator and for admins (CONTRACT.md §10.1); everybody else gets the sentence and no control |
| Archived shops    | sheet over Shops      | the only route to an archived store's id, so the only way R-14's un-archive promise is reachable                                                                                                                                                                                   |
| Notifications     | section on `/you`     | on/off for this device, device count, and the reason it cannot be turned on when it cannot — permission denied, unsupported, or iOS-needs-Home-Screen                                                                                                                              |
| Language          | section on `/you`     | English / Türkçe / Deutsch, each named in itself                                                                                                                                                                                                                                   |
| One-time password | sheet on `/you/admin` | the generated password, **Copy** (with a "Copied" / "Could not copy it" state), and "I have written it down"                                                                                                                                                                       |

### Added in M7

| Screen           | Route                                                             | Notes                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete a shop    | bottom of the shop-settings sheet, and each row of Archived shops | Two taps on two different buttons. The first arms and shows "Delete {shop} for good?" with what it costs; the second is **Delete permanently**, next to **Keep it**. Arming does not survive closing the sheet |
| Deletion receipt | banner on `/s` (Shops)                                            | "Migros was deleted. 4 trips and 27 items went with it." Shown once, on the screen the member lands on, because the screen they deleted from is about to 404                                                   |

### Added in M10

| Surface                    | Rule                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recent-item chips          | Horizontal, 44px-minimum chips under the empty item field. They disappear once typing starts and never include an item already on the open list.                                     |
| Duplicate warning          | Inline accent text. It does not block the legitimate duplicate: the submit label changes to “Add another anyway” after the first attempt.                                            |
| Carry nudge                | One carry remains quiet metadata; two or more changes to bold “Still needed after N trips”. The finish sheet counts pending items carried before.                                    |
| Claim strip                | When the claim is mine, “Change my note” and the danger-coloured “I’m not going” are both visible. Release is not hidden in the edit sheet.                                          |
| Offline / install metadata | English, Turkish and German static offline pages use the same 44px target and paper/night palette. The manifest description and `lang` match the account locale selected during SSR. |

The header icon for shop settings is a **cog**. It was a circle with eight straight rays until M7,
which reads as brightness — on most phones the icon next to it is the display setting.

The words are the safety mechanism here, and they are chosen against each other: **Archive** says
nothing is deleted and names where the shop goes; **Delete** names what goes with it and says it does
not come back. Both sit in the same sheet, Archive first, because the reversible action should be the
one you meet first.

A private shop is marked **"Only you"** wherever it appears — on its card and in its list header.
A claimed shop shows who is going on the home card too; that is what stops two people driving to the
same shop.

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
- **Copy that a translation will lengthen must not be laid out at its English width.** German is
  routinely 30% longer than English and Turkish agglutinates; the segmented controls therefore let
  their labels shrink rather than their layout break. This is the one design rule M6 added, and it
  came from "Türkçe" and "Deutsch" not fitting where "Auto" did.
- **A claim note is plain text.** It is rendered as text, never as HTML and never as a link — there
  is no `{@html}` anywhere in this codebase and this is not the place to introduce one.

---

## 6. Language

Three catalogues, `en` / `tr` / `de`, in `src/lib/i18n/`. Notes that are design decisions rather than
implementation ones:

- **Each language names itself in itself** in the picker — "Türkçe", not "Turkish". Somebody who has
  landed in a language they cannot read has to be able to find their way out.
- **Turkish counted nouns do not take the plural suffix**: "3 ürün", never "3 ürünler". The Turkish
  catalogue supplies one form on purpose; that is correct, not lazy.
- **No suffix is ever glued to a name.** Turkish vowel harmony needs "Migros'a" but "BİM'e", and
  nothing can know which, so every phrase built around a shop name routes the suffix onto a fixed
  word instead — "{shop} listesine ekle". The Turkish reads slightly longer than the English as a
  result, and it is right for every name a family will type.
- **German uses "Sie".** "Du" is warmer for a household app and is also the form that reads wrong to
  exactly one family member; "Sie" reads merely neutral to everyone.
- **Server error messages are never translated by the client.** They are written for a person
  (CONTRACT.md §3.1) and shown as sent — a re-invented "Something went wrong" is what hides a
  `409 STORE_NAME_TAKEN` that would have told the member what to do.
