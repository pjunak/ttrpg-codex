// ═══════════════════════════════════════════════════════════════
//  DATA — default seeds for every collection.
//  Merged into the live dataset on first load via `_mergeDefaults`.
//  Per-id deletions are remembered in `deletedDefaults` so a removed
//  default doesn't resurrect on restart.
// ═══════════════════════════════════════════════════════════════

/** Empty default for the `factions` keyed-object collection. */
export const FACTIONS = {};

/** Entity collections — empty by default; users populate them at runtime. */
export const CHARACTERS        = [];
export const LOCATIONS         = [];
export const EVENTS            = [];
export const RELATIONSHIPS     = [];
export const MYSTERIES         = [];
export const HISTORICAL_EVENTS = [];

/** Pets / companions (Mazlíčci). Lightweight records owned by a
 *  character, faction, the party, or nobody (unassigned). Empty by
 *  default — nothing appears in the UI until the user adds one. */
export const PETS              = [];

/** Empty default for the `pantheon` collection. */
export const PANTHEON  = [];

/** Empty default for the `artifacts` collection. */
export const ARTIFACTS = [];

/**
 * Built-in relationship types. Each entry is the contract every consumer
 * (cloudmap edges, relationship pickers, settings editor) reads against.
 *
 * Field reference:
 * - `id`     — stable key persisted on relationship records.
 * - `label`  — display chip / tooltip / legend text (English seed,
 *              user-editable in Settings → Vazby).
 * - `dirs`   — which directionality choices the editor offers
 *              (`'from'` = A→B, `'to'` = B→A, `'both'` = undirected).
 * - `color`  — Cytoscape `line-color` for the cloudmap edge.
 * - `style`  — edge stroke: `'solid' | 'dashed' | 'dotted'`.
 * - `target` — which entity kind the relationship targets (`'character'`
 *              today; `'location'` is wired in for `mission`).
 *
 * Mirrored into `settings.relationshipTypes` on first load so users can
 * extend the list at runtime; this constant remains the seed source.
 */
export const REL_TYPES = [
  { id:'commands',    label:'commands',       dirs:['from','to'],        color:'#C9A14B', style:'solid',  target:'character' },
  { id:'ally',        label:'ally',           dirs:['from','to','both'], color:'#2E7D32', style:'solid',  target:'character' },
  { id:'enemy',       label:'enemy',          dirs:['from','to','both'], color:'#8B0000', style:'solid',  target:'character' },
  { id:'mission',     label:'mission',        dirs:['from'],             color:'#E65100', style:'dashed', target:'location'  },
  { id:'mystery',     label:'mystery',        dirs:['from','to','both'], color:'#6A1B9A', style:'dotted', target:'character' },
  { id:'captured_by', label:'captured by',    dirs:['from','to'],        color:'#0D47A1', style:'solid',  target:'character' },
  { id:'history',     label:'history',        dirs:['from','to','both'], color:'#795548', style:'dashed', target:'character' },
  { id:'uncertain',   label:'uncertain bond', dirs:['from','to','both'], color:'#888',    style:'dotted', target:'character' },
  { id:'negotiates',  label:'negotiates',     dirs:['from','to','both'], color:'#F9A825', style:'dashed', target:'character' },
];

/** Lookup a relationship type by id. Returns a synthetic orphan entry
 *  (label = id, neutral grey) when the id isn't in REL_TYPES — keeps
 *  rendering alive when a type was deleted in settings. */
export function getRelType(id) {
  return REL_TYPES.find(t => t.id === id)
    || { id, label: id || '?', dirs:['from','to'], color:'#555', style:'dashed', target:'character', _orphan:true };
}

/** Convenience: id → label */
export function relLabel(id) { return getRelType(id).label; }

