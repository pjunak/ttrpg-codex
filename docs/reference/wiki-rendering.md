# Wiki rendering & editors — deep reference (ttrpg-codex)

> Moved verbatim out of CLAUDE.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as CLAUDE.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## Attitude glow (characters · locations · factions · pins)

Cards and pins signal "Postoj k partě" via a **CSS drop-shadow halo
that hugs the icon silhouette** — TWO stacked colored shadows per
active attitude (a wide outer halo + a tighter inner glow ≈ 40% of
the outer blur), alpha = strength (0..1) on both layers. The double
layer makes 100% strength read as a confident glow rather than a
washed-out haze; 50% still looks proportionally subtle because
both layers fade together. Multiple attitudes blend additively, so
a place that's `[{neutral, 1.0}, {hostile, 0.5}]` renders a strong-
blue + weak-red mixed glow without any per-segment masking. Empty
`attitudes[]` = no filter applied = no glow ("not yet meaningful").

The glow is applied directly to the icon-bearing element (no card-
wide ring anymore):
- **Character cards / dashboard party**: inline `style="filter: ..."`
  on the `.portrait-wrap`. Composes cleanly with the existing
  `[data-knowledge="N"] .portrait-img { filter: url(#sketch-N) }`
  rule because the two filter stacks live on different elements.
- **Location cards**: inline filter on `.loc-card-icon`.
- **Faction article side card**: inline filter on the `.ah-icon`
  badge.
- **Map pins** (`.sc-pin`): inline filter on the marker `<div>`,
  with a smaller `blurPx` (`max(4, round(size * 0.18))`) tuned for
  pixel-scale visibility.

`wiki.js` helpers:
- `_attitudeColorMap()` — id → color lookup from the `attitudes` enum
  (uses `labelColor || bg`).
- `_hexToRgba(hex, alpha)` — parses `#rgb`/`#rrggbb` and returns
  `rgba(...)` for use in drop-shadow stops.
- `_attitudeGlow(entries, colors, blurPx = GLOW_BLUR_PX)` — returns a
  CSS `filter:` value (`drop-shadow(...) drop-shadow(...) ...`) or
  `''` when no entry has positive strength. Default blur is 7 px on
  cards.
