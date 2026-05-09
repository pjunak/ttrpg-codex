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
    const enums = Store.getEnum('attitudes') || [];
    const colors = Object.fromEntries(enums.map(a => [a.id, a.labelColor || a.bg || '#888']));
    const layers = [];
    // Stack a tighter inner-glow per attitude so 100% strength reads
    // as a confident glow on small markers (mirrors wiki._attitudeGlow).
    const innerBlur = Math.max(2, Math.round(blurPx * 0.4));
    for (const e of entries) {
      if (!e) continue;
      const id = (typeof e === 'string') ? e : e.id;
      const s  = (typeof e === 'string') ? 1.0 : ((typeof e.strength === 'number') ? e.strength : 1.0);
      if (!id || !colors[id] || s <= 0) continue;
      const rgba = _hexToRgba(colors[id], s);
      layers.push(`drop-shadow(0 0 ${blurPx}px ${rgba})`);
      layers.push(`drop-shadow(0 0 ${innerBlur}px ${rgba})`);
    }
    return layers.join(' ');
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
    // location whose `localMap` image is the backdrop.
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
        <div id="sc-map-container"></div>
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

    _map.on('zoomend', () => { _renderLegend(); });

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
    // Glow halo — one colored drop-shadow per active attitude, blended
    // additively. Empty array = no filter (no glow).
    const glow = _attitudeGlowFilter(pin.attitudes || [], Math.max(5, Math.round(size * 0.22)));

    // Custom marker artwork — when the pin type has uploaded icons
    // configured, the resolver returns a URL; otherwise it falls through
    // to the bundled default under /icons-defaults/. If neither exists,
    // null falls through to the emoji glyph branch below.
    const iconUrl = _resolveIconUrl(pin);
    // For SVG icons we add a stacked black drop-shadow as a 1 px outline
    // so the (mostly-white) artwork stays legible on any tile colour —
    // analogous to the multi-direction text-shadow stroke used on the
    // emoji branch. Stacks on top of any attitude glow.
    const svgOutline = `drop-shadow(0 0 1px rgba(0,0,0,0.95)) drop-shadow(0 0 1px rgba(0,0,0,0.95))`;
    const filterParts = [];
    if (iconUrl) filterParts.push(svgOutline);
    if (glow)    filterParts.push(glow);
    const filterAttr = filterParts.length ? `filter:${filterParts.join(' ')};` : '';

    const inner = iconUrl
      ? `<img class="sc-pin-icon" src="${esc(iconUrl)}" alt="" draggable="false">`
      // Slightly larger emoji-to-box ratio (was 0.55) since there's no
      // background plate eating the vertical space anymore.
      : `<span class="sc-pin-emoji" style="font-size:${Math.round(size * 0.85)}px;text-shadow:${textShadow};">${pt.icon}</span>`;

    return L.divIcon({
      className: '',
      iconSize:  [size, size],
      iconAnchor:[size/2, size/2],
      html: `<div class="sc-pin sc-pin-${pin.status}" style="
        width:${size}px;height:${size}px;
        ${filterAttr}
      " title="${esc(pin.name)}">${inner}</div>`,
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
    // read as "Chrám · Spojenec 100%, Nepřítel 50%" rather than only
    // surfacing the primary stance. Strength % is omitted at 100%.
    const attEntries = (pin.attitudes && pin.attitudes.length)
      ? pin.attitudes
      : (pin.status ? [{ id: pin.status, strength: 1.0 }] : []);
    const attLabels = attEntries.map(e => {
      const id = (typeof e === 'string') ? e : e.id;
      const strength = (typeof e === 'string') ? 1.0
        : ((typeof e.strength === 'number') ? e.strength : 1.0);
      const s = statuses[id];
      if (!s) return '';
      const pct = strength === 1.0 ? '' : ` ${Math.round(strength * 100)}%`;
      return `<span style="color:${s.labelColor}">${esc(s.label)}${esc(pct)}</span>`;
    }).filter(Boolean).join(', ');
    const headerInner = `
      <span class="sc-pin-icon">${pt.icon}</span>
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
        <select class="sc-input" id="spf-type">${typeOpts}</select>
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
    const alreadyOnMap = !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { _armForCurrentTarget(); return; }
    if (window.location.hash !== '#/mapa/svet') window.location.hash = '#/mapa/svet';
    // Defer until the route change (and any parent-map render) finishes.
    // _doInit will call _armForCurrentTarget once the map is ready, so the
    // intent survives SSE-driven re-renders that may happen concurrently.
    setTimeout(() => {
      if (targetParent && targetParent !== _currentParentId) render(targetParent);
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
    const alreadyOnMap = !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { fly(); return; }
    if (window.location.hash !== '#/mapa/svet') window.location.hash = '#/mapa/svet';
    setTimeout(() => {
      if (targetParent) render(targetParent);
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
    const alreadyOnMap = !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { _armForCurrentTarget(); return; }
    if (window.location.hash !== '#/mapa/svet') window.location.hash = '#/mapa/svet';
    // Defer until the route change (and any parent-map render) finishes.
    // _doInit will call _armForCurrentTarget once the map is ready, so the
    // intent survives SSE-driven re-renders that may happen concurrently.
    setTimeout(() => {
      if (targetParent && targetParent !== _currentParentId) render(targetParent);
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
      return `<div class="sc-search-item"${dataAction('WorldMap.zoomToPin', p.id)}>
        <span class="sc-search-ico">${pt.icon}</span>
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

  // Public entry point used from wiki pages. Navigates into the correct
  // map context (world or parent local map), then flies to the pin once
  // Leaflet has finished its async init. If the map is already up, this
  // is equivalent to zoomToPin.
  function showPin(pinId) {
    const loc = Store.getLocation(pinId);
    if (!loc || typeof loc.x !== 'number') return;
    const targetParent = loc.parentId || null;
    const alreadyOnMap = !!_map && targetParent === _currentParentId;
    if (alreadyOnMap) { zoomToPin(pinId); return; }
    _pendingPinId = pinId;
    if (targetParent) {
      // Sub-map: render will be called when someone reaches the map page.
      // Route to world map first (canonical hash), then switch parents.
      window.location.hash = '#/mapa/svet';
      setTimeout(() => render(targetParent), 0);
    } else {
      window.location.hash = '#/mapa/svet';
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
    render(parentId);
  }

  return {
    render,
    toggleAddMode, closePanel,
    toggleEventPaths,
    openPinPanel, savePin, deletePin,
    syncSizeFromRange, syncSizeFromNumber,
    showSettings, closeSettings, applySettings, handleMapFileUpload,
    zoomFitAll,
    applyMapView, captureCurrentView, refreshPresetButtons: _refreshPresetButtons,
    onSearchInput, jumpToFirstMatch, handleSearchKey, zoomToPin, showPin,
    openLocalMap, startPlacingPin,
    startPlacingEventPin, clearEventPin, showEventPin,
    bundledDefaultUrl,
  };
})();
