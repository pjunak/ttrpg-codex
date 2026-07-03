# Style guide — O Barvách Draků design system

The single source of truth for the app's visual language. **All UI — built-in
pages, settings, and addons — is built from the tokens and components here.**

## The one rule

**Never hardcode a colour, spacing, size, radius, shadow, or duration in a
component. Use a `var(--token)`.** A literal value can't be re-skinned by a
theme (`[data-theme]`) and drifts out of sync with everything else. If no token
fits and the value *recurs or is semantic*, add a token (see `main.css :root`)
rather than inline it. One-off, truly component-local values are tolerated, but
prefer a token.

This is what makes two features work for free:
- **Themes** (Settings → Vzhled): a theme is a `[data-theme]` block in
  `themes.css` that overrides tokens; components inherit it with no edits.
- **Addons**: the host hands addons `host.h` (which emits host-classed HTML) and
  they reference these tokens/classes — so an addon looks native and re-skins
  with the app. Addons must **not** ship global stylesheets; scope any bespoke
  rule under an `.addon-<id>` wrapper. Full addon guide:
  [`examples/addons/AUTHORING.md`](../../examples/addons/AUTHORING.md).

---

## Tokens (`main.css :root`)

### Colour — surfaces
| Token | Value | Use |
|---|---|---|
| `--bg-deep` | `#0E0A05` | deepest background (scrollbar track) |
| `--bg-base` | `#141008` | page background |
| `--bg-surface` | `#1C1509` | sidebar, bars, sheets |
| `--bg-raised` | `#241C0D` | **dark panels / cards** |
| `--bg-card` | `#F5EDD8` | **parchment** (light surface) — NOT a dark panel |
| `--bg-card-dark` | `#EDE0C4` | parchment, shaded |

> **Gotcha:** `--bg-card` is parchment (light). For a dark box use `--bg-raised`.

### Colour — text
`--text-parchment` `#F5EDD8` (body on dark) · `--text-light` `#D4C49A` (secondary) ·
`--text-muted` `#9A8660` (tertiary / labels) · `--text-cream` `#F0E6D2` (body on the
*darkest* panels — cards, widgets, inputs) · `--text-ink` `#2B1A00` / `--text-ink-light`
`#5C3D14` (text **on** parchment).

### Colour — brand accents
`--accent-gold` `#C8A040` (primary) · `--accent-gold-dim` `#8B6914` · `--accent-crimson`
`#8B2020` · `--accent-ember` `#C04020`.

### Colour — faction & status
`--faction-{cult-high,cult-red,dragon,party,greenest,neutral,mystery}` ·
`--status-{alive,dead,captured,unknown}`. These are the solid base colours.

### Colour — channel tokens (for alpha)
Comma-separated RGB channels, used as `rgba(var(--X), <alpha>)` for borders / tints /
glows / translucent backgrounds:
- `--accent-gold-rgb` `200,160,64` — the single most-used colour (~150× as
  `rgba(var(--accent-gold-rgb), α)` borders/tints).
- `--gold-muted` `212,184,122` — muted-gold borders/rules (~80×).
- `--status-{alive,dead,captured,unknown}-rgb` — the 0.25/0.5-alpha badge + toast
  backgrounds and borders.

### Colour — semantic feedback (text on dark)
For toasts, status badges, form validation, editor syntax:
`--color-danger` `#EF9A9A` · `--color-danger-bright` `#FF8888` (form errors) ·
`--color-danger-bd` `#CC4444` (border) · `--color-success` `#A5D6A7` ·
`--color-info` `#90CAF9` · `--color-mystery` `#CE93D8`.

### Colour — priority (event / mystery urgency)
`--priority-critical` `#EF5350` (kritická) · `--priority-high` `#FF9800` (vysoká) ·
`--priority-medium` `#FFD54F` (střední) · `--priority-low` `#9CC69A` (nízká).
Theme-agnostic by default (no `[data-theme]` override yet).

### Colour — on-accent ink
`--color-on-accent` `#2B1A00` — dark ink for text/icons sitting **on** a gold
(accent) button surface (same value as `--text-ink`, named for the contrast role).

### Borders — hairlines on dark
`--border-subtle` `rgba(255,255,255,0.07)` (the recurring card / panel / row
separator — the 0.05–0.07 cluster) · `--border-faint` `rgba(255,255,255,0.04)`
(the lighter variant). White-channel, so they read on every dark theme.

### Spacing (4 px rhythm)
`--space-1`=4px · `--space-2`=8px · `--space-3`=12px · `--space-4`=16px ·
`--space-5`=24px · `--space-6`=32px. Use for padding / margin / gap.

### Type scale
`--text-xs` .75 · `--text-sm` .85 · `--text-base` 1 · `--text-lg` 1.2 · `--text-xl` 1.5 ·
`--text-2xl` 2 · `--text-3xl` 2.6 (rem). Use for `font-size`.

### Font families
`--font-title` (Cinzel — display headings) · `--font-body` (Crimson Text —
article prose) · `--font-ui` (system stack — chrome, forms, chips). Use for
`font-family`; never name a typeface directly.

