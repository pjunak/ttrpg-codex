// ═══════════════════════════════════════════════════════════════
//  CONSTANTS — cross-module magic values pulled into one place.
//  Anything shared between 3+ modules or used as a foreign-key-
//  like identifier belongs here. Keep this file small and boring.
// ═══════════════════════════════════════════════════════════════

/** Faction id reserved for player party PCs. The /parta list filters
 *  by this value and /postavy excludes it. Combobox sources keep
 *  showing party PCs so relationships/events can still reference them. */
export const PARTY_FACTION_ID = 'party';

/** Centralised Czech pluralisation helper for count-based labels
 *  like "3 postavy" / "1 postava" / "5 postav". Returns the right
 *  form by the small-number / standard-plural rules of Czech. */
export function czPlural(n, one, few, many) {
  const i = Math.abs(n);
  if (i === 1) return one;
  if (i >= 2 && i <= 4) return few;
  return many;
}

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
 *  but the link doesn't appear in the sidebar. */
export const SIDEBAR_PAGES = [
  { route: '/',             label: 'Přehled',           icon: '🏠', section: 'prehled' },
  { route: '/mapa/svet',    label: 'Mapa',              icon: '🗺', section: 'prehled' },
  { route: '/casova-osa',   label: 'Časová Osa',        icon: '⏳', section: 'kampan' },
  { route: '/zahady',       label: 'Záhady',            icon: '❓', section: 'kampan' },
  { route: '/mapa/palac',   label: 'Myšlenkový Palác',  icon: '☁',  section: 'kampan' },
  { route: '/mista',        label: 'Místa',             icon: '📍', section: 'svet' },
  { route: '/postavy',      label: 'Postavy',           icon: '👤', section: 'svet' },
  { route: '/frakce',       label: 'Frakce',            icon: '⬡',  section: 'svet' },
  { route: '/mazlicci',     label: 'Mazlíčci',          icon: '🐾', section: 'svet' },
  { route: '/druhy',        label: 'Druhy',             icon: '🧬', section: 'kompendium' },
  { route: '/panteon',      label: 'Panteon',           icon: '✨', section: 'kompendium' },
  { route: '/artefakty',    label: 'Artefakty',         icon: '🗝', section: 'kompendium' },
  { route: '/historie',     label: 'Historie',          icon: '📜', section: 'kompendium' },
  { route: '/dm',           label: 'DM panel',          icon: '🛡', section: 'dm', role: 'dm' },
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
    { id: 'prehled',    label: 'Přehled',    icon: '', collapsible: false, defaultOpen: true,  role: '',   pages: ['/', '/mapa/svet'] },
    { id: 'kampan',     label: 'Kampaň',     icon: '', collapsible: false, defaultOpen: true,  role: '',   pages: ['/casova-osa', '/zahady', '/mapa/palac'] },
    { id: 'svet',       label: 'Svět',       icon: '', collapsible: false, defaultOpen: true,  role: '',   pages: ['/mista', '/postavy', '/frakce', '/mazlicci'] },
    { id: 'kompendium', label: 'Kompendium', icon: '', collapsible: true,  defaultOpen: false, role: '',   pages: ['/druhy', '/panteon', '/artefakty', '/historie'] },
    { id: 'dm',         label: 'DM',         icon: '', collapsible: false, defaultOpen: true,  role: 'dm', pages: ['/dm'] },
  ],
  hidden: [],
};
