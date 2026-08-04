// ═══════════════════════════════════════════════════════════════
//  CONSTANTS — cross-module magic values pulled into one place.
//  Anything shared between 3+ modules or used as a foreign-key-
//  like identifier belongs here. Keep this file small and boring.
// ═══════════════════════════════════════════════════════════════

/** Faction id reserved for player party PCs. The /parta list filters
 *  by this value and /postavy excludes it. Combobox sources keep
 *  showing party PCs so relationships/events can still reference them. */
export const PARTY_FACTION_ID = 'party';

// Pluralisation now lives in I18n.plural (native Intl.PluralRules) —
// see web/js/i18n.js. The hand-rolled Czech-only czPlural was removed.

/** Canonical **registry** of pages the left sidebar can show. The
 *  actual sidebar structure (section grouping + order) is data-driven
 *  via `settings.sidebarLayout` (see `SIDEBAR_LAYOUT_DEFAULT` below and
 *  the `Sidebar` module). This list defines each available route plus
 *  its display `label`/`icon`, and `section` = the **id of its home
 *  section** in the default layout (used to place the page when a new
 *  code route isn't yet in the DM's saved layout).
 *
 *  Optional `role: 'dm'` hides the entry for non-DM viewers — the route
 *  is still reachable by URL (defence-in-depth lives in the renderer),
 *  but the link doesn't appear in the sidebar.
 *
 *  `key` is the i18n catalog key for the link label (web/i18n/*.json).
 *  The Sidebar renders `I18n.t(key)`; `label` is the dev-facing default
 *  fallback only. (Section labels in `SIDEBAR_LAYOUT_DEFAULT` are
 *  DM-editable content and are NOT translated — see docs/reference/i18n.md.) */
export const SIDEBAR_PAGES = [
  { route: '/',             label: 'Overview',           key: 'nav.overview',   icon: '🏠', section: 'prehled' },
  { route: '/mapa/svet',    label: 'Map',               key: 'nav.map',        icon: '🗺', section: 'prehled' },
  { route: '/casova-osa',   label: 'Timeline',           key: 'nav.timeline',   icon: '⏳', section: 'kampan' },
  { route: '/zahady',       label: 'Mysteries',          key: 'nav.mysteries',  icon: '❓', section: 'kampan' },
  { route: '/mapa/palac',   label: 'Mind Palace',        key: 'nav.mindPalace', icon: '☁',  section: 'kampan' },
  { route: '/mista',        label: 'Places',             key: 'nav.locations',  icon: '📍', section: 'svet' },
  { route: '/postavy',      label: 'Characters',        key: 'nav.characters', icon: '👤', section: 'svet' },
  { route: '/frakce',       label: 'Factions',          key: 'nav.factions',   icon: '⬡',  section: 'svet' },
  { route: '/mazlicci',     label: 'Pets',               key: 'nav.pets',       icon: '🐾', section: 'svet' },
  { route: '/panteon',      label: 'Pantheon',          key: 'nav.pantheon',   icon: '✨', section: 'kompendium' },
  { route: '/artefakty',    label: 'Artifacts',         key: 'nav.artifacts',  icon: '🗝', section: 'kompendium' },
  { route: '/historie',     label: 'History',           key: 'nav.history',    icon: '📜', section: 'kompendium' },
  { route: '/dm',           label: 'DM panel',          key: 'nav.dmPanel',    icon: '🛡', section: 'dm', role: 'dm' },
];

/** Default sidebar layout — mirrors the historical hardcoded markup.
 *  Seeded when the DM hasn't customized `settings.sidebarLayout`.
 *  Section `id`s are stable (localStorage collapse keys + the home-
 *  section target in `SIDEBAR_PAGES.section`); `label`/`icon` are
 *  DM-editable. `collapsible` sections get the ▸ toggle (Kompendium);
 *  `role:'dm'` sections are hidden from non-DM viewers. Pages are
 *  referenced by route — their label/icon come from `SIDEBAR_PAGES`. */
export const SIDEBAR_LAYOUT_DEFAULT = {
  sections: [
    { id: 'prehled',    label: 'Overview',    icon: '', collapsible: false, defaultOpen: true,  role: '',   pages: ['/', '/mapa/svet'] },
    { id: 'kampan',     label: 'Campaign',    icon: '', collapsible: false, defaultOpen: true,  role: '',   pages: ['/casova-osa', '/zahady', '/mapa/palac'] },
    { id: 'svet',       label: 'World',       icon: '', collapsible: false, defaultOpen: true,  role: '',   pages: ['/mista', '/postavy', '/frakce', '/mazlicci'] },
    { id: 'kompendium', label: 'Compendium', icon: '', collapsible: true,  defaultOpen: false, role: '',   pages: ['/panteon', '/artefakty', '/historie'] },
    { id: 'dm',         label: 'DM',         icon: '', collapsible: false, defaultOpen: true,  role: 'dm', pages: ['/dm'] },
  ],
  hidden: [],
};

/** Registry of selectable visual themes (Settings → Appearance). Each theme
 *  is a `[data-theme="<id>"]` block in `web/css/themes.css` that overrides
 *  the `:root` design tokens; the default `classic` theme IS the `:root`
 *  baseline, so it needs no override block. Adding a new style = one entry
 *  here + one `[data-theme]` block in themes.css — nothing else. The
 *  Settings dropdown and `Settings.applyTheme()` consume this list. */
export const THEMES = [
  { id: 'classic', label: 'Classic — Dragon Colors', labelKey: 'settings.themeClassic' },
];
