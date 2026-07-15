# Settings (/nastaveni) — deep reference (ttrpg-codex)

> Moved verbatim out of CLAUDE.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as CLAUDE.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## Settings (user-editable enums) — `/nastaveni`

`data/settings.json` is a **keyed-by-category** object (not an entity list):
```json
{
  "relationshipTypes": [...],
  "genders":           [...],
  "pinTypes":          [...],
  "characterStatuses": [...],
  "eventPriorities":   [...],
  "attitudes":         [...],
  "mapViews":          [...]
}
```

The `locationStatuses` and `artifactStates` categories were retired:
the location-status icon-variant strategy was never used in practice,
and `artifactStates` was a purely cosmetic chip with no search /
filter / icon hook. `_migrateDropLocationStatus` /
`_migrateDropArtifactState` strip the now-orphaned fields from every
record on load.

**`attitudes`** is the unified "Postoje k partě" palette used on
characters, locations and factions. Each enum item carries
`{id, label, bg, fg, labelColor, strength}`. Default ids:
`ally` · `enemy` · `hostile` · `neutral` · `party`. `unknown` is
gone — empty `attitudes[]` is itself the "no stance set" baseline,
so removing the id avoids the ambiguity of having two ways to
express the same thing. `party` is auto-applied to PCs whose
`faction === 'party'` regardless of any other field, so it's mostly
useful for our own strongholds on the map.

The `strength` field (0..1, default 1.0) drives glow intensity and
lives **on the enum item**, not on the per-entity entry — editing
it in Settings updates every glow at once. Per-entity entries are
just `{id}`. Strength used to live on each entry (`{id, strength}`);
two migrations strip the legacy field on load:
`_migrateAttitudesToObjectShape` and `_migrateStrengthFromEntityToEnum`.
Chip rows in the character/location/faction editors are plain on/off
toggles. Renderers read `def.strength` via the enum lookup
(`_attitudeGlow` in wiki.js, `_resolveAttitudeStripes` in map.js).

**⚠ Idempotency contract for `_migrateAttitudesToObjectShape`** —
canonical entry shape is `[{id}]` *without* a `strength` field. The
normalize helper inside this migration MUST NOT re-add `strength`
to entries that already lack it; if it does, it bounces with
`_migrateStrengthFromEntityToEnum` on every load (one writes the
field, the other strips it) and the resulting infinite SSE-driven
re-render loop makes the page flicker until the user force-closes
it. The hash-dedupe in `_applyRemoteChange` cannot save you here
because each cycle's content genuinely differs (`{id:'enemy'}` ↔
`{id:'enemy', strength:1.0}`). When adding a new field to the
attitudes entry shape, mirror this discipline: only mark `changed
= true` when the input is non-canonical.

Seeded from `SETTINGS_DEFAULTS` in `data.js` on first load via
`store._mergeDefaults`. Per-id deletions are tombstoned as
`deletedDefaults: ["settings:<cat>:<id>", …]` so re-seed doesn't
resurrect them.

**Not in settings** (coupled to code/SVG/CSS): `knowledgeLevels`
(0–4, tied to SVG sketch filters), faction structure (already a
first-class collection), pantheon / artifacts (same).

### Store API
- `getSettings()` → full object
- `getEnum(cat)` → array for one category
- `getEnumValue(cat, id)` → item or synthetic `_orphan: true` fallback
- `getEffectiveAttitudes(entity, kind)` → `[{id}]` resolver used by
  every glow / chip renderer (strength comes from the enum lookup,
  not the returned entry). Rules: party PCs (`faction === PARTY_FACTION_ID`)
  always return `[{id:'party'}]`; otherwise the entity's own
  non-empty `attitudes[]` wins; characters with empty own-attitudes
  inherit their faction's `attitudes[]`; empty everywhere returns
  `[]` (no glow).
- `saveEnumItem(cat, item)` — upsert by id
- `findEnumUsages(cat, id)` — `[{ collection, field, id, name }]`
- `deleteEnumItem(cat, id, { replaceWith, force })` — returns
  `{ ok, usages }`. Without `replaceWith`/`force`, refuses when
  usages > 0 so the caller can surface a modal.
- `resetEnumCategory(cat)` — adds missing defaults, leaves edits
- `getSidebarLayout()` / `setSidebarLayout(layout)` — the DM-curated,
  registry-reconciled sidebar layout (`settings.sidebarLayout`). Powers
  the `Sidebar` module's render + the **Postranní panel** drag-drop
  editor (see **Sidebar structure**). `getHiddenSidebarPages` /
  `setHiddenSidebarPages` survive as thin shims over `layout.hidden`.
