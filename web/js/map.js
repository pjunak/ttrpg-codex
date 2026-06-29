import { Store } from './store.js';
import { Widgets } from './widgets/widgets.js';
import { EditTemplates } from './edit_templates.js';
import { Role } from './role.js';
import { esc, dataAction, dataOn, pageEditToggle } from './utils.js';
import { I18n } from './i18n.js';
import { Addons } from './addons.js';

// `size` is the default marker pixel size for new places of this
// type. Kept in sync with SETTINGS_DEFAULTS.pinTypes in data.js so
// that fresh-installs match what the settings editor shows. The
// runtime size lookup prefers `Store.getEnumValue('pinTypes', id)`
// (user-editable) and falls back to this constant.
export const PIN_TYPES = {
  major_city:  { icon: '🏙',  label: 'Velké město',  color: '#D4A017', size: 38 },
  city:        { icon: '🏛',  label: 'Město',         color: '#C0A060', size: 32 },
  town:        { icon: '🏘',  label: 'Městečko',      color: '#A0B080', size: 28 },
  village:     { icon: '🏠',  label: 'Vesnice',       color: '#80A070', size: 26 },
  fortress:    { icon: '🏰',  label: 'Pevnost',       color: '#9090A0', size: 36 },
  castle:      { icon: '🏯',  label: 'Hrad',          color: '#9A9AA8', size: 36 },
  tower:       { icon: '🗼',  label: 'Věž',           color: '#A8A098', size: 26 },
  temple:      { icon: '🛕',  label: 'Chrám',         color: '#C0A088', size: 28 },
  shrine:      { icon: '⛩',  label: 'Svatyně',       color: '#80A0B0', size: 26 },
  tavern:      { icon: '🍺',  label: 'Hospoda',       color: '#C89050', size: 24 },
  market:      { icon: '🏪',  label: 'Trh',           color: '#C8A050', size: 24 },
  academy:     { icon: '🎓',  label: 'Akademie',      color: '#A890C0', size: 30 },
  port:        { icon: '⚓',  label: 'Přístav',       color: '#6090A0', size: 30 },
  bridge:      { icon: '🌉',  label: 'Most',          color: '#909090', size: 24 },
  camp:        { icon: '⛺',  label: 'Tábor',         color: '#B88040', size: 24 },
  dungeon:     { icon: '⚠',   label: 'Dungeon',       color: '#A06040', size: 28 },
  cave:        { icon: '🕳',  label: 'Jeskyně',       color: '#706050', size: 24 },
  ruin:        { icon: '🏚',  label: 'Ruina',         color: '#888070', size: 26 },
  graveyard:   { icon: '🪦',  label: 'Hřbitov',       color: '#808080', size: 24 },
  battlefield: { icon: '⚔',   label: 'Bojiště',       color: '#A04040', size: 28 },
  landmark:    { icon: '🗿',  label: 'Bod zájmu',     color: '#80A0B0', size: 26 },
  forest:      { icon: '🌲',  label: 'Les',           color: '#4A7A4A', size: 26 },
  mountain:    { icon: '⛰',   label: 'Hora',          color: '#8A7A6A', size: 30 },
  lake:        { icon: '🏞',  label: 'Jezero',        color: '#5A90B0', size: 28 },
  curiosity:   { icon: '✨',  label: 'Zajímavost',    color: '#C8A040', size: 24 },
  region:      { icon: '🗺',  label: 'Oblast',        color: '#708090', size: 32 },
  enemy:       { icon: '💀',  label: 'Nepřátelské',   color: '#B04040', size: 28 },
  custom:      { icon: '📌',  label: 'Vlastní',       color: '#8A5CC8', size: 26 },
};

// Marker size bounds used by inputs and the size-resolver below.
export const PIN_SIZE_MIN = 14;
export const PIN_SIZE_MAX = 64;
export const PIN_SIZE_DEFAULT = 28;

