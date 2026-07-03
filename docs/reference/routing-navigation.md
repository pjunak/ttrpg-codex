# Routing, navigation & edit affordances — deep reference (ttrpg-codex)

> Moved verbatim out of CLAUDE.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as CLAUDE.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## Routing

Hash-based routes. All logic in `app.js:navigate()`.

| Hash | Handler | Notes |
|---|---|---|
| `/` or `/dashboard` | `Wiki.renderPage('dashboard')` | Hero (editable campaign name + tagline) · Naše parta responsive grid · Poslední sezení (events from max `sitting`) · Otevřené záhady (top 3 by priority). |
| `/parta` | `Wiki.renderPage('parta')` | Party PCs only. **No sidebar link** — route preserved for bookmarks and for the "Celá parta →" link on the dashboard. |
| `/postavy` | `Wiki.renderPage('postavy')` | NPCs only (`Store.getNPCs()` — PCs live on the dashboard's Naše parta + `/parta`). Attitude filter row (ally / enemy / hostile / neutral / party). Default sort groups by faction with per-group headers. |
| `/postava/:id` | `Wiki.renderPage('postava', id)` | |
| `/mista` | `Wiki.renderPage('mista')` | Attitude filter chips. Default sort groups by `pinType` with size-ordered grouping (bigger default sizes first → Ostatní last). Each card's `.loc-card-icon` carries the attitude glow (stacked drop-shadow per active attitude). |
| `/misto/:id` | `Wiki.renderPage('misto', id)` | |
| `/udalosti` | redirects to `#/casova-osa` | list page removed; Časová Osa is the unified view |
| `/udalost/:id` | `Wiki.renderPage('udalost', id)` | |
| `/zahady` | `Wiki.renderPage('zahady')` | List of mystery cards PLUS the aggregate **"Všechny otevřené otázky"** block at the top. The aggregate walks BOTH `mystery.questions[]` and `character.unknown[]` via `Store.getOpenQuestions()`, with a live diacritic-insensitive filter and per-row ✏ edit pencils that open the source entity in editor mode (`Wiki.startEditingArticle`). Source-attribution via border colour (purple = mystery, gold = character). |
| `/zahada/:id` | `Wiki.renderPage('zahada', id)` | |
| `/frakce` | `Wiki.renderPage('frakce')` | |
| `/frakce/:id` | `Wiki.renderPage('frakce-id', id)` | |
| `/mazlicci` | `Wiki.renderPage('mazlicci')` | Pets (Mazlíčci) hub — all pets grouped by owner (Bez majitele · Parta · per-faction · per-character). `＋ Mazlíček` opens the editor modal. Toggleable sidebar link (Settings → Postranní panel). See **Pets (Mazlíčci)**. |
| `/panteon` | `Wiki.renderPage('panteon')` | deity list |
| `/buh/:id` | `Wiki.renderPage('buh', id)` | deity article / `new` editor |
| `/artefakty` | `Wiki.renderPage('artefakty')` | artifact list |
| `/artefakt/:id` | `Wiki.renderPage('artefakt', id)` | artifact article / `new` editor |
| `/historie` | `Wiki.renderPage('historie')` | historical-events list (Svět → Historie) |
| `/historicka-udalost/:id` | `Wiki.renderPage('historicka-udalost', id)` | historical event article / `new` editor |
| `/mapa/svet` | `WorldMap.render(null)` | World map. |
| `/mapa/local/:locId` | `WorldMap.render(locId)` | Sub-map of a Location whose `localMap` image is the backdrop. Encoding the parent id in the URL means an edit-mode toggle (which dispatches a synthetic hashchange) preserves the sub-map context instead of dumping the user back to the world map. The sidebar's "Mapa" entry stays highlighted for both routes. `WorldMap.openLocalMap(parentId)` sets this hash; the wiki "🗺 Otevřít místní mapu" button uses the URL directly. `render()` falls back to the world map when the URL points at a deleted/unmapped location, so stale bookmarks degrade gracefully. |
| `/mapa/palac` | `CloudMap.render('frakce')` | alias for /mapa/frakce |
| `/mapa/frakce` | `CloudMap.render('frakce')` | |
| `/mapa/vztahy` | `CloudMap.render('vztahy')` | |
| `/mapa/tajemstvi` | `CloudMap.render('tajemstvi')` | |
| `/casova-osa` | `Timeline.render()` | |
| `/dm` | `DmDashboard.render()` | DM-only landing page. Counts DM-only entities per collection (entities with `visibility: 'dm'`) plus stub links for future DM-specific tools (session notes, plot tracker, etc.). Renders a "jen pro DM" placeholder for non-DM viewers. Sidebar entry is gated on `role: 'dm'` in `SIDEBAR_PAGES` so non-DM visitors don't see the link at all. |
| `/nastaveni` | `Settings.render()` | User-editable enums plus six special tabs: **Naše parta** (player-party visual identity), **Mapy** (per-map image upload + zoom-scale config), **Pohledy na mapě** (rename/delete captured view presets), **Postranní panel** (toggle which sidebar links are visible), **Záloha** (snapshot list, backup zip, restore, revert-last-N — role-aware: non-DM sees only the list + create-snapshot), **Účet** (role chip, logout, DM-only password rotation, DM-only view-as-player toggle). **Role-aware tab visibility:** non-DM viewers see only Účet + Záloha; DM sees everything. Anonymous visitors are intercepted by the route guard in `navigate()` and shown the login modal. |

## Wiki list-view controls (search + sort)

Postavy, Místa, Frakce each render a `.list-toolbar` above the grid.
The toolbar uses a shared `_listToolbar(kind, sortOpts)` template that
embeds a `.tf-mount` TagFilter (chips) plus a sort `<select>`.
Matching is AND across chips against a per-entity text blob using
`utils.norm` (diacritic-insensitive substring).

State lives in `Wiki._listState` and persists in `localStorage` under
key `wiki_list_state_v1`. Shape:
`{ postavy:{values[],sort,faction}, mista:{values[],sort}, frakce:{values[],sort} }`.
A back-compat migration converts any legacy `q:string` slot into
`values:[q]` on load.

Typing does not re-route. A single delegated `tf-change` listener on
`document` (installed by the Wiki IIFE) writes to `_listState[kind].values`,
persists, and re-renders only the `#wl-<kind>-grid` container. Focus
stays in the TagFilter input. Sort changes route the same way via
`Wiki.set<Kind>Sort(v)`.

Per-entity blobs:
- Postavy: name, title, tags, description, species, gender.
- Místa:   name, type, region, tags, description, status.
- Frakce:  id, name, description.

Sort keys:
- Postavy: `faction` (default), `name`, `status`, `knowledge`.
- Místa:   `name` (default), `type`, `status`, `knowledge`.
- Frakce:  `default` (insertion order), `name`, `members` (desc).

Public API: `Wiki.setPostavySearch/Sort`, `Wiki.setMistaSearch/Sort`,
`Wiki.setFrakceSearch/Sort`. The `set*Search` setters now accept an
array but also coerce a string into a one-chip filter (back-compat).

## Global search (Ctrl+K)

`GlobalSearch` in `search.js` owns a singleton overlay (`.gs-modal`)
built on first open. Keybinding: Ctrl+K / Cmd+K toggles. ↑↓ move,
Enter navigates, Esc closes. Results come from `Store.searchAll` +
manual faction scan, grouped by kind. When the input is empty, it
seeds from `Store.getRecentActivity(8)` as a quick-jump menu. The
sidebar has a `.sidebar-search-btn` chip with a `Ctrl K` hint.

## Mobile navigation

Under 768 px, `.sidebar` becomes a slide-in drawer:
`body.mobile-nav-open .sidebar { transform: translateX(0); }`
with a `.sidebar-backdrop` overlay. Bottom-nav has a `☰ Menu`
button that toggles `body.mobile-nav-open`. `navigate()` in
`app.js` removes the class so any sidebar click lands cleanly.

## Sidebar structure (data-driven, DM-configurable)

The left sidebar is **rendered from a layout config**, not static
markup. The `Sidebar` module ([web/js/sidebar.js](web/js/sidebar.js))
renders `Store.getSidebarLayout()` into `#sidebar-nav-root` — a
`display:contents` wrapper inside `.sidebar` so the sections lay out as
direct flex children exactly like the old static markup (every
`.sidebar .sidebar-section` / `.sidebar-nav` CSS selector still matches).
`Sidebar.render()` runs at boot (synchronously from the default layout
to avoid a flash, then again after `Store.load`), in `_applyRemoteChange`
(SSE), and on `role:changed`. It's in `app.js`'s `ACTIONS` map.

**Layout shape** (`settings.sidebarLayout`, DM-only write): `{ sections:
[{ id, label, icon, collapsible, defaultOpen, role, pages:[route,…] }],
hidden:[route,…] }`. Pages are referenced by route; their label/icon/role
come from the `SIDEBAR_PAGES` registry. Sections are DM-owned containers:
editable label + icon, `collapsible` (gets the ▸ toggle, generalising the
old Kompendium), and `role:'dm'` (hidden from non-DM viewers). `hidden`
is the "Skryté" bucket — visibility == membership, so a page in no visible
section doesn't render. Role gating is render-time (`_sectionHtml` /
`_pageLi` skip DM-only entries when `!Role.isDM()`), so DM links never
reach a player's DOM.