- `getMapConfig(mapId)` / `setMapConfig(mapId, patch)` — per-map
  knobs (currently just `zoomScaleRatio`, 0..1). `mapId` is `'world'`
  for the main map, `'local-${locationId}'` for sub-maps (matches
  `_currentMapId` in map.js). Stored under `settings.mapConfigs`
  keyed by mapId. Defaults filled in via `_defaultMapConfig`. The
  Mapy Settings tab edits this; `WorldMap` reads it on every
  zoomend to compute the marker scale.

### Where it plugs in
- `Store.getStatusMap()` reads `characterStatuses`
- Character editor `gender` picker reads `getEnum('genders')`
- Character editor + location editor + faction editor + map pin form
  all use the same `EditTemplates.attitudeChipRow(rowId, entries)`
  helper — plain on/off chips (strength is on the enum, not the
  entry, so no per-chip slider). Read-back lives next to the HTML
  in `EditTemplates.readAttitudeChipRow`. Glow renderers pull from
  `Store.getEffectiveAttitudes`. Editing an attitude colour OR
  strength in settings updates every card glow, the side-panel
  legend, and the article chips at once.
- Map markers route through `_resolveIconUrl(pin)`: uploaded
  artwork (`pinTypes[i].iconConfig.files`) → bundled game-icons SVG
  (`web/icons-defaults/<id>.svg`) → emoji glyph (last resort).
  Strategies are `single` (files[0]) and `random` (deterministic
  hash per pin id). `WorldMap.bundledDefaultUrl(id)` is exported so
  the Settings marker-icon panel can surface the bundled default
  as a "Výchozí ikona" placeholder.
- `REL_TYPES` in `data.js` + `getRelType(id)` is still the canonical
  cloudmap/consumer source; settings keeps the user-edited copy in
  `_data.settings.relationshipTypes`. If you move more consumers to
  read from settings, update `SETTINGS_USAGE_MAP` accordingly.

### findEnumUsages handles three storage shapes
`attitudes` is an array-of-objects (`[{id}]`) on three collections:
characters, locations, AND factions. `findEnumUsages` recognises
scalar fields, string-array fields, and object-array fields;
`deleteEnumItem` walks both array collections AND keyed-object
collections (factions via `Object.values`), and its replace-with
branch rewrites entry ids. Each touched record gets its own
`_sync('factions', 'save', {id, data})` or `_sync('<coll>', 'save', e)`
call so the server sees both ends of the change (fixes a latent
sync bug where array-shaped remaps updated memory but never
persisted).

### Sync contract (server)
Settings is treated like `factions` — a keyed-object collection.
Save shape: `{ type:'settings', action:'save', payload:{ id:<category>, data:<fullArray> }}`.
Delete is always a full-array overwrite via `save`; there's no
per-item delete on the wire.

The server no longer validates relationship type or character status
values — the client-side settings are truth. Structural validation
(collection name, action) stays on the server.

### Settings page tabs

`settings.js` has two kinds of tabs. Regular **category** tabs (from
the `CATEGORIES` array) render the enum editor; **special** tabs
(from `SPECIAL_TABS`) render custom panels. Seven special tabs exist:
`appearance`, `playerParty`, `worldmap`, `sidebarPages`, `addons`,
`backup`, `account` (label **Server**). The former `branding` tab is a
SECTION inside `appearance`, and the former `mapViews` tab is a
per-map SECTION inside `worldmap`; `_editorHtml` coerces the two stale
tab ids for any session still pointing at them.

**Role-aware visibility.** `_visibleEnumTabs()` / `_visibleSpecialTabs()`
filter the rendered tab list by `Role.isDM()`:
- DM viewers see everything (every CATEGORY + every SPECIAL_TAB).
- Non-DM viewers (player, or DM in "view as player" mode) see only
  **Server** (the account tab) + **Záloha** — the rest are DM-only
  saves that would silently fail server-side.

**Default tab.** `_tabPickedByUser` is a session-local flag. Before
the user picks a tab, the landing tab is role-aware: non-DM viewers
land on `account`, DMs land on the first enum editor (`relationshipTypes`).
After any explicit click on a tab, the choice sticks for the rest of
the session. `_pageHtml` also defensively coerces `_activeCat` to
`account` if a role flip (e.g. DM enters "view as player" while on
Vazby) leaves the active tab outside the visible set.

- `appearance` (label: **Vzhled**) — Visual-theme switcher **plus the
  branding section** (`_brandingSectionHtml` — the former Logo a značka
  tab: logo upload/revert + sidebar wordmark; same Store surface,
  `settings.branding` via `setBranding`/`uploadLogo`/`deleteLogo`).
  Theme: a `<select>`
  over the `THEMES` registry (constants.js); the pick is stored campaign-
  wide in `settings.appearance` (`{theme}`, DM-only write) and pushed onto
  `<html data-theme="<id>">` by `Settings.applyTheme()` (called at boot, on
  every SSE refetch, and after a change; mirrored to `localStorage`
  `codex_theme` for a flash-free early apply in app.js). A theme is a
  `[data-theme="<id>"]` token-override block in `web/css/themes.css`;
  `classic` is the bare `:root` baseline. Adding a style = one `THEMES`
  entry + one themes.css block, no component edits (every component reads
  `var(--token)`) — which re-skins addons for free too.
