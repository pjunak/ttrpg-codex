import { Store } from './store.js';
import { Widgets } from './widgets/widgets.js';
import { EditTemplates } from './edit_templates.js';
import { esc, dataAction, dataOn } from './utils.js';

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
    for (const a of Store.getEnum('attitudes') || []) {
      map[a.id] = {
        label:      a.label || a.id,
        bg:         a.bg         || '#37474F',
        fg:         a.fg         || '#E8E0C4',
        labelColor: a.labelColor || '#90A4AE',
      };
    }
    // `unknown` is the safe default when a location carries no attitudes.
    if (!map.unknown) {
      map.unknown = { label: 'Neznámé', bg: '#37474F', fg: '#E8E0C4', labelColor: '#90A4AE' };
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
  //     strategy: 'single' | 'random' | 'state',
  //     files:    [{ id, url, stateId: string | null }, ...],
  //   }
  // Resolution rules:
  //   • No iconConfig or empty files     → bundled default for this
  //                                        pin type (game-icons.net,
  //                                        CC BY 3.0, see ATTRIBUTIONS.md);
  //                                        null when none → emoji fallback.
  //   • strategy 'single'                → default-slot file (stateId null).
  //   • strategy 'random'                → deterministic hash on pin.id
  //                                        across ALL files.
  //   • strategy 'state' + known target  → exact stateId match wins,
  //                                        else closest-severity match
  //                                        among tagged files,
  //                                        else default file.
  //   • strategy 'state' + unknown state → default file.
  //   • strategy 'state' + severity:null → default file (off-axis).

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
  // Public for the Settings marker-icon panel — needs to know whether
  // a given pin type has a bundled default to surface to the GM.
  function bundledDefaultUrl(pinType) {
    return BUNDLED_DEFAULT_ICONS.has(pinType) ? `/icons-defaults/${pinType}.svg` : null;
  }
  const _bundledDefaultUrl = bundledDefaultUrl;

  // Public — resolves the appropriate icon URL for a wiki Location
  // record (built via synthetic pin shape). Lets wiki.js render the
  // same artwork on /mista cards and the location article side card
  // that the map shows for that pin. Returns null when neither a
  // user upload nor a bundled default is available; callers fall
  // back to the emoji glyph in that case.
  function resolveIconForLocation(l) {
    if (!l) return null;
    return _resolveIconUrl({
      id:         l.id,
      locationId: l.id,
      type:       l.pinType || 'custom',
      // Resolver consults `pin.statusId || pin.locationStatus || lookup`
      // — passing the location's status here covers the state-based
      // strategy without having to round-trip through the map module.
      locationStatus: l.status || '',
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
    const types  = (Store.getEnum && Store.getEnum('pinTypes')) || [];
    const cfg    = types.find(t => t.id === pin.type)?.iconConfig;
    const bundled = _bundledDefaultUrl(pin.type);
    if (!cfg || !Array.isArray(cfg.files) || !cfg.files.length) return bundled;

    const files = cfg.files;
    const defaultFile = files.find(f => f.stateId == null) || files[0];

    if (cfg.strategy === 'single' || !cfg.strategy) {
      return defaultFile.url;
    }

    if (cfg.strategy === 'random') {
      const idx = _hashStr(pin.id || pin.locationId || '') % files.length;
      return files[idx].url;
    }

    // strategy === 'state'
    const status = pin.statusId || pin.locationStatus
      || (pin.locationId ? Store.getLocation(pin.locationId)?.status : '');
    if (!status) return defaultFile.url;

    const statuses = Store.getEnum('locationStatuses') || [];
    const target   = statuses.find(s => s.id === status);
    if (!target || target.severity == null) return defaultFile.url;

    const exact = files.find(f => f.stateId === status);
    if (exact) return exact.url;

    const tagged = files
      .filter(f => f.stateId != null)
      .map(f => {
        const s = statuses.find(st => st.id === f.stateId);
        return (s && s.severity != null) ? { url: f.url, severity: s.severity } : null;
      })
      .filter(Boolean);

    if (!tagged.length) return defaultFile.url;

    tagged.sort((a, b) => {
      const da = Math.abs(a.severity - target.severity);
      const db = Math.abs(b.severity - target.severity);
      if (da !== db) return da - db;
      return a.severity - b.severity;
    });
    return tagged[0].url;
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
  function _updateZoomReadout() {
    const slider = document.getElementById('sc-zoom-slider');
    // Readout is now the `1×`-reset button itself — clicking it resets,
    // and the label always reflects the live zoom value.
    const out    = document.getElementById('sc-zoom-readout');
    if (!_map) return;
    const z = _map.getZoom();
    const display = Math.pow(2, z);
    if (slider) slider.value = String(z);
    if (out)    out.textContent = `${display.toFixed(2)}×`;
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
    _map.setZoom(z);
    // setZoom fires zoomend asynchronously which updates the readout,
    // but the user expects the live value to track the slider drag —
    // update the readout eagerly so it doesn't lag.
    const out = document.getElementById('sc-zoom-readout');
    if (out) out.textContent = `${Math.pow(2, z).toFixed(2)}×`;
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
  // Public — Settings calls this after the GM tweaks the
  // zoom-scale slider so the live map rescales markers without
  // waiting for the next zoom event. No-op when the live map is
  // showing a different map than the one being edited in Settings.
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
      status:     firstId,
      // The Location's physical state (locationStatuses id), used by
      // the icon resolver for state-based variant selection. Distinct
      // from `status` above (which carries the primary attitude id —
      // legacy field name kept for the side-panel renderer).
      locationStatus: l.status || '',
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
    const enums  = Store.getEnum('attitudes') || [];
    const byId   = Object.fromEntries(enums.map(a => [a.id, a]));
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

  function render(parentId) {
    // Switching map context. parentId=null → world map; otherwise a
    // location whose `localMap` image is the backdrop. Defensive
    // fallback: if the URL points at a deleted/unmappable location,
    // drop back to the world map silently rather than rendering a
    // broken backdrop.
    if (parentId) {
      const p = Store.getLocation(parentId);
      if (!p || !p.localMap) parentId = null;
    }
    _currentParentId = parentId || null;
    const parent = _currentParentId ? Store.getLocation(_currentParentId) : null;
    const titleHtml = parent
      ? `🗺 ${esc(parent.name)} <span class="sc-breadcrumb">
           · <a href="#/mapa/svet">↩ Mapa</a>
         </span>`
      : `🗺 Mapa světa`;

    // "+ Přidat místo" and "⚙ Mapa" are editor-only actions — hidden unless
    // the body has .edit-mode set by EditMode.toggle().
    document.getElementById('main-content').innerHTML = `
      <div class="sc-shell">
        <div class="sc-toolbar">
          <div class="sc-title">${titleHtml}</div>
          <input type="search" class="sc-search" id="sc-search"
                 placeholder="🔍 Najít místo…" autocomplete="off"
                 ${dataOn('input', 'WorldMap.onSearchInput', '$value')}
                 ${dataOn('keydown', 'WorldMap.handleSearchKey', '$ev')}>
          <div class="sc-search-results" id="sc-search-results" hidden></div>
          <button class="sc-btn edit-only-inline ${_addMode ? 'active' : ''}" id="sc-add-btn"${dataAction('WorldMap.toggleAddMode')}>
            ${_addMode ? '✕ Zrušit' : '+ Přidat místo'}
          </button>
          <button class="sc-btn ${_eventPathsVisible ? 'active' : ''}" id="sc-event-btn"${dataAction('WorldMap.toggleEventPaths')} title="Zobraz trasy událostí a přiblíž k aktuálnímu dění">
            📜 Trasy událostí
          </button>
          <span class="sc-zoom-presets" id="sc-zoom-presets">
            <button class="sc-btn"${dataAction('WorldMap.zoomFitAll')} title="Oddálit na celou mapu">🌐 Celá</button>
            ${_presetButtonsHtml()}
            <button class="sc-btn edit-only-inline"${dataAction('WorldMap.captureCurrentView')} title="Uložit aktuální pohled jako předvolbu">✚ Uložit pohled</button>
          </span>
          <button class="sc-btn edit-only-inline"${dataAction('WorldMap.showSettings')}>⚙ Mapa</button>
          <span class="sc-hint">${_addMode
            ? 'Klikni na mapu pro přidání nového místa'
            : 'Klik = detail místa · Kolečko = zoom · Táhni = pohyb'
          }</span>
        </div>
        <div id="sc-map-container">
          <!-- Floating zoom panel (top-left). Replaces Leaflet's default
               +/- control plus the toolbar slider that was there before.
               Vertical slider so the +/− anchors line up naturally with
               zoom-in (top) and zoom-out (bottom). -->
          <div class="sc-zoom-panel" id="sc-zoom-panel" title="Zoom — 1.0× = skutečné rozlišení">
            <button class="sc-zoom-btn" type="button"${dataAction('WorldMap.zoomStep', 1)} title="Přiblížit" aria-label="Přiblížit">+</button>
            <input type="range" id="sc-zoom-slider"
              class="sc-zoom-slider-vertical"
              orient="vertical"
              min="-8" max="2" step="0.25" value="0"
              aria-label="Plynulý zoom"
              ${dataOn('input', 'WorldMap.zoomSliderInput', '$value')}>
            <button class="sc-zoom-btn" type="button"${dataAction('WorldMap.zoomStep', -1)} title="Oddálit" aria-label="Oddálit">−</button>
            <!-- Live readout doubles as the 1× reset button: shows current
                 zoom (e.g. "1.50×"), click to snap back to 1.00×. Combines
                 two prior elements into one to keep the panel compact. -->
            <button class="sc-zoom-btn sc-zoom-readout-btn" type="button"
              id="sc-zoom-readout"
              ${dataAction('WorldMap.zoomReset')}
              title="Klikni pro reset na 1.0× (skutečné rozlišení)"
              aria-label="Aktuální zoom — klikni pro reset">1.00×</button>
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
          <div class="sc-dialog-title">⚙ Nastavení mapy</div>
          <p class="sc-dialog-hint">
            <strong>Možnost 1 – nahrát obrázek:</strong> Vyber soubor ze svého počítače (doporučeno).<br>
            <strong>Možnost 2 – URL:</strong> Vlož přímý odkaz na obrázek mapy.<br>
            <strong>Možnost 3 – server:</strong> Ulož obrázek jako <code>data/maps/swordcoast/sword_coast.jpg</code> na serveru.
          </p>
          <label class="sc-label">Nahrát ze souboru</label>
          <label class="sc-btn" style="cursor:pointer;display:inline-block;margin-bottom:0.8rem">
            📂 Vybrat soubor…
            <input type="file" accept="image/*" style="display:none"${dataOn('change', 'WorldMap.handleMapFileUpload', '$el')}>
          </label>
          <label class="sc-label">— nebo zadat URL obrázku —</label>
          <input class="sc-input" id="sc-img-url" type="text" value="${esc(_getImgUrl().startsWith('data:') ? '' : _getImgUrl())}">
          <div class="sc-dialog-actions">
            <button class="sc-btn ok"${dataAction('WorldMap.applySettings')}>✓ Použít URL</button>
            <button class="sc-btn"${dataAction('WorldMap.closeSettings')}>Zrušit</button>
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

    _syncZoomSliderBounds();
    _applyMarkerScale();
    _updateZoomReadout();

    _map.on('zoomend', () => {
      _renderLegend();
      _applyMarkerScale();
      _updateZoomReadout();
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

    _modeObserver = new MutationObserver(() => {
      const editable = document.body.classList.contains('edit-mode');
      Object.values(_markers).forEach(m => {
        if (m.dragging) editable ? m.dragging.enable() : m.dragging.disable();
      });
      _renderLegend();
    });
    _modeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

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
      if (hint) hint.textContent = `Klikni na mapu pro umístění: ${loc.name}`;
      return;
    }
    if (_placeForEventId) {
      const ev = Store.getEvent(_placeForEventId);
      if (!ev) { _placeForEventId = null; return; }
      _setAddMode(true);
      const hint = document.querySelector('.sc-hint');
      if (hint) hint.textContent = `Klikni na mapu pro umístění události: ${ev.name}`;
    }
  }

  function _showMapError(container) {
    container.innerHTML = `
      <div class="sc-img-error">
        <div style="font-size:2rem;margin-bottom:1rem">🗺</div>
        <div style="font-size:1.1rem;margin-bottom:0.5rem"><strong>Mapa se nenačetla</strong></div>
        <div style="font-size:0.88rem;line-height:1.6;max-width:420px">
          Nahraj obrázek mapy přes <strong>⚙ Mapa → Vybrat soubor</strong>, nebo ho ulož na server jako
          <code>data/maps/swordcoast/sword_coast.jpg</code>.
        </div>
        <button class="sc-btn" style="margin-top:1.2rem"${dataAction('WorldMap.showSettings')}>⚙ Otevřít nastavení</button>
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
    if (!document.body.classList.contains('edit-mode')) m.dragging.disable();

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
      <button class="sc-btn"${dataAction('WorldMap.zoomFitAll')} title="Oddálit na celou mapu">🌐 Celá</button>
      ${_presetButtonsHtml()}
      <button class="sc-btn edit-only-inline"${dataAction('WorldMap.captureCurrentView')} title="Uložit aktuální pohled jako předvolbu">✚ Uložit pohled</button>
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
    const label = prompt('Název pohledu:');
    if (!label || !label.trim()) return;
    const icon = (prompt('Ikona (volitelně, např. 🏙 nebo 🏰):') || '📍').trim() || '📍';
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
    if (document.body.classList.contains('edit-mode')) {
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
      ? `<button class="sc-btn ok"${dataAction('WorldMap.openLocalMap', loc.id)}>🗺 Místní mapa</button>`
      : '';
    const subInfo = subCount
      ? `<div class="sc-pin-meta" style="margin-top:0.4rem">⛬ ${subCount} dílčí ${subCount === 1 ? 'místo' : 'míst(a)'}</div>`
      : '';

    // Show every attitude label (comma-joined) so mixed-stance places
    // read as "Chrám · Spojenec, Nepřítel 70%" rather than only
    // surfacing the primary stance. Strength is now sourced from the
    // `attitudes` settings enum (per-attitude); % is omitted at 100%.
    const attEntries = (pin.attitudes && pin.attitudes.length)
      ? pin.attitudes
      : (pin.status ? [{ id: pin.status }] : []);
    const attEnum = Store.getEnum('attitudes') || [];
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

    document.getElementById('sc-panel-content').innerHTML = `
      <div class="sc-pin-view">
        ${header}
        ${pin.notes ? `<div class="sc-pin-notes">${esc(pin.notes)}</div>` : ''}
        ${localMapBtn ? `<div class="sc-pin-actions">${localMapBtn}</div>` : ''}
      </div>
    `;
    document.getElementById('sc-panel').removeAttribute('hidden');
  }

  function _openNewPin(x, y) {
    _renderPinForm({ x, y, attitudes: [], type: 'custom' }, true);
    document.getElementById('sc-panel').removeAttribute('hidden');
  }

  function _renderPinForm(pin, isNew) {
    _editPinId = pin.id || null;
    const typeOpts = Object.entries(PIN_TYPES)
      .map(([k, v]) => `<option value="${k}" ${pin.type===k?'selected':''}>${v.icon} ${v.label}</option>`).join('');
    // Live SVG preview of the resolved marker artwork — what the pin
    // will actually look like on the map. The native <select> below
    // can only render emoji glyphs in <option>s, so this companion
    // image gives the GM the real preview. Display size scales with
    // the resolved marker size (clamped to [22, 40]) so a tavern and
    // a major city read as visibly different even in the form.
    const previewUrl = _resolveIconUrl(pin);
    const previewSize = _previewSizeForPin(pin);
    const previewStyle = ` style="--spf-preview-size:${previewSize}px"`;
    const previewHtml = previewUrl
      ? `<img id="spf-type-preview" class="spf-type-preview" src="${esc(previewUrl)}" alt="" draggable="false"${previewStyle}>`
      : `<span id="spf-type-preview" class="spf-type-preview spf-type-preview-emoji"${previewStyle}>${(PIN_TYPES[pin.type]||PIN_TYPES.custom).icon}</span>`;
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
      <label class="sc-label">Použít existující místo (volitelné)</label>
      <div class="cb-mount"
        data-cb-id="spf-existing"
        data-cb-source="location"
        data-cb-value=""
        data-cb-allow-empty="1"
        data-cb-empty-label="— vytvořit nové —"
        data-cb-placeholder="Hledat existující…"></div>` : '';

    document.getElementById('sc-panel-content').innerHTML = `
      <div class="sc-pin-form">
        <div class="sc-pin-form-title">${isNew ? 'Nové místo' : 'Upravit místo'}</div>
        ${linkPicker}
        <label class="sc-label">Název *</label>
        <input class="sc-input" id="spf-name" type="text" value="${esc(pin.name||'')}" placeholder="Waterdeep...">
        <label class="sc-label">Typ</label>
        <div class="spf-type-row">
          ${previewHtml}
          <select class="sc-input" id="spf-type"
            ${dataOn('change', 'WorldMap.refreshTypePreview')}>${typeOpts}</select>
        </div>
        <label class="sc-label">Postoje k partě <span class="sc-hint">(víc postojů s nastavitelnou silou)</span></label>
        ${attChipRowHtml}
        <label class="sc-label">Velikost značky <span class="sc-hint">${inheritsSize ? '(výchozí podle typu)' : '(vlastní)'}</span></label>
        <div class="sc-pin-size-row">
          <input type="range" id="spf-size-range" min="${PIN_SIZE_MIN}" max="${PIN_SIZE_MAX}" step="2" value="${currentSize}"
            ${dataOn('input', 'WorldMap.syncSizeFromRange')}>
          <input type="number" id="spf-size" min="${PIN_SIZE_MIN}" max="${PIN_SIZE_MAX}" step="2" value="${currentSize}"
            ${dataOn('input', 'WorldMap.syncSizeFromNumber')}>
          <span class="sc-hint">px</span>
        </div>
        <label class="sc-label">Popis / Poznámky na mapě</label>
        <textarea class="sc-input" id="spf-notes" rows="3" placeholder="Krátký popis...">${esc(pin.notes||'')}</textarea>
        <div class="sc-pin-actions">
          <button class="sc-btn ok"${dataAction('WorldMap.savePin', isNew, pin.x||0, pin.y||0)}>💾 Uložit</button>
          ${!isNew ? `<a class="sc-btn" href="#/misto/${pin.locationId}">📖 Otevřít místo</a>` : ''}
          ${!isNew ? `<button class="sc-btn err"${dataAction('WorldMap.deletePin', pin.id)}>🗑 Odebrat z mapy</button>` : ''}
        </div>
      </div>
    `;
    document.getElementById('sc-panel').removeAttribute('hidden');
    Widgets.mountAll(document.getElementById('sc-panel-content'));
  }

  // Save form values onto a Location: either the linked existing one,
  // the location currently being edited, or a freshly-created place.
  function savePin(isNew, x, y) {
    const name = document.getElementById('spf-name')?.value.trim();
    if (!name) { alert('Název je povinný.'); return; }
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
        loc = { id: newId, name, type: '', status: '', description: '', notes: '' };
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

  // Display size for the pin form's preview block. Tracks the
  // resolved marker size but clamps to a sane visual range so very
  // small (14px) or very large (64px) markers still read clearly in
  // the side panel context. The preview is informative, not pixel-
  // accurate.
  const PREVIEW_SIZE_MIN = 22;
  const PREVIEW_SIZE_MAX = 40;
  function _previewSizeForPin(pin) {
    const s = _resolvePinSize(pin || {});
    if (!Number.isFinite(s)) return 32;
    return Math.max(PREVIEW_SIZE_MIN, Math.min(PREVIEW_SIZE_MAX, s));
  }

  // Re-render the SVG/emoji preview block in the pin form when the
  // user changes the Type dropdown. The form is otherwise static, so
  // we patch the preview node in place rather than rebuilding the
  // whole form.
  function refreshTypePreview() {
    const sel = document.getElementById('spf-type');
    const cur = document.getElementById('spf-type-preview');
    if (!sel || !cur) return;
    const type = sel.value || 'custom';
    // Synthetic pin shape: id taken from the live editor target so
    // `random` strategy stays deterministic across retypes; status
    // pulled from the location for `state` strategy.
    const loc = _editPinId ? Store.getLocation(_editPinId) : null;
    // Prefer the form's live size input over the saved value so the
    // preview tracks the size slider in real time.
    const sizeInput = document.getElementById('spf-size');
    const liveSize  = sizeInput ? parseInt(sizeInput.value, 10) : NaN;
    const fallback  = (loc && typeof loc.size === 'number') ? loc.size : undefined;
    const synth = {
      id:         _editPinId || '',
      locationId: _editPinId || '',
      type,
      locationStatus: loc?.status || '',
      size:       Number.isFinite(liveSize) && liveSize > 0 ? liveSize : fallback,
    };
    const url = _resolveIconUrl(synth);
    const previewSize = _previewSizeForPin(synth);
    let next;
    if (url) {
      next = document.createElement('img');
      next.id = 'spf-type-preview';
      next.className = 'spf-type-preview';
      next.src = url;
      next.alt = '';
      next.draggable = false;
    } else {
      next = document.createElement('span');
      next.id = 'spf-type-preview';
      next.className = 'spf-type-preview spf-type-preview-emoji';
      next.textContent = (PIN_TYPES[type] || PIN_TYPES.custom).icon;
    }
    next.style.setProperty('--spf-preview-size', previewSize + 'px');
    cur.replaceWith(next);
  }

  // Slider ↔ number-input mirrors for the pin form's size control.
  // Each writes to the other so the visible value stays in sync, and
  // both nudge the live preview block so the GM sees the size change
  // before saving.
  function syncSizeFromRange() {
    const r = document.getElementById('spf-size-range');
    const n = document.getElementById('spf-size');
    if (r && n) n.value = r.value;
    refreshTypePreview();
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
    refreshTypePreview();
  }

  function openPinPanel(pinId) { _openPinPanel(pinId); }

  // "Smazat" on a pin means "remove from map" — we strip the map-only
  // fields and keep the Location intact. To delete the place itself,
  // open it in the wiki (📖 Otevřít místo) and use Smazat there.
  function deletePin(pinId) {
    const loc = Store.getLocation(pinId);
    if (!loc) return;
    if (!confirm(`Odebrat „${loc.name}" z mapy?\n(Stránka místa zůstane zachována.)`)) return;
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
      const sittingLabel = e.sitting ? `S${e.sitting}` : '✦';
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
    if (btn)  btn.textContent = on ? '✕ Zrušit' : '+ Přidat místo';
    if (btn)  btn.classList.toggle('active', on);
    if (hint) hint.textContent = on
      ? 'Klikni na mapu pro přidání nového místa'
      : 'Klik = detail místa · Kolečko = zoom · Táhni = pohyb';
    if (_map) _map.getContainer().style.cursor = on ? 'crosshair' : '';
  }

  function toggleAddMode() {
    // Leaving add-mode (user cancelled) must also clear any pending
    // "place existing location / event" intent so the next add-click
    // creates a new pin as usual.
    if (_addMode) { _placeForLocId = null; _placeForEventId = null; }
    _setAddMode(!_addMode);
  }

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

  // Public entry-point for the wiki "📍 Umístit na mapu" button. Navigates
  // to the correct map (world or parent's local map), enters add-mode, and
  // arms the next click to assign x/y to this existing location.
  function startPlacingPin(locId) {
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
        alert('Soubor je příliš velký pro uložení v prohlížeči. Zkus menší obrázek nebo ho ulož na server jako data/maps/swordcoast/sword_coast.jpg.');
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
      <div class="legend-title">Postoj k partě</div>
      ${(Store.getEnum('attitudes') || []).map(v =>
        `<div class="legend-item">
          <div class="legend-dot" style="background:${v.labelColor || v.bg};box-shadow:0 0 0 1px rgba(0,0,0,0.4)"></div>
          ${v.label}
        </div>`
      ).join('')}
      ${_eventPathsVisible ? `
        <div class="legend-title" style="margin-top:0.8rem">Trasy událostí</div>
        <div class="legend-item">
          <div class="legend-line" style="border-top:2px dashed #C8A040"></div> Cesta příběhu
        </div>
        <div class="legend-item">
          <div class="sc-event-marker-tiny" style="background:#8B6914">S#</div> V sezení
        </div>
        <div class="legend-item">
          <div class="sc-event-marker-tiny" style="background:#5A3A5A">✦</div> Minulost
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

  // Zoom to a pin. If the pin lives on a different map (e.g. a sub-pin
  // in a dungeon while we're viewing the world map), switch context
  // first, then center on the pin once the map has re-initialised.
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

  // Public entry point used from wiki pages. Navigates into the correct
  // map context (world or parent local map), then flies to the pin once
  // Leaflet has finished its async init. If the map is already up, this
  // is equivalent to zoomToPin.
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

  // Switch the map view to a parent location's local map (parent.localMap
  // image, sub-pins overlaid). No-ops if the parent has no localMap set.
  function openLocalMap(parentId) {
    const parent = Store.getLocation(parentId);
    if (!parent || !parent.localMap) {
      alert('Toto místo nemá vlastní mapu. Otevři jeho stránku a nahraj obrázek mapy.');
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
    toggleAddMode, closePanel,
    toggleEventPaths,
    openPinPanel, savePin, deletePin,
    syncSizeFromRange, syncSizeFromNumber, refreshTypePreview,
    showSettings, closeSettings, applySettings, handleMapFileUpload,
    zoomFitAll,
    applyMapView, captureCurrentView, refreshPresetButtons: _refreshPresetButtons,
    onSearchInput, jumpToFirstMatch, handleSearchKey, zoomToPin, showPin,
    openLocalMap, startPlacingPin,
    startPlacingEventPin, clearEventPin, showEventPin,
    bundledDefaultUrl,
    resolveIconForLocation,
    zoomSliderInput, zoomReset, zoomStep, applyZoomScaleRatio,
  };
})();
