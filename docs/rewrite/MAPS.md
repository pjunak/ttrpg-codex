# Campaign maps

The Lit map page uses bundled Leaflet 1.9.4 with `CRS.Simple` and immutable
map tiles, with an original-image fallback. The original `swordcoast.css` shell, toolbar, floating
zoom controls, marker sizes, and marker SVGs are the visual reference.
Leaflet's image-coordinate behavior is documented in its
[non-geographical map guide](https://leafletjs.com/examples/crs-simple/crs-simple.html).

## Coordinates and ownership

- World map route: `#/map/world`; local map route: `#/map/local/<encoded key>`.
  The preserved `#/mapa/svet` and `#/mapa/local/<encoded key>` hashes also work.
  Event article links append `/event/<encoded key>/show` or `/place`. Show
  enables the overlay and centers the event; Place opens a pending placement
  for an authenticated editor. Neither action writes data by navigating.
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
  Campaign marker sizes and the shared attitude projection are reused.

## Marker attitude glows

Map markers retain the preserved v1 diagonal glow bands. Zero active attitudes
leave only the dark artwork outline or glyph stroke; one adds a single colored
glow; two or more render one copy of the artwork/glyph per active attitude.
Each copy has its own glow and a sheared clip polygon, with extended outer
edges so the halo is not cut off around the icon. The parent has no combined
filter, which would blend the colors together again.

Band order follows the entity's attitudes. Unknown IDs and zero-strength
attitudes do not occupy a band. Colors and strengths come from shared settings,
including the synthetic party color; retired entry-level strength is ignored.
The outer marker blur is `max(5, round(size * 0.22))`, with a tighter inner
blur at 40%. Glyph size is 85% of marker size. Artwork retains the two 1px
black outline layers. These layers scale and hover together with the pin.

Visual copies are hidden from accessibility APIs and ignore pointer events;
the owning Leaflet marker remains the single click/keyboard/drag target.
Live settings changes rebuild the visible layers through the normal campaign
refresh, with the existing active-drag protection.

## Image tiles and fallback

The viewer first requests a `map-tiles.v1` manifest for the same opaque media
handle used by the map. The backend builds a disposable pyramid on first use;
cache hits do not decode the source again. Uploads and converted maps use the
same path. See [MEDIA.md](MEDIA.md) for authorization, cache ownership and limits.

Tile levels run from 0 (the whole image fits in one 256px grid cell) to the
manifest's `depth` (native pixels). Leaflet keeps its original image-coordinate
frame: native zoom is 0, `minNativeZoom` is `-depth`, and `zoomOffset` is `depth`.
Over-zoom scales native tiles. Saved views, fractional positions, event paths,
marker scale, and the original toolbar work identically for both backgrounds.

PNG tiles have a 256px grid with one extra source pixel on the right and bottom.
The viewer displays all 257px at their true scale, using normal blending to
cover fractional-zoom seams without stretching coordinates or brightening
joins. Outside-image pixels are transparent. Replacing an image changes the
opaque URL, disposes the old layer, and cannot mix tile generations.

Missing/invalid manifests, unsupported images, and generation failures use
the original-image overlay. A tile load failure also loads the original into
the existing map, retaining its viewport and edit state. Route disposal aborts
pending work; a failed original load uses the ordinary map error/retry state.

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

Location articles and edit forms expose Show/Place/Move actions targeting
`/location/<encoded key>/show` or `/place` on their world/local map route.
Show centers the marker and opens its details; Place starts the existing map
position editor without writing. Missing, off-map, and anonymous targets cannot
start a placement. Selecting an existing location captures its revision before
the map click, so remote edits, reparenting, or deletion reject the later save
and retain the draft. The same protection applies to the map's unplaced picker.

The location form edits `pinType` through the shared marker definitions and an
optional 14–64px `size` override. Empty size restores type inheritance; unknown
stored marker IDs remain selectable but cannot be invented. The v1 Custom
fallback remains available when there are no configured definitions. The free
text Kind label remains independent metadata. Changing `parentId` clears only
the old `x`/`y` placement, as the coordinates belong to another image frame;
the form explains that a new placement is needed after saving. Other location
data, extensions, and the location's own `localMap` image are retained.

The form previews only opaque local media and links to the existing local-map
viewer/upload controls. New locations must be saved first. Map navigation uses
the ordinary unsaved-edit guard, so following a link cannot discard a pending
record edit without the user's choice. Coordinate and image writes continue
through their existing map handlers instead of a second set of form inputs.

Event articles expose Show on map and Place/Move event pin. The map's event
picker places an existing event on the current world/local map. An event with
an explicit pin on another map must have that pin removed before placement
elsewhere. This prevents moving a pin between maps unintentionally.

Event placement captures the opening event revision before the map click.
The position form supports coordinates, another map click, Save/Cancel, and
removal; existing explicit event markers can also be dragged while editing.
Map-marker clicks open this editor in edit mode and the article in view mode.
Saving merges only `mapX`, `mapY`, and `mapParentId`. Removal clears those three
fields, retaining the event, linked locations, session data, and extensions;
linked-location markers become visible again through the ordinary projection.
Live updates and remote deletion retain the draft and reject stale saves or
removals. Missing targets show an unavailable message, and anonymous links
cannot start placement. A successful save ends the pending placement intent.

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

## Map settings and zoom

The DM Maps settings panel uses the original brown/gold settings layout with
a map selector, image preview/upload, marker scaling, and links to the map and
its saved-view editor. It includes unplaced locations so their local maps can
be uploaded. `#/settings/maps` opens the world map configuration;
`#/settings/maps/local/<encoded key>` opens a location's configuration.

Shared `settings/mapConfigs` retains the original `world` and `local-<key>`
entries. Each entry's `zoomScaleRatio` ranges from 0 to 1, defaulting to 0.
Location marker scale is `2 ** (zoomScaleRatio * zoom)`: 0 keeps constant
screen size, 1 scales with the image, and intermediate values scale gently.
The original 1.25 hover enlargement applies on top. Event markers retain their
original constant 28px size. Changes apply to the visible map on live refresh.

Configuration drafts capture the settings revision, preserve all other maps
and unknown fields, and use explicit Save/Cancel. Live refresh updates a clean
form but retains an edited draft and its opening revision. Category changes,
map changes, and navigation use the unsaved-edit guard; uploads are disabled
while configuration changes are pending. Missing maps, stale revisions, and
malformed stored configuration reject saves without overwriting stored data.
Only DMs may change shared map preferences.

Zoom controls use quarter-level snapping, half-level button steps, and 120
wheel pixels per level. The minimum follows the image's fit level (bounded by
-8 and 2), recomputed independently of the previous limit after a resize.
A fitted map stays fitted as the responsive layout changes; zoomed views keep
their zoom unless it is below the new minimum. The native-size button requests
level 0, subject to these bounds.

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