- `addons` (label: **Doplňky**) — a TWO-LEVEL surface: a `.codex-tab-strip`
  of sub-tabs switching between the DM-only **Manager** (`_addonsManagerHtml`)
  and every **addon-registered settings tab** (`registerSettingsTab` —
  they are NOT top-level tabs anymore; `_pageHtml` coerces a stale
  pre-restructure `_activeCat` addon-tab id into `addons` + `_activeAddonSub`).
  Sub-tab state: `_activeAddonSub` (`'manager'` | `'<addonId>:<specId>'`,
  role-aware default) via `Settings.selectAddonSub`; the strip is skipped
  when only one entry is visible. Non-DM viewers get the `addons` tab
  only when at least one addon ships a player-visible settings tab
  (`role !== 'dm'`) — they see the addon sub-tabs, never the Manager,
  and `selectCategory('addons')` skips the DM-only list fetch for them.
  The **Manager** lists
  installed addons from `GET /api/addons` (lazy-loaded on tab entry like
  the account tab) with live load-state badges + enable/disable/remove
  (`POST /api/addons/:id/enable|disable`, `DELETE /api/addons/:id`), and a
  `＋ Instalovat z GitHubu` button opening the **install wizard** modal
  (`Settings.openAddonWizard` — paste a GitHub URL → `POST /api/addons/install`
  → the addon live-loads via the `addons-changed` SSE reconcile, no reload).
  Toolbar also has **⬆ Aktualizovat vše** (`Settings.updateAllAddons` →
  `POST /api/addons/update-all` — updates every GitHub addon at once; local addons
  skipped). The **♻ Restartovat server** button MOVED to the `account`
  (**Server**) tab; when the server is restartable the addons intro shows a
  hint pointing there. All built on design-system tokens/classes. See
  **Addon framework**.
- **Branding — a SECTION of `appearance`** (`_brandingSectionHtml`; used to
  be the `branding` tab). Site logo + sidebar wordmark editor. Uploads a
  custom logo (`POST /api/logo` →
  `data/branding/logo.<ext>`, 5 MB cap) or reverts to the bundled
  default (`DELETE /api/logo`); also edits the sidebar title +
  subtitle text. Config is stored in `settings.branding`
  (`{logoUrl, title, subtitle, updatedAt}`) via `Store.setBranding`.
  `Settings.applyBranding()` pushes it onto the chrome — the
  `.js-brand-logo` `<img>`s (sidebar + loading screen), the
  `#sidebar-logo-title` / `#sidebar-logo-sub` spans, the `#favicon`
  link, and `document.title`. Called from app.js at boot, in
  `_applyRemoteChange`, and on `role:changed`. Empty `logoUrl` =
  render `/branding/logo-default.svg`; non-empty is cache-busted by
  `updatedAt`. DM-only (settings is in `DM_ONLY_WRITE_TYPES`).
- `worldmap` (label: **Mapy**) — Per-map editor covering image
  upload AND per-map config. Left side: explorer tree
  (`_mapsTree` + `_renderMapNode`) mirroring the `location.parentId`
  hierarchy — world root + every location with a `localMap`, nested
  under its nearest mapped ancestor. Un-mapped locations appear only
  as faint italic breadcrumb "ghosts" on mapped descendants' rows so
  lineage stays visible without cluttering click targets. Right
  side: selected map's preview, upload button (`POST /api/worldmap`
  for world / `POST /api/localmap/:locId` for sub-maps), and a
  zoom-scale slider that writes
  `settings.mapConfigs[mapId].zoomScaleRatio` (0..1). World uploads
  clear the legacy `localStorage['world_map_image_url']` override.
  **Self-commit suppression:** `Settings.commitMapZoomRatio` is
  debounced 600 ms; once it fires, `_selfCommitUntil = now + 1500`,
  exposed via `Settings.isPendingSelfCommit()` so app.js's
  `_applyRemoteChange` skips the wholesale `navigate()` re-render
  when our own PATCH echoes back (the user is dragging — don't yank
  the slider DOM out from under them). Genuine remote edits during
  the 1.5 s window get one missed re-render at worst. Then
  `WorldMap.applyZoomScaleRatio(mapId)` rescales the live map.
  Preview `<img>` URLs use per-map cache-bust tokens
  (`_previewBust[mapId]`) bumped only on successful upload.
  The panel also hosts the **saved-views (Pohledy) section**
  (`_mapViewsSectionHtml`; used to be the `mapViews` tab): the SELECTED
  map's user-captured zoom/pan presets, rename/delete only — creation
  happens on the map itself via the ✚ toolbar button.
