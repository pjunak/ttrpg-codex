import {
  FACTIONS, CHARACTERS, LOCATIONS, EVENTS, RELATIONSHIPS, MYSTERIES,
  PANTHEON, ARTIFACTS, HISTORICAL_EVENTS, PETS,
  SETTINGS_DEFAULTS, SETTINGS_USAGE_MAP,
} from './data.js';
import { norm, clearMarkdownCache } from './utils.js';
import { PARTY_FACTION_ID, SIDEBAR_PAGES, SIDEBAR_LAYOUT_DEFAULT } from './constants.js';
import { I18n } from './i18n.js';
import { Role } from './role.js';

export const Store = (() => {
  let _data            = null;
  let _serverAvailable = false;
  let _loadedOnce      = false;   // a successful load() completed this session

  // ── Secondary indices (rebuilt by _reindex on every mutation) ──
  let _idxCharsByFaction   = new Map();
  let _idxCharsByLocation  = new Map();
  let _idxRelsByChar       = new Map();
  let _idxEventsByChar     = new Map();
  let _idxEventsByLocation = new Map();
  let _idxMysteriesByChar  = new Map();
  let _idxChildLocations   = new Map();  // parentId -> [childLoc, ...]

  function _push(map, key, val) {
    if (!key) return;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(val);
  }

  // Per-collection reindex helpers. Save/delete callers invoke only the
  // ones that could have changed — saving a character can't affect the
  // events index, etc. `_reindex()` runs all of them and is used by
  // `load()` after a fresh fetch. The split lets a save touch ~1/5 the
  // entries it used to. Each helper also busts the markdown cache so
  // wiki-link resolution stays consistent after renames/creates.
  function _reindexCharacters() {
    _idxCharsByFaction  = new Map();
    _idxCharsByLocation = new Map();
    _bustMarkdownCache();
    if (!_data) return;
    for (const c of _data.characters || []) {
      _push(_idxCharsByFaction, c.faction, c);
      if (c.location) _push(_idxCharsByLocation, c.location, c);
      for (const r of c.locationRoles || []) {
        if (r?.locationId) _push(_idxCharsByLocation, r.locationId, c);
      }
    }
  }
  function _reindexRelationships() {
    _idxRelsByChar = new Map();
    _bustMarkdownCache();
    if (!_data) return;
    for (const r of _data.relationships || []) {
      _push(_idxRelsByChar, r.source, r);
      if (r.target !== r.source) _push(_idxRelsByChar, r.target, r);
    }
  }
  function _reindexEvents() {
    _idxEventsByChar     = new Map();
    _idxEventsByLocation = new Map();
    _bustMarkdownCache();
    if (!_data) return;
    for (const e of _data.events || []) {
      for (const cid of e.characters || []) _push(_idxEventsByChar, cid, e);
      for (const lid of e.locations  || []) _push(_idxEventsByLocation, lid, e);
    }
  }
  function _reindexMysteries() {
    _idxMysteriesByChar = new Map();
    _bustMarkdownCache();
    if (!_data) return;
    for (const m of _data.mysteries || []) {
      for (const cid of m.characters || []) _push(_idxMysteriesByChar, cid, m);
    }
  }
  function _reindexLocations() {
    _idxChildLocations = new Map();
    _bustMarkdownCache();
    if (!_data) return;
    for (const l of _data.locations || []) {
      if (l.parentId) _push(_idxChildLocations, l.parentId, l);
    }
  }

  function _reindex() {
    _reindexCharacters();
    _reindexRelationships();
    _reindexEvents();
    _reindexMysteries();
    _reindexLocations();
  }

  // Wiki-link resolution (`[[Name]]` → `#/postava/<id>`) walks every
  // collection. The markdown cache keyed by raw source can hold stale
  // resolutions after a rename or creation. Invalidate it on every
  // mutation. Cheap — markdown re-rendering is incremental and cached
  // again the next time each article is opened.
  function _bustMarkdownCache() {
    try { clearMarkdownCache(); } catch (_) {}
  }

  function _defaults() {
    return {
      characters:       JSON.parse(JSON.stringify(CHARACTERS)),
      relationships:    JSON.parse(JSON.stringify(RELATIONSHIPS)),
      locations:        JSON.parse(JSON.stringify(LOCATIONS)),
      events:           JSON.parse(JSON.stringify(EVENTS)),
      mysteries:        JSON.parse(JSON.stringify(MYSTERIES)),
      factions:         JSON.parse(JSON.stringify(FACTIONS)),
      pantheon:         JSON.parse(JSON.stringify(PANTHEON)),
      artifacts:        JSON.parse(JSON.stringify(ARTIFACTS)),
      historicalEvents: JSON.parse(JSON.stringify(HISTORICAL_EVENTS)),
      pets:             JSON.parse(JSON.stringify(PETS)),
      settings:         JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)),
      // Campaign metadata stored as a keyed-object collection with a
      // single 'main' record so it round-trips through the existing
      // PATCH handler (same shape as factions/settings). The default
      // name is a neutral placeholder — users override it inline from
      // the dashboard hero on first edit.
      campaign:         { main: { name: 'Untitled Campaign', tagline: '' } },
      // Tombstones for default entries the user has explicitly deleted,
      // so _mergeDefaults doesn't re-seed them on next load. Keyed by
      // entity id (or `settings:<cat>:<id>` for settings tombstones).
      // Kept as an object — round-trips through the keyed-object PATCH
      // path the same way factions/settings do.
      deletedDefaults:  {},
    };
  }

  function _mergeDefaults() {
    // Coerce legacy array-shaped tombstones to the keyed object shape.
    if (Array.isArray(_data.deletedDefaults)) {
      _data.deletedDefaults = Object.fromEntries(_data.deletedDefaults.map(k => [k, true]));
    }
    if (!_data.deletedDefaults || typeof _data.deletedDefaults !== 'object') {
      _data.deletedDefaults = {};
    }
    const deleted  = new Set(Object.keys(_data.deletedDefaults));
    const savedIds = new Set(_data.characters.map(c => c.id));
    for (const c of CHARACTERS) {
      if (!savedIds.has(c.id) && !deleted.has(c.id)) {
        _data.characters.push(JSON.parse(JSON.stringify(c)));
      }
    }
    if (!_data.factions) {
      _data.factions = JSON.parse(JSON.stringify(FACTIONS));
    } else {
      for (const [id, fac] of Object.entries(FACTIONS)) {
        if (!_data.factions[id]) _data.factions[id] = JSON.parse(JSON.stringify(fac));
      }
    }
    // Seed pantheon/artifacts/historicalEvents for fresh installs.
    if (!Array.isArray(_data.pantheon))         _data.pantheon         = [];
    if (!Array.isArray(_data.artifacts))        _data.artifacts        = [];
    if (!Array.isArray(_data.historicalEvents)) _data.historicalEvents = [];
    if (!Array.isArray(_data.pets))             _data.pets             = [];
    // Seed/merge settings enums. For each category in SETTINGS_DEFAULTS,
    // start with an empty array if missing, then add defaults whose ids
    // aren't yet present and aren't tombstoned. User-edited entries are
    // left untouched so label/colour edits survive across restarts.
    if (!_data.settings || typeof _data.settings !== 'object') _data.settings = {};
    for (const [cat, defArr] of Object.entries(SETTINGS_DEFAULTS)) {
      if (!Array.isArray(_data.settings[cat])) _data.settings[cat] = [];
      const existing = new Set(_data.settings[cat].map(x => x.id));
      for (const item of defArr) {
        const tombstoneKey = `settings:${cat}:${item.id}`;
        if (!existing.has(item.id) && !deleted.has(tombstoneKey)) {
          _data.settings[cat].push(JSON.parse(JSON.stringify(item)));
        }
      }
    }
    // Player party (Naše parta) — single-object setting (not an enum
    // array). Seeded once on first install; never overwritten if
    // already present. Migration from legacy `factions.party` runs
    // later in load() via `_migratePartyFactionToPlayerParty`.
    if (!_data.settings.playerParty || typeof _data.settings.playerParty !== 'object'
        || Array.isArray(_data.settings.playerParty)) {
      _data.settings.playerParty = {
        name:      'Our Party',
        icon:      '🛡',
        badge:     '🛡',
        color:     '#F5F0E4',
        textColor: '#1a1410',
      };
    }

    // Site branding (logo + sidebar wordmark) — single-object setting.
    // Seeded once; never overwritten if present. Empty `logoUrl` means
    // "use the bundled default" (web/branding/logo-default.svg). The
    // condition only fires when the key is missing/invalid, so it's
    // idempotent and never re-syncs on its own (avoids the settings
    // re-render loop documented in CLAUDE.md).
    if (!_data.settings.branding || typeof _data.settings.branding !== 'object'
        || Array.isArray(_data.settings.branding)) {
      _data.settings.branding = {
        logoUrl:   '',
        title:     'TTRPG Codex',
        subtitle:  'Wiki & World Atlas',
        updatedAt: 0,
      };
    }

    // Campaign metadata (name + tagline, shown on dashboard hero).
    // Keyed-object collection with a single 'main' record.
    if (!_data.campaign || typeof _data.campaign !== 'object' || Array.isArray(_data.campaign)) {
      _data.campaign = {};
    }
    if (!_data.campaign.main || typeof _data.campaign.main !== 'object') {
      _data.campaign.main = { name: 'Untitled Campaign', tagline: '' };
    }
    if (typeof _data.campaign.main.name    !== 'string') _data.campaign.main.name    = 'Untitled Campaign';
    if (typeof _data.campaign.main.tagline !== 'string') _data.campaign.main.tagline = '';
  }

  // ─────────────────────────────────────────────────────────────
  //  Schema migrations.
  //
  //  Each `_migrate*()` helper below MUST be idempotent — `load()`
  //  invokes the full set on every page load, so re-running on
  //  already-migrated data has to be a no-op.
  //
  //  Each helper returns the entities it touched (plus, in some
  //  cases, flags or category ids) so `load()` can sync per-record
  //  via the normal PATCH path. Returning `[]` / `false` means
  //  "nothing changed; no sync needed."
  //
  //  When adding a new migration: hook it into `load()` in the
  //  same order-sensitive batch (mapStatus must precede the shape
  //  upgrade so `unknown` ids are stripped together).
  // ─────────────────────────────────────────────────────────────

  /**
   * Translate the retired `location.mapStatus` field into the unified
   * `attitudes[]` vocabulary and remove the orphan `mapStatuses` enum
   * category from settings.
   *
   * @returns {{touchedLocations: Array, droppedSettingsCat: boolean}}
   */
  function _migrateMapStatusToAttitudes() {
    if (!_data) return { touchedLocations: [], droppedSettingsCat: false };
    const touched = [];
    const IDMAP = { visited: 'ally', enemy: 'enemy', fog: 'unknown', known: 'neutral' };
    for (const l of _data.locations || []) {
      let locChanged = false;
      let attitudes = Array.isArray(l.attitudes) ? l.attitudes.slice() : null;
      // Carry legacy mapStatus forward into attitudes if not already set.
      if (l.mapStatus) {
        const mapped = IDMAP[l.mapStatus] || 'unknown';
        if (!attitudes || !attitudes.length) attitudes = [mapped];
        else if (!attitudes.includes(mapped)) attitudes.push(mapped);
      }
      if (attitudes && JSON.stringify(l.attitudes || []) !== JSON.stringify(attitudes)) {
        l.attitudes = attitudes;
        locChanged = true;
      }
      if (l.mapStatus !== undefined) {
        delete l.mapStatus;
        locChanged = true;
      }
      if (locChanged) touched.push(l);
    }
    let droppedSettingsCat = false;
    if (_data.settings && Array.isArray(_data.settings.mapStatuses)) {
      delete _data.settings.mapStatuses;
      droppedSettingsCat = true;
    }
    return { touchedLocations: touched, droppedSettingsCat };
  }

  /**
   * Replace any remaining `status: 'captured'` characters with
   * `alive` + a `Zajat/a` note in the free-text `circumstances` field.
   * The narrower enum keeps the picker simple; `circumstances` is the
   * place to record richer states.
   *
   * @returns {Array} Characters whose record was rewritten.
   */
  function _migrateCapturedStatus() {
    if (!_data || !Array.isArray(_data.characters)) return [];
    const touched = [];
    for (const c of _data.characters) {
      if (c.status === 'captured') {
        c.status = 'alive';
        if (!c.circumstances) c.circumstances = 'Zajat/a';
        touched.push(c);
      }
    }
    return touched;
  }

  /**
   * Coerce every entity's `attitudes` field into the canonical
   * `[{id}]` shape: drop the legacy single-string `character.attitude`,
   * upgrade legacy `string[]` arrays to objects, and strip the legacy
   * `unknown` id (now expressed by an empty array).
   *
   * @returns {{characters: Array, locations: Array, factions: Array<{id:string, fac:object}>}}
   */
  function _migrateAttitudesToObjectShape() {
    if (!_data) return { characters: [], locations: [], factions: [] };
    const out = { characters: [], locations: [], factions: [] };

    // Returns a normalised array if any change is needed; null when the
    // input is already canonical (so the caller can skip a no-op sync).
    // Canonical shape is `[{id}]` — no `strength` field; strength lives
    // on the `attitudes` settings enum item itself (see
    // `_migrateStrengthFromEntityToEnum`).
    //
    // ⚠ LOAD-BEARING INVARIANT: this function MUST NOT re-add `strength`
    // to entries that are already canonical. If it does, it ping-pongs
    // with `_migrateStrengthFromEntityToEnum` on every load — each
    // migration sees the other's output as "non-canonical" and writes
    // a fresh sync, which the SSE pushes back as a `data-changed`
    // event, which triggers another load, which… The hash-dedupe in
    // `_applyRemoteChange` cannot save you here because each cycle's
    // payload genuinely differs (`{id:'enemy'}` ↔ `{id:'enemy', strength:1.0}`).
    // Symptom: the page flickers continuously until the tab is closed.
    const normalize = (arr) => {
      if (!Array.isArray(arr)) return null;
      let changed = false;
      const seen = new Set();
      const next = [];
      for (const e of arr) {
        if (typeof e === 'string') {
          changed = true;
          if (e === 'unknown' || !e) continue;
          if (seen.has(e)) continue;
          seen.add(e);
          next.push({ id: e });
        } else if (e && typeof e === 'object' && typeof e.id === 'string') {
          if (e.id === 'unknown') { changed = true; continue; }
          if (seen.has(e.id))      { changed = true; continue; }
          seen.add(e.id);
          if ('strength' in e) {
            // Drop the legacy strength field (now per-enum).
            changed = true;
            const { strength, ...rest } = e;  // eslint-disable-line no-unused-vars
            next.push({ ...rest, id: e.id });
          } else {
            // Already canonical — preserve as-is, no `changed` bump.
            next.push(e);
          }
        } else {
          changed = true; // drop garbage
        }
      }
      return changed ? next : null;
    };

    for (const c of _data.characters || []) {
      let touched = false;
      // Legacy single `attitude` field → array form.
      if ('attitude' in c) {
        const legacy = c.attitude;
        if (typeof legacy === 'string' && legacy && legacy !== 'unknown'
            && (!Array.isArray(c.attitudes) || c.attitudes.length === 0)) {
          c.attitudes = [{ id: legacy }];
        }
        delete c.attitude;
        touched = true;
      }
      const norm = normalize(c.attitudes);
      if (norm) { c.attitudes = norm; touched = true; }
      else if (!Array.isArray(c.attitudes)) { c.attitudes = []; touched = true; }
      if (touched) out.characters.push(c);
    }

    for (const l of _data.locations || []) {
      const norm = normalize(l.attitudes);
      if (norm) { l.attitudes = norm; out.locations.push(l); }
      else if (!Array.isArray(l.attitudes)) { l.attitudes = []; out.locations.push(l); }
    }

    for (const [id, f] of Object.entries(_data.factions || {})) {
      if (!f || typeof f !== 'object') continue;
      if (!Array.isArray(f.attitudes)) {
        f.attitudes = [];
        out.factions.push({ id, fac: f });
      } else {
        const norm = normalize(f.attitudes);
        if (norm) { f.attitudes = norm; out.factions.push({ id, fac: f }); }
      }
    }

    return out;
  }

  /**
   * Remove the `unknown` row from `settings.attitudes` and tombstone it
   * so `_mergeDefaults` won't re-seed. Empty `attitudes[]` IS the new
   * "no stance" baseline; the old explicit id was redundant and made
   * the renderer ambiguous.
   *
   * @returns {boolean} `true` if the row was dropped (caller persists).
   */
  function _dropUnknownFromAttitudesEnum() {
    if (!_data?.settings?.attitudes) return false;
    const before = _data.settings.attitudes.length;
    _data.settings.attitudes = _data.settings.attitudes.filter(a => a.id !== 'unknown');
    if (_data.settings.attitudes.length === before) return false;
    if (!_data.deletedDefaults || typeof _data.deletedDefaults !== 'object') {
      _data.deletedDefaults = {};
    }
    _data.deletedDefaults['settings:attitudes:unknown'] = true;
    return true;
  }

  /**
   * Replace the `priority` (1/2/3) field on every pin type and on every
   * placed location with an explicit pixel `size`. Visibility is no
   * longer derived from priority; it'll be a per-Pohled rule.
   *
   * Mapping: 1→36 px, 2→30 px, 3→26 px (mirrors the seeded defaults).
   *
   * @returns {{pinTypesTouched: boolean, touchedLocations: Array}}
   */
  function _migratePinPriorityToSize() {
    if (!_data) return { pinTypesTouched: false, touchedLocations: [] };
    const SIZE_FROM_PRIORITY = { 1: 36, 2: 30, 3: 26 };
    let pinTypesTouched = false;
    const arr = (_data.settings && _data.settings.pinTypes) || [];
    for (const pt of arr) {
      if ('priority' in pt) {
        if (typeof pt.size !== 'number') {
          pt.size = SIZE_FROM_PRIORITY[pt.priority] || 28;
        }
        delete pt.priority;
        pinTypesTouched = true;
      } else if (typeof pt.size !== 'number') {
        // Item that pre-dates both fields — give it a sensible default.
        pt.size = 28;
        pinTypesTouched = true;
      }
    }
    const touched = [];
    for (const l of _data.locations || []) {
      if ('priority' in l) {
        if (typeof l.size !== 'number') {
          const mapped = SIZE_FROM_PRIORITY[l.priority];
          if (mapped) l.size = mapped;
        }
        delete l.priority;
        touched.push(l);
      }
    }
    return { pinTypesTouched, touchedLocations: touched };
  }

  /**
   * Strip the `strength` field from every entity's attitude entries.
   * Strength now lives on the `attitudes` settings enum item, so editing
   * intensity in Settings updates every glow at once instead of having
   * to walk every entity record.
   *
   * Pairs with the LOAD-BEARING INVARIANT in
   * `_migrateAttitudesToObjectShape.normalize` — see that comment for
   * why this migration must NOT bounce with the shape upgrade.
   *
   * @returns {{characters: Array, locations: Array, factions: Array<{id:string, fac:object}>}}
   */
  function _migrateStrengthFromEntityToEnum() {
    if (!_data) return { characters: [], locations: [], factions: [] };
    const out = { characters: [], locations: [], factions: [] };
    const stripStrength = (arr) => {
      if (!Array.isArray(arr)) return null;
      let changed = false;
      const next = arr.map(e => {
        if (e && typeof e === 'object' && 'strength' in e) {
          changed = true;
          const { strength, ...rest } = e;  // eslint-disable-line no-unused-vars
          return rest;
        }
        return e;
      });
      return changed ? next : null;
    };
    for (const c of _data.characters || []) {
      const next = stripStrength(c.attitudes);
      if (next) { c.attitudes = next; out.characters.push(c); }
    }
    for (const l of _data.locations || []) {
      const next = stripStrength(l.attitudes);
      if (next) { l.attitudes = next; out.locations.push(l); }
    }
    for (const [id, f] of Object.entries(_data.factions || {})) {
      if (!f || typeof f !== 'object') continue;
      const next = stripStrength(f.attitudes);
      if (next) { f.attitudes = next; out.factions.push({ id, fac: f }); }
    }
    return out;
  }

  /** PCs always render with the `party` palette via the faction
   *  shortcut in getEffectiveAttitudes; their own `attitudes[]` field
   *  is dead data. Strip it so saved records match reality.
   *  Idempotent: only emits when the array is non-empty. Must run
   *  after `_migrateStrengthFromEntityToEnum` so we don't double-
   *  touch a record being normalised by both passes. */
  function _migratePartyAttitudesEmpty() {
    if (!_data) return { characters: [] };
    const out = [];
    for (const c of (_data.characters || [])) {
      if (isPartyMember(c)
          && Array.isArray(c.attitudes)
          && c.attitudes.length > 0) {
        c.attitudes = [];
        out.push(c);
      }
    }
    return { characters: out };
  }

  /**
   * Ensure every `settings.attitudes` row has a numeric `strength`
   * (defaulting to 1.0). The renderer expects a number; missing values
   * would silently break the glow on first paint.
   *
   * @returns {boolean} `true` if any row was patched.
   */
  function _seedAttitudeStrength() {
    if (!_data?.settings?.attitudes) return false;
    let touched = false;
    for (const a of _data.settings.attitudes) {
      if (typeof a.strength !== 'number') {
        a.strength = 1.0;
        touched = true;
      }
    }
    return touched;
  }

  /**
   * Strip `location.status`. The `locationStatuses` enum and its
   * icon-variant strategy were retired; description text is the place
   * to record richer state.
   *
   * @returns {Array} Locations whose record was patched.
   */
  function _migrateDropLocationStatus() {
    if (!_data || !Array.isArray(_data.locations)) return [];
    const touched = [];
    for (const l of _data.locations) {
      if (Object.prototype.hasOwnProperty.call(l, 'status')) {
        delete l.status;
        touched.push(l);
      }
    }
    return touched;
  }

  /**
   * Strip `artifact.state`. The `artifactStates` enum was a cosmetic
   * chip with no search / filter / icon hook, retired alongside
   * `locationStatuses`.
   *
   * @returns {Array} Artifacts whose record was patched.
   */
  function _migrateDropArtifactState() {
    if (!_data || !Array.isArray(_data.artifacts)) return [];
    const touched = [];
    for (const a of _data.artifacts) {
      if (Object.prototype.hasOwnProperty.call(a, 'state')) {
        delete a.state;
        touched.push(a);
      }
    }
    return touched;
  }

  /**
   * Remove the `locationStatuses` and `artifactStates` keys from
   * `_data.settings`. Pure server-side cleanup — without this, the
   * orphan categories would linger in `data/settings.json` forever.
   *
   * @returns {Array<string>} Category ids actually removed (caller
   *                          issues one `_sync('settings', 'delete')`
   *                          per id).
   */
  function _migrateDropRetiredSettingsCategories() {
    if (!_data?.settings) return [];
    const RETIRED = ['locationStatuses', 'artifactStates'];
    const dropped = [];
    for (const cat of RETIRED) {
      if (Object.prototype.hasOwnProperty.call(_data.settings, cat)) {
        delete _data.settings[cat];
        dropped.push(cat);
      }
    }
    return dropped;
  }

  /**
   * Collapse the retired `state` icon-strategy to `single` and strip
   * per-file `stateId` markers on every pin type. With the `state`
   * strategy gone, `files[0]` is the default for `single` mode so the
   * marker metadata is no longer needed.
   *
   * @returns {boolean} `true` if any pin type was patched (caller
   *                    persists the whole `pinTypes` category once).
   */
  function _migrateRetirePinTypeStateStrategy() {
    const types = _data?.settings?.pinTypes;
    if (!Array.isArray(types)) return false;
    let touched = false;
    for (const t of types) {
      const cfg = t.iconConfig;
      if (!cfg || typeof cfg !== 'object') continue;
      if (cfg.strategy === 'state') {
        cfg.strategy = 'single';
        touched = true;
      }
      if (Array.isArray(cfg.files)) {
        for (const f of cfg.files) {
          if (Object.prototype.hasOwnProperty.call(f, 'stateId')) {
            delete f.stateId;
            touched = true;
          }
        }
      }
    }
    return touched;
  }

  /**
   * Move `factions.party` (legacy regular-faction record for the
   * player party) into `settings.playerParty`. PCs are still
   * identified by `character.faction === 'party'` — only the visual
   * identity moves. Idempotent: if `settings.playerParty` is already
   * populated, the factions side is dropped without overwrite.
   *
   * @returns {{movedFromFactions: boolean, playerPartyChanged: boolean}}
   */
  function _migratePartyFactionToPlayerParty() {
    if (!_data) return { movedFromFactions: false, playerPartyChanged: false };
    const fac = _data.factions && _data.factions.party;
    if (!fac) return { movedFromFactions: false, playerPartyChanged: false };
    // Always import the user's existing party-faction data — defaults
    // were seeded in _mergeDefaults so settings.playerParty exists,
    // but we want the real user-customised colours/name/badge to win
    // on the first migration pass. After this runs, factions.party
    // is gone so subsequent loads short-circuit at the !fac guard.
    if (!_data.settings) _data.settings = {};
    _data.settings.playerParty = {
      name:      fac.name      || 'Our Party',
      icon:      fac.badge     || '🛡',
      badge:     fac.badge     || '🛡',
      color:     fac.color     || '#F5F0E4',
      textColor: fac.textColor || '#1a1410',
    };
    delete _data.factions.party;
    if (!_data.deletedDefaults || typeof _data.deletedDefaults !== 'object') {
      _data.deletedDefaults = {};
    }
    _data.deletedDefaults['factions:party'] = true;
    return { movedFromFactions: true, playerPartyChanged: true };
  }

  /**
   * Remove the legacy `party` entry from the attitudes settings enum
   * AND strip it from any per-entity `attitudes[]` array. The party
   * palette is now sourced from `settings.playerParty.color` directly
   * (see `_attitudeColorMap` consumers); the enum entry is dead
   * data that would just clutter the Settings → Postoje editor.
   *
   * @returns {{enumChanged: boolean, characters: Array, locations: Array, factions: Array}}
   */
  /**
   * Promote `mystery.questions[]` and `character.unknown[]` from string
   * arrays to arrays of `{text, answer}` objects so each question /
   * unknown item can carry its own answer (and thus its own "solved"
   * state). Mystery is considered solved iff every question has a
   * non-empty `answer`.
   *
   * Idempotent: entries that are already objects with a `text` key are
   * left alone. Entries with a non-string, non-object value (or null)
   * get coerced into an empty `{text:'', answer:''}` so subsequent code
   * can assume the canonical shape.
   *
   * @returns {{mysteries: Array, characters: Array}}
   */
  function _migrateQuestionsToObjects() {
    if (!_data) return { mysteries: [], characters: [] };
    const touchedM = [];
    const touchedC = [];
    const promote = (entry) => {
      // Already in target shape — leave alone.
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
        // Capture BEFORE mutating — checking after the assignment made
        // `changed` tautologically false, so the added `answer:''` was
        // normalized in memory on every load but never persisted.
        const missingAnswer = typeof entry.answer !== 'string';
        if (missingAnswer) entry.answer = '';
        return { entry, changed: missingAnswer };
      }
      // Promote a bare string to {text, answer:''}.
      if (typeof entry === 'string') {
        return { entry: { text: entry, answer: '' }, changed: true };
      }
      // Anything else (null, number, …) becomes an empty record.
      return { entry: { text: '', answer: '' }, changed: true };
    };
    for (const m of _data.mysteries || []) {
      if (!Array.isArray(m.questions)) continue;
      let changed = false;
      const next = m.questions.map(q => {
        const r = promote(q);
        if (r.changed) changed = true;
        return r.entry;
      });
      if (changed) {
        m.questions = next;
        touchedM.push(m);
      }
    }
    for (const c of _data.characters || []) {
      if (!Array.isArray(c.unknown)) continue;
      let changed = false;
      const next = c.unknown.map(u => {
        const r = promote(u);
        if (r.changed) changed = true;
        return r.entry;
      });
      if (changed) {
        c.unknown = next;
        touchedC.push(c);
      }
    }
    return { mysteries: touchedM, characters: touchedC };
  }

  function _migrateDropPartyFromAttitudesEnum() {
    const result = { enumChanged: false, characters: [], locations: [], factions: [] };
    if (!_data) return result;
    if (Array.isArray(_data.settings?.attitudes)) {
      const before = _data.settings.attitudes.length;
      _data.settings.attitudes = _data.settings.attitudes.filter(a => a.id !== 'party');
      if (_data.settings.attitudes.length !== before) {
        result.enumChanged = true;
        if (!_data.deletedDefaults || typeof _data.deletedDefaults !== 'object') {
          _data.deletedDefaults = {};
        }
        _data.deletedDefaults['settings:attitudes:party'] = true;
      }
    }
    const stripParty = (arr) => arr.filter(e => {
      if (typeof e === 'string') return e !== 'party';
      return !(e && e.id === 'party');
    });
    for (const c of (_data.characters || [])) {
      if (Array.isArray(c.attitudes) && c.attitudes.some(e => (typeof e === 'string' ? e === 'party' : e?.id === 'party'))) {
        c.attitudes = stripParty(c.attitudes);
        result.characters.push(c);
      }
    }
    for (const l of (_data.locations || [])) {
      if (Array.isArray(l.attitudes) && l.attitudes.some(e => (typeof e === 'string' ? e === 'party' : e?.id === 'party'))) {
        l.attitudes = stripParty(l.attitudes);
        result.locations.push(l);
      }
    }
    for (const [fid, fac] of Object.entries(_data.factions || {})) {
      if (Array.isArray(fac.attitudes) && fac.attitudes.some(e => (typeof e === 'string' ? e === 'party' : e?.id === 'party'))) {
        fac.attitudes = stripParty(fac.attitudes);
        result.factions.push({ id: fid, fac });
      }
    }
    return result;
  }

  /**
   * Fetch the full dataset from `/api/data`, merge defaults for any
   * collection the server hasn't seeded yet, and run every idempotent
   * schema migration. Each migration's touched records are PATCHed back
   * individually — never as a wholesale dataset overwrite.
   *
   * If the server is unreachable, the in-memory dataset falls back to
   * defaults and a `store:server-unavailable` event fires; subsequent
   * `_sync` calls become no-ops until the page is reloaded with a
   * working server.
   *
   * @returns {Promise<boolean>} `true` when the dataset was (re)loaded
   *   from the server; `false` when the fetch failed and the in-memory
   *   data was kept/defaulted. Callers that latch state on "I now hold
   *   the server's version X" (app.js `_lastHash`) must check this.
   * @fires window#store:server-unavailable
   */
  async function load() {
    try {
      const res = await fetch('/api/data');
      if (res.ok) {
        _serverAvailable = true;
        const serverData = await res.json();
        _loadedOnce = true;
        if (serverData && serverData.characters) {
          // Layer the server payload OVER the defaults rather than replacing
          // wholesale. The server omits collections that have no file yet
          // (e.g. a fresh instance where the user added characters but never
          // a relationship → no relationships.json), so a bare `_data =
          // serverData` leaves those keys `undefined`. Every getter that does
          // `_data.X.filter(...)` (e.g. getRelationships in the character
          // article) would then throw and the page can't render. Spreading
          // _defaults() first guarantees every collection key exists as at
          // least an empty array/object; present keys are overridden by the
          // server (the source of truth).
          _data = { ..._defaults(), ...serverData };
          _mergeDefaults();
          // Migrations run in a specific order — `mapStatus` must
          // precede the shape upgrade so the `unknown` ids it inserts
          // get stripped together; the rest are independent.
          const capturedTouched = _migrateCapturedStatus();
          const mapStatus       = _migrateMapStatusToAttitudes();
          // Run the mapStatus → attitudes migration BEFORE the shape
          // upgrade so the `unknown` ids it inserts get stripped here.
          const attShape        = _migrateAttitudesToObjectShape();
          const droppedUnknown  = _dropUnknownFromAttitudesEnum();
          const pinSize         = _migratePinPriorityToSize();
          const droppedLocStat  = _migrateDropLocationStatus();
          const droppedArtStat  = _migrateDropArtifactState();
          const droppedSettingsCats = _migrateDropRetiredSettingsCategories();
          const pinStrategyTouched = _migrateRetirePinTypeStateStrategy();
          const strengthMigrated = _migrateStrengthFromEntityToEnum();
          const partyAtts       = _migratePartyAttitudesEmpty();
          const strengthSeeded  = _seedAttitudeStrength();
          // Party-faction → settings.playerParty + drop `party`
          // attitude. Must run before _reindex so the renderers see
          // the new shape. Idempotent — safe to re-run on subsequent
          // loads after migration completed.
          const playerPartyMig = _migratePartyFactionToPlayerParty();
          const partyAttMig    = _migrateDropPartyFromAttitudesEnum();
          // Mystery questions + character unknowns: strings → objects
          // with an `answer` field. Each entry becomes "solved" when
          // its answer is non-empty.
          const questionsMig   = _migrateQuestionsToObjects();
          // Persisting migration results is DM-only. Player sessions
          // would 403 on the `settings` writes (DM_ONLY_WRITE_TYPES) and
          // surface a red "save failed" banner for edits they never
          // made; anonymous sessions would fire straight into 401s.
          // Non-DM sessions keep the in-memory normalization — the next
          // DM load persists it (migrations are idempotent).
          if (Role.isDM()) {
            for (const c of capturedTouched)            _sync('characters', 'save', c);
            for (const l of mapStatus.touchedLocations) _sync('locations', 'save', l);
            if (mapStatus.droppedSettingsCat)           _sync('settings', 'delete', { id: 'mapStatuses' });
            for (const c of attShape.characters)        _sync('characters', 'save', c);
            for (const l of attShape.locations)         _sync('locations',  'save', l);
            for (const { id, fac } of attShape.factions) _sync('factions',  'save', { id, data: fac });
            if (droppedUnknown || strengthSeeded) {
              _sync('settings', 'save', { id: 'attitudes', data: _data.settings.attitudes });
            }
            if (pinSize.pinTypesTouched || pinStrategyTouched) {
              _sync('settings', 'save', { id: 'pinTypes', data: _data.settings.pinTypes });
            }
            for (const c of strengthMigrated.characters) _sync('characters', 'save', c);
            for (const l of strengthMigrated.locations)  _sync('locations',  'save', l);
            for (const { id, fac } of strengthMigrated.factions) _sync('factions', 'save', { id, data: fac });
            for (const c of partyAtts.characters)        _sync('characters', 'save', c);
            for (const l of pinSize.touchedLocations)   _sync('locations', 'save', l);
            for (const l of droppedLocStat)             _sync('locations', 'save', l);
            for (const a of droppedArtStat)             _sync('artifacts', 'save', a);
            for (const cat of droppedSettingsCats)      _sync('settings', 'delete', { id: cat });
            if (playerPartyMig.playerPartyChanged) {
              _sync('settings', 'save', { id: 'playerParty', data: _data.settings.playerParty });
            }
            if (playerPartyMig.movedFromFactions) {
              _sync('factions', 'delete', { id: 'party' });
            }
            if (partyAttMig.enumChanged) {
              _sync('settings', 'save', { id: 'attitudes', data: _data.settings.attitudes });
            }
            for (const c of partyAttMig.characters) _sync('characters', 'save', c);
            for (const l of partyAttMig.locations)  _sync('locations',  'save', l);
            for (const { id, fac } of partyAttMig.factions) _sync('factions', 'save', { id, data: fac });
            for (const m of questionsMig.mysteries)  _sync('mysteries',  'save', m);
            for (const c of questionsMig.characters) _sync('characters', 'save', c);
          }
          _reindex();
          return true;
        }
        // Empty server: keep defaults locally; the first user edit
        // will lazily create files server-side via the per-entity
        // PATCH path. No bulk wipe necessary.
        _data = _defaults();
        _reindex();
        return true;
      }
    } catch (e) {
      console.error('Store: server not reachable.', e);
    }
    // Mid-session refetch failure (an SSE-triggered reload during a
    // network blip / server hiccup): keep the already-loaded dataset and
    // stay write-enabled — the write queue retries transient failures on
    // its own. Wiping to defaults here would replace a live campaign
    // with an empty one and silently disable all syncing until reload.
    if (_loadedOnce) {
      console.warn('Store: refetch failed — keeping current in-memory data.');
      return false;
    }
    _serverAvailable = false;
    _data = _defaults();
    _reindex();
    window.dispatchEvent(new CustomEvent('store:server-unavailable'));
    return false;
  }

  function init() {
    if (!_data) { _data = _defaults(); _reindex(); }
  }

  // ── Serialised write queue ────────────────────────────────────
  // Every PATCH waits for the previous one to settle (success, terminal
  // failure, or auth bounce) before going on the wire. This preserves
  // ordering on the server side — a save-then-delete pair can't arrive
  // out of order, even if the second was issued before the first
  // completed. Each request gets up to 3 attempts with exponential
  // backoff (200 ms → 800 ms) for transient network / 5xx errors.
  //
  // Local mutations are NOT rolled back on terminal failure. The next
  // page load will reconcile from the server's authoritative copy, and
  // the `store:save-failed` banner alerts the user that a refresh is
  // needed. Rolling back optimistically would force editors to
  // re-discover stale form state mid-edit, which is a worse UX than
  // the rare "your last save didn't make it" message.
  let _writeChain   = Promise.resolve();
  let _inflightCount = 0;
  function _setInflight(n) {
    _inflightCount = n;
    window.dispatchEvent(new CustomEvent('store:inflight', { detail: { count: n } }));
  }

  async function _patchOnce(type, action, payload) {
    const res = await fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type, action, payload }),
    });
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('store:auth-failed'));
      return { ok: false, terminal: true, status: 401 };
    }
    if (res.ok) return { ok: true };
    // 4xx (other than 401) means our payload is wrong — retrying won't
    // help. 5xx and network errors are worth retrying.
    if (res.status >= 400 && res.status < 500) return { ok: false, terminal: true, status: res.status };
    return { ok: false, terminal: false, status: res.status };
  }

  function _sync(type, action, payload) {
    if (!_serverAvailable) return false;
    // Snapshot the payload NOW. The queue serializes requests, so the
    // JSON.stringify in _patchOnce may run several writes later — by then
    // an in-place mutation of the same live object (peer location moves,
    // pet orphaning) would make this EARLIER patch silently carry the
    // LATER state, undermining the ordering guarantee above.
    const body = (payload && typeof payload === 'object')
      ? JSON.parse(JSON.stringify(payload))
      : payload;
    _setInflight(_inflightCount + 1);
    _writeChain = _writeChain.then(async () => {
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await _patchOnce(type, action, body);
          if (r.ok) return;
          if (r.terminal) {
            if (r.status !== 401) {
              console.warn(`Store: ${type}/${action} rejected (${r.status}).`);
              window.dispatchEvent(new CustomEvent('store:save-failed', { detail: { type, action, status: r.status }}));
            }
            return;
          }
          lastErr = new Error(`HTTP ${r.status}`);
        } catch (e) {
          lastErr = e;
        }
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * attempt * 200));  // 200ms, 800ms
        }
      }
      console.warn(`Store: ${type}/${action} sync failed after retries.`, lastErr);
      window.dispatchEvent(new CustomEvent('store:save-failed', { detail: { type, action }}));
    }).finally(() => {
      _setInflight(Math.max(0, _inflightCount - 1));
    });
    return true;
  }

  // ─ Twin operations (DM-only) ──────────────────────────────────
  // The server handles atomicity (both sides of a twin link are
  // written together in one `withWriteLock` pass on /api/twin) so
  // the client just fires-and-awaits and relies on the SSE refetch
  // to pick up both records. `linkTwin('create', ...)` returns the
  // new twin id on success so the caller can navigate to it.

  /**
   * Twin operations on an entity. DM-only.
   *
   *   - 'create' → spawn a new sibling entity in the opposite space
   *               with the source's fields copied.
   *   - 'link'   → marry an existing target entity to the source.
   *               Requires opposite visibility + neither already
   *               linked. `targetId` is required.
   *   - 'unlink' → break the existing pair (entities survive).
   *
   * @param {'create'|'link'|'unlink'} action
   * @param {string} type     - Collection name (must be in VISIBILITY_BEARING).
   * @param {string} sourceId - Id of the source entity.
   * @param {string} [targetId] - Required for 'link'; ignored otherwise.
   * @returns {Promise<{ok: boolean, twinId?: string, error?: string}>}
   */
  async function linkTwin(action, type, sourceId, targetId) {
    if (!_serverAvailable) return { ok: false, error: I18n.t('store.serverUnavailable') };
    try {
      const payload = { action, type, sourceId };
      if (action === 'link') payload.targetId = targetId;
      const res = await fetch('/api/twin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body:    JSON.stringify(payload),
      });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent('store:auth-failed'));
        return { ok: false, error: I18n.t('store.dmRequired') };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, twinId: body.twinId };
    } catch (e) {
      return { ok: false, error: e.message || I18n.t('store.networkError') };
    }
  }

  /** Resolve an entity's twin from its `linkedTwinId`. Returns null
   *  if no twin id is set or the target doesn't exist in the same
   *  collection. */
  function getTwin(collection, entity) {
    if (!entity || !entity.linkedTwinId) return null;
    init();
    const tid = entity.linkedTwinId;
    switch (collection) {
      case 'characters':       return getCharacter(tid);
      case 'locations':        return getLocation(tid);
      case 'events':           return getEvent(tid);
      case 'mysteries':        return getMystery(tid);
      case 'factions':         return getFaction(tid);
      case 'pantheon':         return getBuh(tid);
      case 'artifacts':        return getArtifact(tid);
      case 'historicalEvents': return getHistoricalEvent(tid);
      default:                 return null;
    }
  }

  /** Return every entity in a visibility-bearing collection as a
   *  uniform array (factions is keyed-object → values are merged
   *  with their parent-object key as `id`, so the returned shape is
   *  always `{id, ...}` regardless of underlying storage). Used by
   *  the twin picker + `dedupeShadowTwins` to enumerate candidates.
   *  Returns [] for unknown collections. */
  function getCollection(name) {
    init();
    switch (name) {
      case 'characters':       return _data.characters       || [];
      case 'locations':        return _data.locations        || [];
      case 'events':           return _data.events           || [];
      case 'mysteries':        return _data.mysteries        || [];
      case 'pantheon':         return _data.pantheon         || [];
      case 'artifacts':        return _data.artifacts        || [];
      case 'historicalEvents': return _data.historicalEvents || [];
      case 'factions':
        // Faction objects live keyed in the parent — no `id` field on
        // the value itself. Stamp it on so `dedupeShadowTwins` and the
        // twin picker (both keyed off `entity.id`) see the same shape
        // as array-collections. Return new objects to avoid mutating
        // the live store.
        return Object.entries(_data.factions || {}).map(([id, fac]) => ({ id, ...fac }));
      default: {
        // Addon-owned collections (`addon:<id>:<name>`) + any other present
        // container. Return arrays as-is; stamp ids onto keyed objects so the
        // shape matches array-collections (`{id, ...}`). Unknown → [].
        const c = _data[name];
        if (Array.isArray(c)) return c;
        if (c && typeof c === 'object') return Object.entries(c).map(([id, v]) => ({ id, ...v }));
        return [];
      }
    }
  }

  /** Twin dedup: when a DM viewer sees BOTH halves of a twin pair we
   *  hide the public-side entity and surface only the DM-side one
   *  (DMs spend most of their time on their own annotated copies; the
   *  public twin is reachable via the twin link in the side card).
   *
   *  No-op for player viewers — they only ever receive the public
   *  half because the server strips DM-visibility records from their
   *  payload, so there's nothing to dedupe.
   *
   *  @param {string} collection - Collection name (see getCollection).
   *  @param {Array}  list       - Entities to filter (subset of the
   *                               collection — search results, page
   *                               filters, etc.).
   *  @returns {Array} Filtered list with public twins removed when
   *                   their DM-side counterpart is also present in
   *                   the underlying collection.
   */
  function dedupeShadowTwins(collection, list) {
    if (!Array.isArray(list) || !list.length) return list || [];
    const all = getCollection(collection);
    if (!all.length) return list;
    const byId = new Map(all.map(e => [e.id, e]));
    return list.filter(e => {
      if (!e || e.visibility === 'dm' || !e.linkedTwinId) return true;
      const twin = byId.get(e.linkedTwinId);
      // Only hide when the twin actually exists, is DM-side, and points
      // back at us (defensive: stale linkedTwinId on one side without
      // reciprocation would otherwise silently disappear the public
      // entity).
      if (!twin) return true;
      if (twin.visibility !== 'dm') return true;
      if (twin.linkedTwinId !== e.id) return true;
      return false;
    });
  }

  /**
   * Upload a portrait image for a character.
   *
   * @param {File|Blob} file - Image file (multer accepts up to 20 MB).
   * @param {string} charId - Character id the portrait belongs to.
   * @returns {Promise<string>} Server-relative URL of the saved file.
   * @throws {Error} On auth failure (also fires `store:auth-failed`)
   *                 or any other upload error.
   */
  async function uploadPortrait(file, charId) {
    if (!charId) throw new Error('uploadPortrait: charId is required.');
    if (!_serverAvailable) throw new Error(I18n.t('store.serverUnavailablePortrait'));
    const form     = new FormData();
    form.append('portrait', file);
    const endpoint = `/api/portrait/${encodeURIComponent(charId)}`;
    const res = await fetch(endpoint, { method: 'POST', body: form });
    if (res.ok) return (await res.json()).url;
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('store:auth-failed'));
      throw new Error(I18n.t('store.unknownPassword'));
    }
    throw new Error(I18n.t('store.portraitUploadFailed'));
  }

  /**
   * Upload a local map image for a location. The server saves to
   * `data/maps/local/{locId}/map.{ext}` and schedules an async tile
   * pyramid build via `tiler.buildFor`.
   *
   * @param {File|Blob} file - Image file.
   * @param {string} locId - Location id the map belongs to.
   * @returns {Promise<string>} Server-relative URL of the saved file.
   */
  async function uploadLocalMap(file, locId) {
    if (!locId) throw new Error('uploadLocalMap: locId is required.');
    if (!_serverAvailable) throw new Error(I18n.t('store.serverUnavailableMap'));
    const form = new FormData();
    form.append('localmap', file);
    const res = await fetch(`/api/localmap/${encodeURIComponent(locId)}`, { method: 'POST', body: form });
    if (res.ok) return (await res.json()).url;
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('store:auth-failed'));
      throw new Error(I18n.t('store.unknownPassword'));
    }
    throw new Error(I18n.t('store.mapUploadFailed'));
  }

  // ── Marker icon uploads ──────────────────────────────────────
  // Per-pin-type image variants live under `data/icons/<pinTypeId>/`
  // (served at `/icons/...`). The strategy + variant metadata is held
  // in-band on `settings.pinTypes[i].iconConfig` rather than as on-
  // disk metadata. These helpers just shuttle bytes; `settings.js`
  // owns the iconConfig record.

  /**
   * Upload one or more marker icon variants for a pin type.
   *
   * @param {string} pinTypeId
   * @param {Array<File|Blob>} files - Up to 16 SVG/PNG/JPEG/WEBP files,
   *                                   2 MB each.
   * @returns {Promise<{files: Array<{id: string, url: string, name: string}>}>}
   */
  async function uploadIcons(pinTypeId, files) {
    if (!pinTypeId) throw new Error('uploadIcons: pinTypeId is required.');
    if (!_serverAvailable) throw new Error(I18n.t('store.serverUnavailableIcons'));
    if (!files || !files.length) return { files: [] };
    const form = new FormData();
    for (const f of files) form.append('icons', f);
    const res = await fetch(`/api/icons/${encodeURIComponent(pinTypeId)}`, { method: 'POST', body: form });
    if (res.ok) return res.json();
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('store:auth-failed'));
      throw new Error(I18n.t('store.unknownPassword'));
    }
    let msg = I18n.t('store.iconUploadFailed');
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }

  async function deleteIcon(pinTypeId, filename) {
    if (!_serverAvailable || !pinTypeId || !filename) return false;
    try {
      const res = await fetch(
        `/api/icons/${encodeURIComponent(pinTypeId)}/${encodeURIComponent(filename)}`,
        { method: 'DELETE' },
      );
      if (res.status === 401) window.dispatchEvent(new CustomEvent('store:auth-failed'));
      return res.ok;
    } catch (e) {
      console.warn('Store: deleteIcon failed.', e);
      return false;
    }
  }

  // Drop the entire icon folder for a pin type. Called when a pin type
  // is deleted from settings so we don't leave orphan files on disk.
  async function deleteIcons(pinTypeId) {
    if (!_serverAvailable || !pinTypeId) return false;
    try {
      const res = await fetch(`/api/icons/${encodeURIComponent(pinTypeId)}`, { method: 'DELETE' });
      if (res.status === 401) window.dispatchEvent(new CustomEvent('store:auth-failed'));
      return res.ok;
    } catch (e) {
      console.warn('Store: deleteIcons failed.', e);
      return false;
    }
  }

  function deletePortrait(url) {
    if (!_serverAvailable || !url || !url.startsWith('/portraits/')) return;
    const identifier = url.slice('/portraits/'.length).split('/')[0];
    if (!identifier) return;
    fetch(`/api/portrait/${encodeURIComponent(identifier)}`, { method: 'DELETE' })
      .then(res => { if (res.status === 401) window.dispatchEvent(new CustomEvent('store:auth-failed')); })
      .catch(e => console.warn('Store: portrait delete failed.', e));
  }

  /** @returns {Array} The live characters array (mutate via `saveCharacter`). */
  function getCharacters()    { init(); return _data.characters; }

  /** Is this entity a player-party PC? The canonical seam for any
   *  code that needs to treat PCs differently from NPCs. Today this
   *  is just a faction check; tomorrow it may also look at a
   *  dedicated `isPC` field or similar. Callers should NOT inline
   *  `c.faction === PARTY_FACTION_ID` — route through here. */
  function isPartyMember(c) {
    return !!(c && c.faction === PARTY_FACTION_ID);
  }

  /** Would `entity` be visible to a viewer with the given `role`?
   *  Cosmetic-only — the client receives data the server already
   *  filtered, so this only matters in editor previews (e.g. the
   *  DM wants to know which entries are hidden from players without
   *  flipping into view-as-player mode). Mirrors the entity-level
   *  filter in `server/visibility.cjs`; per-field secrets and
   *  inline markers aren't reconstructable from a filtered payload
   *  so this is the entity-level question only.
   *
   *  @param {object} entity - Any record carrying `visibility`.
   *  @param {'dm'|'player'} role - Effective viewer role.
   *  @returns {boolean} True if the entity would appear in `role`'s payload. */
  function isVisibleTo(entity, role) {
    if (!entity || typeof entity !== 'object') return false;
    if (role === 'dm') return true;
    return entity.visibility !== 'dm';
  }

  /** PCs only. Sorted by Czech locale to match dashboard / /parta. */
  function getPartyMembers() {
    return getCharacters()
      .filter(isPartyMember)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
  }

  /** Everyone except PCs. Use this anywhere `/postavy`-style "wider
   *  roster" semantics apply. Returns an unsorted array — callers
   *  apply their own sort. */
  function getNPCs() {
    return getCharacters().filter(c => !isPartyMember(c));
  }

  /** @returns {Array} The live relationships array. */
  function getRelationships() { init(); return _data.relationships; }
  /** @returns {Array} The live locations array. */
  function getLocations()     { init(); return _data.locations; }
  /** @returns {Array} The live events array. */
  function getEvents()        { init(); return _data.events; }
  /** @returns {Array} The live mysteries array. */
  function getMysteries()     { init(); return _data.mysteries; }
  /** @returns {Object} The live factions keyed-object map. */
  function getFactions()      { init(); return _data.factions; }
  /** @param {string} id - Faction id. @returns {object|null} */
  function getFaction(id)     { return getFactions()[id] || null; }

  /**
   * @returns {Object<string, object>} Status id → record map. Built from
   *   the merged kind registry (`getKinds('statuses')` = settings
   *   `characterStatuses` base/DM list + any addon status kinds), with a
   *   defaults fallback for the brief window before settings have loaded.
   *   This is the single central status resolver, so addon statuses render
   *   everywhere (cloudmap / wiki / map) for free.
   */
  function getStatusMap() {
    const arr = (_data?.settings?.characterStatuses)
      ? getKinds('statuses')
      : SETTINGS_DEFAULTS.characterStatuses;
    return Object.fromEntries(arr.map(s => [s.id, s]));
  }
  function getPantheon()      { init(); return _data.pantheon || []; }
  function getArtifacts()     { init(); return _data.artifacts || []; }
  function getBuh(id)         { return getPantheon().find(g => g.id === id) || null; }
  function getArtifact(id)    { return getArtifacts().find(a => a.id === id) || null; }

  /**
   * Locations with map coordinates set. Falsy `parentId` means "on the
   * world map"; pass a location id to get the places pinned on that
   * location's local sub-map.
   *
   * @param {string|null} parentId
   * @returns {Array} Locations where `x`/`y` are numeric and the
   *                  `parentId` matches.
   */
  function getLocationsOnMap(parentId) {
    init();
    const p = parentId || null;
    return _data.locations.filter(l =>
      typeof l.x === 'number' && typeof l.y === 'number'
      && (l.parentId || null) === p
    );
  }
  /**
   * All locations whose `parentId` is `parentId`, regardless of whether
   * they're placed on a map. Useful for hierarchy / breadcrumb UI.
   *
   * @param {string} parentId
   * @returns {Array}
   */
  function getSubLocations(parentId) {
    init(); return _idxChildLocations.get(parentId) || [];
  }

  /**
   * Walk the `parentId` chain upward from a location, closest-first.
   * Cycle-guarded so a misconfigured parent loop terminates cleanly.
   *
   * @param {string} locId - Starting location id.
   * @returns {Array} Ancestors, ordered immediate-parent → root.
   */
  function getAncestorLocations(locId) {
    init();
    const chain = [];
    const seen  = new Set();
    let cur = _data.locations.find(l => l.id === locId);
    while (cur && cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const parent = _data.locations.find(l => l.id === cur.parentId);
      if (!parent) break;
      chain.push(parent);
      cur = parent;
    }
    return chain;
  }

  /** @param {string} id @returns {object|null} */
  function getCharacter(id) { return getCharacters().find(c => c.id === id) || null; }
  /** @param {string} id @returns {object|null} */
  function getLocation(id)  { return getLocations().find(l => l.id === id) || null; }
  /** @param {string} id @returns {object|null} */
  function getEvent(id)     { return getEvents().find(e => e.id === id) || null; }
  /** @param {string} id @returns {object|null} */
  function getMystery(id)   { return getMysteries().find(m => m.id === id) || null; }

  /** A mystery question is "answered" iff its `answer` is a non-empty
   *  string. Defensive against legacy string-shaped entries (treated
   *  as unanswered). */
  function isQuestionAnswered(q) {
    if (!q) return false;
    if (typeof q === 'string') return false;
    return typeof q.answer === 'string' && q.answer.trim().length > 0;
  }
  /** Extract the question/unknown text regardless of entry shape. The
   *  migration normalises everything to `{text, answer}` objects, but
   *  this helper stays defensive so search-blob construction and the
   *  dashboard preview survive pre-migration data. */
  function questionText(q) {
    if (q && typeof q === 'object') return q.text || '';
    return String(q || '');
  }
  function questionAnswer(q) {
    if (q && typeof q === 'object') return q.answer || '';
    return '';
  }
  /** A mystery is "solved" iff (1) the legacy `solved:true` flag is set,
   *  OR (2) it has at least one question and every question is answered.
   *  No questions = not auto-solved (an empty mystery is "still open"). */
  function isMysterySolved(m) {
    if (!m) return false;
    if (m.solved === true) return true;
    const qs = Array.isArray(m.questions) ? m.questions : [];
    if (qs.length === 0) return false;
    return qs.every(isQuestionAnswered);
  }
  /** Flat list of every open question across the whole campaign:
   *  mysteries' `questions[]` AND characters' `unknown[]`. Each entry:
   *  `{ source: 'mystery'|'character', sourceEntity, index, text }`.
   *  Callers use `source` to build the right link target + icon.
   *  `mystery` kept as an alias of `sourceEntity` for back-compat
   *  with the existing /zahady aggregate template — drop once the
   *  template uses `sourceEntity` directly. Filters out empty-text
   *  entries from either side. */
  function getOpenQuestions() {
    const out = [];
    for (const m of getMysteries() || []) {
      const qs = Array.isArray(m.questions) ? m.questions : [];
      qs.forEach((q, i) => {
        if (isQuestionAnswered(q)) return;
        const text = (q && typeof q === 'object') ? (q.text || '') : String(q || '');
        if (!text.trim()) return;
        out.push({
          source: 'mystery',
          sourceEntity: m,
          mystery: m,   // back-compat alias; remove when callers migrate
          index: i,
          text,
        });
      });
    }
    for (const c of getCharacters() || []) {
      const us = Array.isArray(c.unknown) ? c.unknown : [];
      us.forEach((u, i) => {
        if (isQuestionAnswered(u)) return;
        const text = (u && typeof u === 'object') ? (u.text || '') : String(u || '');
        if (!text.trim()) return;
        out.push({
          source: 'character',
          sourceEntity: c,
          index: i,
          text,
        });
      });
    }
    return out;
  }

  // Stamp the entity with a last-modified timestamp. Used by the
  // dashboard activity feed and any "Naposledy upraveno" label.
  function _stamp(entity) {
    if (entity && typeof entity === 'object') entity.updatedAt = Date.now();
    return entity;
  }

  // ── lastChange: "what changed" summaries ──────────────────────
  // Every primary saveX records a compact summary of the edit on the
  // entity itself (`entity.lastChange`) — the dashboard "Poslední
  // změny" feed renders it as a one-line preview. Values are stored
  // RAW (enum ids, location ids); labels are resolved at render time
  // so previews survive renames and language switches.
  const _CHANGE_SKIP_KEYS = new Set([
    'id', 'updatedAt', 'lastChange', 'order', 'visibility', 'linkedTwinId',
    'addonData', 'secrets',
  ]);
  const _CHANGE_MAX_FIELDS    = 6;   // the preview is one line anyway
  const _CHANGE_VALUE_MAX_LEN = 40;  // longer values → field name only

  /** Compute the `lastChange` payload between two versions of an
   *  entity. Pure (exported for tests). Returns `{created: true}` for
   *  a first save, `{fields: [{key, from?, to?}]}` for an edit —
   *  `from`/`to` captured only when both sides are short scalars
   *  (enum ids, names, numbers); long text and array/object fields
   *  are name-only — or `null` when nothing observable changed (the
   *  caller keeps the previous summary: a no-op re-save must not wipe
   *  a meaningful one). */
  function computeChangeSummary(before, after) {
    if (!after || typeof after !== 'object') return null;
    if (!before || typeof before !== 'object') return { created: true };
    const isScalar = v =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const fields = [];
    for (const key of keys) {
      if (_CHANGE_SKIP_KEYS.has(key)) continue;
      const a = before[key] ?? '';
      const b = after[key]  ?? '';
      const scalars = isScalar(a) && isScalar(b);
      const equal = scalars ? a === b : JSON.stringify(a) === JSON.stringify(b);
      if (equal) continue;
      if (scalars
          && String(a).length <= _CHANGE_VALUE_MAX_LEN
          && String(b).length <= _CHANGE_VALUE_MAX_LEN) {
        fields.push({ key, from: a, to: b });
      } else {
        fields.push({ key });
      }
      if (fields.length >= _CHANGE_MAX_FIELDS) break;
    }
    return fields.length ? { fields } : null;
  }

  /** Record the change summary on `after` before it replaces `before`
   *  in `_data`. Empty diff → keep the previous summary. */
  function _noteChange(after, before) {
    const summary = computeChangeSummary(before, after);
    if (summary) after.lastChange = summary;
    else if (before && before.lastChange) after.lastChange = before.lastChange;
    return after;
  }

  /** Cascade writes (peer syncs, dead-ref cleanup) mutate entities in
   *  place, so there's no `before` left to diff — mark them with the
   *  coarse "links updated" summary instead. */
  function _noteRefChange(entity) {
    if (entity && typeof entity === 'object') entity.lastChange = { refs: true };
    return entity;
  }

  // Mark a default-id as deleted so `_mergeDefaults` doesn't re-seed
  // it on next load. Tombstones round-trip through the keyed-object
  // PATCH path so the server keeps an authoritative `deletedDefaults`
  // file across restarts.
  function _tombstone(key) {
    init();
    if (!_data.deletedDefaults || typeof _data.deletedDefaults !== 'object'
        || Array.isArray(_data.deletedDefaults)) {
      _data.deletedDefaults = {};
    }
    if (_data.deletedDefaults[key]) return;
    _data.deletedDefaults[key] = true;
    _sync('deletedDefaults', 'save', { id: key, data: true });
  }

  // ── Trash: session-only undo for deletes ──────────────────────
  // Every delete*() helper stores a snapshot keyed by `${kind}:${id}`.
  // `Store.undelete(kind, id)` re-applies the snapshot. Trash lives
  // only for the current browser session (deliberately not persisted)
  // — a reload commits all deletions.
  const _trash = new Map();

  function _trashKey(kind, id) { return `${kind}:${id}`; }

  /** Restore a previously-deleted entity + its dependents from trash.
   *  Returns true if something was restored, false if the trash entry
   *  wasn't found (expired, already restored, or never created). */
  function undelete(kind, id) {
    const key = _trashKey(kind, id);
    const snap = _trash.get(key);
    if (!snap) return false;
    _trash.delete(key);
    // Apply entity restore through the public saveX API so every
    // entity gets reindexed and synced cleanly. `_stamp` refreshes
    // updatedAt so the restored item appears at the top of activity.
    switch (snap.kind) {
      case 'characters':    saveCharacter(snap.entity);      break;
      case 'locations':     saveLocation(snap.entity);       break;
      case 'events':        saveEvent(snap.entity);          break;
      case 'mysteries':     saveMystery(snap.entity);        break;
      case 'factions':      saveFaction(snap.id, snap.entity); break;
      case 'pantheon':      saveBuh(snap.entity);            break;
      case 'artifacts':         saveArtifact(snap.entity);         break;
      case 'historicalEvents':  saveHistoricalEvent(snap.entity);  break;
      case 'relationships':     saveRelationship(snap.entity);     break;
      case 'pets':              savePet(snap.entity);              break;
      default:
        console.warn('[Store.undelete] unknown kind:', snap.kind);
        return false;
    }
    // Character delete cascade-stripped relationships — restore those.
    for (const r of snap.relationships || []) saveRelationship(r);
    return true;
  }

  /** Upsert `item` into a list by id: replace the existing record with
   *  the same id, or push when new. The single source of truth for the
   *  ~10 hand-rolled findIndex/replace-or-push blocks in the saveX
   *  functions below. Returns `arr` for chaining. */
  function _upsertById(arr, item) {
    const idx = arr.findIndex(x => x && x.id === item.id);
    if (idx >= 0) arr[idx] = item; else arr.push(item);
    return arr;
  }

  /**
   * Upsert a character by id. Stamps `updatedAt`, rebuilds the
   * character indices, and queues a PATCH to the server.
   *
   * @param {object} char - Full character record (id required).
   * @returns {boolean} `true` if a server sync was queued; `false`
   *                    when offline (local mutation still applied).
   */
  function saveCharacter(char) {
    init();
    _noteChange(char, _data.characters.find(c => c.id === char.id) || null);
    _stamp(char);
    _upsertById(_data.characters, char);
    _reindexCharacters();
    return _sync('characters', 'save', char);
  }

  /**
   * Delete a character. Snapshots the record + its incident
   * relationships into the session-only trash (recoverable via
   * `undelete`), strips the id from every event/mystery `characters[]`,
   * removes its relationships, deletes its portrait file if any, and
   * tombstones the id when it was a default seed.
   *
   * @param {string} id
   * @returns {boolean} See `saveCharacter`.
   */
  function deleteCharacter(id) {
    init();
    const char = _data.characters.find(c => c.id === id);
    // Snapshot character + its direct relationships for undo.
    if (char) {
      _trash.set(_trashKey('characters', id), {
        kind: 'characters',
        entity: JSON.parse(JSON.stringify(char)),
        relationships: _data.relationships
          .filter(r => r.source === id || r.target === id)
          .map(r => JSON.parse(JSON.stringify(r))),
      });
    }
    if (char?.portrait) deletePortrait(char.portrait);
    if (CHARACTERS.some(c => c.id === id)) _tombstone(id);
    _data.characters    = _data.characters.filter(c => c.id !== id);
    _data.relationships = _data.relationships.filter(r => r.source !== id && r.target !== id);

    // Strip the dead id from every event/mystery that actually listed
    // it — and persist ONLY those (mirrors deleteLocation's touched-peer
    // pattern). The previous `.map(...)` rebuilt the whole array in
    // memory but only synced the character delete, so the server never
    // learned the character was removed from those events/mysteries —
    // the next page load re-introduced the dangling reference.
    const touchedEvents = [];
    for (const e of _data.events || []) {
      if (Array.isArray(e.characters) && e.characters.includes(id)) {
        e.characters = e.characters.filter(cid => cid !== id);
        _noteRefChange(e); _stamp(e); touchedEvents.push(e);
      }
    }
    const touchedMysteries = [];
    for (const m of _data.mysteries || []) {
      if (Array.isArray(m.characters) && m.characters.includes(id)) {
        m.characters = m.characters.filter(cid => cid !== id);
        _noteRefChange(m); _stamp(m); touchedMysteries.push(m);
      }
    }

    _reindexCharacters();
    _reindexRelationships();
    if (touchedEvents.length)    _reindexEvents();
    if (touchedMysteries.length) _reindexMysteries();
    _orphanPetsOf('character', id);   // pets keep, just go unassigned
    const ok = _sync('characters', 'delete', { id });
    for (const e of touchedEvents)    _sync('events', 'save', e);
    for (const m of touchedMysteries) _sync('mysteries', 'save', m);
    return ok;
  }

  function saveRelationship(rel) {
    init();
    _stamp(rel);
    const key = r => `${r.source}||${r.target}||${r.type}`;
    const k   = key(rel);
    const idx = _data.relationships.findIndex(r => key(r) === k);
    if (idx >= 0) _data.relationships[idx] = rel; else _data.relationships.push(rel);
    _reindexRelationships();
    return _sync('relationships', 'save', rel);
  }

  function deleteRelationship(source, target, type) {
    init();
    const rel = _data.relationships.find(
      r => r.source === source && r.target === target && r.type === type
    );
    if (rel) {
      _trash.set(_trashKey('relationships', `${source}|${target}|${type}`), {
        kind: 'relationships',
        entity: JSON.parse(JSON.stringify(rel)),
      });
    }
    _data.relationships = _data.relationships.filter(
      r => !(r.source === source && r.target === target && r.type === type)
    );
    _reindexRelationships();
    return _sync('relationships', 'delete', { source, target, type });
  }

  /**
   * Upsert a location by id. Maintains undirected `connections[]`
   * symmetry: every add/remove diff is mirrored onto the peer
   * location, and every touched peer gets its own PATCH so the server
   * persists both ends of the change.
   *
   * @param {object} loc - Full location record (id required).
   * @returns {boolean} See `saveCharacter`.
   */
  function saveLocation(loc) {
    init();
    const idx    = _data.locations.findIndex(l => l.id === loc.id);
    const before = idx >= 0 ? _data.locations[idx] : null;
    _noteChange(loc, before);
    _stamp(loc);
    if (idx >= 0) _data.locations[idx] = loc; else _data.locations.push(loc);

    // Connection symmetry. `connections[]` is undirected — if A lists B,
    // B must list A. Diff old vs new and mirror every add/remove onto
    // the peer; each touched peer is then synced individually.
    const oldSet   = new Set((before?.connections) || []);
    const newSet   = new Set(loc.connections      || []);
    const added    = [...newSet].filter(x => !oldSet.has(x));
    const removed  = [...oldSet].filter(x => !newSet.has(x));
    const touched  = new Set();
    for (const peerId of added) {
      if (peerId === loc.id) continue;
      const peer = _data.locations.find(l => l.id === peerId);
      if (!peer) continue;
      if (!Array.isArray(peer.connections)) peer.connections = [];
      if (!peer.connections.includes(loc.id)) {
        peer.connections.push(loc.id);
        _noteRefChange(peer); _stamp(peer);
        touched.add(peer.id);
      }
    }
    for (const peerId of removed) {
      const peer = _data.locations.find(l => l.id === peerId);
      if (!peer || !Array.isArray(peer.connections)) continue;
      const next = peer.connections.filter(x => x !== loc.id);
      if (next.length !== peer.connections.length) {
        peer.connections = next;
        _noteRefChange(peer); _stamp(peer);
        touched.add(peer.id);
      }
    }

    _reindexLocations();
    const ok = _sync('locations', 'save', loc);
    for (const pid of touched) {
      const peer = _data.locations.find(l => l.id === pid);
      if (peer) _sync('locations', 'save', peer);
    }
    return ok;
  }

  /**
   * Delete a location. Cascade: snapshots into trash, strips the dead
   * id from every peer's `connections[]`, clears `parentId` on any
   * child that pointed at it, and syncs each touched peer individually.
   *
   * @param {string} id
   * @returns {boolean} See `saveCharacter`.
   */
  function deleteLocation(id) {
    init();
    const loc = _data.locations.find(l => l.id === id);
    if (loc) _trash.set(_trashKey('locations', id), { kind:'locations', entity: JSON.parse(JSON.stringify(loc)) });
    _data.locations = _data.locations.filter(l => l.id !== id);

    // Strip the dead id from every peer's connections[]; clear parentId
    // on any child that pointed at it; every touched peer is then
    // synced individually so the server persists both sides.
    const touched = [];
    for (const l of _data.locations) {
      let changed = false;
      if (Array.isArray(l.connections) && l.connections.includes(id)) {
        l.connections = l.connections.filter(x => x !== id);
        changed = true;
      }
      if (l.parentId === id) {
        l.parentId = '';
        changed = true;
      }
      if (changed) { _noteRefChange(l); _stamp(l); touched.push(l); }
    }

    // Characters reference locations by id: `location` is the canonical
    // "where they are", plus secondary `locationRoles[]`. Clear those dead
    // refs too — otherwise the deleted location lingers as a phantom on the
    // character (a broken location chip / orphaned role). Each touched
    // character is persisted individually, mirroring the peer-location sync.
    const touchedChars = [];
    for (const c of _data.characters || []) {
      let cChanged = false;
      if (c.location === id) { c.location = ''; cChanged = true; }
      if (Array.isArray(c.locationRoles) && c.locationRoles.some(r => r?.locationId === id)) {
        c.locationRoles = c.locationRoles.filter(r => r?.locationId !== id);
        cChanged = true;
      }
      if (cChanged) { _noteRefChange(c); _stamp(c); touchedChars.push(c); }
    }

    _reindexLocations();
    if (touchedChars.length) _reindexCharacters();
    const ok = _sync('locations', 'delete', { id });
    for (const peer of touched) _sync('locations', 'save', peer);
    for (const c of touchedChars) _sync('characters', 'save', c);
    return ok;
  }

  function saveEvent(evt) {
    init();
    _noteChange(evt, _data.events.find(e => e.id === evt.id) || null);
    _stamp(evt);
    _upsertById(_data.events, evt);
    _reindexEvents();
    return _sync('events', 'save', evt);
  }

  function deleteEvent(id) {
    init();
    const evt = _data.events.find(e => e.id === id);
    if (evt) _trash.set(_trashKey('events', id), { kind:'events', entity: JSON.parse(JSON.stringify(evt)) });
    _data.events = _data.events.filter(e => e.id !== id);
    _reindexEvents();
    return _sync('events', 'delete', { id });
  }

  function saveMystery(mys) {
    init();
    _noteChange(mys, _data.mysteries.find(m => m.id === mys.id) || null);
    _stamp(mys);
    _upsertById(_data.mysteries, mys);
    _reindexMysteries();
    return _sync('mysteries', 'save', mys);
  }

  function deleteMystery(id) {
    init();
    const m = _data.mysteries.find(x => x.id === id);
    if (m) _trash.set(_trashKey('mysteries', id), { kind:'mysteries', entity: JSON.parse(JSON.stringify(m)) });
    _data.mysteries = _data.mysteries.filter(m => m.id !== id);
    _reindexMysteries();
    return _sync('mysteries', 'delete', { id });
  }

  function saveBuh(g) {
    init();
    if (!Array.isArray(_data.pantheon)) _data.pantheon = [];
    _noteChange(g, _data.pantheon.find(x => x.id === g.id) || null);
    _stamp(g);
    _upsertById(_data.pantheon, g);
    // No reindex helper for this collection, but wiki-link resolution
    // walks it — bust the markdown cache so renames resolve fresh.
    _bustMarkdownCache();
    return _sync('pantheon', 'save', g);
  }
  function deleteBuh(id) {
    init();
    const g = (_data.pantheon || []).find(x => x.id === id);
    if (g) _trash.set(_trashKey('pantheon', id), { kind:'pantheon', entity: JSON.parse(JSON.stringify(g)) });
    _data.pantheon = (_data.pantheon || []).filter(g => g.id !== id);
    _bustMarkdownCache();
    return _sync('pantheon', 'delete', { id });
  }

  function saveArtifact(a) {
    init();
    if (!Array.isArray(_data.artifacts)) _data.artifacts = [];
    _noteChange(a, _data.artifacts.find(x => x.id === a.id) || null);
    _stamp(a);
    _upsertById(_data.artifacts, a);
    _bustMarkdownCache();
    return _sync('artifacts', 'save', a);
  }
  function deleteArtifact(id) {
    init();
    const a = (_data.artifacts || []).find(x => x.id === id);
    if (a) _trash.set(_trashKey('artifacts', id), { kind:'artifacts', entity: JSON.parse(JSON.stringify(a)) });
    _data.artifacts = (_data.artifacts || []).filter(a => a.id !== id);
    _bustMarkdownCache();
    return _sync('artifacts', 'delete', { id });
  }

  // ── Player party (Naše parta) ─────────────────────────────────
  // Special settings entry holding the party's visual identity
  // (name / icon / colors). Members are identified by
  // `character.faction === PARTY_FACTION_ID` — no duplicate roster
  // on this object.
  const PLAYER_PARTY_DEFAULTS = {
    name:      'Our Party',
    icon:      '🛡',
    badge:     '🛡',
    color:     '#F5F0E4',
    textColor: '#1a1410',
  };

  /**
   * @returns {{name:string, icon:string, badge:string, color:string,
   *            textColor:string}} Player-party visual identity, with
   *   defaults substituted for missing fields so renderers never have
   *   to null-check.
   */
  function getPlayerParty() {
    init();
    const pp = (_data.settings && _data.settings.playerParty) || {};
    return {
      name:      pp.name      || PLAYER_PARTY_DEFAULTS.name,
      icon:      pp.icon      || PLAYER_PARTY_DEFAULTS.icon,
      badge:     pp.badge     || pp.icon || PLAYER_PARTY_DEFAULTS.badge,
      color:     pp.color     || PLAYER_PARTY_DEFAULTS.color,
      textColor: pp.textColor || PLAYER_PARTY_DEFAULTS.textColor,
    };
  }

  /**
   * Merge `patch` into the player-party record and persist. The
   * record lives under `_data.settings.playerParty` and rides through
   * the same settings PATCH path as other settings categories — the
   * server's keyed-object branch overwrites `settings.playerParty`
   * with the new value.
   */
  function setPlayerParty(patch) {
    init();
    if (!_data.settings) _data.settings = {};
    const cur = _data.settings.playerParty || {};
    const next = { ...cur, ...(patch || {}) };
    _data.settings.playerParty = next;
    return _sync('settings', 'save', { id: 'playerParty', data: next });
  }

  // ── Site branding (logo + sidebar wordmark) ───────────────────
  // Single-object setting under `settings.branding`. `logoUrl` is the
  // server path of an uploaded logo, or '' to use the bundled default.
  // Rides the same settings PATCH path as playerParty; DM-only writes
  // are enforced server-side (settings is in DM_ONLY_WRITE_TYPES).
  const BRANDING_DEFAULTS = {
    logoUrl:   '',
    title:     'TTRPG Codex',
    subtitle:  'Wiki & World Atlas',
    updatedAt: 0,
  };

  /**
   * @returns {{logoUrl:string, title:string, subtitle:string,
   *            updatedAt:number}} Branding config with defaults
   *   substituted. Empty `logoUrl` means "render the bundled default".
   *   `subtitle` may legitimately be '' (the user cleared it), so it's
   *   only defaulted when the field is missing entirely.
   */
  function getBranding() {
    init();
    const b = (_data.settings && _data.settings.branding) || {};
    return {
      logoUrl:   typeof b.logoUrl  === 'string' ? b.logoUrl  : BRANDING_DEFAULTS.logoUrl,
      title:     b.title || BRANDING_DEFAULTS.title,
      subtitle:  typeof b.subtitle === 'string' ? b.subtitle : BRANDING_DEFAULTS.subtitle,
      updatedAt: b.updatedAt || 0,
    };
  }

  /**
   * Merge `patch` into the branding record and persist. Stamps a fresh
   * `updatedAt` so consumers can cache-bust the logo `<img>` (the file
   * keeps the same path when an upload reuses the extension).
   *
   * @param {Partial<{logoUrl:string, title:string, subtitle:string}>} patch
   */
  function setBranding(patch) {
    init();
    if (!_data.settings) _data.settings = {};
    const cur = _data.settings.branding || {};
    const next = { ...cur, ...(patch || {}), updatedAt: Date.now() };
    _data.settings.branding = next;
    return _sync('settings', 'save', { id: 'branding', data: next });
  }

  /**
   * Upload a new logo image. Resolves to the server URL of the stored
   * file; the caller is expected to persist it via `setBranding`.
   *
   * @param {File} file
   * @returns {Promise<string>} the new `/branding/logo.<ext>` URL
   */
  function uploadLogo(file) {
    const fd = new FormData();
    fd.append('logo', file);
    return fetch('/api/logo', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(j => j.url);
  }

  /** Remove the custom logo on the server (revert to bundled default). */
  function deleteLogo() {
    return fetch('/api/logo', { method: 'DELETE', credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)));
  }

  // ── Campaign metadata (dashboard hero) ────────────────────────
  // Keyed-object collection with a single `main` record (matches the
  // factions PATCH shape on the wire: `{type, action, payload:{id,data}}`).
  // On disk it's just `{ "main": { name, tagline } }`.

  /**
   * @returns {{name: string, tagline: string}} Campaign metadata, with
   *   defaults substituted when a field is missing.
   */
  function getCampaign() {
    init();
    const c = (_data.campaign && _data.campaign.main) || {};
    return { name: c.name || 'Untitled Campaign', tagline: c.tagline || '' };
  }

  /**
   * Merge `patch` over the current campaign metadata and persist.
   *
   * @param {Partial<{name: string, tagline: string}>} patch
   * @returns {boolean} See `saveCharacter`.
   */
  function setCampaign(patch) {
    init();
    if (!_data.campaign || typeof _data.campaign !== 'object') _data.campaign = {};
    _data.campaign.main = { ...getCampaign(), ...(patch || {}) };
    return _sync('campaign', 'save', { id: 'main', data: _data.campaign.main });
  }

  // ── Appearance (visual theme) ─────────────────────────────────
  // settings.appearance = { theme: '<id from THEMES>' }. DM-only write
  // (settings ∈ DM_ONLY_WRITE_TYPES). Pushed onto <html data-theme> by
  // Settings.applyTheme on boot + every SSE refetch. Default 'classic'
  // (the bare :root token baseline — no override block needed).
  function getAppearance() {
    init();
    const a = (_data.settings && _data.settings.appearance) || {};
    return { theme: (typeof a.theme === 'string' && a.theme) ? a.theme : 'classic' };
  }
  function setAppearance(patch) {
    init();
    if (!_data.settings) _data.settings = {};
    const next = { ...getAppearance(), ...(patch || {}) };
    _data.settings.appearance = next;
    return _sync('settings', 'save', { id: 'appearance', data: next });
  }

  // ── Settings (user-editable enums) ────────────────────────────
  // Each category is an array of `{ id, label, ... }` items. See
  // SETTINGS_DEFAULTS in data.js for the shape and seed values.
  function getSettings() { init(); return _data.settings || {}; }
  function getEnum(cat)  { init(); return (_data.settings && _data.settings[cat]) || []; }

  /** Return the full record for (cat, id), or a synthetic orphan
   *  placeholder when the id isn't present — keeps consumers from
   *  having to null-check every lookup. */
  function getEnumValue(cat, id) {
    const items = getEnum(cat);
    const found = items.find(x => x.id === id);
    if (found) return found;
    return { id: id || '', label: id || '—', _orphan: true, color: '#555', icon: '?' };
  }

  // ── Data-driven "kinds" registry (base/DM settings + addon layer) ──
  // A "kind" is a DATA-only descriptor (id/label/color/style/…). Behavior
  // kinds that carry render fns (graph node/view descriptors) live in the
  // consumer/addon code registry, not here. `getKinds(domain)` merges the
  // settings-backed base/DM list with the addon layer (provided by addons.js
  // via `setAddonKindProvider`, wired in app.js — same late-binding seam as
  // `setWikiLinkResolver`, so store.js never imports addons.js). Addon kind
  // ids are namespaced (`<addonId>:<id>`) so they can never shadow a base/DM
  // kind — base wins on any id collision.
  const _KIND_DOMAIN_CATEGORY = {
    connections: 'relationshipTypes',
    statuses:    'characterStatuses',
    priorities:  'eventPriorities',
    attitudes:   'attitudes',
    genders:     'genders',
    pinTypes:    'pinTypes',
  };
  let _addonKindProvider = null;
  function setAddonKindProvider(fn) { _addonKindProvider = (typeof fn === 'function') ? fn : null; }
  function getKinds(domain) {
    init();
    const cat = _KIND_DOMAIN_CATEGORY[domain];
    const base = cat ? getEnum(cat) : [];
    let addon = [];
    if (_addonKindProvider) {
      try { const a = _addonKindProvider(domain); if (Array.isArray(a)) addon = a; } catch (_) { /* addon layer is best-effort */ }
    }
    if (!addon.length) return base.slice();
    const seen = new Set(base.map(x => x && x.id));
    return base.concat(addon.filter(x => x && x.id && !seen.has(x.id)));
  }
  /** Resolve one kind by id across base/DM + addon layers. Orphan-safe:
   *  returns a synthetic placeholder (domain-shaped for `connections`, so it
   *  carries the rel-type fields cloudmap needs) when the id is unknown. */
  function getKind(domain, id) {
    const found = getKinds(domain).find(x => x && x.id === id);
    if (found) return found;
    if (domain === 'connections') {
      return { id: id || '', label: id || '?', dirs: ['from', 'to'], color: '#555', style: 'dashed', target: 'character', _orphan: true };
    }
    return { id: id || '', label: id || '—', _orphan: true };
  }

  /** Resolve the attitudes that should drive an entity's glow.
   *  Returns `[{id, strength}]`. Rules:
   *    1. Party PCs (`faction === PARTY_FACTION_ID`) always render with
   *       the parchment `party` palette regardless of any other field.
   *    2. Otherwise the entity's own `attitudes[]` wins when non-empty.
   *    3. Characters with empty own-attitudes inherit their faction's
   *       `attitudes[]` (live fallback — no data duplication).
   *    4. Empty everywhere returns `[]` — caller renders nothing
   *       ("unknown" baseline).
   *
   *  `kind` is one of `'character'`, `'location'`, `'faction'`. */
  function getEffectiveAttitudes(entity, kind) {
    if (!entity) return [];
    if (kind === 'character' && isPartyMember(entity)) {
      // Strength is sourced from the `attitudes` enum (editable in
      // Settings → updates every glow at once), not hardcoded — falls
      // back to 1.0 when the enum has no `party` row (the default).
      const partyStrength = getEnumValue('attitudes', 'party')?.strength;
      return [{ id: 'party', strength: (typeof partyStrength === 'number') ? partyStrength : 1.0 }];
    }
    const own = Array.isArray(entity.attitudes) ? entity.attitudes : [];
    if (own.length) return own;
    if (kind === 'character' && entity.faction) {
      const f = _data?.factions?.[entity.faction];
      if (f && Array.isArray(f.attitudes) && f.attitudes.length) return f.attitudes;
    }
    return [];
  }

  /** Upsert an enum item by id. New ids slugified by the caller.
   *  Sends the whole category array over the wire — `settings` is a
   *  keyed object (one doc) on the server, not a per-entity list, so
   *  the PATCH handler's object-collection branch (`container[id] =
   *  data`) treats each category as a value to overwrite. */
  function saveEnumItem(cat, item) {
    init();
    if (!_data.settings) _data.settings = {};
    if (!Array.isArray(_data.settings[cat])) _data.settings[cat] = [];
    const arr = _data.settings[cat];
    const idx = arr.findIndex(x => x.id === item.id);
    const stamped = { ...item, updatedAt: Date.now() };
    if (idx >= 0) arr[idx] = stamped; else arr.push(stamped);
    return _sync('settings', 'save', { id: cat, data: _data.settings[cat] });
  }

  /** Find every entity referencing the given enum id. Shape:
   *    [{ collection, id, name, field }]
   *  where `collection` is the lowercase collection name (e.g.
   *  'characters'), `id` and `name` identify the referring entity,
   *  and `field` is the property that holds the enum reference.
   *
   *  Handles three storage shapes:
   *    - scalar (`character.status === 'alive'`)
   *    - array of strings (legacy `location.attitudes`)
   *    - array of `{id, strength}` objects (current `*.attitudes`)
   *  And both array-shaped collections AND keyed-object collections
   *  (factions). */
  function findEnumUsages(cat, id) {
    init();
    const bindings = SETTINGS_USAGE_MAP[cat] || [];
    const out = [];
    for (const b of bindings) {
      const coll = _data[b.collection];
      if (!coll) continue;
      const list = Array.isArray(coll) ? coll : Object.values(coll);
      for (const e of list) {
        if (!e) continue;
        const v = e[b.field];
        let matched = false;
        if (Array.isArray(v)) {
          matched = v.some(x =>
            (typeof x === 'string') ? x === id
            : (x && typeof x === 'object' && x.id === id));
        } else {
          matched = v === id;
        }
        if (matched) {
          out.push({
            collection: b.collection,
            field:      b.field,
            id:         e.id,
            name:       e.name || e.id,
          });
        }
      }
    }
    return out;
  }

  /** Delete an enum item.
   *    opts.replaceWith   — remap all usages to this id, then delete.
   *    opts.force         — delete even if there are usages (leaves
   *                         orphan references; resolveEnum handles them).
   *  Without either, the call is a no-op when usages > 0.
   *  Returns `{ ok, usages }`.
   *
   *  Walks both array collections AND keyed-object collections
   *  (factions). For arrays of `{id, strength}` objects, id is
   *  rewritten in place and dedupe collapses duplicates by id while
   *  keeping the first kept strength.                                  */
  function deleteEnumItem(cat, id, opts = {}) {
    init();
    const usages = findEnumUsages(cat, id);
    if (usages.length > 0 && !opts.force && !opts.replaceWith) {
      return { ok: false, usages };
    }

    // Records touched by the replace-with rewrite — re-synced after
    // the settings PATCH so the server sees both ends of the change.
    const touched = [];   // { collection, key, entity }
    if (opts.replaceWith) {
      const bindings = SETTINGS_USAGE_MAP[cat] || [];
      for (const b of bindings) {
        const coll = _data[b.collection];
        if (!coll) continue;
        const records = Array.isArray(coll)
          ? coll.map(e => ({ entity: e, key: e?.id }))
          : Object.entries(coll).map(([k, e]) => ({ entity: e, key: k }));
        for (const rec of records) {
          const e = rec.entity;
          if (!e) continue;
          const v = e[b.field];
          let changed = false;
          if (Array.isArray(v)) {
            const seen = new Set();
            const next = [];
            for (const x of v) {
              if (typeof x === 'string') {
                const newId = (x === id) ? opts.replaceWith : x;
                if (!seen.has(newId)) { seen.add(newId); next.push(newId); }
                if (newId !== x) changed = true;
              } else if (x && typeof x === 'object') {
                const newId = (x.id === id) ? opts.replaceWith : x.id;
                if (!seen.has(newId)) {
                  seen.add(newId);
                  next.push({ ...x, id: newId });
                }
                if (newId !== x.id) changed = true;
              }
            }
            if (changed) { e[b.field] = next; touched.push({ ...rec, b }); }
          } else if (v === id) {
            e[b.field] = opts.replaceWith;
            touched.push({ ...rec, b });
          }
        }
      }
    }
    // Remove the item and tombstone its default so it doesn't reseed.
    const arr = (_data.settings && _data.settings[cat]) || [];
    _data.settings[cat] = arr.filter(x => x.id !== id);
    const wasDefault = (SETTINGS_DEFAULTS[cat] || []).some(d => d.id === id);
    if (wasDefault) _tombstone(`settings:${cat}:${id}`);
    // Pin types own a folder of uploaded icon files — clean it up.
    // Fire-and-forget; the orphan folder is harmless if the call fails.
    if (cat === 'pinTypes') deleteIcons(id);
    // Sync: push the full post-delete category array plus persist
    // every touched record via the entity-level save path so each
    // gets its own PATCH (correct audit trail on the server).
    _sync('settings', 'save', { id: cat, data: _data.settings[cat] });
    for (const { entity, key, b } of touched) {
      if (b.collection === 'factions') {
        _sync('factions', 'save', { id: key, data: entity });
      } else {
        _sync(b.collection, 'save', entity);
      }
    }
    _reindex();
    return { ok: true, usages };
  }

  // ── Per-map config ───────────────────────────────────────────
  // Each map (world map + every location with `localMap`) carries
  // its own knobs that the renderer in map.js consults — currently
  // just `zoomScaleRatio` (0..1, controls how much markers grow/
  // shrink with zoom: 0 = constant pixel size, 1 = scales with the
  // map). Stored under `settings.mapConfigs[mapId]` so it
  // round-trips through the existing settings PATCH path; per-id
  // tombstones aren't needed because the server treats the whole
  // category as one blob. mapId is `world` for the main map and
  // `local-${locationId}` for sub-maps (matches `_currentMapId`
  // in map.js).
  function _defaultMapConfig() {
    return { zoomScaleRatio: 0 };
  }
  function getMapConfig(mapId) {
    init();
    const all = (_data.settings && _data.settings.mapConfigs) || {};
    return { ..._defaultMapConfig(), ...(all[mapId] || {}) };
  }
  function setMapConfig(mapId, patch) {
    init();
    if (!_data.settings) _data.settings = {};
    if (!_data.settings.mapConfigs || typeof _data.settings.mapConfigs !== 'object') {
      _data.settings.mapConfigs = {};
    }
    const next = { ...getMapConfig(mapId), ...(patch || {}) };
    _data.settings.mapConfigs[mapId] = next;
    _sync('settings', 'save', { id: 'mapConfigs', data: _data.settings.mapConfigs });
    return next;
  }

  // ── Sidebar visibility ───────────────────────────────────────
  // ── Sidebar layout (data-driven, DM-curated) ─────────────────
  // The whole left sidebar is rendered from `settings.sidebarLayout`
  // (see the Sidebar module). Shape:
  //   { sections: [{ id, label, icon, collapsible, defaultOpen,
  //                  role, pages: [route,…] }], hidden: [route,…] }
  // Stored as a keyed-object settings value (DM-only write). Pages
  // are referenced by route; label/icon/role come from SIDEBAR_PAGES.

  /** Reconciled sidebar layout: saved config (else the default),
   *  cleaned against the live page registry so it never goes stale —
   *  dead routes dropped, brand-new code routes appended to their home
   *  section (or `hidden`), every route placed exactly once. Read-only
   *  (no persist), so it's cheap to call on every render. */
  function getSidebarLayout() {
    init();
    const saved = _data.settings && _data.settings.sidebarLayout;
    const base = (saved && Array.isArray(saved.sections))
      ? JSON.parse(JSON.stringify(saved))
      : JSON.parse(JSON.stringify(SIDEBAR_LAYOUT_DEFAULT));
    if (!Array.isArray(base.sections)) base.sections = [];
    if (!Array.isArray(base.hidden))   base.hidden = [];
    // First run with no saved layout but a legacy hiddenSidebarPages
    // list → fold those routes into the new `hidden` bucket.
    if (!saved) {
      const legacy = (_data.settings && _data.settings.hiddenSidebarPages) || [];
      if (Array.isArray(legacy) && legacy.length) {
        const hide = new Set(legacy);
        for (const s of base.sections) s.pages = (s.pages || []).filter(r => !hide.has(r));
        base.hidden = [...new Set([...base.hidden, ...legacy])];
      }
    }
    // Reconcile against the registry: keep only known routes, once each.
    const registry = new Set(SIDEBAR_PAGES.map(p => p.route));
    const seen = new Set();
    const keep = (r) => { if (!registry.has(r) || seen.has(r)) return false; seen.add(r); return true; };
    for (const s of base.sections) s.pages = (Array.isArray(s.pages) ? s.pages : []).filter(keep);
    base.hidden = (Array.isArray(base.hidden) ? base.hidden : []).filter(keep);
    // Place any registry page not yet referenced → home section, else hidden.
    for (const p of SIDEBAR_PAGES) {
      if (seen.has(p.route)) continue;
      const home = base.sections.find(s => s.id === p.section);
      if (home) home.pages.push(p.route); else base.hidden.push(p.route);
      seen.add(p.route);
    }
    return base;
  }

  /** Persist a normalized sidebar layout. DM-only write (server gates
   *  `settings` via DM_ONLY_WRITE_TYPES). */
  function setSidebarLayout(layout) {
    init();
    if (!_data.settings) _data.settings = {};
    const clean = {
      sections: (Array.isArray(layout && layout.sections) ? layout.sections : []).map(s => ({
        id: s.id, label: s.label || '', icon: s.icon || '',
        collapsible: !!s.collapsible, defaultOpen: s.defaultOpen !== false,
        role: s.role === 'dm' ? 'dm' : '',
        pages: Array.isArray(s.pages) ? s.pages.slice() : [],
      })),
      hidden: Array.isArray(layout && layout.hidden) ? layout.hidden.slice() : [],
    };
    _data.settings.sidebarLayout = clean;
    return _sync('settings', 'save', { id: 'sidebarLayout', data: clean });
  }

  // Back-compat shims — visibility now == membership in the layout's
  // `hidden` bucket. Kept so any stray caller keeps working.
  function getHiddenSidebarPages() {
    return getSidebarLayout().hidden.slice();
  }
  function setHiddenSidebarPages(arr) {
    const layout = getSidebarLayout();
    const hide = new Set((arr || []).filter(Boolean));
    const wasHidden = new Set(layout.hidden);
    for (const s of layout.sections) s.pages = s.pages.filter(r => !hide.has(r));
    layout.hidden = [...hide].filter(r => SIDEBAR_PAGES.some(p => p.route === r));
    // Routes that were hidden but aren't in the new list → back to home section.
    for (const r of wasHidden) {
      if (hide.has(r)) continue;
      const page = SIDEBAR_PAGES.find(p => p.route === r);
      const home = layout.sections.find(s => s.id === (page && page.section)) || layout.sections[0];
      if (home && !home.pages.includes(r)) home.pages.push(r);
    }
    return setSidebarLayout(layout);
  }

  /** Re-seed a category from defaults (adds missing, leaves edits). */
  function resetEnumCategory(cat) {
    init();
    if (!_data.settings) _data.settings = {};
    if (!Array.isArray(_data.settings[cat])) _data.settings[cat] = [];
    const existing = new Set(_data.settings[cat].map(x => x.id));
    for (const item of SETTINGS_DEFAULTS[cat] || []) {
      if (!existing.has(item.id)) _data.settings[cat].push(JSON.parse(JSON.stringify(item)));
    }
    return _sync('settings', 'save', { id: cat, data: _data.settings[cat] });
  }

  function saveFaction(id, fac) {
    init();
    _noteChange(fac, _data.factions[id] || null);
    _stamp(fac);
    _data.factions[id] = fac;
    _bustMarkdownCache();
    return _sync('factions', 'save', { id, data: fac });
  }

  function deleteFaction(id) {
    init();
    const f = _data.factions[id];
    if (f) _trash.set(_trashKey('factions', id), { kind:'factions', id, entity: JSON.parse(JSON.stringify(f)) });
    delete _data.factions[id];
    _orphanPetsOf('faction', id);   // pets keep, just go unassigned
    _bustMarkdownCache();
    return _sync('factions', 'delete', { id });
  }

  // ── Historical events (Svět → Historie) ──────────────────────
  // Separate collection from campaign `events` so the timeline stays
  // campaign-only. Each record has `{id, name, start, end, summary,
  // body (markdown), tags[], characters[], locations[]}` plus the
  // usual `updatedAt`. `start`/`end` are free-text year strings so
  // the DM can use D&D calendar years, vague ranges, etc.
  function getHistoricalEvents()   { init(); return _data.historicalEvents || []; }
  function getHistoricalEvent(id)  {
    return getHistoricalEvents().find(h => h.id === id) || null;
  }
  function saveHistoricalEvent(h) {
    init();
    if (!Array.isArray(_data.historicalEvents)) _data.historicalEvents = [];
    _noteChange(h, _data.historicalEvents.find(x => x.id === h.id) || null);
    _stamp(h);
    _upsertById(_data.historicalEvents, h);
    _bustMarkdownCache();
    return _sync('historicalEvents', 'save', h);
  }
  function deleteHistoricalEvent(id) {
    init();
    const h = (_data.historicalEvents || []).find(x => x.id === id);
    if (h) _trash.set(_trashKey('historicalEvents', id), {
      kind:'historicalEvents', entity: JSON.parse(JSON.stringify(h))
    });
    _data.historicalEvents = (_data.historicalEvents || []).filter(x => x.id !== id);
    _bustMarkdownCache();
    return _sync('historicalEvents', 'delete', { id });
  }

  // ── Pets / companions (Mazlíčci) ─────────────────────────────
  // Lightweight records: {id, name, icon, portrait, species, note,
  // ownerType:'none'|'party'|'character'|'faction', ownerId, updatedAt}.
  // A plain public list collection (no visibility/twin wiring). Owner
  // is polymorphic — 'none' is an unassigned pet prepared in advance.
  function getPets() { init(); return _data.pets || []; }
  function getPet(id) { return getPets().find(p => p.id === id) || null; }

  /** Pets attached to a given owner. `ownerType:'none'` returns the
   *  unassigned pile (also catches legacy records missing ownerType).
   *  `'party'` ignores ownerId; 'character'/'faction' match on id. */
  function getPetsForOwner(ownerType, ownerId) {
    return getPets().filter(p => {
      const ot = p.ownerType || 'none';
      if (ot !== ownerType) return false;
      if (ot === 'none' || ot === 'party') return true;
      return p.ownerId === ownerId;
    });
  }

  /** All pets that belong to the party in the wide sense: owned by the
   *  party itself PLUS owned by any individual party member (PC). Feeds
   *  the dashboard flank columns. Party-owned first, then member pets
   *  in party-roster order — deterministic, and a pet has exactly one
   *  owner so the concat can't duplicate. */
  function getPartyPets() {
    const memberPets = getPartyMembers()
      .flatMap(pc => getPetsForOwner('character', pc.id));
    return [...getPetsForOwner('party'), ...memberPets];
  }

  /** Resolve a pet's owner to a display descriptor `{label, icon, href}`.
   *  `href` is null when there's nowhere to link (none / deleted owner). */
  function getPetOwner(pet) {
    const ot = (pet && pet.ownerType) || 'none';
    if (ot === 'party') {
      const pp = getPlayerParty();
      return { label: pp.name || 'Our Party', icon: pp.icon || pp.badge || '🛡', href: '#/parta' };
    }
    if (ot === 'character') {
      const c = getCharacter(pet.ownerId);
      if (c) return { label: c.name, icon: '👤', href: `#/postava/${c.id}` };
    }
    if (ot === 'faction') {
      const f = getFaction(pet.ownerId);
      if (f) return { label: f.name, icon: f.badge || '⬡', href: `#/frakce/${pet.ownerId}` };
    }
    return { label: 'Bez majitele', icon: '🏷', href: null };
  }

  function savePet(pet) {
    init();
    _stamp(pet);
    // Normalise: ownerless / party-owned pets carry no ownerId.
    if (!pet.ownerType) pet.ownerType = 'none';
    if (pet.ownerType === 'none' || pet.ownerType === 'party') pet.ownerId = '';
    _upsertById(_data.pets, pet);
    return _sync('pets', 'save', pet);
  }

  function deletePet(id) {
    init();
    const pet = (_data.pets || []).find(p => p.id === id);
    if (pet) {
      if (pet.portrait) deletePortrait(pet.portrait);
      _trash.set(_trashKey('pets', id), { kind: 'pets', entity: JSON.parse(JSON.stringify(pet)) });
    }
    _data.pets = (_data.pets || []).filter(p => p.id !== id);
    return _sync('pets', 'delete', { id });
  }

  /** Reassign every pet owned by `(ownerType, ownerId)` back to the
   *  unassigned pile — called when that owner is deleted so important
   *  pets survive rather than dangle. Persists each touched pet. */
  function _orphanPetsOf(ownerType, ownerId) {
    for (const pet of (_data.pets || [])) {
      if (pet.ownerType === ownerType && pet.ownerId === ownerId) {
        pet.ownerType = 'none';
        pet.ownerId = '';
        _stamp(pet);
        _sync('pets', 'save', pet);
      }
    }
  }

  // ── Indexed lookups ─────────────────────────────────────────
  function getCharactersByFaction(factionId) {
    init(); return _idxCharsByFaction.get(factionId) || [];
  }
  function getCharactersInLocation(locId) {
    init(); return _idxCharsByLocation.get(locId) || [];
  }
  function getRelationshipsFor(charId) {
    init(); return _idxRelsByChar.get(charId) || [];
  }
  function getEventsWithCharacter(charId) {
    init(); return _idxEventsByChar.get(charId) || [];
  }
  function getEventsAtLocation(locId) {
    init(); return _idxEventsByLocation.get(locId) || [];
  }
  function getMysteriesWithCharacter(charId) {
    init(); return _idxMysteriesByChar.get(charId) || [];
  }
  // Legacy alias — pin metadata now lives directly on the Location.
  // Returns a stripped-down view for any external caller; map.js's
  // own renderer reads the location record directly.
  function getPinForLocation(locId) {
    init();
    const l = _data.locations.find(x => x.id === locId);
    if (!l || typeof l.x !== 'number' || typeof l.y !== 'number') return null;
    return {
      id: l.id, name: l.name, x: l.x, y: l.y,
      type: l.pinType, attitudes: l.attitudes || [],
      size: l.size, locationId: l.id,
      notes: l.mapNotes || '',
    };
  }

  // ── Search ─────────────────────────────────────────────────
  // Diacritic-insensitive substring match over user-visible text fields.
  function _match(haystack, q) {
    if (!q) return true;
    return norm(haystack).includes(q);
  }
  function searchCharacters(query) {
    init();
    const q = norm(query);
    if (!q) return _data.characters.slice();
    return _data.characters.filter(c =>
      _match(c.name, q) || _match(c.title, q) || _match((c.tags || []).join(' '), q)
    );
  }
  function searchLocations(query) {
    init();
    const q = norm(query);
    if (!q) return _data.locations.slice();
    return _data.locations.filter(l =>
      _match(l.name, q) || _match(l.type, q) || _match((l.tags || []).join(' '), q)
    );
  }
  function searchEvents(query) {
    init();
    const q = norm(query);
    if (!q) return _data.events.slice();
    return _data.events.filter(e =>
      _match(e.name, q) || _match(e.short, q) || _match((e.tags || []).join(' '), q)
    );
  }
  function searchMysteries(query) {
    init();
    const q = norm(query);
    if (!q) return _data.mysteries.slice();
    return _data.mysteries.filter(m => {
      // questions are now {text, answer} objects — extract both so
      // the user can find a mystery by the text in either field.
      const qBlob = (m.questions || [])
        .map(qa => questionText(qa) + ' ' + questionAnswer(qa))
        .join(' ');
      return _match(m.name, q)
        || _match(qBlob, q)
        || _match((m.tags || []).join(' '), q);
    });
  }
  function searchPantheon(query) {
    init();
    const q = norm(query);
    if (!q) return (_data.pantheon || []).slice();
    return (_data.pantheon || []).filter(g =>
      _match(g.name, q) || _match(g.domain, q) || _match((g.tags || []).join(' '), q)
    );
  }
  function searchArtifacts(query) {
    init();
    const q = norm(query);
    if (!q) return (_data.artifacts || []).slice();
    return (_data.artifacts || []).filter(a =>
      _match(a.name, q) || _match(a.description, q) || _match((a.tags || []).join(' '), q)
    );
  }
  function searchHistoricalEvents(query) {
    init();
    const q = norm(query);
    if (!q) return (_data.historicalEvents || []).slice();
    return (_data.historicalEvents || []).filter(h =>
      _match(h.name, q) || _match(h.summary, q) || _match(h.body, q) ||
      _match((h.tags || []).join(' '), q)
    );
  }
  function searchAll(query) {
    // Dedupe twin pairs so search results don't double-count entities
    // that have a player + DM half (the DM side is kept; see
    // dedupeShadowTwins for the rule).
    return {
      characters:       dedupeShadowTwins('characters',       searchCharacters(query)),
      locations:        dedupeShadowTwins('locations',        searchLocations(query)),
      events:           dedupeShadowTwins('events',           searchEvents(query)),
      mysteries:        dedupeShadowTwins('mysteries',        searchMysteries(query)),
      pantheon:         dedupeShadowTwins('pantheon',         searchPantheon(query)),
      artifacts:        dedupeShadowTwins('artifacts',        searchArtifacts(query)),
      historicalEvents: dedupeShadowTwins('historicalEvents', searchHistoricalEvents(query)),
    };
  }

  /** Generate a unique id for a new entity. The id is a diacritic-stripped
   *  slug of the name PLUS a short random suffix, so renaming is safe
   *  (the id never changes) and two entities with the same name get
   *  distinct keys — no silent overwrites on save.
   *
   *  Shape: `frulam_mondath_a7b3c9`. Readable in URLs, unique in practice.
   *  Existing records already in `_data` keep whatever id they had. */
  /** Return the most-recently-edited entities across every collection.
   *  Each item is `{ kind, id, name, updatedAt, route }` — consumed by
   *  the dashboard "Poslední úpravy" feed and the global search.
   *  Items without `updatedAt` are treated as epoch 0 (oldest). */
  function getRecentActivity(limit = 5) {
    init();
    const entries = [];
    const collect = (kind, route, list, nameOf) => {
      for (const e of list || []) {
        entries.push({
          kind, id: e.id,
          name: nameOf(e),
          updatedAt: e.updatedAt || 0,
          lastChange: e.lastChange || null,
          route,
        });
      }
    };
    collect('postava',            '#/postava',            _data.characters,       e => e.name);
    collect('misto',              '#/misto',              _data.locations,        e => e.name);
    collect('udalost',            '#/udalost',            _data.events,           e => e.name);
    collect('zahada',             '#/zahada',             _data.mysteries,        e => e.name);
    collect('buh',                '#/buh',                _data.pantheon,         e => e.name);
    collect('artefakt',           '#/artefakt',           _data.artifacts,        e => e.name);
    collect('historicka-udalost', '#/historicka-udalost', _data.historicalEvents, e => e.name);
    // Factions are a keyed object rather than an array.
    for (const [id, f] of Object.entries(_data.factions || {})) {
      entries.push({
        kind: 'frakce', id, name: f.name, updatedAt: f.updatedAt || 0,
        lastChange: f.lastChange || null,
        route: '#/frakce',
      });
    }
    return entries
      .filter(e => e.updatedAt > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /**
   * Generate a unique entity id from a human name. The id is a
   * diacritic-stripped slug PLUS a 6-char base36 random suffix \u2014
   * `frulam_mondath_a7b3c9`. Renaming an entity never changes its id
   * (so wiki-links survive); two entities with the same name still
   * get distinct keys (so saves don't silently overwrite). Existing
   * records keep whatever id they were originally created with.
   *
   * @param {string} name
   * @returns {string}
   */
  function generateId(name) {
    const base = String(name || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);
    const suffix = Math.random().toString(36).slice(2, 8);
    return (base || 'e') + '_' + suffix;
  }

  // \u2500\u2500 Addon-owned collections \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Addons declare collections in their manifest; the server exposes each as
  // the colon-namespaced wire type `addon:<id>:<name>` (file on disk:
  // data/addon-data/<id>/<name>.json \u2014 isolated, removed with the addon).
  // These back the host facade's scoped CRUD (host.store.collection(...)),
  // gated client-side by the addon's `data:own` permission. They mirror the
  // core saveX/deleteX shape: stamp updatedAt, fire _sync, bust the markdown
  // cache (addon content can carry [[wiki-links]] too). `keyed` mirrors the
  // manifest's `collections[].keyed` \u2014 keyed-object vs entity-list storage.
  function _addonType(addonId, name) { return `addon:${addonId}:${name}`; }

  /** Ensure a collection container exists locally so reads never throw, even
   *  before the first server round-trip. Returns the container. */
  function ensureCollection(name, keyed) {
    init();
    // Defence in depth: never write a prototype-chain key onto `_data` (the
    // wire name is colon-namespaced so this can't happen in practice, but
    // ensureCollection is also exported for direct use).
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') return keyed ? {} : [];
    if (_data[name] == null) _data[name] = keyed ? {} : [];
    return _data[name];
  }

  /** Read an addon's own collection: the live array (entity-list) or keyed
   *  object. Callers must not mutate it directly \u2014 go through
   *  saveAddonItem / deleteAddonItem so changes sync to the server. */
  function getAddonCollection(addonId, name, keyed) {
    return ensureCollection(_addonType(addonId, name), keyed);
  }

  /** Upsert an item into an addon's collection. Generates an id from
   *  item.name (or the collection name) when missing, stamps updatedAt, and
   *  syncs. Returns the stored record. */
  function saveAddonItem(addonId, name, item, keyed) {
    const type = _addonType(addonId, name);
    const container = ensureCollection(type, keyed);
    const rec = { ...item };
    if (!rec.id) rec.id = generateId(rec.name || name);
    rec.updatedAt = Date.now();
    if (keyed) {
      // Defence in depth \u2014 the server rejects these keys too, but never let a
      // buggy addon pollute the local keyed-object prototype chain.
      if (/^(__proto__|constructor|prototype)$/.test(rec.id)) {
        console.warn('Store: refusing forbidden addon collection key', rec.id);
        return rec;
      }
      container[rec.id] = rec;
      _sync(type, 'save', { id: rec.id, data: rec });
    } else {
      const i = container.findIndex(x => x && x.id === rec.id);
      if (i >= 0) container[i] = rec; else container.push(rec);
      _sync(type, 'save', rec);
    }
    _bustMarkdownCache();
    return rec;
  }

  /** Delete an item from an addon's collection by id. */
  function deleteAddonItem(addonId, name, id, keyed) {
    const type = _addonType(addonId, name);
    const container = ensureCollection(type, keyed);
    if (keyed) {
      delete container[id];
    } else {
      const i = container.findIndex(x => x && x.id === id);
      if (i >= 0) container.splice(i, 1);
    }
    _sync(type, 'delete', { id });
    _bustMarkdownCache();
  }

  // ── Per-entity addonData (Phase 5) ────────────────────────────
  // Each addon may stash a namespaced blob on a core entity under
  // `entity.addonData[<addonId>]` — e.g. an active character sheet's HP/stats.
  // The blob rides INSIDE the entity's JSON, so it's snapshotted and
  // role-filtered with the entity (DM-secret sheet data belongs on the DM
  // twin, not here). `patchAddonData` is a read-modify-write of ONE namespace
  // on ONE entity; the host facade injects the calling addon's own id, so an
  // addon can only ever touch its own namespace (gated by
  // data:write:<collection>.addonData). Standard list-shaped entity
  // collections only (factions' keyed signature is excluded for now).
  const _ADDON_DATA_TARGETS = {
    characters:       { get: getCharacter,       save: saveCharacter },
    locations:        { get: getLocation,        save: saveLocation },
    events:           { get: getEvent,           save: saveEvent },
    mysteries:        { get: getMystery,         save: saveMystery },
    pantheon:         { get: getBuh,             save: saveBuh },
    artifacts:        { get: getArtifact,        save: saveArtifact },
    historicalEvents: { get: getHistoricalEvent, save: saveHistoricalEvent },
  };

  /** Read-modify-write one addon's namespace on a core entity. `patchFn`
   *  receives a shallow copy of the current namespace ({} if none) and returns
   *  the next namespace (or mutates + returns nothing). Returns the saved
   *  entity, or null if the collection / entity is unknown. */
  function patchAddonData(collection, itemId, addonId, patchFn) {
    init();
    const tgt = _ADDON_DATA_TARGETS[collection];
    if (!tgt) return null;
    const entity = tgt.get(itemId);
    if (!entity) return null;
    const cur   = (entity.addonData && entity.addonData[addonId]) || {};
    const draft = { ...cur };
    const out   = (typeof patchFn === 'function') ? patchFn(draft) : draft;
    const ns    = (out && typeof out === 'object') ? out : draft;
    const next  = { ...entity, addonData: { ...(entity.addonData || {}), [addonId]: ns } };
    tgt.save(next);
    return next;
  }

  /** DM-only: resolve an addon fragment-override conflict. `winner` = an
   *  addonId (that addon's op wins), `null` (force the built-in), or '' /
   *  undefined (clear → back to auto). POSTs /api/addons/resolve; the
   *  addons-changed SSE reconcile applies it across clients. */
  async function resolveAddonConflict(target, winner) {
    try {
      const res = await fetch('/api/addons/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ target, winner }),
      });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent('store:auth-failed'));
        return { ok: false, error: I18n.t('store.dmRequired') };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, resolutions: body.resolutions };
    } catch (e) {
      return { ok: false, error: e.message || I18n.t('store.networkError') };
    }
  }

  /** DM-only: on-demand addon update check (re-resolve each installed addon's
   *  ref → latest SHA, diff vs installed). Pure read. Returns
   *  `{ ok, updates: [{id, status, hasUpdate, repo, ...}] }`. */
  async function checkAddonUpdates() {
    try {
      const res = await fetch('/api/addons/check-updates', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent('store:auth-failed'));
        return { ok: false, error: I18n.t('store.dmRequired') };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, updates: Array.isArray(body.updates) ? body.updates : [] };
    } catch (e) {
      return { ok: false, error: e.message || I18n.t('store.networkError') };
    }
  }

  /** DM-only: content-addressed rollback of an addon to a kept prior version
   *  (flip activeHash). `hash` targets a specific version; omitted → the one
   *  before the active. The addons-changed SSE reconcile live-loads it. */
  async function rollbackAddon(id, hash) {
    try {
      const res = await fetch(`/api/addons/${encodeURIComponent(id)}/rollback`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hash ? { hash } : {}),
      });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent('store:auth-failed'));
        return { ok: false, error: I18n.t('store.dmRequired') };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, version: body.version };
    } catch (e) {
      return { ok: false, error: e.message || I18n.t('store.networkError') };
    }
  }

  /** DM-only: update every GitHub-installed addon to its latest commit in one
   *  call (local/dev-installed addons are skipped server-side). Returns
   *  `{ ok, updated:[], skipped:[], errors:[], serverChanged }`. */
  async function updateAllAddons() {
    try {
      const res = await fetch('/api/addons/update-all', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent('store:auth-failed'));
        return { ok: false, error: I18n.t('store.dmRequired') };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return {
        ok: true,
        updated: Array.isArray(body.updated) ? body.updated : [],
        skipped: Array.isArray(body.skipped) ? body.skipped : [],
        errors:  Array.isArray(body.errors)  ? body.errors  : [],
        serverChanged: !!body.serverChanged,
      };
    } catch (e) {
      return { ok: false, error: e.message || I18n.t('store.networkError') };
    }
  }

  /** DM-only: restart the server process — a supervisor (Docker
   *  `restart: unless-stopped`) brings it back up, reloading addon server code.
   *  Returns `{ ok }` or `{ ok:false, error }` (e.g. server not restartable). */
  async function restartServer() {
    try {
      const res = await fetch('/api/restart', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent('store:auth-failed'));
        return { ok: false, error: I18n.t('store.dmRequired') };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || I18n.t('store.networkError') };
    }
  }

  /** Whether the server can restart itself (Docker/supervisor) — reads
   *  /api/version `canRestart`. Gates the DM "restart server" button. */
  async function getCanRestart() {
    try {
      const res = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return false;
      const body = await res.json().catch(() => ({}));
      return !!body.canRestart;
    } catch (_) { return false; }
  }

  /**
   * Serialise the entire dataset to a JSON string, suitable for
   * `/api/restore` upload or out-of-band backup. Includes every
   * collection (campaign + addon-owned ones too — the restore endpoint
   * iterates its ALL_TYPES for whatever keys are present) plus the
   * `deletedDefaults` tombstone map.
   *
   * @returns {string}
   */
  function exportJSON() {
    init();
    const ts = I18n.formatDate(Date.now(), { dateStyle: 'medium', timeStyle: 'medium' });
    const out = {
      _version:         5,
      _exported:        ts,
      factions:         _data.factions,
      characters:       _data.characters,
      relationships:    _data.relationships,
      locations:        _data.locations,
      events:           _data.events,
      mysteries:        _data.mysteries,
      pantheon:         _data.pantheon         || [],
      artifacts:        _data.artifacts        || [],
      historicalEvents: _data.historicalEvents || [],
      pets:             _data.pets             || [],
      settings:         _data.settings         || {},
      campaign:         _data.campaign         || {},
      deletedDefaults:  _data.deletedDefaults  || {},
    };
    for (const [k, v] of Object.entries(_data)) {
      if (k.startsWith('addon:')) out[k] = v;
    }
    return JSON.stringify(out, null, 2);
  }

  return {
    load, init,
    uploadPortrait, deletePortrait, uploadLocalMap,
    uploadIcons, deleteIcon, deleteIcons,
    linkTwin, getTwin, getCollection, dedupeShadowTwins,
    getPlayerParty, setPlayerParty,
    getBranding, setBranding, uploadLogo, deleteLogo,
    getAppearance, setAppearance,
    getCharacters, isPartyMember, isVisibleTo, getPartyMembers, getNPCs,
    getRelationships, getLocations, getEvents, getMysteries,
    getFactions, getFaction, getStatusMap,
    getCharacter, getLocation, getEvent, getMystery,
    getPantheon, getArtifacts,
    getBuh, getArtifact,
    getHistoricalEvents, getHistoricalEvent,
    getLocationsOnMap, getSubLocations, getAncestorLocations,
    getCharactersByFaction, getCharactersInLocation, getRelationshipsFor,
    getEventsWithCharacter, getEventsAtLocation, getMysteriesWithCharacter,
    getPinForLocation,
    isQuestionAnswered, isMysterySolved, getOpenQuestions,
    questionText, questionAnswer,
    searchCharacters, searchLocations, searchEvents, searchMysteries,
    searchPantheon, searchArtifacts, searchHistoricalEvents,
    searchAll,
    getRecentActivity, computeChangeSummary,
    saveCharacter, deleteCharacter,
    saveRelationship, deleteRelationship,
    saveLocation, deleteLocation,
    saveEvent, deleteEvent,
    saveMystery, deleteMystery,
    saveFaction, deleteFaction,
    saveBuh, deleteBuh,
    saveArtifact, deleteArtifact,
    saveHistoricalEvent, deleteHistoricalEvent,
    getPets, getPet, getPetsForOwner, getPartyPets, getPetOwner, savePet, deletePet,
    undelete,
    getSettings, getEnum, getEnumValue, getEffectiveAttitudes,
    saveEnumItem, deleteEnumItem, findEnumUsages, resetEnumCategory,
    getKinds, getKind, setAddonKindProvider,
    getSidebarLayout, setSidebarLayout,
    getHiddenSidebarPages, setHiddenSidebarPages,
    getMapConfig, setMapConfig,
    getCampaign, setCampaign,
    ensureCollection, getAddonCollection, saveAddonItem, deleteAddonItem,
    patchAddonData, resolveAddonConflict, checkAddonUpdates, rollbackAddon,
    updateAllAddons, restartServer, getCanRestart,
    generateId, exportJSON,
  };
})();