export const WorldMap = (() => {

  const LS_IMG_KEY  = 'world_map_image_url';
  const DEFAULT_IMG = '/maps/swordcoast/sword_coast.jpg';

  // Server-uploaded world maps live at the canonical DEFAULT_IMG path
  // (written by POST /api/worldmap in server.js). `localStorage` still
  // works as a per-browser override for the legacy "upload to the
  // browser" flow exposed by WorldMap.showSettings, but server uploads
  // clear that key so the fresh file wins.
  function _getImgUrl() {
    return localStorage.getItem(LS_IMG_KEY) || DEFAULT_IMG;
  }

  // Pin fill / label colors come from the unified `attitudes` settings
  // enum (same vocabulary used on character rings and location cards).
  // `bg` = solid marker fill, `fg` = icon/text color contrast for bg,
  // `labelColor` = readable chip/legend color on dark UI.
  // A default fallback handles locations with no attitudes set.
  function _pinStatuses() {
    const map = {};
    for (const a of Store.getKinds('attitudes') || []) {
      map[a.id] = {
        label:      a.label || a.id,
        bg:         a.bg         || '#37474F',
        fg:         a.fg         || '#E8E0C4',
        labelColor: a.labelColor || '#90A4AE',
      };
    }
    // `unknown` is the safe default when a location carries no attitudes.
    if (!map.unknown) {
      map.unknown = { label: I18n.t('map.attitudeUnknown'), bg: '#37474F', fg: '#E8E0C4', labelColor: '#90A4AE' };
    }
    return map;
  }

  // ── Marker size resolver ──────────────────────────────────────
  // Per-pin override wins; otherwise the user-edited pinTypes
  // settings entry; otherwise the constant default in PIN_TYPES;
  // finally a global PIN_SIZE_DEFAULT. Clamped to [PIN_SIZE_MIN,
  // PIN_SIZE_MAX] so a stale settings value can't blow up the map.
  //
  // TODO (future): per-Pohled visibility rules. The legacy
  // `priority` field used to gate pin visibility by zoom level — that
  // got dropped in favour of an upcoming system where each Pohled
  // (map view preset) can carry rules like "hide pins of type X" or
  // "only show pins with attitude Y". When that lands, plug it in
  // here / `_pinsForCurrent` rather than re-introducing priority.
  // ── Custom marker icon resolver ───────────────────────────────
  // `settings.pinTypes[i].iconConfig` (optional) carries:
  //   {
  //     strategy: 'single' | 'random',
  //     files:    [{ id, url }, ...],
  //   }
  // Resolution rules:
  //   • No iconConfig or empty files → bundled default for this pin
  //                                    type (game-icons.net, CC BY 3.0,
  //                                    see ATTRIBUTIONS.md); null when
  //                                    none → emoji fallback.
  //   • strategy 'single' (default)  → files[0].
  //   • strategy 'random'            → deterministic hash on pin.id
  //                                    across ALL files.

  // Pin type ids that have a bundled default SVG under
  // `web/icons-defaults/<id>.svg`. Kept in sync with the files
  // committed in that folder; user-created pin types fall through
  // to the emoji glyph because they have no entry here.
  const BUNDLED_DEFAULT_ICONS = Object.freeze(new Set([
    'major_city','city','town','village','fortress','castle','tower',
    'temple','shrine','tavern','market','academy','port','bridge','camp',
    'dungeon','cave','ruin','graveyard','battlefield','landmark','forest',
    'mountain','lake','curiosity','region','enemy','custom',
  ]));
  /**
   * @param {string} pinType - Pin type id from `pinTypes` settings.
   * @returns {string|null} Path to the bundled default SVG for this
   *   pin type (null when none ships — user-created pin types). Used
   *   by the Settings marker-icon panel to surface a "Výchozí ikona"
   *   placeholder.
   */
  function bundledDefaultUrl(pinType) {
    return BUNDLED_DEFAULT_ICONS.has(pinType) ? `/icons-defaults/${pinType}.svg` : null;
  }
  const _bundledDefaultUrl = bundledDefaultUrl;

  /** List of bundled default icon ids — exposed so Settings can render
   *  a default-icon picker for user-created pin types (which otherwise
   *  fall through to the emoji glyph). Sorted by the order they appear
   *  in PIN_TYPES so the picker matches the rest of the UI. */
  function getBundledDefaultIconIds() {
    return Object.keys(PIN_TYPES).filter(id => BUNDLED_DEFAULT_ICONS.has(id));
  }

  /**
   * Resolve the icon URL for a wiki Location record using the same
   * fallback chain as the map (uploaded → bundled → null), so wiki
   * cards and the article side panel render the same artwork the
   * map shows. Callers fall back to the emoji glyph when this returns
   * null.
   *
   * @param {object|null} l - Location record.
   * @returns {string|null}
   */
  function resolveIconForLocation(l) {
    if (!l) return null;
    return _resolveIconUrl({
      id:         l.id,
      locationId: l.id,
      type:       l.pinType || 'custom',
      attitudes:  l.attitudes,
    });
  }

  function _hashStr(s) {
    let h = 2166136261;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }

  function _resolveIconUrl(pin) {
    const types = (Store.getEnum && Store.getEnum('pinTypes')) || [];
    const pt    = types.find(t => t.id === pin.type);
    const cfg   = pt?.iconConfig;
    // Uploaded files (iconConfig) always win when present.
    if (cfg && Array.isArray(cfg.files) && cfg.files.length) {
      const files = cfg.files;
      if (cfg.strategy === 'random') {
        const idx = _hashStr(pin.id || pin.locationId || '') % files.length;
        return files[idx].url;
      }
      return files[0].url;
    }
    // User-picked default icon from the bundled set (lets user-created
    // pin types ride on the bundled-defaults SVG palette instead of
    // falling through to an emoji glyph).
    if (pt && pt.defaultIconId && _bundledDefaultUrl(pt.defaultIconId)) {
      return _bundledDefaultUrl(pt.defaultIconId);
    }
    // Per-type bundled default — only resolves for the seed pin-type
    // ids that ship an SVG under /icons-defaults/.
    return _bundledDefaultUrl(pin.type);
  }

  function _resolvePinSize(pin) {
    if (typeof pin.size === 'number' && pin.size > 0) {
      return Math.max(PIN_SIZE_MIN, Math.min(PIN_SIZE_MAX, pin.size));
    }
    const fromSettings = (Store.getEnum && Store.getEnum('pinTypes') || [])
      .find(p => p.id === pin.type);
    if (fromSettings && typeof fromSettings.size === 'number' && fromSettings.size > 0) {
      return Math.max(PIN_SIZE_MIN, Math.min(PIN_SIZE_MAX, fromSettings.size));
    }
    const fromConst = PIN_TYPES[pin.type];
    if (fromConst && typeof fromConst.size === 'number' && fromConst.size > 0) {
      return fromConst.size;
    }
    return PIN_SIZE_DEFAULT;
  }

  // ── Zoom-driven icon scaling ──────────────────────────────────
  // Per-map config (`settings.mapConfigs[mapId].zoomScaleRatio`,
  // 0..1) controls how aggressively markers grow/shrink with the
  // map: 0 = constant pixel size (the existing behaviour), 1 =
  // markers scale at the same rate as the map (always the same
  // fraction of map area). The Leaflet zoom is logarithmic
  // (each whole step = 2× / 0.5×), so the scale factor is
  //   scale = 2^(ratio · zoom)
  // where zoom = 0 corresponds to the image's "real" pixel
  // resolution under CRS.Simple.
  function _currentZoomScaleRatio() {
    const cfg = Store.getMapConfig(_currentMapId());
    const r = (cfg && typeof cfg.zoomScaleRatio === 'number') ? cfg.zoomScaleRatio : 0;
    if (r < 0) return 0;
    if (r > 1) return 1;
    return r;
  }
  function _iconScaleAtZoom(z, ratio) {
    if (!isFinite(z)) return 1;
    if (ratio <= 0)   return 1;
    return Math.pow(2, ratio * z);
  }
  // Walk every active marker and apply a CSS `transform: scale(...)`
  // matching the current zoom × ratio. Cheap — one inline-style
  // mutation per marker. The Leaflet click hit-area is unchanged
  // (still tied to iconSize), so very large scale-ups can leave
  // visual click area > hit area. Acceptable trade-off for v1.
  function _applyMarkerScale() {
    if (!_map) return;
    const scale = _iconScaleAtZoom(_map.getZoom(), _currentZoomScaleRatio());
    // The CSS rule on .sc-pin reads this custom property and applies
    // it as the base scale; :hover multiplies it via calc(...) so
    // the hover-zoom-on-hover animation still composes cleanly.
    const value = scale.toFixed(3);
    for (const m of Object.values(_markers)) {
      const el  = m.getElement && m.getElement();
      const pin = el && el.querySelector ? el.querySelector('.sc-pin') : null;
      if (pin) pin.style.setProperty('--sc-pin-base-scale', value);
    }
  }
  // Walk every marker's `.sc-pin` element and apply (or clear) an
  // inline `transition` value. Used by the zoomanim/zoomend pair to
  // tween marker scale in lock-step with Leaflet's pane animation.
  // Empty value falls back to the CSS rule (0.15s, used by hover).
  function _setMarkerTransition(value) {
    for (const m of Object.values(_markers)) {
      const el  = m.getElement && m.getElement();
      const pin = el && el.querySelector ? el.querySelector('.sc-pin') : null;
      if (pin) pin.style.transition = value || '';
    }
  }
  // Leaflet's zoom animation only writes `translate` to the map pane;
  // the `scale` lives on the tile-level container (a SIBLING of the
  // marker pane, not an ancestor), so a marker's CSS scale isn't
  // multiplied by any pane scale — it IS the visible size. Earlier
  // attempts to counter-scale the marker against the pane (the
  // `_animScaleEnd` formula, then a per-frame rAF) made markers
  // visibly travel the wrong direction during the animation before
  // snapping correct at zoomend (e.g. 1× → 2× → 0.5× for a 2-step
  // zoom-out at ratio 0.5). The fix is to drop the counter entirely:
  // at zoomanim we set `--sc-pin-base-scale` directly to the target
  // value `2^(r·z1)` and let a CSS transition (matching Leaflet's
  // tile timing — 0.25 s, `cubic-bezier(0,0,0.25,1)`) interpolate
  // smoothly from the current value.
  // Suppresses the slider write-back inside `_updateZoomReadout`
  // while the user is actively dragging the thumb. Without this
  // guard, a `zoomend` from an in-flight `setZoom` call can fire
  // mid-drag, write a stale zoom level into `slider.value`, and
  // make the thumb visually jump backward. Set on pointerdown
  // (see `_wirePostInit`), cleared on pointerup.
  let _sliderInteracting = false;
  function _formatZoom(z) {
    // Drop the trailing `×` — the small button (36–40 px wide) can't
    // fit "16.00×". The numeric value alone reads unambiguously as
    // a zoom factor in context.
    return Math.pow(2, z).toFixed(2);
  }
  function _updateZoomReadout() {
    const slider = document.getElementById('sc-zoom-slider');
    // Readout is the bottom button itself — clicking resets, label
    // tracks the live zoom value.
    const out    = document.getElementById('sc-zoom-readout');
    if (!_map) return;
    const z = _map.getZoom();
    // Only sync the slider position when the user isn't currently
    // dragging it. Otherwise an async zoomend can race with the
    // drag and force the thumb backward.
    if (slider && !_sliderInteracting) slider.value = String(z);
    if (out)    out.textContent = _formatZoom(z);
  }
  function _syncZoomSliderBounds() {
    const slider = document.getElementById('sc-zoom-slider');
    if (!_map || !slider) return;
    const minZ = _map.getMinZoom();
    const maxZ = _map.getMaxZoom();
    if (Number.isFinite(minZ)) slider.min = String(minZ);
    if (Number.isFinite(maxZ)) slider.max = String(maxZ);
  }
  function zoomSliderInput(value) {
    if (!_map) return;
    const z = parseFloat(value);
    if (!isFinite(z)) return;
    // `animate: false` snaps instantly so back-to-back drag inputs
    // can't queue overlapping zoom animations whose `zoomend` events
    // race with subsequent drags. Combined with `_sliderInteracting`,
    // the slider stays in lock-step with the user's gesture.
    _map.setZoom(z, { animate: false });
    // Eager readout update — `zoomend` would fire next tick and
    // refresh this anyway, but the user expects the value to track
    // the slider drag without a frame of lag.
    const out = document.getElementById('sc-zoom-readout');
    if (out) out.textContent = _formatZoom(z);
  }
  function zoomReset() {
    if (!_map) return;
    // Clamp to the map's allowed range so a tiny image whose
    // minZoom is > 0 doesn't refuse the call.
    const minZ = _map.getMinZoom();
    const maxZ = _map.getMaxZoom();
    let target = 0;
    if (Number.isFinite(minZ) && target < minZ) target = minZ;
    if (Number.isFinite(maxZ) && target > maxZ) target = maxZ;
    _map.setZoom(target);
  }
  // Step the zoom by `dir` Leaflet zoom units (typically ±1) — used
  // by the +/- buttons in the floating zoom panel. Honours zoomSnap
  // so the result lands on a clean step.
  function zoomStep(dir) {
    if (!_map) return;
    const z = _map.getZoom();
    const step = (typeof _map.options.zoomDelta === 'number' && _map.options.zoomDelta > 0)
      ? _map.options.zoomDelta : 1;
    _map.setZoom(z + (dir > 0 ? step : -step));
  }
  /**
   * Force a marker rescale using the current `zoomScaleRatio` for
   * `mapId`. Settings calls this right after the GM commits a slider
   * change so the live map updates without waiting for the next zoom
   * event. No-op when the live map is showing a different map than
   * the one being edited.
   *
   * @param {string} mapId - `'world'` or `local-${locId}` (matches
   *                         `_currentMapId()`).
   */
  function applyZoomScaleRatio(mapId) {
    if (mapId && mapId !== _currentMapId()) return;
    _applyMarkerScale();
  }

  let _map       = null;
  let _imgW      = 1;
  let _imgH      = 1;
  let _bounds    = null;
  let _markers   = {};
  let _addMode   = false;
  let _editPinId = null;
  // Per-page edit toggle. Replaces the global EditMode.isActive() (and
  // the MutationObserver on `body.edit-mode`) that used to gate pin
  // draggability, the +Add toolbar button, etc. Toggled via the
  // toolbar's ✏ Editovat mapu button; `setEditing(bool)` syncs marker
  // dragging directly so no observer is needed.
  let _editing   = false;
  // When set, the next map click in add-mode assigns x/y to this existing
  // location id instead of opening the new-pin form. Used by the wiki's
  // "📍 Umístit na mapu" button.
  let _placeForLocId = null;
  // When set, the next map click in add-mode writes map coordinates onto
  // the event (mapX/mapY + mapParentId) so sessions can be pinned to the
  // map even when the party didn't visit a named Location.
  let _placeForEventId = null;
  let _modeObserver    = null;
  let _resizeObserver  = null;
  let _eventPathsVisible = false;
  let _eventMarkers    = [];
  let _eventPolylines  = [];

  // Current map context. null = the world map. Otherwise, a location id
  // whose `localMap` image is shown and whose subplaces appear as pins.
  let _currentParentId = null;

  // When navigating into the map from elsewhere (e.g. the "Najít na mapě"
  // button on a wiki page), we can't fly to the pin until the map has
  // finished its async image-preload init. Stash the target here; _doInit
  // consumes it once the map is ready.
  let _pendingPinId = null;

  // Pin shape derived from a Location. Map code below operates on this
  // pin-like view; writes go through Store.saveLocation. `attitudes`
  // is now an array of `{id, strength}` (post-migration); pin fill
  // uses the first entry's id, glow stacks one drop-shadow per entry.
  function _pinFromLocation(l) {
    const attitudes = Array.isArray(l.attitudes) ? l.attitudes : [];
    const firstId = attitudes[0]
      ? (typeof attitudes[0] === 'string' ? attitudes[0] : attitudes[0].id)
      : 'unknown';
    return {
      id:         l.id,
      locationId: l.id,
      name:       l.name,
      x:          l.x,
      y:          l.y,
      type:       l.pinType  || 'custom',
      // The marker fill uses the first listed attitude — enough signal
      // at pin size. The side-panel form exposes the full array.
      // (`status` is a legacy field name on synthetic pins; the
      // side-panel renderer reads it as the primary attitude id.)
      status:     firstId,
      attitudes,
      // Per-pin size override (px); _resolvePinSize falls back to
      // settings.pinTypes[type].size when this is missing.
      size:       (typeof l.size === 'number' && l.size > 0) ? l.size : undefined,
      notes:      l.mapNotes || '',
      parentId:   l.parentId || null,
    };
  }

  // Glow helpers — one drop-shadow per active attitude, alpha = strength.
  // Tiny markers use a smaller blur than wiki cards (`blurPx` arg).
  function _hexToRgba(hex, alpha) {
    let h = String(hex || '').trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return `rgba(136,136,136,${alpha})`;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return `rgba(136,136,136,${alpha})`;
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  function _attitudeGlowFilter(entries, blurPx = 5) {
    if (!Array.isArray(entries) || !entries.length) return '';
    const stripes = _resolveAttitudeStripes(entries);
    if (!stripes.length) return '';
    const layers = [];
    // Stack a tighter inner-glow per attitude so 100% strength reads
    // as a confident glow on small markers (mirrors wiki._attitudeGlow).
    const innerBlur = Math.max(2, Math.round(blurPx * 0.4));
    for (const s of stripes) {
      const rgba = _hexToRgba(s.color, s.strength);
      layers.push(`drop-shadow(0 0 ${blurPx}px ${rgba})`);
      layers.push(`drop-shadow(0 0 ${innerBlur}px ${rgba})`);
    }
    return layers.join(' ');
  }

  // Resolve attitude entries into a normalised list of `{id, strength,
  // color}` records — drops empties, zero-strength, and unknown ids
  // up front so callers don't have to repeat the filtering. Strength
  // is sourced from the `attitudes` settings enum (per-attitude),
  // NOT from each entry — the per-entity strength field was retired
  // (see `_migrateStrengthFromEntityToEnum` in store.js). Used by
  // both the simple stacked-glow and the segmented-stripe rendering
  // paths in `_pinIcon`.
  function _resolveAttitudeStripes(entries) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const enums  = Store.getKinds('attitudes') || [];
    const byId   = Object.fromEntries(enums.map(a => [a.id, a]));
    // Synthetic 'party' meta — pulled from settings.playerParty so
    // PC markers + party-faction pins still glow with the right
    // colour even though 'party' is no longer in the attitudes enum.
    const pp = (Store.getPlayerParty && Store.getPlayerParty()) || null;
    if (pp && pp.color && !byId.party) {
      byId.party = { labelColor: pp.color, strength: 1.0 };
    }
    const out = [];
    for (const e of entries) {
      if (!e) continue;
      const id = (typeof e === 'string') ? e : e.id;
      if (!id) continue;
      const meta = byId[id];
      if (!meta) continue;
      const color = meta.labelColor || meta.bg || '#888';
      const s     = (typeof meta.strength === 'number') ? meta.strength : 1.0;
      if (s <= 0) continue;
      out.push({ id, strength: s, color });
    }
    return out;
  }

  // Drop-shadow filter for a single attitude stripe (used by the
  // segmented multi-attitude renderer where each slab gets its own
  // filter rather than one big additive stack).
  function _stripeGlowFilter(att, blurPx) {
    const innerBlur = Math.max(2, Math.round(blurPx * 0.4));
    const rgba = _hexToRgba(att.color, att.strength);
    return `drop-shadow(0 0 ${blurPx}px ${rgba}) drop-shadow(0 0 ${innerBlur}px ${rgba})`;
  }

  // Sheared vertical-slab clip-path for stripe `i` of `N` (TF2-style
  // diagonal cut between bands — looks better than a hard vertical
  // line). The first/last stripes extend past the marker box on
  // their outer side so drop-shadow blooms freely on the marker's
  // left/right edges; every stripe extends one box-height past the
  // top and bottom too, with the shear angle preserved at y=0 and
  // y=1 so the cut still hits the icon at the intended angle.
  function _stripeClipPath(i, N) {
    if (N <= 1) return '';
    const shear  = 0.65 / N;          // shear amount in 0..1 coords
    const left   = i / N;
    const right  = (i + 1) / N;
    // Extend `yExt` box-heights above/below; the x-coords at the
    // extended y must be moved further out so the line through the
    // box edges still has the correct slope.
    const yExt   = 1.0;
    const xCoef  = 1 + 2 * yExt;      // = 3 when yExt = 1
    const tlx = (i === 0)     ? -1.0 : (left  + xCoef * shear);
    const trx = (i === N - 1) ?  2.0 : (right + xCoef * shear);
    const brx = (i === N - 1) ?  2.0 : (right - xCoef * shear);
    const blx = (i === 0)     ? -1.0 : (left  - xCoef * shear);
    const topY = (-yExt * 100).toFixed(0);
    const botY = ((1 + yExt) * 100).toFixed(0);
    const f = v => (v * 100).toFixed(2);
    return `polygon(${f(tlx)}% ${topY}%, ${f(trx)}% ${topY}%, ${f(brx)}% ${botY}%, ${f(blx)}% ${botY}%)`;
  }
  // All pins for the currently-displayed map (world or a local sub-map).
  function _pinsForCurrent() {
    return Store.getLocationsOnMap(_currentParentId).map(_pinFromLocation);
  }
  // Background image URL for the active map context.
  function _currentImgUrl() {
    if (_currentParentId) {
      const parent = Store.getLocation(_currentParentId);
      if (parent && parent.localMap) return parent.localMap;
    }
    return _getImgUrl();
  }

  function _toLL(fx, fy)  { return L.latLng(-fy * _imgH, fx * _imgW); }
  function _toFrac(ll)    { return { x: ll.lng / _imgW, y: -ll.lat / _imgH }; }

  /**
   * Render the world map (or a location's local sub-map) into
   * `#main-content`. Wired into `app.js`'s router for the
   * `/mapa/svet` and `/mapa/local/:locId` routes.
   *
   * @param {string|null} parentId - Location id whose `localMap` image
   *   is the backdrop, or `null`/falsy for the world map. Stale ids
   *   (deleted location, unmapped) silently fall back to the world
   *   map so bookmarks degrade gracefully.
   */
  function render(parentId) {
    // parentId=null → world map; otherwise a location whose `localMap`
    // image is the backdrop. Stale ids fall back to the world map.
    if (parentId) {
      const p = Store.getLocation(parentId);
      if (!p || !p.localMap) parentId = null;
    }
    _currentParentId = parentId || null;
    const parent = _currentParentId ? Store.getLocation(_currentParentId) : null;
    const titleHtml = parent
      ? `🗺 ${esc(parent.name)} <span class="sc-breadcrumb">
           · <a href="#/mapa/svet">↩ ${esc(I18n.t('map.breadcrumbBack'))}</a>
         </span>`
      : `🗺 ${esc(I18n.t('map.worldTitle'))}`;

    // "+ Přidat místo" / "✚ Uložit pohled" / "⚙ Mapa" are editor-only
    // actions — gated by the `.sc-shell.is-editing` class set by
    // `setEditing(bool)` (toggled via the `✏ Editovat mapu` button).
    // Unified `pageEditToggle` helper keeps the look + behaviour in
    // sync with /casova-osa and /mapa/palac. Positioned as the LAST
    // toolbar item so it anchors top-right next to `.sc-hint`.
    const shellClass = _editing ? 'sc-shell is-editing' : 'sc-shell';
    const editToggle = _renderEditToggleHtml();
    document.getElementById('main-content').innerHTML = `
      <div class="${shellClass}">
        <div class="sc-toolbar ${_editing ? 'is-editing' : ''}">
          <div class="sc-title">${titleHtml}</div>
          <input type="search" class="sc-search" id="sc-search"
                 placeholder="🔍 ${esc(I18n.t('map.searchPlaceholder'))}" autocomplete="off"
                 ${dataOn('input', 'WorldMap.onSearchInput', '$value')}
                 ${dataOn('keydown', 'WorldMap.handleSearchKey', '$ev')}>
          <div class="sc-search-results" id="sc-search-results" hidden></div>
          <button class="sc-btn edit-only-inline ${_addMode ? 'active' : ''}" id="sc-add-btn"${dataAction('WorldMap.toggleAddMode')}>
            ${_addMode ? '✕ ' + esc(I18n.t('map.cancel')) : '+ ' + esc(I18n.t('map.addPlace'))}
          </button>
          <button class="sc-btn ${_eventPathsVisible ? 'active' : ''}" id="sc-event-btn"${dataAction('WorldMap.toggleEventPaths')} title="${esc(I18n.t('map.eventPathsTitle'))}">
            📜 ${esc(I18n.t('map.eventPaths'))}
          </button>
          <span class="sc-zoom-presets" id="sc-zoom-presets">
            <button class="sc-btn"${dataAction('WorldMap.zoomFitAll')} title="${esc(I18n.t('map.zoomFitAllTitle'))}">🌐 ${esc(I18n.t('map.zoomFitAll'))}</button>
            ${_presetButtonsHtml()}
            <button class="sc-btn edit-only-inline"${dataAction('WorldMap.captureCurrentView')} title="${esc(I18n.t('map.saveViewTitle'))}">✚ ${esc(I18n.t('map.saveView'))}</button>
          </span>
          <button class="sc-btn edit-only-inline"${dataAction('WorldMap.showSettings')}>⚙ ${esc(I18n.t('map.mapSettings'))}</button>
          <span class="sc-hint">${_addMode
            ? esc(I18n.t('map.hintAddMode'))
            : esc(I18n.t('map.hintDefault'))
          }</span>
          ${editToggle}
        </div>
        <div id="sc-map-container">
          <!-- Floating zoom panel (top-left). Replaces Leaflet's default
               +/- control plus the toolbar slider that was there before.
               Vertical slider so the +/− anchors line up naturally with
               zoom-in (top) and zoom-out (bottom). -->
          <div class="sc-zoom-panel" id="sc-zoom-panel" title="${esc(I18n.t('map.zoomPanelTitle'))}">
            <button class="sc-zoom-btn" type="button"${dataAction('WorldMap.zoomStep', 1)} title="${esc(I18n.t('map.zoomIn'))}" aria-label="${esc(I18n.t('map.zoomIn'))}">+</button>
            <input type="range" id="sc-zoom-slider"
              class="sc-zoom-slider-vertical"
              orient="vertical"
              min="-8" max="2" step="0.25" value="0"
              aria-label="${esc(I18n.t('map.zoomSliderLabel'))}"
              ${dataOn('input', 'WorldMap.zoomSliderInput', '$value')}>
            <button class="sc-zoom-btn" type="button"${dataAction('WorldMap.zoomStep', -1)} title="${esc(I18n.t('map.zoomOut'))}" aria-label="${esc(I18n.t('map.zoomOut'))}">−</button>
            <!-- Live readout doubles as the 1× reset button: shows current
                 zoom (e.g. "1.50×"), click to snap back to 1.00×. Combines
                 two prior elements into one to keep the panel compact. -->
            <button class="sc-zoom-btn sc-zoom-readout-btn" type="button"
              id="sc-zoom-readout"
              ${dataAction('WorldMap.zoomReset')}
              title="${esc(I18n.t('map.zoomResetTitle'))}"
              aria-label="${esc(I18n.t('map.zoomResetLabel'))}">1.00×</button>
          </div>
        </div>
        <div class="sc-legend" id="sc-legend"></div>
      </div>

      <!-- Pin detail / edit panel -->
      <div class="sc-panel" id="sc-panel" hidden>
        <button class="sc-panel-close"${dataAction('WorldMap.closePanel')}>✕</button>
        <div id="sc-panel-content"></div>
      </div>

      <!-- Settings dialog -->
      <div class="sc-overlay" id="sc-overlay" hidden>
        <div class="sc-dialog">
          <div class="sc-dialog-title">⚙ ${esc(I18n.t('map.settingsTitle'))}</div>
          <p class="sc-dialog-hint">
            <strong>${esc(I18n.t('map.settingsOpt1Label'))}</strong> ${esc(I18n.t('map.settingsOpt1Text'))}<br>
            <strong>${esc(I18n.t('map.settingsOpt2Label'))}</strong> ${esc(I18n.t('map.settingsOpt2Text'))}<br>
            <strong>${esc(I18n.t('map.settingsOpt3Label'))}</strong> ${esc(I18n.t('map.settingsOpt3TextPre'))} <code>data/maps/swordcoast/sword_coast.jpg</code> ${esc(I18n.t('map.settingsOpt3TextPost'))}
          </p>
          <label class="sc-label">${esc(I18n.t('map.settingsUploadLabel'))}</label>
          <label class="sc-btn" style="cursor:pointer;display:inline-block;margin-bottom:0.8rem">
            📂 ${esc(I18n.t('map.settingsChooseFile'))}
            <input type="file" accept="image/*" style="display:none"${dataOn('change', 'WorldMap.handleMapFileUpload', '$el')}>
          </label>
          <label class="sc-label">${esc(I18n.t('map.settingsOrUrl'))}</label>
          <input class="sc-input" id="sc-img-url" type="text" value="${esc(_getImgUrl().startsWith('data:') ? '' : _getImgUrl())}">
          <div class="sc-dialog-actions">
            <button class="sc-btn ok"${dataAction('WorldMap.applySettings')}>✓ ${esc(I18n.t('map.settingsApplyUrl'))}</button>
            <button class="sc-btn"${dataAction('WorldMap.closeSettings')}>${esc(I18n.t('map.cancel'))}</button>
          </div>
        </div>
      </div>
    `;

    _initLeaflet();
    _renderLegend();
  }

  // Identifier of the currently-displayed map. Used to build the
  // tile-pyramid manifest URL `/maps/tiles/<mapId>/tiles.json`.
  //   world map          → "world"
  //   local map of loc X → "local-<locId>"
  function _currentMapId() {
    return _currentParentId ? `local-${_currentParentId}` : 'world';
  }

  function _initLeaflet() {
    _clearEventPaths();
    if (_modeObserver)   { _modeObserver.disconnect();   _modeObserver   = null; }
    if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
    if (_map) { _map.remove(); _map = null; }

    const imgUrl    = _currentImgUrl();
    const container = document.getElementById('sc-map-container');
    const mapId     = _currentMapId();

    // Try the tile-pyramid manifest first. Server computes tiles on
    // demand via sharp and exposes a `tiles.json` with dimensions +
    // zoom bounds. If the manifest is absent (404 / network error /
    // bad JSON) we fall back to the single-image overlay path that
    // has always worked.
    fetch(`/maps/tiles/${encodeURIComponent(mapId)}/tiles.json`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('no manifest')))
      .then(m => _doInitTiled(mapId, m, container))
      .catch(() => {
        const img = new Image();
        img.onload  = () => _doInit(img, imgUrl, container);
        img.onerror = () => _showMapError(container);
        img.src = imgUrl;
      });
  }

  // Initialise the map using a sharp-generated tile pyramid. `manifest`
  // shape: { width, height, tileSize, minZoom, maxZoom, ext? }. The
  // ext defaults to "jpg". Tile URLs follow Leaflet's {z}/{x}/{y} scheme.
  function _doInitTiled(mapId, manifest, container) {
    _imgW   = Number(manifest.width)  || 2048;
    _imgH   = Number(manifest.height) || 1340;
    _bounds = [[-_imgH, 0], [0, _imgW]];

    const tileSize = Number(manifest.tileSize) || 256;
    const ext      = String(manifest.ext || 'jpg');
    const minZoom  = Number.isFinite(manifest.minZoom) ? manifest.minZoom : -8;
    const maxZoom  = Number.isFinite(manifest.maxZoom) ? manifest.maxZoom : 2;

    _map = L.map(container, {
      crs:                 L.CRS.Simple,
      minZoom,
      maxZoom,
      zoomSnap:            0.25,
      zoomDelta:           0.5,
      wheelPxPerZoomLevel: 120,
      attributionControl:  false,
      // Leaflet's default +/- zoom control would duplicate our custom
      // vertical slider in the floating top-left zoom panel.
      zoomControl:         false,
    });

    L.tileLayer(
      `/maps/tiles/${encodeURIComponent(mapId)}/{z}/{x}/{y}.${ext}`,
      { tileSize, noWrap: true, bounds: _bounds, minZoom, maxZoom },
    ).addTo(_map);

    _map.fitBounds(_bounds);
    requestAnimationFrame(() => _enforceFitZoom());

    _wirePostInit();
  }

  function _fitZoom() {
    if (!_map || !_bounds) return -3;
    return _map.getBoundsZoom(_bounds, false);
  }

  function _enforceFitZoom() {
    if (!_map) return;
    const minZ = _fitZoom();
    _map.setMinZoom(minZ);
    if (_map.getZoom() < minZ) {
      _map.fitBounds(_bounds, { animate: true });
    }
    // The slider's min was set from the static L.map options before
    // `_fitZoom()` had a width to work with — refresh bounds and
    // readout now that we know the actual lower limit.
    _syncZoomSliderBounds();
    _updateZoomReadout();
  }

  function _doInit(img, imgUrl, container) {
    _imgW   = img.naturalWidth  || 2048;
    _imgH   = img.naturalHeight || 1340;
    _bounds = [[-_imgH, 0], [0, _imgW]];

    _map = L.map(container, {
      crs:                 L.CRS.Simple,
      minZoom:             -8,
      maxZoom:             2,
      zoomSnap:            0.25,
      zoomDelta:           0.5,
      wheelPxPerZoomLevel: 120,
      attributionControl:  false,
      // Leaflet's default +/- zoom control would duplicate our custom
      // vertical slider in the floating top-left zoom panel.
      zoomControl:         false,
    });

    L.imageOverlay(imgUrl, _bounds).addTo(_map);
    _map.fitBounds(_bounds);

    requestAnimationFrame(() => _enforceFitZoom());

    _wirePostInit(container);
  }

  // Shared post-init wiring: marker placement, zoomend/click/edit-mode
  // observers, resize handling, pending-pin flush. Used by both the
  // tile-pyramid init path and the legacy imageOverlay fallback.
  function _wirePostInit(container) {
    _markers = {};
    _pinsForCurrent().forEach(_placePin);

    // Stop slider/button drags inside the floating zoom panel from
    // bubbling up to Leaflet's pan handler. Without this guard, a
    // mousedown on the slider thumb starts a map pan AND the slider
    // never receives the live drag events — so the map slides
    // around while the slider thumb appears frozen until release.
    // `disableClickPropagation` covers mouse + touch; `disableScrollPropagation`
    // stops wheel scroll over the panel from zooming the map (so a
    // wheel over the controls doesn't fight with a wheel over tiles).
    const zoomPanel = document.getElementById('sc-zoom-panel');
    if (zoomPanel && L && L.DomEvent) {
      L.DomEvent.disableClickPropagation(zoomPanel);
      L.DomEvent.disableScrollPropagation(zoomPanel);
    }
    // Track the slider's drag gesture so async zoomend events don't
    // overwrite `slider.value` mid-drag (which would make the thumb
    // visually jump backward). Pointer events cover mouse + touch +
    // pen in one listener; `pointercancel` handles tablet flicks.
    const zoomSlider = document.getElementById('sc-zoom-slider');
    if (zoomSlider) {
      const onDown = () => { _sliderInteracting = true; };
      const onUp   = () => { _sliderInteracting = false; };
      zoomSlider.addEventListener('pointerdown',   onDown);
      zoomSlider.addEventListener('pointerup',     onUp);
      zoomSlider.addEventListener('pointercancel', onUp);
      // Defensive: a focused slider that loses focus mid-drag (e.g. a
      // modal opens) should release the lock so the readout sync
      // resumes on the next zoomend.
      zoomSlider.addEventListener('blur',          onUp);
    }

    _syncZoomSliderBounds();
    _applyMarkerScale();
    _updateZoomReadout();

    // zoomanim fires only for animated zooms (wheel, double-click, +/−
    // buttons via Leaflet shortcut). Slider drags use {animate:false}
    // and skip this entirely, so they keep snapping instantly.
    _map.on('zoomanim', (e) => {
      const r  = _currentZoomScaleRatio();
      const z1 = e.zoom;
      const target = _iconScaleAtZoom(z1, r).toFixed(4);
      // Match Leaflet's tile animation timing/easing so the marker
      // scale lerps in lock-step with the visible map zoom.
      _setMarkerTransition('transform 0.25s cubic-bezier(0,0,0.25,1)');
      for (const m of Object.values(_markers)) {
        const el  = m.getElement && m.getElement();
        const pin = el && el.querySelector ? el.querySelector('.sc-pin') : null;
        if (pin) pin.style.setProperty('--sc-pin-base-scale', target);
      }
    });
    _map.on('zoomend', () => {
      // Snap any in-flight transition off, write the final scale
      // (same value the transition was heading to, so no visible
      // jump), then restore the CSS-rule hover transition next frame.
      _setMarkerTransition('none');
      _renderLegend();
      _applyMarkerScale();
      _updateZoomReadout();
      requestAnimationFrame(() => _setMarkerTransition(''));
    });

    _map.on('click', evt => {
      if (!_addMode) return;
      const frac = _toFrac(evt.latlng);
      // If we're placing an existing location (from the wiki "Umístit na
      // mapu" button), just write x/y and re-render instead of opening
      // the new-pin form.
      if (_placeForLocId) {
        const loc = Store.getLocation(_placeForLocId);
        _placeForLocId = null;
        _setAddMode(false);
        if (!loc) return;
        const patch = { ...loc, x: frac.x, y: frac.y };
        if (_currentParentId) patch.parentId = _currentParentId;
        if (!patch.pinType)   patch.pinType   = 'custom';
        // Preserve existing attitudes; only seed an empty array.
        if (!Array.isArray(patch.attitudes)) patch.attitudes = [];
        Store.saveLocation(patch);
        _refreshPin(loc.id);
        setTimeout(() => zoomToPin(loc.id), 50);
        return;
      }
      // Placing an event-only pin — stash coordinates on the event itself.
      if (_placeForEventId) {
        const ev = Store.getEvent(_placeForEventId);
        _placeForEventId = null;
        _setAddMode(false);
        if (!ev) return;
        Store.saveEvent({ ...ev, mapX: frac.x, mapY: frac.y, mapParentId: _currentParentId });
        // Make sure the newly-placed pin is actually visible.
        if (!_eventPathsVisible) {
          _eventPathsVisible = true;
          const btn = document.getElementById('sc-event-btn');
          if (btn) btn.classList.add('active');
        }
        _drawEventPaths();
        _renderLegend();
        return;
      }
      _openNewPin(frac.x, frac.y);
      _setAddMode(false);
    });

    // No MutationObserver any more — the legacy global edit-mode toggle
    // is gone. Marker draggability + toolbar state are kept in sync by
    // `setEditing(bool)` calling directly into Leaflet (see below).
    _modeObserver = null;

    if (_resizeObserver) _resizeObserver.disconnect();
    _resizeObserver = new ResizeObserver(() => {
      if (!_map) return;
      _map.invalidateSize();
      _enforceFitZoom();
    });
    _resizeObserver.observe(container);

    // Consume any pending "fly to pin" request scheduled before the map
    // was ready (e.g. WorldMap.showPin triggered during a hash navigation).
    if (_pendingPinId) {
      const id = _pendingPinId;
      _pendingPinId = null;
      setTimeout(() => zoomToPin(id), 50);
    }

    // Re-arm placement intent if it survived a re-render (SSE flush,
    // hashchange re-nav, etc.). The click handler clears the intent on
    // success, so this is idempotent after placement.
    _armForCurrentTarget();
  }

  // Reads the current _placeForLocId / _placeForEventId intent and puts
  // the map back into add-mode with the right hint. Safe to call whenever
  // the map is (re)initialised — no-op if nothing is armed.
  function _armForCurrentTarget() {
    if (!_map) return;
    if (_placeForLocId) {
      const loc = Store.getLocation(_placeForLocId);
      if (!loc) { _placeForLocId = null; return; }
      _setAddMode(true);
      const hint = document.querySelector('.sc-hint');
      if (hint) hint.textContent = I18n.t('map.hintPlaceLocation', { name: loc.name });
      return;
    }
    if (_placeForEventId) {
      const ev = Store.getEvent(_placeForEventId);
      if (!ev) { _placeForEventId = null; return; }
      _setAddMode(true);
      const hint = document.querySelector('.sc-hint');
      if (hint) hint.textContent = I18n.t('map.hintPlaceEvent', { name: ev.name });
    }
  }

  function _showMapError(container) {
    container.innerHTML = `
      <div class="sc-img-error">
        <div style="font-size:2rem;margin-bottom:1rem">🗺</div>
        <div style="font-size:1.1rem;margin-bottom:0.5rem"><strong>${esc(I18n.t('map.errorTitle'))}</strong></div>
        <div style="font-size:0.88rem;line-height:1.6;max-width:420px">
          ${esc(I18n.t('map.errorTextPre'))} <strong>⚙ ${esc(I18n.t('map.errorTextMenu'))}</strong> ${esc(I18n.t('map.errorTextMid'))}
          <code>data/maps/swordcoast/sword_coast.jpg</code>.
        </div>
        <button class="sc-btn" style="margin-top:1.2rem"${dataAction('WorldMap.showSettings')}>⚙ ${esc(I18n.t('map.errorOpenSettings'))}</button>
      </div>`;
  }

  function _pinIcon(pin) {
    const pt   = PIN_TYPES[pin.type]  || PIN_TYPES.custom;
    const size = _resolvePinSize(pin);
    const fontPx = Math.round(size * 0.85);
    const blurPx = Math.max(5, Math.round(size * 0.22));
    // 1px multi-direction dark stroke + soft halo so the bare emoji
    // stays legible on any tile colour. Replaces the old "solid pin
    // fill" approach — attitudes show via the colored drop-shadow
    // glow below; pins without attitudes have no glow at all (per
    // the convention that "no stance set" = "not yet meaningful").
    const textShadow = [
      '-1px 0 0 rgba(0,0,0,0.75)',
      '1px 0 0 rgba(0,0,0,0.75)',
      '0 -1px 0 rgba(0,0,0,0.75)',
      '0 1px 0 rgba(0,0,0,0.75)',
      '0 0 4px rgba(0,0,0,0.55)',
    ].join(', ');

    // Custom marker artwork — when the pin type has uploaded icons
    // configured, the resolver returns a URL; otherwise it falls through
    // to the bundled default under /icons-defaults/. If neither exists,
    // null falls through to the emoji glyph branch below.
    const iconUrl = _resolveIconUrl(pin);
    // For SVG icons we add a stacked black drop-shadow as a 1 px outline
    // so the (mostly-white) artwork stays legible on any tile colour —
    // analogous to the multi-direction text-shadow stroke used on the
    // emoji branch. Stacks alongside any attitude glow.
    const svgOutline = iconUrl
      ? `drop-shadow(0 0 1px rgba(0,0,0,0.95)) drop-shadow(0 0 1px rgba(0,0,0,0.95))`
      : '';

    // Build the visible layer(s).
    //   • 0 attitudes → one layer, no glow (just outline for SVG, plain emoji otherwise).
    //   • 1 attitude  → one layer, single coloured glow.
    //   • 2+ attitudes → one layer per attitude, each clipped to a sheared
    //                    vertical slab so the colours stripe rather than
    //                    blend into a muddy single colour. Outer slabs
    //                    extend past the box so the halo blooms unclipped
    //                    on the marker's left/right edges.
    const stripes = _resolveAttitudeStripes(pin.attitudes || []);
    const N = stripes.length;
    const layerHtml = (filterStr, clipStr, isOnlyLayer) => {
      const cls = isOnlyLayer
        ? (iconUrl ? 'sc-pin-icon'  : 'sc-pin-emoji')
        : (iconUrl ? 'sc-pin-icon-segment' : 'sc-pin-emoji-segment');
      const styles = [];
      if (filterStr) styles.push(`filter:${filterStr}`);
      if (clipStr)   styles.push(`clip-path:${clipStr};-webkit-clip-path:${clipStr}`);
      if (!iconUrl)  styles.push(`font-size:${fontPx}px`, `text-shadow:${textShadow}`);
      const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
      return iconUrl
        ? `<img class="${cls}" src="${esc(iconUrl)}" alt="" draggable="false"${styleAttr}>`
        : `<span class="${cls}"${styleAttr}>${pt.icon}</span>`;
    };

    let inner;
    if (N <= 1) {
      const glow = N === 1 ? _stripeGlowFilter(stripes[0], blurPx) : '';
      const filterStr = [svgOutline, glow].filter(Boolean).join(' ');
      inner = layerHtml(filterStr, '', /* isOnlyLayer */ true);
    } else {
      const segments = [];
      for (let i = 0; i < N; i++) {
        const filterStr = [svgOutline, _stripeGlowFilter(stripes[i], blurPx)].filter(Boolean).join(' ');
        const clipStr   = _stripeClipPath(i, N);
        segments.push(layerHtml(filterStr, clipStr, /* isOnlyLayer */ false));
      }
      inner = segments.join('');
    }

    return L.divIcon({
      className: '',
      iconSize:  [size, size],
      iconAnchor:[size/2, size/2],
      html: `<div class="sc-pin sc-pin-${pin.status}" style="width:${size}px;height:${size}px;" title="${esc(pin.name)}">${inner}</div>`,
    });
  }

  function _placePin(pin) {
    if (!_map) return;
    const ll = _toLL(pin.x, pin.y);
    const m  = L.marker(ll, {
      icon:      _pinIcon(pin),
      draggable: true,
      title:     pin.name,
    }).addTo(_map);
    if (!_editing) m.dragging.disable();

    m.on('click', () => _openPinPanel(pin.id));
    m.on('dragend', () => {
      const frac = _toFrac(m.getLatLng());
      const loc  = Store.getLocation(pin.locationId);
      if (!loc) return;
      Store.saveLocation({ ...loc, x: frac.x, y: frac.y });
    });

    _markers[pin.id] = m;
  }

  function _refreshPin(pinId) {
    const pin = _pinsForCurrent().find(p => p.id === pinId);
    if (!pin) return;
    if (_markers[pinId]) { _markers[pinId].remove(); delete _markers[pinId]; }
    _placePin(pin);
  }

  // (`_applyPinVisibility`/`_priorityOf`/`_thresholdForZoom` were
  // removed when the legacy priority field was retired. Per-Pohled
  // visibility rules will replace that gating in a future iteration.)

  // ── Preset zoom buttons ────────────────────────────────────────
  function zoomFitAll() {
    if (_map && _bounds) _map.fitBounds(_bounds, { animate: true });
  }

  // Fit bounds around pins linked to EVERY event that has a `sitting`
  // number, i.e. everything that has happened in play so far. `maxZoom`
  // caps how close Leaflet may zoom when the bounds collapse to a
  // single pin. Used internally by toggleEventPaths when activating.
  function _zoomCurrentSitting() {
    if (!_map) return;
    const events = Store.getEvents();
    const locs = new Set();
    for (const e of events) {
      if (typeof e.sitting !== 'number') continue;
      for (const lid of e.locations || []) locs.add(lid);
    }
    if (!locs.size) { zoomFitAll(); return; }
    const pts = _pinsForCurrent()
      .filter(p => p.locationId && locs.has(p.locationId))
      .map(p => _toLL(p.x, p.y));
    if (!pts.length) { zoomFitAll(); return; }
    const capZoom = Math.min(0, _map.getMaxZoom());
    _map.fitBounds(L.latLngBounds(pts).pad(0.4), {
      animate: true,
      maxZoom: capZoom,
    });
  }

  // ── User-defined map view presets ──────────────────────────────
  // Stored in settings as `mapViews`; each preset captures the
  // fractional image bounds of a Leaflet view plus a parentId so
  // world-map presets don't pollute sub-map toolbars.
  function _mapViewsForCurrent() {
    const all = (Store.getEnum && Store.getEnum('mapViews')) || [];
    return all.filter(v => (v.parentId || null) === (_currentParentId || null));
  }

  function _presetButtonsHtml() {
    const views = _mapViewsForCurrent();
    return views.map(v => {
      const icon  = esc(v.icon || '📍');
      const label = esc(v.label || '—');
      return `<button class="sc-btn"${dataAction('WorldMap.applyMapView', v.id)}
                 title="${esc(v.label || '')}">${icon} ${label}</button>`;
    }).join('');
  }

  function _refreshPresetButtons() {
    const host = document.getElementById('sc-zoom-presets');
    if (!host) return;
    // Rebuild just the preset buttons between "Celá" and "Uložit pohled".
    host.innerHTML = `
      <button class="sc-btn"${dataAction('WorldMap.zoomFitAll')} title="${esc(I18n.t('map.zoomFitAllTitle'))}">🌐 ${esc(I18n.t('map.zoomFitAll'))}</button>
      ${_presetButtonsHtml()}
      <button class="sc-btn edit-only-inline"${dataAction('WorldMap.captureCurrentView')} title="${esc(I18n.t('map.saveViewTitle'))}">✚ ${esc(I18n.t('map.saveView'))}</button>
    `;
  }

  function applyMapView(id) {
    if (!_map) return;
    const v = (Store.getEnum && Store.getEnum('mapViews') || []).find(x => x.id === id);
    if (!v || !v.bounds) return;
    const b = v.bounds;
    const p1 = _toLL(b.x1, b.y1);
    const p2 = _toLL(b.x2, b.y2);
    _map.flyToBounds(L.latLngBounds(p1, p2), { animate: true });
  }

  function captureCurrentView() {
    if (!_map) return;
    const label = prompt(I18n.t('map.promptViewName'));
    if (!label || !label.trim()) return;
    const icon = (prompt(I18n.t('map.promptViewIcon')) || '📍').trim() || '📍';
    const ll = _map.getBounds();
    const sw = _toFrac(ll.getSouthWest());
    const ne = _toFrac(ll.getNorthEast());
    const bounds = {
      x1: Math.max(0, Math.min(sw.x, ne.x)),
      y1: Math.max(0, Math.min(sw.y, ne.y)),
      x2: Math.min(1, Math.max(sw.x, ne.x)),
      y2: Math.min(1, Math.max(sw.y, ne.y)),
    };
    const id = _slugify(label) + '_' + Math.random().toString(36).slice(2, 7);
    const preset = {
      id,
      label: label.trim(),
      icon,
      parentId: _currentParentId || null,
      bounds,
    };
    Store.saveEnumItem('mapViews', preset);
    _refreshPresetButtons();
  }

  function _slugify(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 30) || 'view';
  }

  function _openPinPanel(pinId) {
    // Edit mode opens the edit form directly. Viewing opens a read-only
    // panel whose header links to the place page.
    if (_editing) {
      const pin = _pinsForCurrent().find(p => p.id === pinId) || {};
      _renderPinForm(pin, false);
      return;
    }
    const pin = _pinsForCurrent().find(p => p.id === pinId);
    if (!pin) return;
    _editPinId = pinId;
    const pt       = PIN_TYPES[pin.type] || PIN_TYPES.custom;
    const statuses = _pinStatuses();
    const ps       = statuses[pin.status] || statuses.unknown;
    const loc      = pin.locationId ? Store.getLocation(pin.locationId) : null;

    const subCount = loc ? Store.getSubLocations(loc.id).length : 0;
    const hasLocalMap = !!(loc && loc.localMap);
    const localMapBtn = hasLocalMap
      ? `<button class="sc-btn ok"${dataAction('WorldMap.openLocalMap', loc.id)}>🗺 ${esc(I18n.t('map.localMap'))}</button>`
      : '';
    const subInfo = subCount
      ? `<div class="sc-pin-meta" style="margin-top:0.4rem">⛬ ${esc(I18n.plural('map.subLocationCount', subCount))}</div>`
      : '';

    // Show every attitude label (comma-joined) so mixed-stance places
    // read as "Chrám · Spojenec, Nepřítel 70%" rather than only
    // surfacing the primary stance. Strength is now sourced from the
    // `attitudes` settings enum (per-attitude); % is omitted at 100%.
    const attEntries = (pin.attitudes && pin.attitudes.length)
      ? pin.attitudes
      : (pin.status ? [{ id: pin.status }] : []);
    const attEnum = Store.getKinds('attitudes') || [];
    const attLabels = attEntries.map(e => {
      const id = (typeof e === 'string') ? e : e.id;
      const s = statuses[id];
      if (!s) return '';
      const def = attEnum.find(a => a.id === id);
      const strength = (def && typeof def.strength === 'number') ? def.strength : 1.0;
      const pct = strength === 1.0 ? '' : ` ${Math.round(strength * 100)}%`;
      return `<span style="color:${s.labelColor}">${esc(s.label)}${esc(pct)}</span>`;
    }).filter(Boolean).join(', ');
    const previewUrl = _resolveIconUrl(pin);
    const previewHtml = previewUrl
      ? `<img class="sc-pin-icon" src="${esc(previewUrl)}" alt="" draggable="false">`
      : `<span class="sc-pin-icon">${pt.icon}</span>`;
    const headerInner = `
      ${previewHtml}
      <div>
        <div class="sc-pin-name">${esc(pin.name)}</div>
        <div class="sc-pin-meta">${pt.label}${attLabels ? ' · ' + attLabels : ''}</div>
        ${subInfo}
      </div>`;
    const header = loc
      ? `<a class="sc-pin-header sc-pin-header-link" href="#/misto/${loc.id}"${dataAction('WorldMap.closePanel')}>${headerInner}</a>`
      : `<div class="sc-pin-header">${headerInner}</div>`;

    // Additive addon content slot for the pin/location side panel. Zero-cost
    // without addons; each contribution wrapped in its own data-addon-id div.
    const addonExtra = Addons.slotContent('map:pin:panel', {
      location: loc, pin, role: { isDM: Role.isDM() },
    }).map(c => `<div class="sc-pin-addon" data-addon-id="${esc(c.addonId)}">${c.html}</div>`).join('');
    document.getElementById('sc-panel-content').innerHTML = `
      <div class="sc-pin-view">
        ${header}
        ${pin.notes ? `<div class="sc-pin-notes">${esc(pin.notes)}</div>` : ''}
        ${localMapBtn ? `<div class="sc-pin-actions">${localMapBtn}</div>` : ''}
        ${addonExtra}
      </div>
    `;
    document.getElementById('sc-panel').removeAttribute('hidden');
  }

  function _openNewPin(x, y) {
    _renderPinForm({ x, y, attitudes: [], type: 'custom' }, true);
    document.getElementById('sc-panel').removeAttribute('hidden');
  }

  // Resolve the representative icon URL for the type-picker menu. Uses
  // the default-slot file or first uploaded file when a pin type has
  // an iconConfig; otherwise falls through to the bundled game-icons
  // default. Skips the random strategy logic since the menu wants
  // ONE consistent icon per type, not a per-pin sample.
  function _typeMenuIconUrl(typeId) {
    const types  = (Store.getEnum && Store.getEnum('pinTypes')) || [];
    const cfg    = types.find(t => t.id === typeId)?.iconConfig;
    if (cfg && Array.isArray(cfg.files) && cfg.files.length && cfg.files[0].url) {
      return cfg.files[0].url;
    }
    return _bundledDefaultUrl(typeId);
  }
  function _renderPinForm(pin, isNew) {
    _editPinId = pin.id || null;
    const currentType = pin.type || 'custom';
    // Custom dropdown — the native <select> can only render emoji
    // in <option>s, but we want SVG icons throughout. A hidden
    // `#spf-type` input preserves the existing save/read contract;
    // a styled button trigger + click-to-open menu replaces the
    // native picker. Each menu row is a button so the action
    // dispatcher routes selection through `WorldMap.selectPinType`.
    const typeMenuItems = Object.entries(PIN_TYPES).map(([k, v]) => {
      const url = _typeMenuIconUrl(k);
      const iconHtml = url
        ? `<img class="spf-type-menu-icon" src="${esc(url)}" alt="" draggable="false">`
        : `<span class="spf-type-menu-icon spf-type-menu-icon-emoji">${v.icon}</span>`;
      const activeCls = (k === currentType) ? ' is-active' : '';
      return `<button type="button" class="spf-type-menu-item${activeCls}"
        data-spf-type="${esc(k)}"
        ${dataAction('WorldMap.selectPinType', k)}>
        ${iconHtml}
        <span class="spf-type-menu-label">${esc(v.label)}</span>
      </button>`;
    }).join('');
    const currentLabel = (PIN_TYPES[currentType] || PIN_TYPES.custom).label;
    // Trigger icon mirrors the menu items so the closed dropdown still
    // shows the visual marker for the currently-selected type, not just
    // its name. Same resolver and fallback chain as menu rows.
    const currentTriggerIconUrl = _typeMenuIconUrl(currentType);
    const currentTriggerIconHtml = currentTriggerIconUrl
      ? `<img class="spf-type-trigger-icon" src="${esc(currentTriggerIconUrl)}" alt="" draggable="false">`
      : `<span class="spf-type-trigger-icon spf-type-trigger-icon-emoji">${(PIN_TYPES[currentType] || PIN_TYPES.custom).icon}</span>`;
    // Pin form exposes the full attitudes array (with per-attitude
    // strength sliders) so multi-stance places can be edited from the
    // map without switching to the wiki editor. Same chip-row helper
    // the location/character editors use.
    const pinAttEntries = Array.isArray(pin.attitudes) && pin.attitudes.length
      ? pin.attitudes
      : (pin.status ? [{ id: pin.status, strength: 1.0 }] : []);
    const attChipRowHtml = EditTemplates.attitudeChipRow('spf-attitudes', pinAttEntries);
    // Marker pixel size — defaults to the pin type's size from
    // settings, overridable per-place. Number input + range slider
    // pair; both `oninput` write into each other so the readout
    // stays in sync without a dedicated handler.
    const currentSize  = _resolvePinSize(pin);
    const inheritsSize = !(typeof pin.size === 'number' && pin.size > 0);

    // For NEW pins on the world map: optional Combobox to drop an EXISTING
    // location onto the map (sets x/y on it). Otherwise a fresh place is
    // created. For existing pins, this picker is hidden.
    const linkPicker = isNew ? `
      <label class="sc-label">${esc(I18n.t('map.useExistingLocation'))}</label>
      <div class="cb-mount"
        data-cb-id="spf-existing"
        data-cb-source="location"
        data-cb-value=""
        data-cb-allow-empty="1"
        data-cb-empty-label="${esc(I18n.t('map.createNewOption'))}"
        data-cb-placeholder="${esc(I18n.t('map.searchExistingPlaceholder'))}"></div>` : '';

    document.getElementById('sc-panel-content').innerHTML = `
      <div class="sc-pin-form">
        <div class="sc-pin-form-title">${isNew ? esc(I18n.t('map.formTitleNew')) : esc(I18n.t('map.formTitleEdit'))}</div>
        ${linkPicker}
        <label class="sc-label">${esc(I18n.t('map.fieldName'))} *</label>
        <input class="sc-input" id="spf-name" type="text" value="${esc(pin.name||'')}" placeholder="Waterdeep...">
        <label class="sc-label">${esc(I18n.t('map.fieldType'))}</label>
        <div class="spf-type-row">
          <!-- Hidden input preserves the read contract: savePin reads
               document.getElementById('spf-type').value. -->
          <input type="hidden" id="spf-type" value="${esc(currentType)}">
          <div class="spf-type-picker">
            <button type="button" class="sc-input spf-type-trigger"
              id="spf-type-trigger"
              aria-haspopup="listbox"
              aria-expanded="false"
              ${dataAction('WorldMap.toggleTypeMenu')}>
              ${currentTriggerIconHtml}
              <span class="spf-type-trigger-label">${esc(currentLabel)}</span>
              <span class="spf-type-trigger-chevron" aria-hidden="true">▾</span>
            </button>
            <div class="spf-type-menu" id="spf-type-menu" role="listbox" hidden>
              ${typeMenuItems}
            </div>
          </div>
        </div>
        <label class="sc-label">${esc(I18n.t('map.fieldAttitudes'))} <span class="sc-hint">${esc(I18n.t('map.fieldAttitudesHint'))}</span></label>
        ${attChipRowHtml}
        <label class="sc-label">${esc(I18n.t('map.fieldSize'))} <span class="sc-hint">${inheritsSize ? esc(I18n.t('map.fieldSizeInherited')) : esc(I18n.t('map.fieldSizeCustom'))}</span></label>
        <div class="sc-pin-size-row">
          <input type="range" id="spf-size-range" min="${PIN_SIZE_MIN}" max="${PIN_SIZE_MAX}" step="2" value="${currentSize}"
            ${dataOn('input', 'WorldMap.syncSizeFromRange')}>
          <input type="number" id="spf-size" min="${PIN_SIZE_MIN}" max="${PIN_SIZE_MAX}" step="2" value="${currentSize}"
            ${dataOn('input', 'WorldMap.syncSizeFromNumber')}>
          <span class="sc-hint">px</span>
        </div>
        <label class="sc-label">${esc(I18n.t('map.fieldNotes'))}</label>
        <textarea class="sc-input" id="spf-notes" rows="3" placeholder="${esc(I18n.t('map.fieldNotesPlaceholder'))}">${esc(pin.notes||'')}</textarea>
        <div class="sc-pin-actions">
          <button class="sc-btn ok"${dataAction('WorldMap.savePin', isNew, pin.x||0, pin.y||0)}>💾 ${esc(I18n.t('map.save'))}</button>
          ${!isNew ? `<a class="sc-btn" href="#/misto/${pin.locationId}">📖 ${esc(I18n.t('map.openPlace'))}</a>` : ''}
          ${!isNew ? `<button class="sc-btn err"${dataAction('WorldMap.deletePin', pin.id)}>🗑 ${esc(I18n.t('map.removeFromMap'))}</button>` : ''}
        </div>
      </div>
    `;
    document.getElementById('sc-panel').removeAttribute('hidden');
    Widgets.mountAll(document.getElementById('sc-panel-content'));
  }

  // ── Custom pin-type dropdown ─────────────────────────────────────
  // The native <select> can only render emoji glyphs in <option>s,
  // so we built a custom dropdown that uses the same SVG resolver
  // as the marker preview. State is minimal: the menu is either
  // open or closed; closing happens on selection, Esc, or click
  // outside the picker.
  function toggleTypeMenu() {
    const menu    = document.getElementById('spf-type-menu');
    const trigger = document.getElementById('spf-type-trigger');
    if (!menu || !trigger) return;
    const willOpen = menu.hasAttribute('hidden');
    if (willOpen) {
      menu.removeAttribute('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      // Scroll the active item into view so the GM doesn't have to
      // search through 28 entries.
      const active = menu.querySelector('.spf-type-menu-item.is-active');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' });
      }
    } else {
      closeTypeMenu();
    }
  }
  function closeTypeMenu() {
    const menu    = document.getElementById('spf-type-menu');
    const trigger = document.getElementById('spf-type-trigger');
    if (menu)    menu.setAttribute('hidden', '');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  // Pick a pin type from the custom dropdown. Updates the hidden
  // input (so save/read code is unchanged), refreshes the trigger
  // label + active highlight, closes the menu, and refreshes the
  // big SVG preview block.
  function selectPinType(typeId) {
    const hidden  = document.getElementById('spf-type');
    const trigger = document.getElementById('spf-type-trigger');
    const menu    = document.getElementById('spf-type-menu');
    if (!hidden || !trigger || !menu) return;
    hidden.value = typeId;
    const label = (PIN_TYPES[typeId] || PIN_TYPES.custom).label;
    const labelSpan = trigger.querySelector('.spf-type-trigger-label');
    if (labelSpan) labelSpan.textContent = label;
    // Replace the trigger icon in place so img↔emoji-span fallback
    // toggles cleanly when the new type has no resolvable artwork.
    const oldIcon = trigger.querySelector('.spf-type-trigger-icon');
    if (oldIcon) {
      const url = _typeMenuIconUrl(typeId);
      let nextIcon;
      if (url) {
        nextIcon = document.createElement('img');
        nextIcon.className = 'spf-type-trigger-icon';
        nextIcon.src = url;
        nextIcon.alt = '';
        nextIcon.draggable = false;
      } else {
        nextIcon = document.createElement('span');
        nextIcon.className = 'spf-type-trigger-icon spf-type-trigger-icon-emoji';
        nextIcon.textContent = (PIN_TYPES[typeId] || PIN_TYPES.custom).icon;
      }
      oldIcon.replaceWith(nextIcon);
    }
    // Move the .is-active highlight to the freshly-picked row so a
    // re-open shows the right selection state without a full re-render.
    menu.querySelectorAll('.spf-type-menu-item.is-active').forEach(el =>
      el.classList.remove('is-active')
    );
    const next = menu.querySelector(`.spf-type-menu-item[data-spf-type="${typeId}"]`);
    if (next) next.classList.add('is-active');
    closeTypeMenu();
  }
  // Close the custom dropdown when the user clicks outside it. One
  // document-level listener wired at module init; safely no-ops when
  // the menu isn't currently open / mounted.
  document.addEventListener('click', (ev) => {
    const menu = document.getElementById('spf-type-menu');
    if (!menu || menu.hasAttribute('hidden')) return;
    const picker = ev.target.closest && ev.target.closest('.spf-type-picker');
    if (!picker) closeTypeMenu();
  }, true);
  // Esc also closes — independent of focus, since the menu items
  // don't necessarily own the focus.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const menu = document.getElementById('spf-type-menu');
    if (menu && !menu.hasAttribute('hidden')) closeTypeMenu();
  });

  // Save form values onto a Location: either the linked existing one,
  // the location currently being edited, or a freshly-created place.
  function savePin(isNew, x, y) {
    const name = document.getElementById('spf-name')?.value.trim();
    if (!name) { alert(I18n.t('map.nameRequired')); return; }
    const pinType  = document.getElementById('spf-type')?.value   || 'custom';
    const mapNotes = document.getElementById('spf-notes')?.value  || '';
    // Multi-attitude with per-attitude strength sliders. Empty array
    // = no stance set, pin renders with no glow halo.
    const attitudes = EditTemplates.readAttitudeChipRow('spf-attitudes');
    // Marker size — only persist when it actually differs from the
    // pin type's default, so changing the type's default later still
    // moves places that were never explicitly customised.
    const sizeRaw = document.getElementById('spf-size')?.value;
    const sizeNum = sizeRaw === '' || sizeRaw == null ? null : parseInt(sizeRaw, 10);

    let loc = null;
    if (isNew) {
      const existingId = document.getElementById('spf-existing')?.value || '';
      if (existingId) loc = Store.getLocation(existingId);
      if (!loc) {
        const newId = 'loc_' + Store.generateId(name) + '_' + Date.now();
        loc = { id: newId, name, type: '', description: '', notes: '' };
      }
      loc = { ...loc, name, x, y };
    } else {
      loc = Store.getLocation(_editPinId);
      if (!loc) return;
      loc = { ...loc, name };
    }
    if (_currentParentId) loc.parentId = _currentParentId;
    loc.pinType    = pinType;
    loc.attitudes  = attitudes;
    loc.mapNotes   = mapNotes;
    // Decide whether to write a per-place size override.
    const typeDefault = (Store.getEnumValue('pinTypes', pinType) || {}).size
      || (PIN_TYPES[pinType] && PIN_TYPES[pinType].size)
      || PIN_SIZE_DEFAULT;
    if (Number.isFinite(sizeNum) && sizeNum >= PIN_SIZE_MIN && sizeNum <= PIN_SIZE_MAX
        && sizeNum !== typeDefault) {
      loc.size = sizeNum;
    } else {
      delete loc.size;  // matches the type default → live fallback
    }
    // Drop any legacy mapStatus so old data doesn't shadow the new
    // attitudes[] field once this location is saved.
    delete loc.mapStatus;
    Store.saveLocation(loc);
    _refreshPin(loc.id);
    _openPinPanel(loc.id);
  }

  // Slider ↔ number-input mirrors for the pin form's size control.
  // Each writes to the other so the visible value stays in sync.
  function syncSizeFromRange() {
    const r = document.getElementById('spf-size-range');
    const n = document.getElementById('spf-size');
    if (r && n) n.value = r.value;
  }
  function syncSizeFromNumber() {
    const n = document.getElementById('spf-size');
    const r = document.getElementById('spf-size-range');
    if (!n || !r) return;
    let v = parseInt(n.value, 10);
    if (!Number.isFinite(v)) return;
    if (v < PIN_SIZE_MIN) v = PIN_SIZE_MIN;
    if (v > PIN_SIZE_MAX) v = PIN_SIZE_MAX;
    r.value = v;
  }

  function openPinPanel(pinId) { _openPinPanel(pinId); }

  // "Smazat" on a pin means "remove from map" — we strip the map-only
  // fields and keep the Location intact. To delete the place itself,
  // open it in the wiki (📖 Otevřít místo) and use Smazat there.
  function deletePin(pinId) {
    const loc = Store.getLocation(pinId);
    if (!loc) return;
    if (!confirm(I18n.t('map.removePinConfirm', { name: loc.name }))) return;
    const cleaned = { ...loc };
    delete cleaned.x; delete cleaned.y;
    delete cleaned.size;
    delete cleaned.pinType; delete cleaned.mapStatus; delete cleaned.mapNotes;
    // Attitudes describe the place itself, not its pin presence, so they
    // survive an "unplace" action — keep them in the Location record.
    Store.saveLocation(cleaned);
    if (_markers[pinId]) { _markers[pinId].remove(); delete _markers[pinId]; }
    closePanel();
  }

  function _drawEventPaths() {
    _clearEventPaths();
    if (!_map) return;

    const events = [...Store.getEvents()].sort((a, b) => {
      const sA = a.sitting ?? 0;
      const sB = b.sitting ?? 0;
      if (sA !== sB) return sA - sB;
      return (a.order ?? 0) - (b.order ?? 0);
    });

    const pins = _pinsForCurrent();

    // An event appears on the map in three ways, in priority order:
    //   1. An explicit event pin (e.mapX/mapY) on the current sub-map.
    //   2. Otherwise, all Locations listed in e.locations[] that are
    //      placed on the current sub-map (multi-location events show
    //      once per visited pin).
    //   3. Legacy fallback: the single primary location.
    const eventPoints = [];
    events.forEach(e => {
      const hasOwnPin = typeof e.mapX === 'number' && typeof e.mapY === 'number';
      const ownParent = hasOwnPin ? (e.mapParentId || null) : null;
      if (hasOwnPin && ownParent === _currentParentId) {
        eventPoints.push({ event: e, ll: _toLL(e.mapX, e.mapY), eventPin: true });
        return;
      }
      const locIds = (e.locations || []);
      const hits = locIds
        .map(lid => pins.find(p => p.locationId === lid))
        .filter(Boolean);
      if (hits.length) {
        hits.forEach(pin => eventPoints.push({ event: e, pin, ll: _toLL(pin.x, pin.y) }));
      }
    });

    if (!eventPoints.length) return;

    // Connect consecutive event points with a dashed line. A stable key
    // identifies the rendered spot (event-pin id, location-pin id, or raw
    // coords) so we skip zero-length hops between identical spots.
    const spotKey = p => p.eventPin ? `ev:${p.event.id}`
                      : p.pin     ? `loc:${p.pin.id}`
                      : `${p.ll.lat},${p.ll.lng}`;
    for (let i = 1; i < eventPoints.length; i++) {
      const prev = eventPoints[i - 1];
      const curr = eventPoints[i];
      if (spotKey(prev) === spotKey(curr)) continue;
      const line = L.polyline([prev.ll, curr.ll], {
        color:      '#C8A040',
        weight:     2.5,
        opacity:    0.75,
        dashArray:  '7, 5',
      }).addTo(_map);
      _eventPolylines.push(line);
    }

    eventPoints.forEach(({ event: e, ll }) => {
      const sittingLabel = e.sitting ? I18n.t('map.sittingShort', { n: e.sitting }) : '✦';
      const bgColor      = e.sitting ? '#8B6914' : '#5A3A5A';
      const icon = L.divIcon({
        className: '',
        iconSize:  [28, 28],
        iconAnchor:[14, 14],
        html: `<div class="sc-event-marker" title="${esc(e.name)}"
                    style="background:${bgColor}">
                 <span class="sc-event-marker-label">${esc(sittingLabel)}</span>
               </div>`,
      });
      const m = L.marker(ll, { icon, interactive: true }).addTo(_map);
      m.on('click', () => { window.location.hash = `#/udalost/${e.id}`; });
      _eventMarkers.push(m);
    });
  }

  function _clearEventPaths() {
    _eventMarkers.forEach(m => m.remove());
    _eventPolylines.forEach(l => l.remove());
    _eventMarkers   = [];
    _eventPolylines = [];
  }

  function toggleEventPaths() {
    _eventPathsVisible = !_eventPathsVisible;
    const btn = document.getElementById('sc-event-btn');
    if (btn) btn.classList.toggle('active', _eventPathsVisible);
    if (_eventPathsVisible) {
      _drawEventPaths();
      // Auto-zoom to the pins of every played session when activating,
      // so turning paths on also flies the camera to the current action.
      _zoomCurrentSitting();
    } else {
      _clearEventPaths();
    }
    _renderLegend();
  }

  function _setAddMode(on) {
    _addMode = on;
    const btn = document.getElementById('sc-add-btn');
    const hint = document.querySelector('.sc-hint');
    if (btn)  btn.textContent = on ? '✕ ' + I18n.t('map.cancel') : '+ ' + I18n.t('map.addPlace');
    if (btn)  btn.classList.toggle('active', on);
    if (hint) hint.textContent = on
      ? I18n.t('map.hintAddMode')
      : I18n.t('map.hintDefault');
    if (_map) _map.getContainer().style.cursor = on ? 'crosshair' : '';
  }

  function toggleAddMode() {
    // Leaving add-mode (user cancelled) must also clear any pending
    // "place existing location / event" intent so the next add-click
    // creates a new pin as usual.
    if (_addMode) { _placeForLocId = null; _placeForEventId = null; }
    _setAddMode(!_addMode);
  }

  // Module-local helper so the toolbar's pageEditToggle args (module
  // name + Czech noun) live in exactly ONE place — both the initial
  // render above and setEditing's in-place refresh below call this.
  function _renderEditToggleHtml() {
    return pageEditToggle({
      moduleName: 'WorldMap', isEditing: _editing, label: I18n.t('map.editToggleLabel'),
    });
  }

  /** Per-page edit toggle. Enables pin dragging, surfaces the
   *  `+ Přidat místo` / `✚ Uložit pohled` / `⚙ Mapa` toolbar buttons
   *  (via the `.sc-toolbar.is-editing` CSS gate), and switches pin
   *  clicks from "open detail panel" to "open editor form".
   *
   *  Anonymous viewers see the toggle and clicking it surfaces the
   *  login modal — routed via the `auth:prompt-login` window event
   *  because `editmode.js → map.js` is the established import direction
   *  (PIN_TYPES etc.) and importing EditMode back would be a cycle. */
  function setEditing(on) {
    if (on && Role.isAnonymous()) {
      window.dispatchEvent(new CustomEvent('auth:prompt-login'));
      return;
    }
    _editing = !!on;
    // Refresh the toolbar class gate and replace the toggle button via
    // the shared template — outerHTML keeps the in-DOM state aligned
    // with what initial render would emit (no stale data-args / text /
    // is-active mismatch — the old bug where the toggle stopped firing
    // after one click was a stale `data-args=[true]` on a setEditing
    // call that never updated. Routing through `pageEditToggle` /
    // `toggleEditing` removes the arg entirely.)
    const shell = document.querySelector('.sc-shell');
    if (shell) shell.classList.toggle('is-editing', _editing);
    const toolbar = document.querySelector('.sc-toolbar');
    if (toolbar) toolbar.classList.toggle('is-editing', _editing);
    const editBtn = document.querySelector('.sc-toolbar .page-edit-toggle');
    if (editBtn) editBtn.outerHTML = _renderEditToggleHtml();
    // Enable / disable Leaflet drag on every mounted marker. Direct
    // calls — no MutationObserver since there's no global edit-mode
    // class to watch any more.
    Object.values(_markers).forEach(m => {
      if (m && m.dragging) _editing ? m.dragging.enable() : m.dragging.disable();
    });
    // Leaving edit mode while in add-mode would leave a confusing
    // crosshair + pending intent; cancel both.
    if (!_editing && _addMode) {
      _placeForLocId = null;
      _placeForEventId = null;
      _setAddMode(false);
    }
    _renderLegend();
  }
  /** No-arg public toggle wired to the shared `pageEditToggle` button.
   *  Reading `_editing` here (instead of stamping it into the button's
   *  data-args at render time) is what fixes the "button only works
   *  once" bug. */
  function toggleEditing() { setEditing(!_editing); }

  // Arm the map so the next click writes mapX/mapY onto the given event.
  // Used by the event editor's "📍 Umístit pin události" button so a
  // session can be pinned to a spot on the map without creating a Location.
  function startPlacingEventPin(eventId) {
    const ev = Store.getEvent(eventId);
    if (!ev) return;
    _placeForLocId = null;
    _placeForEventId = eventId;
    const targetParent = ev.mapParentId || null;
    const alreadyOnMap = _isOnMapRoute() && !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { _armForCurrentTarget(); return; }
    const targetHash = _hashForParent(targetParent);
    const sameHash   = window.location.hash === targetHash;
    if (!sameHash) window.location.hash = targetHash;
    // Defer until the route change (and any parent-map render) finishes.
    // _doInit will call _armForCurrentTarget once the map is ready, so the
    // intent survives SSE-driven re-renders that may happen concurrently.
    setTimeout(() => {
      if (targetParent && targetParent !== _currentParentId) render(targetParent);
      else if (sameHash && !_map) render(targetParent);
      else if (!_map) _initLeaflet();
      else _armForCurrentTarget();
    }, 0);
  }

  // Navigate to the event pin's map context and fly to its position.
  // Mirrors showPin/zoomToPin for Locations.
  function showEventPin(eventId) {
    const ev = Store.getEvent(eventId);
    if (!ev || typeof ev.mapX !== 'number') return;
    const targetParent = ev.mapParentId || null;
    const fly = () => {
      if (!_map) return;
      _eventPathsVisible = true;
      _drawEventPaths();
      const btn = document.getElementById('sc-event-btn');
      if (btn) btn.classList.add('active');
      const ll = _toLL(ev.mapX, ev.mapY);
      const capZoom = Math.min(0, _map.getMaxZoom());
      _map.flyTo(ll, capZoom, { animate: true, duration: 0.6 });
    };
    const alreadyOnMap = _isOnMapRoute() && !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { fly(); return; }
    const targetHash = _hashForParent(targetParent);
    const sameHash   = window.location.hash === targetHash;
    if (!sameHash) window.location.hash = targetHash;
    setTimeout(() => {
      if (targetParent && targetParent !== _currentParentId) render(targetParent);
      else if (sameHash && !_map) render(targetParent);
      setTimeout(fly, 120);
    }, 0);
  }

  // Strip a previously-placed event pin. Keeps the Event itself intact.
  function clearEventPin(eventId) {
    const ev = Store.getEvent(eventId);
    if (!ev) return;
    const patch = { ...ev };
    delete patch.mapX; delete patch.mapY; delete patch.mapParentId;
    Store.saveEvent(patch);
    if (_eventPathsVisible) _drawEventPaths();
  }

  /**
   * Begin placing an existing (unplaced) location on the appropriate
   * map. Bound to the wiki "📍 Umístit na mapu" button. Navigates to
   * the right map context (world or the location's parent's local
   * map), enters add-mode, and arms the next map click to write x/y
   * onto the existing location record.
   *
   * @param {string} locId
   */
  function startPlacingPin(locId) {
    // "📍 Umístit na mapu" is visible to anonymous viewers on the
    // location article; clicking surfaces the login modal first.
    if (Role.isAnonymous()) {
      window.dispatchEvent(new CustomEvent('auth:prompt-login'));
      return;
    }
    const loc = Store.getLocation(locId);
    if (!loc) return;
    const targetParent = loc.parentId || null;
    _placeForEventId = null;
    _placeForLocId = locId;
    const alreadyOnMap = _isOnMapRoute() && !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { _armForCurrentTarget(); return; }
    const targetHash = _hashForParent(targetParent);
    const sameHash   = window.location.hash === targetHash;
    if (!sameHash) window.location.hash = targetHash;
    // Defer until the route change (and any parent-map render) finishes.
    // _doInit will call _armForCurrentTarget once the map is ready, so the
    // intent survives SSE-driven re-renders that may happen concurrently.
    setTimeout(() => {
      if (targetParent && targetParent !== _currentParentId) render(targetParent);
      else if (sameHash && !_map) render(targetParent);
      else if (!_map) _initLeaflet();
      else _armForCurrentTarget();
    }, 0);
  }

  function closePanel() {
    document.getElementById('sc-panel')?.setAttribute('hidden', '');
    _editPinId = null;
  }

  function showSettings() {
    document.getElementById('sc-overlay')?.removeAttribute('hidden');
  }

  function closeSettings() {
    document.getElementById('sc-overlay')?.setAttribute('hidden', '');
  }

  function handleMapFileUpload(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try { localStorage.setItem(LS_IMG_KEY, e.target.result); } catch (err) {
        alert(I18n.t('map.fileTooLarge'));
        return;
      }
      closeSettings();
      _initLeaflet();
    };
    reader.readAsDataURL(file);
  }

  function applySettings() {
    const url = document.getElementById('sc-img-url')?.value.trim();
    if (url) {
      try { localStorage.setItem(LS_IMG_KEY, url); } catch (e) { /* private browsing / quota */ }
      closeSettings();
      _initLeaflet();
    }
  }

  function _renderLegend() {
    const leg = document.getElementById('sc-legend');
    if (!leg) return;
    leg.innerHTML = `
      <div class="legend-title">${esc(I18n.t('map.legendAttitude'))}</div>
      ${(Store.getEnum('attitudes') || []).map(v =>
        `<div class="legend-item">
          <div class="legend-dot" style="background:${v.labelColor || v.bg};box-shadow:0 0 0 1px rgba(0,0,0,0.4)"></div>
          ${esc(v.label)}
        </div>`
      ).join('')}
      ${_eventPathsVisible ? `
        <div class="legend-title" style="margin-top:0.8rem">${esc(I18n.t('map.eventPaths'))}</div>
        <div class="legend-item">
          <div class="legend-line" style="border-top:2px dashed #C8A040"></div> ${esc(I18n.t('map.legendStoryPath'))}
        </div>
        <div class="legend-item">
          <div class="sc-event-marker-tiny" style="background:#8B6914">S#</div> ${esc(I18n.t('map.legendInSitting'))}
        </div>
        <div class="legend-item">
          <div class="sc-event-marker-tiny" style="background:#5A3A5A">✦</div> ${esc(I18n.t('map.legendPast'))}
        </div>` : ''}
    `;
  }

  // ── Toolbar search — pan/zoom to a pin by name ──────────────
  function _searchResultsEl() { return document.getElementById('sc-search-results'); }
  function _hideSearchResults() { const el = _searchResultsEl(); if (el) el.setAttribute('hidden', ''); }
  function _showSearchResults() { const el = _searchResultsEl(); if (el) el.removeAttribute('hidden'); }

  // Search every placed location across the world map and every local
  // sub-map. zoomToPin handles map-context switching so a hit on a
  // dungeon sub-pin opens the dungeon's local map and centers there.
  function _searchMatches(q) {
    const qn = String(q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (!qn) return [];
    const pins = Store.getLocations()
      .filter(l => typeof l.x === 'number' && typeof l.y === 'number')
      .map(_pinFromLocation);
    return pins
      .map(p => {
        const text = [p.name, p.notes, p.type]
          .filter(Boolean).join(' ')
          .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return { pin: p, text };
      })
      .filter(h => h.text.includes(qn))
      .slice(0, 8)
      .map(h => h.pin);
  }

  function onSearchInput(q) {
    const el = _searchResultsEl();
    if (!el) return;
    const hits = _searchMatches(q);
    if (!hits.length) { el.innerHTML = ''; _hideSearchResults(); return; }
    el.innerHTML = hits.map(p => {
      const pt = PIN_TYPES[p.type] || PIN_TYPES.custom;
      const url = _resolveIconUrl(p);
      const ico = url
        ? `<img class="sc-search-ico" src="${esc(url)}" alt="" draggable="false">`
        : `<span class="sc-search-ico">${pt.icon}</span>`;
      return `<div class="sc-search-item"${dataAction('WorldMap.zoomToPin', p.id)}>
        ${ico}
        <span class="sc-search-name">${esc(p.name)}</span>
        <span class="sc-search-sub">${esc(pt.label)}</span>
      </div>`;
    }).join('');
    _showSearchResults();
  }

  function jumpToFirstMatch() {
    const q = document.getElementById('sc-search')?.value;
    const hits = _searchMatches(q);
    if (hits.length) zoomToPin(hits[0].id);
  }
  // Bound to the search input's keydown via the data-on-keydown
  // dispatcher. Replaces the inline `if(event.key==='Enter')…`.
  function handleSearchKey(ev) {
    if (ev?.key === 'Enter') { ev.preventDefault(); jumpToFirstMatch(); }
  }

  /**
   * Fly the camera to the marker for `pinId`. If the pin lives on a
   * different map than the one currently shown, switches context first
   * and waits (polled, ≤ 30 × 80 ms) for the marker to mount before
   * flying. Opens the side panel for the pin on arrival.
   *
   * @param {string} pinId - Location id (pins ARE locations).
   */
  function zoomToPin(pinId) {
    const loc = Store.getLocation(pinId);
    if (!loc || typeof loc.x !== 'number') return;
    const targetParent = loc.parentId || null;
    if (targetParent !== _currentParentId) {
      render(targetParent);
      // _initLeaflet runs async (image preload). Wait for the marker.
      const tryFly = (tries) => {
        if (_markers[pinId]) return zoomToPin(pinId);
        if (tries > 30) return;
        setTimeout(() => tryFly(tries + 1), 80);
      };
      setTimeout(() => tryFly(0), 80);
      return;
    }
    if (!_map) return;
    const ll = _toLL(loc.x, loc.y);
    const capZoom = Math.min(0, _map.getMaxZoom());
    _map.flyTo(ll, capZoom, { animate: true, duration: 0.6 });
    _hideSearchResults();
    const searchEl = document.getElementById('sc-search');
    if (searchEl) searchEl.value = '';
    _openPinPanel(pinId);
  }

  // True when the world-map page is the active route. The module
  // keeps `_map` and `_currentParentId` populated even after the
  // user navigates away, so they're not safe stand-alone signals
  // for "is the map mounted in the DOM right now". Public-entry
  // helpers (showPin / startPlacingPin / showEventPin / etc.)
  // gate their fast-paths on this so they don't try to fly /
  // arm a stale, detached Leaflet instance.
  function _isOnMapRoute() {
    const h = window.location.hash || '';
    return h === '#/mapa/svet' || h.startsWith('#/mapa/local/');
  }

  // Hash for a given map context. World map is `#/mapa/svet`; a
  // sub-map is `#/mapa/local/<locId>`. Encoding the parent id in the
  // URL means edit-mode toggles (which dispatch synthetic hashchange)
  // re-render the same context instead of dumping the user back to
  // the world map.
  function _hashForParent(parentId) {
    return parentId
      ? '#/mapa/local/' + encodeURIComponent(parentId)
      : '#/mapa/svet';
  }

  /**
   * Wiki-page entry point: navigate into the correct map context (world
   * or parent local map), then fly to the pin once Leaflet has finished
   * its async init. Equivalent to `zoomToPin` if the map is already up
   * and showing the right context.
   *
   * @param {string} pinId - Location id.
   */
  function showPin(pinId) {
    const loc = Store.getLocation(pinId);
    if (!loc || typeof loc.x !== 'number') return;
    const targetParent = loc.parentId || null;
    const alreadyOnMap = _isOnMapRoute() && !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { zoomToPin(pinId); return; }
    _pendingPinId = pinId;
    // Encode the target context in the URL so app.js navigates straight
    // into the right map; render() fires from the hashchange. If we're
    // already at the target hash (no event will fire), render directly.
    const targetHash = _hashForParent(targetParent);
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    } else {
      setTimeout(() => render(targetParent), 0);
    }
  }

  /**
   * Switch the live map to a parent location's local sub-map (the
   * parent's `localMap` image as backdrop with sub-pins overlaid).
   * Alerts and no-ops if the parent has no `localMap` configured.
   *
   * @param {string} parentId - Location id of the parent.
   */
  function openLocalMap(parentId) {
    const parent = Store.getLocation(parentId);
    if (!parent || !parent.localMap) {
      alert(I18n.t('map.noLocalMap'));
      return;
    }
    closePanel();
    // Drive the context via hash so an edit-mode toggle (synthetic
    // hashchange) re-renders the same sub-map instead of resetting.
    const newHash = _hashForParent(parentId);
    if (window.location.hash !== newHash) {
      window.location.hash = newHash;
    } else {
      render(parentId);
    }
  }

  return {
    render,
    setEditing, toggleEditing,
    toggleAddMode, closePanel,
    toggleEventPaths,
    openPinPanel, savePin, deletePin,
    syncSizeFromRange, syncSizeFromNumber,
    toggleTypeMenu, closeTypeMenu, selectPinType,
    showSettings, closeSettings, applySettings, handleMapFileUpload,
    zoomFitAll,
    applyMapView, captureCurrentView, refreshPresetButtons: _refreshPresetButtons,
    onSearchInput, jumpToFirstMatch, handleSearchKey, zoomToPin, showPin,
    openLocalMap, startPlacingPin,
    startPlacingEventPin, clearEventPin, showEventPin,
    bundledDefaultUrl,
    getBundledDefaultIconIds,
    resolveIconForLocation,
    zoomSliderInput, zoomReset, zoomStep, applyZoomScaleRatio,
  };
})();