`Store.getSidebarLayout()` reconciles the saved config (else
`SIDEBAR_LAYOUT_DEFAULT` in `constants.js`) against the live registry on
every read: dead routes dropped, brand-new code routes appended to their
home section (`SIDEBAR_PAGES.section` = a section **id**) or `hidden`,
each route placed once. A legacy `hiddenSidebarPages` list folds into
`hidden` on first read. So a new route never silently vanishes and never
wipes the DM's custom layout.

The default layout mirrors the historical structure: **Přehled** (Přehled
· Mapa) · **Kampaň** (Časová Osa · Záhady · Myšlenkový Palác) · **Svět**
(Místa · Postavy · Frakce · Mazlíčci) · collapsible **Kompendium**
(Panteon · Artefakty · Historie) · DM-only **DM** (🛡 DM panel). Section
ids (`prehled`/`kampan`/`svet`/`kompendium`/`dm`) are stable: they key the
per-section collapse localStorage (`sidebar_section_open:<id>`), the
home-section target above, and the `.sidebar-section-<id>` colour rules
(Kampaň purple / Svět green survive a rename). `Sidebar.toggleSection(id)`
replaces the retired `toggleKompendium`. **`boot.js` is retired** —
collapse state is applied inside `Sidebar.render` from localStorage on the
first JS render, and the sidebar is rendered by the external `app.js`
module, so CSP stays clean (no inline script).