- `sidebarPages` — the **drag & drop sidebar layout editor**
  (the tab delegates to `Sidebar.renderEditor()`). DM-only. Drag pages
  between sections or into the Skryté bucket, drag a section grip to
  reorder sections, rename / set icon / toggle collapsible / DM-only per
  section, add / delete sections. Every change persists to
  `settings.sidebarLayout` and re-renders the live sidebar instantly.
  See **Sidebar structure** for the model + DnD wiring.
- `backup` — Snapshot system + ZIP download/upload. **Role-aware UI:**
  non-DM viewers see only the snapshot list (read-only — no per-row
  actions) plus the `＋ Vytvořit bod zálohy` and `↻ Obnovit` buttons.
  DM sees additionally: `📥 Stáhnout ZIP`, `📤 Obnovit ze zálohy…`
  (uploads ZIP or JSON), `↶ Vrátit posledních X úprav`, and per-row
  ↶ restore / 🗑 delete. The hide is in `_backupHtml` / `_snapshotRow`
  via `Role.isDM()` checks; the server enforces the same gating via
  `requireAuth` on destructive endpoints (`/api/backup`, restore /
  delete / revert-last-N) while leaving `GET /api/snapshots` and
  `POST /api/snapshots` (manual create) open to any authed role.
  ZIP download stays DM-only because the raw `data/*.json` files
  bypass the role-filter — a player download would leak `visibility:
  'dm'` entities.
- `account` (label: **Server**, icon 🖥) — Role chip + Odhlásit +
  (DM-only) view-as-player / back-to-DM toggles + DM-only password
  rotation forms **+ the DM-only ♻ Restartovat server button** (moved
  here from the addons toolbar; gated on `/api/version canRestart`,
  `Settings.restartServer` → `POST /api/restart` with the
  `#server-restart-overlay` that polls until the server is back, then
  reloads — still how server-side addon code (re)loads after an
  install/update). Visible to any authed viewer. See "Auth flow" below
  for the password storage and cookie model.
- `playerParty` — Edit the visual identity of the PC group (name,
  icon, badge, colour). Members are NOT stored here — membership is
  derived from `character.faction === PARTY_FACTION_ID`. Replaces
  the legacy `factions.party` keyed-object record; `setPlayerParty`
  writes to `settings.playerParty`.

The sidebar "Záloha" button was removed — the single `⚙ Nastavení`
link covers backup/world-map/enums/account.

### Marker icon panel (pinTypes 🎨)

Each row in the Typy míst tab carries a 🎨 toggle next to ✏ / 🗑.
Clicking expands a `.mit-panel` below the row (only one open at a
time — opening another collapses the previous, and entering inline
edit mode collapses the panel). The panel is a self-contained
auto-persist widget — every change writes through to
`Store.saveEnumItem('pinTypes', …)` immediately:

- **Strategy radio** — `single` / `random`. Drives the resolver in
  `map.js`. Default for newly-uploaded pin types is `single` (the
  user can switch to `random` for variety). The retired `state`
  strategy (which keyed file variants off `location.status`) is
  gone; `_migrateRetirePinTypeStateStrategy` coerces any legacy
  `'state'` value to `'single'` on load.
- **File list** — each uploaded variant shows as a row with a
  thumbnail (`<img>` fed by `/icons/<pinTypeId>/<file>`), the
  on-disk filename, and a 🗑 delete button (also DELETEs the file
  off disk). No per-file metadata — `files[0]` is the default for
  `single`; `random` picks deterministically across all files.
- **Multi-file uploader** — `<input type="file" multiple>` accepting
  svg/png/jpg/webp. New files arrive with just `{id, url}`.

Resolver semantics live in [map.js](web/js/map.js) `_resolveIconUrl`:
- No `iconConfig` or empty `files` → bundled default at
  `/icons-defaults/<pinTypeId>.svg` (see `BUNDLED_DEFAULT_ICONS`),
  else null → emoji fallback. The bundled set covers every default
  `pinTypes` id seeded by `data.js`; user-created pin types skip
  the bundled fallback and go straight to emoji.
- `single` (default) → `files[0]`.
- `random` → `_hashStr(pin.id) % files.length` deterministic pick.

Bundled defaults are sourced from [game-icons.net](https://game-icons.net/)
under CC BY 3.0 (Lorc, Delapouite, Caro Asercion). The SVGs ship
white-on-transparent (the upstream black backgrounds are stripped
during import so the attitude-glow filter traces only the icon
silhouette) and per-icon credit lives in [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md)
in the repo root — the file must travel with any redistribution to
satisfy the license's attribution clause.

When a pin type is deleted from settings, `Store.deleteEnumItem`
fires `Store.deleteIcons(id)` so `data/icons/<id>/` doesn't leak.