### Radius · shadow · z-index · motion
Radius: `--radius-sm` 4 · `--radius` 6 · `--radius-lg` 12 · `--radius-pill` 999 (px).
Shadow: `--shadow-sm/md/lg` (elevation) + `--shadow-card`, `--shadow-glow-gold`.
Z-index: `--z-base/sticky/drawer/dropdown/modal/toast` — stay on these rungs.
Motion: `--ease-out`, `--dur-fast` .12s / `--dur-base` .18s / `--dur-slow` .25s.
A global `@media (prefers-reduced-motion: reduce)` block in `main.css`
near-zeroes all animations/transitions + smooth scroll, so individual
components don't each need to handle it.

### Breakpoints (documented; CSS can't tokenize `@media`)
`768px` mobile / sidebar drawer · `1100px` wiki two-col→one · `1200px` split editor
two-col→one. Use these three, nothing else.

---

## Component vocabulary (non-exhaustive)

Reuse these instead of restyling. The authoritative definitions live in the CSS
files noted; this is the everyday set:

- **Buttons** — `.inline-create-btn` (secondary / "＋ add"), `.edit-save-btn`
  (primary save), `.edit-delete-btn` (destructive), `.back-btn`. Map/timeline/
  cloudmap toolbars use `.sc-btn` (+ `.ok`/`.err`).
- **Page chrome** — `.page-header` (wraps the page `<h1>`).
- **Settings panels** — `.settings-panel`, `.settings-editor-head`,
  `.settings-hint` (muted help text), `.settings-field` + `.settings-field-label`,
  `.edit-input` (text input / select). (`settings.css`, `edit.css`)
- **Badges / chips** — `.badge-status-{alive,dead,captured,unknown}`
  (`wiki.css`), `.role-badge-chip` (`edit.css`). The chip/badge families share a base
  `.chip` (inline-flex · centred · UI font) grouped in `main.css`; each
  variant keeps its own radius/padding/colour.
- **Round icon button** — `.icon-btn-round` (26px circular pencil base,
  `main.css`), shared by `.edit-card-overlay` / `.oq-edit` / `.dash-hero-pen`.
- **Toasts** — `.app-toast` (+ `.err`), `.edit-toast` (+ `.ok`/`.err`).
- **Nav** — `.nav-link`, `.sidebar-section`, `.sidebar-subsection`.
- **Breadcrumb** — `.wiki-breadcrumb` (`utils.breadcrumbNav` / `host.h.breadcrumb`
  emit the markup; `wiki.css` styles, `edit.css` docks it on articles).
- **Shared component classes** (`widgets.css`, hoisted from the D&D sheet addon
  once they proved generic — host + addons alike):
  - `.codex-tip` / `.codex-pop` (+ `-l`/`-r` edge pins, `.codex-tip-u`
    underline, `.codex-pop-{title,desc,formula,terms,total}`) — the hover/focus
    popover legend ("how did we get this number").
  - `.codex-tab-strip` / `.codex-tab` (+ `.is-active`, `.codex-tab-tool`) — a
    horizontal tablist with the gold bottom-border indicator; callers own ARIA
    + keyboard wiring.
  - `.codex-tile` (+ `.codex-tile-label`/`-value`, `-accent` ring, `-wide`) —
    a labelled headline-number tile.
  - `.codex-warnings` — advisory validation-warning list.
  - `.codex-stepper` (+ `-btn`, `data-num-step`) — the −/＋ number stepper
    (`edit.css`; the click handler lives in `app.js`).

Addons get these via `host.h` (esc/dataAction/dataOn/renderMarkdown) producing the
same markup; build addon UI from this vocabulary so it looks native.

---

## File map (`@import` order in `bundle.css`)

`main.css` (tokens + reset + typography + layout + nav + mobile) → `themes.css`
(`[data-theme]` overrides; `classic` = `:root` baseline) → `wiki.css` →
`cloudmap.css` → `edit.css` → `timeline.css` → `swordcoast.css` (map) →
`factions.css` → `widgets.css` → `search.css` → `settings.css`.

---

## Unification status & known follow-ups

The design-system sweep is incremental and **safe-by-construction** (every token
substitution is exact-equal — zero visual change).

- **Done:** every colour literal that maps to a token has been tokenized — the
  gold/muted-gold channel families (236×), the status-colour channels, the
  semantic feedback hexes, and the dead `var(--tok, #wrongFallback)` fallbacks
  cleaned up (376 substitutions total). Exact-match `font-size` values → `--text-*`.
- **Follow-up (low-risk, scales already exist):** tokenize spacing/`gap`/radius
  shorthands → `--space-*`/`--radius-*` (property-aware, exact-equal); decide
  on off-scale values (e.g. `0.82rem`, `0.72rem` font-sizes; `0.55rem`,
  `0.45rem` spacings) — snap to the nearest scale step (sub-pixel change) or keep.
  Do this with the app open so each pass can be eyeballed.
- **Known orphan `var()`** (used, not defined in CSS): `--cm-z` / `--gc` / `--tc`
  are set at runtime by `cloudmap.js` and carry CSS fallbacks (intentional);
  `--font-display` is a stale reference worth chasing; `--attitude-color` /
  `--token` only appear inside comments. None are regressions.
