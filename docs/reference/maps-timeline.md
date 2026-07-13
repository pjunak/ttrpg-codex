# World map + timeline — deep reference (ttrpg-codex)

> Moved verbatim out of CLAUDE.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as CLAUDE.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## WorldMap — toolbar search + pin types + edit gating

Toolbar has a search input (`#sc-search`) that filters pins by
name/notes and the linked location's name/region/type (diacritic-
insensitive). Dropdown `#sc-search-results` shows live matches.
Enter or click jumps to the first hit via `WorldMap.zoomToPin(id)`,
which `flyTo`s the coordinate (capped to max zoom) then opens the
pin side-panel.

Public additions: `onSearchInput(q)`, `jumpToFirstMatch()`,
`zoomToPin(id)`, `showPin(pinId)` — the last one is safe to call
from any route (it switches to `#/mapa/svet`, hops through
`_pendingPinId` when the map isn't mounted yet, and re-renders the
right sub-map context if the pin lives on a local map).
`startPlacingPin(locId)` navigates to the correct map (world or the
location's `parentId` local map), enters add-mode, and arms the next
map click to assign x/y to that existing Location instead of opening
the new-pin form. Used by the Location detail page's "📍 Umístit na
mapu" button (visible in edit mode when the location isn't placed).

**`_isOnMapRoute()` route guard.** `_map` and `_currentParentId`
stay populated after the user navigates off the map page, so
truthy `_map` alone isn't proof the Leaflet instance is mounted.
All four public entry-points (`showPin`, `startPlacingPin`,
`showEventPin`, `startPlacingEventPin`) gate their `alreadyOnMap`
fast-path on `_isOnMapRoute() && !!_map && targetParent ===
_currentParentId` (the helper checks the hash matches
`#/mapa/svet` or `#/mapa/local/...`), so wiki-page invocations
always route through the hash-change / `_pendingPinId` flow
instead of poking a detached map.

Event-only map pins: `startPlacingEventPin(eventId)` arms the next
click to write `mapX`/`mapY`/`mapParentId` onto the Event itself
(no Location created). `showEventPin(eventId)` flies the map to a
previously-placed event pin, switching sub-map context if needed.
`clearEventPin(eventId)` strips those fields. Event-pin rendering
takes priority over location-derived event markers inside
`_drawEventPaths` — if an event has its own `mapX`/`mapY` it shows
once at that spot; otherwise the event is drawn once per placed
Location listed in `e.locations[]`. Event paths auto-toggle on
after a pin is placed so the user sees the marker immediately.

Pin type palette (`PIN_TYPES`, exported from `map.js`): settlements
(`major_city` 🏙 · `city` 🏛 · `town` 🏘 · `village` 🏠), fortifications
(`fortress` 🏰 · `castle` 🏯 · `tower` 🗼), worship (`temple` 🛕 ·
`shrine` ⛩), civic (`tavern` 🍺 · `market` 🏪 · `academy` 🎓 ·
`port` ⚓ · `bridge` 🌉), danger (`camp` ⛺ · `dungeon` ⚠ · `cave` 🕳 ·
`ruin` 🏚 · `graveyard` 🪦 · `battlefield` ⚔ · `enemy` 💀), nature
(`landmark` 🗿 · `forest` 🌲 · `mountain` ⛰ · `lake` 🏞 · `region` 🗺),
plus `curiosity` ✨ and a `custom` 📌 fallback. Other modules (`wiki.js`,
`edit_templates.js`) import `PIN_TYPES` directly to reuse icons,
labels, and default sizes. Each entry carries a `size` (px) used as
the default for new places of that type — major settlements +
fortifications get 36–38, mid-tier (port/academy/city/region) get
30–32, the rest sit between 24 and 28. `PIN_SIZE_MIN`/`PIN_SIZE_MAX`/
`PIN_SIZE_DEFAULT` constants are exported alongside for clamping
inputs and resolver fallbacks.

Edit-mode gating: "+ Přidat místo", "✚ Uložit pohled", and "⚙ Mapa"
toolbar buttons carry the `edit-only-inline` class. `swordcoast.css`
rule `.sc-toolbar.is-editing .edit-only-inline { display: inline-block; }`
makes them visible only when the toolbar carries `.is-editing` — set
by `WorldMap.setEditing(true)` (toggled via the `✏ Editovat mapu`
button in the toolbar). The legacy global `body.edit-mode` gate was
retired in the per-page edit migration. Search and zoom presets
remain always visible. The toggle itself is hidden for anonymous
viewers (`Role.isAnonymous()` check at render time).

## WorldMap — pin size and zoom presets

`map.js` renders the Leaflet world map. Pins prefer an SVG icon
(uploaded → bundled game-icons default → emoji glyph as last
resort, all routed through `_resolveIconUrl`), with two visual
layers stacked on top:

1. **Attitude glow** — `filter: drop-shadow(...)` per active attitude
   (see "Attitude glow" section above). Empty `attitudes[]` = no
   glow at all.
2. **Legibility outline** — SVG branch stacks a 2× 1 px black
   `drop-shadow` so white-fill icons read on any tile; emoji branch
   uses a multi-direction text-shadow stroke + soft halo. Both
   baked into the marker's inline style by `_pinIcon`, no solid
   background plate either way.

The legacy `priority` field (1/2/3 zoom-gating) was retired together
with `_priorityOf` / `_thresholdForZoom` / `_applyPinVisibility`. All
pins show at all zoom levels for now. **Future plan:** per-Pohled
visibility rules — each `mapViews` preset will be able to carry rules
like "hide pins of type X" or "only show pins with attitude Y", and
the renderer will consult the active preset instead of a global zoom
threshold. Wire through `_pinsForCurrent` / `_resolvePinSize` when
that lands.

**Pin size.** Each `pinTypes` settings entry carries a default `size`
(px). Per-place `location.size` overrides it. `_resolvePinSize(pin)`
returns the effective px size, clamped to `[PIN_SIZE_MIN,
PIN_SIZE_MAX]` (14..64). `PIN_SIZE_DEFAULT` (28) is the fallback
when neither the place nor the type carry a value. Both the pin
form (range slider + number input, mirrored via
`syncSizeFromRange`/`syncSizeFromNumber`) and the wiki location
editor (`lf-size-${uid}` number input) write the override; saves
delete the override when it matches the type default so changing
the type's default later still moves un-customised places.

**Zoom-driven icon scaling.** Each map carries a per-map
`zoomScaleRatio` (0..1, stored under
`settings.mapConfigs[mapId].zoomScaleRatio`, edited from the
**Mapy** Settings tab). 0 = markers stay at constant pixel size
(default behaviour); 1 = markers grow/shrink at the same rate as
the map. The scale formula is `2^(ratio · leafletZoom)` where
Leaflet zoom 0 corresponds to the image's "real" pixel resolution
under CRS.Simple. `_applyMarkerScale()` runs on each `zoomend` and
writes `--sc-pin-base-scale` as an inline custom property on
every `.sc-pin`; the CSS rule applies it via `transform:
scale(var(--sc-pin-base-scale))` and `:hover` multiplies it
through `calc(...)` so the hover-pop animation still composes.

**Marker scale during animated zoom.** Leaflet's zoom animation
writes only `translate` to the map pane; the `scale` lives on the
tile-level container, a *sibling* of the marker pane, not an
ancestor. So a marker's CSS scale has **no pane scale multiplying
through** — `.sc-pin`'s own `transform: scale(...)` is the entire
visible size. Two earlier "fixes" assumed the opposite and computed
a counter-scale (`_animScaleEnd`, then a per-frame rAF), which made
markers visibly travel the wrong direction during the animation
before snapping correct at `zoomend` (e.g. 1× → 2× → 0.5× on a
2-step zoom-out at ratio 0.5). Current approach: at `zoomanim` we
write `--sc-pin-base-scale = 2^(r·z1)` (the target end value) on
every `.sc-pin` with `transition: transform 0.25s cubic-bezier(0,0,0.25,1)`
matching Leaflet's tile animation timing/easing — CSS handles the
smooth interpolation in lock-step with the visible tile zoom. At
`zoomend`, `_setMarkerTransition('none')` snaps the transition off,
`_applyMarkerScale` writes the same final value (no visible jump),
then a `requestAnimationFrame` restores the CSS-rule `transition:
transform 0.15s` (hover-pop). Slider drags use `setZoom(z, {animate:
false})` which skip `zoomanim` entirely and snap directly via
`_applyMarkerScale`.
A floating **zoom panel** docked top-left over `#sc-map-container`
(`.sc-zoom-panel`) replaces both Leaflet's built-in `+/-` control
(disabled via `zoomControl: false` on the L.map options) and the
older inline-toolbar slider. The panel stacks vertically: `+`,
vertical slider (`<input type="range" orient="vertical">` + CSS
`appearance: slider-vertical` for cross-browser coverage), `−`, and
a single **readout-as-reset** button at the bottom — its label is the
live zoom value (`1.50×`) AND clicking it snaps back to `1.00×`,
collapsing what used to be two separate elements. All three buttons
share the `.sc-zoom-btn` class (36×36 base, 40×40 under
`@media (pointer: coarse)`); the readout variant only overrides the
typography. Keyboard focus lands `:focus-visible` rings (`outline:
2px solid var(--accent-gold)`) so tab navigation is visible.

Helpers: `WorldMap.zoomSliderInput(value)` (continuous drag),
`WorldMap.zoomStep(±1)` (button taps, honours `zoomDelta`),
`WorldMap.zoomReset()` (back to the image's native pixel resolution —
also wired to the readout button), `WorldMap.applyZoomScaleRatio(mapId)`
(used by Settings to push immediate rescales). `_updateZoomReadout`
writes the live value into the `#sc-zoom-readout` button label;
`zoomSliderInput` writes eagerly during drag so the value tracks
the slider without zoomend-roundtrip lag. The toolbar still owns
view presets (🌐 Celá and saved `mapViews`) — those are positional
shortcuts, not zoom level.

**Zoom presets.** The toolbar has one hard-coded button (🌐 Celá →
`WorldMap.zoomFitAll()`) and then renders every entry from the
`mapViews` settings category whose `parentId` matches the current map
context. In edit mode, a ✚ Uložit pohled button captures the current
Leaflet view as a new preset: `WorldMap.captureCurrentView()` prompts
for label + icon, reads `_map.getBounds()`, converts corners to
fractional image coords via `_toFrac`, and persists via
`Store.saveEnumItem('mapViews', …)`. `WorldMap.applyMapView(id)`
`flyToBounds` to the preset. `_refreshPresetButtons()` rebuilds the
`#sc-zoom-presets` span after a preset is created/renamed/deleted so
the toolbar reflects changes without a full map re-render. Preset
shape: `{ id, label, icon, parentId, bounds:{x1,y1,x2,y2} }` (all
fractions 0–1, independent of image pixel dimensions).

**Trasy událostí button** merges the old "📍 Dění" behavior: when
activating, `toggleEventPaths()` draws the event-path overlay AND
calls `_zoomCurrentSitting()` to fit the bounds of pins linked to
every event with a numeric `sitting`. Deactivating only clears the
overlay — camera stays put.

Side panel: `_pinStatuses()` maps attitude id → `{label, bg, fg,
labelColor}` and the side panel header shows every active attitude
comma-joined with strength % (≠100 % only). The pin-fill from `bg`
is gone (the marker IS the icon now); `_pinStatuses` survives only
as the side-panel / legend label resolver. The header also shows
the resolved SVG icon (or emoji fallback) at 28 px next to the name.

Pin edit form has a `#spf-attitudes` chip row (plain toggles, same
widget as the wiki location editor) plus a size row
(`#spf-size-range` + `#spf-size`). Save writes `loc.attitudes` and
conditionally `loc.size` (only when ≠ type default).

**Type picker is not a native `<select>`** — native `<option>` can
only render text, so the menu was rebuilt as a custom dropdown that
hosts SVG icons in each row. The standalone preview block that used
to sit next to the dropdown was removed; the menu items themselves
carry the visual preview, and the trigger button shows the current
type's label. Structure:
- A hidden `<input type="hidden" id="spf-type">` preserves the save
  contract (`savePin` reads `getElementById('spf-type').value`).
- `.spf-type-trigger` (button styled as `.sc-input`) shows the
  current type's label + chevron; `aria-haspopup="listbox"` /
  `aria-expanded` track open state.
- `.spf-type-menu` (absolute-positioned panel, `role="listbox"`,
  max-height 320 px scroll) lists every `PIN_TYPES` entry as a
  `.spf-type-menu-item` button carrying a 24 px SVG icon + label.
  Icon resolution: `_typeMenuIconUrl(typeId)` returns the
  default-slot upload, else the bundled game-icons SVG, else null
  (falls back to the emoji glyph for that single type — rare).
  The rule has explicit `display: flex`, which would defeat the
  browser's default `[hidden]{display:none}` — restored with a
  paired `.spf-type-menu[hidden] { display: none; }` selector so
  the menu actually stays closed on mount.
- `WorldMap.toggleTypeMenu`, `WorldMap.closeTypeMenu`,
  `WorldMap.selectPinType(id)` drive the open/close/select cycle;
  selection writes to the hidden input, updates the trigger label,
  moves the `.is-active` highlight, and closes the menu.
- Two document-level listeners (registered at module init, no-op
  when the menu isn't mounted): a capture-phase `click` closes the
  menu when the target isn't inside `.spf-type-picker`, and a
  `keydown` listener closes on `Escape`.

## WorldMap — tile pyramid (sharp-based, dynamic)

`map.js` prefers a sharp-generated 256 px tile pyramid and falls back
to a single `L.imageOverlay` if no pyramid exists.

`_initLeaflet()` picks a `mapId` via `_currentMapId()`:
- world map → `world`
- local map of Location X → `local-<locId>`

Then `fetch('/maps/tiles/<mapId>/tiles.json')`. If the manifest
loads, `_doInitTiled(mapId, manifest, container)` mounts an
`L.tileLayer('/maps/tiles/<mapId>/{z}/{x}/{y}.<ext>')`. Manifest
shape:
```json
{ "width": 2048, "height": 1340, "tileSize": 256,
  "minZoom": -8, "maxZoom": 2, "ext": "jpg" }
```
On 404 / network error / bad JSON, `_doInit()` keeps the legacy
single-image overlay path. Post-init wiring (marker placement,
zoomend/click/edit-mode observers, resize handling, pending-pin
flush) is factored into `_wirePostInit(container)` and shared by
both paths.

Server side: `tiler.js` (requires `sharp`) owns the actual pyramid
build and is loaded lazily — if `sharp` isn't installed, tile
generation logs a warning and the server keeps serving the raw
`imageOverlay` fallback. Tiles live in `data/maps/tiles/<mapId>/`
and are exposed as static files under `/maps/tiles`. `POST
/api/localmap/:locId` triggers an async `tiler.buildFor(...)` for
the uploaded image; a `_backgroundTileSweep()` at server startup
rebuilds any missing pyramids for the world map
(`data/maps/swordcoast/*.jpg`) and every local map
(`data/maps/local/<locId>/map.*`).

## WorldMap — Locations as pins, sub-maps via parentId/localMap

`mapPins` is gone; pins are Locations carrying optional x/y. `map.js`
keeps a module-level `_currentParentId` (null = world map). Helpers:
- `_pinsForCurrent()` = `Store.getLocationsOnMap(_currentParentId)`
  rendered through `_pinFromLocation(l)` (legacy pin shape for the
  marker code).
- `_currentImgUrl()` returns the parent's `localMap` URL when on a
  sub-map, else the world tile URL.

`WorldMap.render(parentId)` accepts an optional parentId. The toolbar
title shows a breadcrumb back to "↩ Mapa" when on a sub-map.
`WorldMap.openLocalMap(parentId)` is the public entry-point used from
Location detail pages.

Pin save writes through `Store.saveLocation({...existing, x, y, ...})`,
auto-tagging new pins with `parentId = _currentParentId` if on a sub-map.
Pin "delete" is "remove from map" — strips x/y/pinType/size/mapNotes
but keeps the Location (and its `attitudes`) in the wiki. Actual
Location deletion remains in the wiki editor.

`zoomToPin(id)` resolves the pin's `parentId`; if it doesn't match
`_currentParentId` it re-renders the map in that parent's context,
then polls (≤30 × 80 ms) for the marker to mount before flying to it.

Search now spans all placed Locations across all maps (world + every
local map), not just the currently visible context.

Location detail page (`renderLocationArticle`):
- Ancestor breadcrumb at the top (reverse `getAncestorLocations(id)`).
- "Dílčí místa" chip section (`getSubLocations(id)`), 📍 marks placed
  children.
- Map-entry buttons row: "🧭 Najít na mapě" when placed,
  "🗺 Otevřít místní mapu" when `localMap` is set.
- "+ Dílčí místo" inline-create that prefills `parentId` via
  `EditMode.startNewLocation({parentId: l.id})`.

Location editor (`renderLocationEditor`) has:
- `type` as a `<select>` over all PIN_TYPES entries rendered as
  `${icon} ${label}`. Stores the PIN_TYPES **key** into `l.pinType`
  and also mirrors the label into legacy `l.type` for wiki search/
  display back-compat.
- "Hierarchie a mapa" section with a "Pin na mapě" control row
  (Umístit na mapu / Zobrazit / Přemístit / Odebrat z mapy — disabled
  for new Locations until first save), a parent picker (Combobox
  `cb-mount`, excludes self), a `localMap` URL input, and a 📤 upload
  button that calls `EditMode.uploadLocalMap(locId, file, inputId)` →
  `Store.uploadLocalMap` → `POST /api/localmap/:locId`. Upload is
  disabled for new (unsaved) Locations.
- "Přítomné postavy" as a MultiSelect (`.ms-mount`) with
  `data-loc-id`. A delegated `w-ms-change` listener in `editmode.js`
  diffs selections and calls `Store.saveCharacter({...c, location})`
  for adds/removes. This enforces "one place per character": adding
  a character moves it from its previous location.

`editmode.saveLocation` does `{...existing, ...formFields}` so
`x`/`y`/`pinType`/`mapNotes` survive a wiki-side edit that doesn't
expose them. The wiki editor DOES expose `attitudes`, `status`, and
`size`, so those are always rewritten from the form. `size` is
`delete`d when the form value matches the type default — keeps the
record clean and lets a later type-default change still propagate.
The save **does not** write `l.characters` anymore — character
location is persisted via `character.location`.

Místa list (`_mistaGridHtml`) renders a `.loc-grid` thumbnail grid.
Each card shows the `PIN_TYPES[l.pinType].icon` large, the name and
the type label. CSS lives under `wiki.css` → "Location Grid".

## Timeline (`timeline.js`)

Kanban board: one column per sezení. Columns are `Sezení 1..maxSitting`
— **including empty sittings in the middle**, so a skipped session
renders as an empty column you can drop into. Any event without a
numeric `sitting >= 1` is coerced into column 1 by `_groupBySitting`
(was a separate "Dávná minulost" column; the dedicated historical
record now lives in the `historicalEvents` collection at `/historie`).
`maxSitting = Math.max(1, max(event.sitting))` so there's always at
least one column. In edit mode a phantom `Nové sezení N+1` column
hangs off the end as a drop target that bumps `maxSitting` when used.

Performance: `render()` builds module-level `_charMap` and `_locMap`
(id → entity) once per render, and `_cardHTML`/`_eventAccentColor`
do O(1) Map lookups instead of O(n) `.find()` across every card.

**Horizontal scrolling — ONE affordance.** The board viewport's
native scrollbar is hidden (`scrollbar-width: none` +
`::-webkit-scrollbar { display: none }`); the styled `.tl-hscroll`
range slider under the board is the single visible scroll control
(custom track/thumb pseudo-elements in timeline.css — recessed gold
track, wide pill thumb, `:focus-visible` ring). It's two-way synced
with `viewport.scrollLeft` in `_wireHScroll`/`_syncHScroll` and
hidden entirely while the board fits. The **mouse wheel pans the
board horizontally** (non-passive `wheel` listener on the viewport):
dominant-`deltaX` events are left to native handling (trackpad
sideways swipes), and over a `.tl-col-body` that itself overflows
vertically the wheel keeps its native card-scrolling job;
`deltaMode === 1` (Firefox line mode) is scaled ×40.

Each column: header (title + count badge), scrollable body of
cards, and in edit mode a dashed `＋ Nová událost` footer button
that calls `EditMode.startNewEvent({sitting})` so the new event
lands pre-assigned to that column.

Stacking: columns with more than `STACK_THRESHOLD` (=4) cards get
`.tl-col-stacked`. Collapsed, cards after the first overlap with
`margin-top:-54px`; hovering the column (or toggling
`.tl-col-expanded` via tap on touch, or initiating a drag from
within) fans them back out. Individual cards also pop forward on
hover for a quick peek.

Drag-drop: every card is `draggable` in edit mode. Columns handle
`dragover`/`drop` — a `.tl-drop-indicator` gold line is inserted
at the prospective position (computed from pointer Y relative to
card midpoints). On drop, `_handleDrop(srcId, targetSitting,
insertIdx)` relocates the event in its column group and
`_commitReorder` renumbers `order`=1,2,3… per column, writing only
the events whose `(sitting, order)` actually changed. Dragging
from a stacked column auto-expands it so mid-column drops are
precise.

Event editor (`renderEventEditor`) has a 🛡 + Naše parta button next to
the characters MultiSelect title — wires to `EditMode.addPartyToEvent(mountId)`
which merges all characters where `faction === 'party'` into the current
selection via the MultiSelect's `_multiselect.setValue()` API. Also has
a "Pin události na mapě" row that calls `WorldMap.startPlacingEventPin` /
`showEventPin` / `clearEventPin` depending on placement state. Disabled
for unsaved events.