Both event and location markers support click, Enter, and Space. The story
trail follows authoritative live data until Save; explicit markers preview
their position draft, and a new placement displays a temporary circle.
Linked-location markers are never draggable as event pins, so event editing
cannot move a location. The separate Leaflet layer group is cleared on toggle,
live refresh, and page disposal, while active drags defer marker rebuilding.

## Runtime and validation

Map instances, event listeners, image loads, and resize observers belong to the
page lifetime and are disposed on route replacement. The Leaflet map owns its
canvas DOM; Lit owns the surrounding toolbar and edit panel. Live updates do
not rebuild a marker in the middle of a drag. Successful edits retain the
viewport when the background image has not changed.

`campaign-map.test.ts` checks map scoping, coordinate mutations, stale writes,
saved views, configuration preservation/scaling, and opaque local image binding.
`maps.browser.mjs` exercises the
production build with synthetic campaign/media responses on desktop and phone,
including position geometry, dragging, live conflicts, creation, unplacing,
view creation/edit/delete with stale revisions, local image uploads, and event
ordering, geometry, appearance, keyboard links, refresh, and teardown.
Event-pin regressions also exercise article links, world/local placement,
coordinates, drag drafts, removal with restored location fallback, revisions
captured before clicking the map, remote deletion, and anonymous/missing targets.
Map-settings regressions cover desktop/phone layout, per-map configuration,
marker scaling, draft conflicts, clean live refresh, category/map navigation,
world/local uploads, malformed configuration, and DM-only access. Zoom checks
cover fit limits and resizing in both directions.
Location regressions cover marker type/size editing, world/local reparenting,
targeted article links, local image preview/upload, navigation guards, captured
placement revisions, missing targets, and anonymous access on the production
build. `campaign-record-editor.test.ts` covers field validation, inherited size,
extension preservation, and clearing only coordinates when the parent changes.
`campaign-attitude-glow.test.ts` locks the preserved band geometry, glow radii,
strengths, and outline behavior. Browser fixtures exercise artwork and glyph
bands on desktop/phone, world/local scope, keyboard activation, scaling, and
live removal of a glow. Card/article checks distinguish portrait border rings
from icon silhouette filters. Projection tests cover explicit/inherited
attitudes, unknown IDs, and unavailable factions.
`map_placement_test.go` covers public/DM projection and player-save preservation
for visible, hidden, and missing parents. These fixtures contain no live data.
Screenshots are written to ignored `frontend/test-results/maps/`.

Tile regressions verify native pixels, transparent edges, bounded decoding,
WebP/JPEG handling, cache regeneration, concurrency and cancellation in Go.
Application/HTTP checks verify current owner visibility even for cached and
conditional reads. Desktop/phone browser fixtures verify matching coordinate
geometry, zoom, image replacement, and failure fallback without downloading
the source image on the successful tiled path. Real campaign acceptance remains
in the suite backlog.