// ── Settings defaults ──────────────────────────────────────────
// The `settings` collection holds user-editable enums. Seeded from
// this shape on first load; additions/edits/deletions persist to
// `data/settings.json`. Categories coupled to code (knowledge levels
// tied to SVG sketch filters) stay hardcoded and are *not* in here.
export const SETTINGS_DEFAULTS = {
  relationshipTypes: REL_TYPES.map(t => ({ ...t })),

  // Gender options shown in the character editor. Users can extend this
  // list freely; `character.gender` stores the id.
  genders: [
    { id: 'male',   label: 'Male' },
    { id: 'female', label: 'Female' },
  ],

  // Place / pin types on the world map and local maps. `size` is the
  // default marker pixel size for this type, used as the pre-fill when
  // a new place of this type is created; per-place overrides live on
  // `location.size`. Tier sizing reflects map prominence, not zoom
  // visibility — visibility rules will be per-Pohled (see roadmap).
  pinTypes: [
    { id:'major_city',  icon:'🏙',  label:'Major city',   color:'#D4A017', size:38 },
    { id:'city',        icon:'🏛',  label:'City',          color:'#C0A060', size:32 },
    { id:'town',        icon:'🏘',  label:'Town',          color:'#A0B080', size:28 },
    { id:'village',     icon:'🏠',  label:'Village',       color:'#80A070', size:26 },
    { id:'fortress',    icon:'🏰',  label:'Fortress',      color:'#9090A0', size:36 },
    { id:'castle',      icon:'🏯',  label:'Castle',        color:'#9A9AA8', size:36 },
    { id:'tower',       icon:'🗼',  label:'Tower',         color:'#A8A098', size:26 },
    { id:'temple',      icon:'🛕',  label:'Temple',        color:'#C0A088', size:28 },
    { id:'shrine',      icon:'⛩',  label:'Shrine',        color:'#80A0B0', size:26 },
    { id:'tavern',      icon:'🍺',  label:'Tavern',        color:'#C89050', size:24 },
    { id:'market',      icon:'🏪',  label:'Market',        color:'#C8A050', size:24 },
    { id:'academy',     icon:'🎓',  label:'Academy',       color:'#A890C0', size:30 },
    { id:'port',        icon:'⚓',  label:'Port',          color:'#6090A0', size:30 },
    { id:'bridge',      icon:'🌉',  label:'Bridge',        color:'#909090', size:24 },
    { id:'camp',        icon:'⛺',  label:'Camp',          color:'#B88040', size:24 },
    { id:'dungeon',     icon:'⚠',   label:'Dungeon',       color:'#A06040', size:28 },
    { id:'cave',        icon:'🕳',  label:'Cave',          color:'#706050', size:24 },
    { id:'ruin',        icon:'🏚',  label:'Ruin',          color:'#888070', size:26 },
    { id:'graveyard',   icon:'🪦',  label:'Graveyard',     color:'#808080', size:24 },
    { id:'battlefield', icon:'⚔',   label:'Battlefield',   color:'#A04040', size:28 },
    { id:'landmark',    icon:'🗿',  label:'Landmark',      color:'#80A0B0', size:26 },
    { id:'forest',      icon:'🌲',  label:'Forest',        color:'#4A7A4A', size:26 },
    { id:'mountain',    icon:'⛰',   label:'Mountain',      color:'#8A7A6A', size:30 },
    { id:'lake',        icon:'🏞',  label:'Lake',          color:'#5A90B0', size:28 },
    { id:'curiosity',   icon:'✨',  label:'Curiosity',     color:'#C8A040', size:24 },
    { id:'region',      icon:'🗺',  label:'Region',        color:'#708090', size:32 },
    { id:'enemy',       icon:'💀',  label:'Hostile',       color:'#B04040', size:28 },
    { id:'custom',      icon:'📌',  label:'Custom',        color:'#8A5CC8', size:26 },
  ],

  // Character life-state. The `circumstances` free-text field on each
  // character covers richer states like "captured" or "missing" without
  // bloating this enum.
  characterStatuses: [
    { id: 'alive',   label: 'Alive',   color: '#2E7D32', icon: '●' },
    { id: 'dead',    label: 'Dead',    color: '#8B0000', icon: '✦' },
    { id: 'unknown', label: 'Unknown', color: '#6A1B9A', icon: '?' },
  ],

  // ⚠ The priority IDS stay as the original Czech words on purpose:
  // they're persisted on `event.priority` and hardcoded in code
  // (wiki.js `PRIORITY_ORDER`, cloudmap.js colour logic, new-entity
  // defaults). Only the display LABELS are English. Changing the ids
  // would require migrating existing event data + every reference.
  eventPriorities: [
    { id: 'kritická', label: 'Critical', color: '#8B0000' },
    { id: 'vysoká',   label: 'High',     color: '#E65100' },
    { id: 'střední',  label: 'Medium',   color: '#FFA000' },
    { id: 'nízká',    label: 'Low',      color: '#689F38' },
  ],

  // Unified "Postoje k partě" palette — shared by characters,
  // locations and factions. Each entity carries an `attitudes` array
  // of `{id}` references; the visual glow intensity (`strength`,
  // 0..1) lives on each enum item below, NOT on the entity, so
  // editing an attitude's strength in Settings updates every place
  // it's used at once. Renderers stack a colored `drop-shadow` per
  // entry on the entity's icon (portrait, pin emoji, faction palette);
  // multi-attitude map markers stripe the slabs vertically rather
  // than blending. Empty array = no stance set ("unknown" baseline,
  // no glow).
  //
  // **`party` is no longer in this enum** — party membership is its
  // own concept now, edited via Settings → Naše parta. The renderer
  // synthesizes a `party` entry from `settings.playerParty.color` on
  // the fly when a PC carries the implicit `{id:'party'}` from
  // Store.getEffectiveAttitudes.
  attitudes: [
    { id: 'ally',    label: 'Ally',    bg: '#2E7D32', fg: '#ffffff', labelColor: '#4CAF50', strength: 1.0 },
    { id: 'enemy',   label: 'Enemy',   bg: '#C62828', fg: '#ffffff', labelColor: '#EF5350', strength: 1.0 },
    { id: 'hostile', label: 'Hostile', bg: '#7E1F1F', fg: '#ffffff', labelColor: '#FF7043', strength: 0.7 },
    { id: 'neutral', label: 'Neutral', bg: '#1565C0', fg: '#ffffff', labelColor: '#64B5F6', strength: 0.7 },
  ],

  // User-defined map view presets. Each entry captures the bounds
  // of a Leaflet view as fractions (0-1) of the image so the preset
  // stays valid across resizes. Shape:
  //   { id, label, icon, parentId, bounds: {x1,y1,x2,y2} }
  // parentId=null → world map; location id → that location's local map.
  // Captured from the live map via the ✚ toolbar button (edit mode).
  mapViews: [],
};

/** Which collection+field each settings category is referenced from.
 *  `Store.findEnumUsages(cat, id)` walks these bindings. Defined here
 *  so the mapping is co-located with the defaults.
 *
 *  `attitudes` is bound on three collections — characters, locations
 *  and factions — and stored as an array of `{id, strength}` objects
 *  in every case. `findEnumUsages` / `deleteEnumItem` recognise that
 *  shape and look up by entry.id. `factions` is a keyed-object
 *  collection (Object.values), the others are arrays.                  */
export const SETTINGS_USAGE_MAP = {
  relationshipTypes: [{ collection: 'relationships', field: 'type' }],
  genders:           [{ collection: 'characters',    field: 'gender' }],
  pinTypes:          [{ collection: 'locations',     field: 'pinType' }],
  characterStatuses: [{ collection: 'characters',    field: 'status' }],
  eventPriorities:   [{ collection: 'events',        field: 'priority' }],
  attitudes:         [
    { collection: 'characters', field: 'attitudes' },
    { collection: 'locations',  field: 'attitudes' },
    { collection: 'factions',   field: 'attitudes' },
  ],
};