**Editor.** Settings → **Postranní panel** renders
`Sidebar.renderEditor()` — a **drag & drop** layout builder (DM-only tab).
Drag page rows between sections / into Skryté, drag a section grip to
reorder sections; rename sections, set an icon, toggle collapsible /
DM-only, add / delete sections. DnD is wired through delegated `document`
listeners registered once in `sidebar.js`, scoped to
`#sidebar-layout-editor` so it never clashes with the timeline's drag
handlers (they no-op unless a sidebar-editor drag set the module's
`_drag`). Each change persists via `Store.setSidebarLayout` and re-renders
both the editor (`#sidebar-layout-editor` innerHTML) and the live sidebar;
SSE propagates it. `settings.js`'s `applySidebarVisibility` is now a thin
alias to `Sidebar.render`.

The old sidebar **Parta** link was removed — the dashboard's Naše parta
section fills that role, and `/parta` stays reachable via the "Celá parta →"
action there (and via bookmarks).

**Sidebar footer.** Holds a single `⚙ Nastavení` link. The global
`✏ Úpravy` toggle that used to live here (and on mobile bottom-nav)
was retired when editing moved to per-page affordances — see the
**Per-page edit affordances** section. Anonymous viewers see a
`🔑 Přihlásit` chip floating top-right on the Přehled route; on
every other route, login is on-demand (clicking any edit pencil
surfaces the same password modal). Logout + role switching live
under Settings → Účet.

## Per-page edit affordances

The project used to have a single global "✏ Úpravy" toggle (sidebar +
mobile bottom-nav) that set `body.edit-mode` and gated every editor
render in the app. That model was retired — editing is now per-page,
per-entity, and per-field. There is no global edit-mode flag; the
`body.edit-mode` class is never set anywhere.

