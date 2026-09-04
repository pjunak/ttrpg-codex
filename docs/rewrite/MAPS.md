# Campaign maps

The Lit map page uses bundled Leaflet 1.9.4 with `CRS.Simple` and an immutable
source-image overlay. The original `swordcoast.css` shell, toolbar, floating
zoom controls, marker sizes, and marker SVGs are the visual reference.
Leaflet's image-coordinate behavior is documented in its
[non-geographical map guide](https://leafletjs.com/examples/crs-simple/crs-simple.html).

## Coordinates and ownership

- World map route: `#/map/world`; local map route: `#/map/local/<encoded key>`.
  The preserved `#/mapa/svet` and `#/mapa/local/<encoded key>` hashes also work.
- A location's `parentId` selects its map; null/empty means the world map.
  Child markers do not appear on the world map. Missing/hidden local parents
  display an unavailable state rather than another location's image.
  Public projections remove both the hidden parent reference and its placement
  coordinates, so a local location/event cannot appear on the world map by
  losing only its parent. Player saves preserve that unavailable placement as
  one unit in the stored record.
- Existing `x` and `y` are fractions of source-image width and height, with
  top-left origin. Leaflet coordinates remain `[-y * height, x * width]`.
  Pins outside the image are retained, as in v1; fractions are units rather
  than a clipping boundary. The form displays percentages for readability.
- The world background resolves the newest `world-map/main` media binding.
  Local backgrounds use the owning location's opaque `localMap` URL.
- Marker artwork follows configured `pinTypes.iconConfig`, including stable
  random selection, then the configured bundled icon or original type icon.
  Campaign marker sizes and the existing attitude projection are reused.

## Editing

Authenticated users can place new or existing locations, drag a marker, edit
its coordinates, or remove its placement. Dragging produces a draft with
explicit Save/Cancel. Removing a marker clears only `x`/`y`, not the location.
All writes use the ordinary CSRF-protected campaign transaction; the server
still owns visibility, reference policy, and authority.

Position drafts retain the original location revision during live refresh.
Save preparation checks that revision and the map scope before merging only
coordinates into the current record. Other fields and add-on data survive.
Stale saves retain the draft and use the existing navigation/unload guard.
Pan/zoom is local UI state and does not dirty campaign data.

DMs can create, edit, and delete view presets in `settings/mapViews`. The inline
editor exposes a name, icon, preview, and explicit capture of the current map
area. Captured bounds are clipped to the source image; an entirely off-image
viewport shows an error without replacing the draft. Saving retains the stable
preset ID, unknown fields (including bounds extensions), and all other presets.
Updates/deletes require exactly one matching ID in the reviewed map scope and
the settings revision captured when the editor opened. Live refresh and failed
saves leave the draft intact. The normal unsaved-navigation guard applies.
Presets are filtered by map scope when shown and applied.

Map uploads use `MediaClient`: DM authority for world maps and the existing
location media policy for local maps. A local upload creates a new immutable
handle, then revision-checks the location URL update. A failed update retains
the previous referenced image; no old handle is deleted by this UI.

## Event paths

The toolbar's Event paths toggle restores the original 28px session/past-event
markers, dashed gold story trail, and legend. It uses only the campaign dataset
already projected for the current role. Events sort by `sitting`, then `order`,
with missing values treated as zero and insertion order retained for ties.
An explicit finite `mapX`/`mapY` pin takes precedence on its own `mapParentId`;
otherwise each visible, placed entry of `locations` appears in its stored order
on the current map. Missing or off-map locations have no rendered point. The
trail connects consecutive rendered points and skips zero-length segments.
Enabling it fits played-event points, capped at native image scale.

Markers open their event articles; both event and location markers support
click, Enter, and Space. The overlay is read-only and follows authoritative
live data; position drafts do not move its points before Save. Its separate
Leaflet layer group is cleared on toggle, live refresh, and page disposal.

## Runtime and validation

Map instances, event listeners, image loads, and resize observers belong to the
page lifetime and are disposed on route replacement. The Leaflet map owns its
canvas DOM; Lit owns the surrounding toolbar and edit panel. Live updates do
not rebuild a marker in the middle of a drag. Successful edits retain the
viewport when the background image has not changed.

`campaign-map.test.ts` checks map scoping, coordinate mutations, stale writes,
saved views, and opaque local image binding. `maps.browser.mjs` exercises the
production build with synthetic campaign/media responses on desktop and phone,
including position geometry, dragging, live conflicts, creation, unplacing,
view creation/edit/delete with stale revisions, local image uploads, and event
ordering, geometry, appearance, keyboard links, refresh, and teardown.
`map_placement_test.go` covers public/DM projection and player-save preservation
for visible, hidden, and missing parents. These fixtures contain no live data.
Screenshots are written to ignored `frontend/test-results/maps/`.

Generated tile pyramids, map configuration controls, direct event-pin editing,
and segmented attitude glows remain tracked in the
suite backlog. The current viewer uses the original source image directly.