- The renderer pulls `entries` from `Store.getEffectiveAttitudes(c,
  'character')` so faction inheritance (empty own-attitudes →
  faction's attitudes) and the party shortcut both happen in the
  Store rather than in each call site.

`map.js` carries its own `_hexToRgba` and `_attitudeGlowFilter`
copies (small enough that depending on wiki.js for them isn't worth
the cycle); `_pinIcon` uses a smaller blur tuned to marker size.

**Striped multi-attitude glow on map markers.** When a pin carries
2+ active attitudes, `_pinIcon` switches from the additive stacked-
drop-shadow blend to a *segmented* renderer: it emits one stacked
copy of the icon per attitude, each with its own drop-shadow filter
and a sheared `clip-path: polygon(...)` slab so the colours stripe
across the marker rather than blending into one muddy halo (TF2-
style diagonal slab cuts — the angle reads better than a hard
vertical line). The leftmost slab's polygon extends past x=0 and
the rightmost past x=100% so the halo blooms unclipped on the
marker's outer edges; every slab also extends ±100% vertically with
the shear angle preserved at y=0 and y=100% so vertical bloom isn't
clipped. Helpers: `_resolveAttitudeStripes(entries)` normalises the
list, `_stripeGlowFilter(att, blurPx)` builds one slab's filter,
`_stripeClipPath(i, N)` builds the polygon. The single-attitude
path is unchanged (no clip-path needed when there's only one
colour, so the glow blooms freely). Wiki portraits / location
cards / faction badges still use the additive stacked-shadow mix
in `wiki.js._attitudeGlow` — they're single-element renders rather
than stacked-layer composites; extending the stripe approach to
them would require wrapping every call site in a multi-img stack.

Empty `attitudes[]` everywhere = no glow. Removing the `unknown` id
from the enum is what made this clean — the absence of any attitude
is itself "unknown", so the renderer doesn't need a special-case
filter.

The old `.has-attitude-ring::before` pseudo-element + `--attitude-ring`
custom property approach is gone; the CSS rule was deleted.

## Dashboard

`renderDashboard()` in `wiki.js` renders four stacked sections:

1. **Hero** — `_dashHeroHtml(campaign, editing)`. Two centered lines:
   the campaign name (big) and tagline (thin subtitle). In edit mode
   both become `contenteditable="plaintext-only"` regions with a
   dashed hover outline; `onblur` commits via `Wiki.saveCampaignField
   → Store.setCampaign`. Enter blurs (no newlines in the title).
2. **Naše parta** — responsive `grid-template-columns:
   repeat(auto-fill, minmax(180px, 1fr))`. Each PC shows a circular
   portrait, name + status dot, title, and an aktuální-location chip.
   Header action: "Celá parta →" linking to `/parta`. Edit mode adds
   a `＋ Nová postava` card at the end.
3. **Poslední sezení** — events whose `sitting` equals the max over
   all events, sorted by `order`. Each row links to `/udalost/:id`
   and shows `e.name`, `e.short`, and a small character/location
   count meta line. Empty state hidden in read mode.
4. **Otevřené záhady** — top 3 unsolved mysteries by `PRIORITY_ORDER`
   (kritická < vysoká < střední < nízká), then name. Each row shows
   the priority chip and the first question.

The old "Mind mapy" + "Rychlý Přehled" + "Poslední úpravy" dashboard
blocks were removed. Legacy `.dashboard-title` / `.dashboard-subtitle`
CSS classes remain as aliases in case something external still links
to them, but nothing inside the app uses them anymore.

Export: `Wiki.saveCampaignField(field, value)` — called from the
hero's contenteditable `onblur` handler.

## Wiki article layout

Every entity article (character / location / event / faction / mystery
/ deity / artifact / historical event) uses the shared
`_articleShell(...)` helper in `wiki.js`. Two-column grid:

- **Breadcrumb action bar `.article-actions`** above the grid, on EVERY
  article: a horizontal `utils.breadcrumbNav` row (list root → location
  `parentId` ancestors → current; last crumb unlinked, `›` separators —
  the old generic ← Zpět button and the vertical rail trail are gone).
  On wide containers (`@container (min-width: 1700px)` on
  `.article-shell`, edit.css) the bar docks absolutely into the shell's
  top-left gutter — level with the content, cqw-clamped so it can't
  overlap the columns — so it stops reserving a row; narrower screens
  keep it as a thin in-flow row.
- **Left sidebar `.wiki-side`** (sticky, ~300 px): `.wiki-side-card`
  with the visual (portrait or `.ah-icon`) + title + subtitle + chips
  + facts + the **✏ Upravit button (last child — bottom-right corner
  of the card, compact; anchored to the record it edits)**, then
  `.wiki-outline` (auto-generated TOC from the article body's markdown
  headings — hidden when the body has no H1/H2/H3).
- **Main column `.wiki-main`** (capped at 1100 px): freeform
  `.char-section` blocks for structured data (chips, fact lists,
  relation chips) followed by `.article-body` for the markdown
  narrative.

The whole grid is centered with `justify-content: center`, so on
wide screens the sidebar sits in space that would otherwise be
empty padding and the main column keeps its 1100 px width.
Collapses to single-column under 1100 px viewport.

**Full-width takeover** (`Addons.bodyOverridden(kind)` — an addon holds
an exclusive replace/hide claim on `<kind>:body`, e.g. the D&D sheet's
tab strip): the shell gains `.article-shell-full` / `.wiki-article-full`
(single `minmax(0, 1400px)` column), the rail is dropped, and the
side-card (as a floated `.article-sidecard-inbody` block) **plus every
core + addon section** fold INTO the body fragment handed to the
takeover addon — the addon receives the whole wiki profile as one blob
(the sheet shows it as its Overview tab, so the tab strip sits at the
very top). `<kind>:section:*` fragment ids don't exist on such pages; a
section-targeted claim reports as unmatched. The breadcrumb bar renders
identically in both modes.

Shell signature:
```
_articleShell({
  visual,   // HTML for portrait or <div class="ah-icon">🛕</div>, or null
  title, subtitle,
  chips,    // array of badge/chip HTML strings (in side card)
  facts,    // [{label, value}] — key/value list in side card
  sections, // [{title, html}]  — rendered as .char-section above body
  body,     // the markdown article HTML (usually <div class="md-view">…</div>)
  outlineSource,  // raw markdown for TOC generation (pass the description)
  editButton,     // _articleEditButton(collection, id) — rides the side-card
  kind, entity,   // fragment ids + breadcrumb root + override ctx
})
```

The outline uses `extractOutline(src)` from `utils.js`; heading IDs
are injected by `renderMarkdown` via a post-sanitize DOM walk that
calls `slugify(heading.textContent)`.

Do not reintroduce the old right-side `.wiki-aside` / `.wiki-infobox`
approach — it used `--bg-card` (parchment) and clashed with the
dark theme.

## Split editor layout

Every "article-style" editor wraps its form in `.edit-form-split` —
a 2-col grid (compact structured fields on the left, tall markdown
textarea on the right). Applied to: character, location, event,
mystery, deity (buh), artifact, historical-event editors.
Faction editor stays single-column because the rank-chain tables
need full width.

Layout is defined in `edit.css` → "Split editor layout":
- `grid-template-columns: minmax(0, 1fr) minmax(0, 1.8fr)`
- `max-width: 1800px`, `margin: 0 auto`, `justify-content: center`
  — so the empty space on the left and right of the column pair is
  symmetric on wide screens
- `.edit-form-split-header` spans both columns (`grid-column: 1 / -1`)
- `.edit-form-split-article` is `position: sticky; top: 1rem` so the
  prose editor stays in view while scrolling the structured fields,
  and its CodeMirror pane has `min-height: calc(100vh - 10rem)` to
  fill the viewport
- Collapses to single column under 1200 px (phantom column becomes
  static, min-height drops to 400 px)

Template structure every split editor follows:
```
<div class="edit-form edit-form-split">
  <div class="edit-form-header edit-form-split-header">…</div>
  <div class="edit-form-split-fields">…structured fields…</div>
  <div class="edit-form-split-article">…_mdTextarea(…)…</div>
</div>
```

## Markdown editor (EasyMDE)

`_mdTextarea(id, value, rows, placeholder)` in `edit_templates.js`
emits a plain `<textarea class="md-easy">`. `EditMode.mountEasyMDE(root)`
walks the subtree and upgrades every un-mounted `.md-easy` textarea
into an `EasyMDE` instance (`window.EasyMDE` loaded from CDN in
`index.html`). `app.js:navigate()` calls it after `Widgets.mountAll`
on every route change.

EasyMDE settings: `forceSync: true` (so `textarea.value` stays live —
existing save code reading `document.getElementById(id).value`
works unchanged), `spellChecker: false`, status bar with
lines/words, and `previewRender` wired to our sanitized
`renderMarkdown` (marked + DOMPurify). Toolbar: bold / italic /
strikethrough / H1-H3 / quote / lists / link / image / table /
code / hr / preview / side-by-side / fullscreen / undo / redo /
guide. Shortcuts: Ctrl+B, Ctrl+I, Ctrl+K (link), Ctrl+H (heading),
Ctrl+P (preview), F9 (side-by-side), F11 (fullscreen).

Dark-theme overrides live in `edit.css` under "EasyMDE — dark theme
overrides" — targets `.EasyMDEContainer` / `.editor-toolbar` /
`.CodeMirror` / `.editor-preview*`. Don't revert to a light theme;
the library ships light by default.

See the "Split editor layout" section above for how the sticky
prose editor lives inside `.edit-form-split-article`.

## Draft recovery + dirty guard

`editmode.js` autosaves every `.md-easy` markdown textarea to
localStorage and warns before the user can lose unsaved edits.

**Autosave:** `_wireEasyMDEDraft(mde, textarea)` (called from
`mountEasyMDE` for every mounted EasyMDE) subscribes to CodeMirror
`change` and writes `{ content, savedAt }` to
`localStorage['md_draft:<textareaId>']` after a 500 ms debounce
(`DRAFT_DEBOUNCE_MS`). `window.pagehide` flushes all pending timers
so the last keystrokes survive tab close. Drafts expire after 30 days
(`DRAFT_TTL_MS`).

**Banner:** On mount, if a stored draft for this textarea id differs
from the loaded entity's content, `_showDraftBanner` inserts a small
banner above the EasyMDE wrapper with **Obnovit** / **Zahodit**
buttons (styled in `edit.css` → "Draft-recovery banner"). If the
draft matches the loaded content, it's auto-cleaned as stale.

**Dirty guard:** A module-level `_dirty` boolean flips true on any
`input`/`change` event inside an `.edit-form` (captured document-wide
so dropdowns, chips, and multiselects all count — not just MD). The
flag goes through `_setDirty()` so each `false→true` transition fires
an `editmode:dirty` window event; `_markClean()` fires
`editmode:clean` symmetrically. `EditMode.isDirty()` is exposed in
the public API for other modules to gate behavior on unsaved state.

- `window.beforeunload` sets `preventDefault` when dirty → native
  "are you sure?" browser prompt on tab close/refresh.
- A capturing `click` listener on `document` watches for `<a
  href="#/…">` navigations; if dirty, it `confirm()`s before letting
  the hash change. Declines cancel the navigation.
- `Wiki.cancelEditingArticle` (the editor's `← Zrušit` button)
  confirms before exiting edit state when dirty. The legacy
  `EditMode.toggle()` global-mode prompt is gone along with the
  toggle itself.
- Every successful `save*()` in `editmode.js` ends with
  `_markClean(); _navigateOrRefresh(…)`. `_markClean` clears `_dirty`
  and wipes drafts for every currently-mounted `.md-easy` textarea
  (the saved entity's content now matches, so drafts are stale).

Only MD content is restored from drafts — other form fields (name,
dropdowns, chip selections) aren't persisted. The guard covers the
whole form; recovery covers just the body.

**SSE / dirty interaction:** the SSE listener in `app.js` checks
`EditMode.isDirty()` before applying a `data-changed` event. If
dirty, it stores `_pendingHash` and pops a `#remote-change-banner`
(blue, top-of-page) with **Načíst** / **Zavřít** buttons. The banner
also auto-clears on `editmode:clean` (the user saved), at which
point the deferred change is applied. This replaces the older
`focusin`/`focusout` selector-based pause, which missed CodeMirror's
contenteditable surface and could clobber EasyMDE mid-keystroke.

**EasyMDE leak prevention:** `mountEasyMDE` tracks every instance in
`_mountedEasyMDE` and runs `_cleanupOrphanedEasyMDE()` before each
mount pass. Any tracked instance whose `mde.element.isConnected` is
false (because `navigate()` did `innerHTML = ...`) is torn down via
`mde.toTextArea()` so document-level listeners don't accumulate.

**Heading slug disambiguation:** `extractOutline` and the heading
post-process inside `renderMarkdown` both dedupe duplicate slugs
with `-2`, `-3`, … suffixes. They MUST stay in sync — same
`slugify` input, same dedupe counter — so TOC anchor links resolve
to the right heading even when two headings share the same text.