| Surface | Affordance | Owner |
|---|---|---|
| Article pages (postava, místo, …) | `✏ Upravit` button on the `.wiki-side-card` (last child, bottom-right corner; inside the addon's Overview tab on a body-takeover page). The action bar above the article carries only the breadcrumb. | `Wiki._editingArticle` + `Wiki.startEditingArticle(route)` |
| List-page cards | Hover-prominent `.edit-card-overlay` pencil per card | `Wiki.editOverlay(href)` → `Wiki.startEditingArticle` |
| List page headers | Always-visible "+ Přidat" button | navigates to `/<entity>/new` (renderer short-circuits to editor) |
| World map / sub-maps | Toolbar `✏ Editovat mapu` toggle (DM + player) | `WorldMap.setEditing(bool)` + `.sc-toolbar.is-editing` CSS gate |
| Timeline | Toolbar `✏ Editovat osu` toggle | `Timeline.setEditing(bool)` + `.tl-shell.is-editing` CSS gate |
| Cloudmap (palác) | Toolbar `✏ Editovat palác` toggle | `CloudMap.setEditing(bool)` + `.map-toolbar.is-editing` CSS gate |
| Dashboard hero | Per-field pen icon next to name + tagline | `Wiki.startInlineEdit(elId)` → `commitInlineEdit` on blur |
| Inline create (faction / location article) | Always-visible "+ Postava zde" etc. for authed viewers | gated by `!Role.isAnonymous()` |

**Shared mechanics:**

- **Edit affordances are visible to everyone.** Anonymous click on
  any of them surfaces the login modal (via `EditMode.promptLogin`)
  rather than hiding the affordance — discoverability beats stealth
  for a tool used by a known group. `navigate()` in app.js also has
  a route guard that intercepts anonymous nav to `/nastaveni` or
  any `/<entity>/new` and shows the same modal + a fallback
  placeholder page in case the user cancels.
- **Per-article edit state.** `Wiki._editingArticle` holds the hash
  route (e.g. `'/postava/foo'`) of the article currently rendering
  its editor. `_isCurrentArticleEditing()` returns true when the
  current `window.location.hash` matches. After save, `_markClean()`
  fires the `editmode:clean` window event, and `wiki.js` listens to
  clear `_editingArticle`. After navigation, `navigate()` calls
  `Wiki.syncEditRoute(route)` which clears state if the route changed.
- **Per-page edit toggles** (`WorldMap` / `Timeline` / `CloudMap`)
  keep their `_editing` flag in module scope. They survive route
  changes within the session and only reset on a hard reload.
  Public API on each: `setEditing(on)` (programmatic) plus
  `toggleEditing()` (no-arg, wired to the toolbar button).
- **Shared toolbar button template.** `utils.js → pageEditToggle({
  moduleName, isEditing, label })` is the single source of truth
  for the "✏ Editovat X" / "✓ Hotovo" button. Each modal-page
  module imports it and uses it via a module-local
  `_renderEditToggleHtml()` wrapper that captures the module's
  args. The button calls `<Module>.toggleEditing` with no args —
  the module reads its own `_editing` flag at click time. This
  avoids the "data-args goes stale after one click" bug that an
  arg-stamped approach would have. CSS: `.page-edit-toggle` in
  edit.css. All three toolbars position the button trailing
  `.sc-hint` / `.tl-hint` / `.map-hint` (each has `margin-left:
  auto`) so it anchors top-right consistently across pages.
- **The "← Zrušit"** button in every editor template uses
  `Wiki.cancelEditingArticle` — for an existing entity it stops
  editing + re-renders the article view; for `new` entities it
  falls through to `history.back()` so cancel jumps back to the
  list.
- **`auth:prompt-login` window event.** Modules that can't import
  EditMode directly (circular import — `editmode.js → map.js` for
  PIN_TYPES etc.) dispatch this event when an anonymous user tries
  to enter edit mode. `editmode.js` registers a single listener
  that calls `promptLogin`. Used by `WorldMap.setEditing(true)`,
  `Timeline.setEditing(true)`, `CloudMap.setEditing(true)` and
  `WorldMap.startPlacingPin`.
- The construction-stripe (`body.edit-mode::after`) and
  `.edit-only-btn` global CSS rules are gone. Each context carries
  its own visual cue: editor forms are obviously distinct from
  articles; toolbar toggle buttons get `.is-active` styling when
  on.

## Auth flow

Login lives in two places, decoupled from editing:

- **Top-right "🔑 Přihlásit" chip** on the Přehled (dashboard) route
  only, visible only for anonymous visitors. Rendered/removed by
  `_renderTopbarLogin()` in `app.js` — called from `role:changed`,
  from `navigate()` (route-dependent), and from boot.
- **Settings → Účet "🔑 Přihlásit" button** for users who navigate
  there manually.

Both buttons fire `EditMode.promptLogin()` (formerly `EditMode.toggle`;
renamed when global edit mode was retired). The function:
1. Returns immediately if `Role.isAnonymous()` is false.
2. Otherwise opens the password modal (`_passwordPrompt` in
   `editmode.js`).
3. POSTs to `/api/login` and refreshes `Role` on success.
4. Returns `Promise<boolean>` so callers can branch.

Per-page edit affordances (article ✏ Upravit, list-page ✏ pencils,
map/timeline/cloudmap ✏ Editovat toggles) call `promptLogin` first
when they detect an anonymous viewer. After successful login the
user retries the action — no auto-resume is wired yet; one extra
click is the cost of keeping the login flow stateless.

**Password storage.** Two sources, in priority order:

1. `data/auth.json` — `{ dm?: {salt, hash, updatedAt}, player?: {…} }`.
   Set by the DM via Settings → Účet. Hash is SHA-256(salt + ':' + pwd),
   16-byte hex salt regenerated on every set. Hashes (not raw passwords)
   feed the cookie-token derivation, so a password change rotates the
   secret and invalidates every outstanding cookie for that role — the
   DM's own session is automatically re-issued by `POST /api/passwords`
   so they stay logged in.
2. Env vars `DM_PASSWORD` / `PLAYER_PASSWORD` (`EDIT_PASSWORD` is a
   legacy alias for `DM_PASSWORD`). Used only when the corresponding
   role has no stored credential.

The startup warning fires when neither source is configured (or DM
falls back to the `"123"` default). A stored credential silences the
warning. `data/auth.json` is excluded from snapshots (so snapshot
restore doesn't roll back a password change) and from `_dataHash`
(so password rotation doesn't trigger no-op SSE refetches), but IS
included in the full backup zip for disaster recovery. The file lives
under `/data/` which is gitignored; written with mode `0600` on POSIX.

`app.set('trust proxy', 1)` is enabled so `req.ip` reflects the
real client IP behind nginx/Caddy/Traefik — without this the login
rate limiter would lump all clients under the proxy IP and a single
brute-forcer could lock out everyone.

### Account tab — Settings → Účet

DM-only password management plus a role chip + logout/login for any
signed-in viewer. The password subsection only renders when
`Role.getReal() === 'dm'` (DMs in "view as player" mode still see it).
Two forms, one per role, each requiring the caller's current DM
password as a safety check (so a stolen session can't silently rotate
credentials). Player-password field accepts the empty string as a
"clear stored credential" lever — when no env fallback exists, that
disables player login entirely. Status loaded lazily via
`GET /api/passwords` on tab entry, re-fetched after each successful
change so the "nastaveno (změněno…)" label updates.

Hash + verify helpers live in `server-utils.cjs` (`hashPassword`,
`verifyPassword`, `safeEqStrings`) so they're unit-testable. The
file-level `NON_DATA_JSON_FILES` set in `server.js` is the single
source of truth for which top-level JSON files are excluded from
snapshots + data hash (currently just `auth.json`).

## Inline contextual creation

`EditMode` exposes prefill helpers. They navigate to a new-entity
form with fields pre-populated. Used by faction and location wiki
pages and the cloudmap context menu.

- `startNewCharacter(prefill)` goes to `#/postava/new`. Example:
  `{faction:'cult_high'}` for "Nová postava ve frakci".
- `startNewLocation(prefill)` goes to `#/misto/new`.
- `startNewEvent(prefill)` goes to `#/udalost/new`. Example:
  `{locations:['greenest']}` for "Událost zde".
- `startNewCharacterInLocation(locId)` creates a character, then
  a one-shot `_afterSave` hook appends its id to `location.characters[]`.

Implementation: prefill stored in module-level `_prefill` and
`_afterSave` registries. `renderXxxEditor(null)` consumes prefill
on render. `saveXxx()` runs the `_afterSave` hook with the new id.
Editor templates merge prefill over defaults as
`{...defaults, ...prefill}`. Any field can be pre-set.

Cloudmap right-click on a character node offers
"➕ Přidat vazbu odsud". It navigates to that character's page and
scrolls/focuses the inline new-relationship row. Edit mode only.
