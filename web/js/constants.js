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

/** Canonical list of pages shown in the left sidebar. Mirrors the
 *  static markup in index.html — keep in sync when adding/removing
 *  sidebar links. Used by Settings → Postranní panel to let the
 *  user hide individual pages, and by Settings.applySidebarVisibility
 *  to apply the user's choice at runtime.
 *
 *  Optional `role: 'dm'` field hides the entry for non-DM viewers —
 *  the route is still reachable by URL (defence-in-depth lives in
 *  the renderer itself), but the link doesn't appear in the
 *  sidebar. */
export const SIDEBAR_PAGES = [
  { route: '/',             label: 'Přehled',           icon: '🏠', section: 'Přehled' },
  { route: '/mapa/svet',    label: 'Mapa',              icon: '🗺', section: 'Přehled' },
  { route: '/casova-osa',   label: 'Časová Osa',        icon: '⏳', section: 'Kampaň' },
  { route: '/zahady',       label: 'Záhady',            icon: '❓', section: 'Kampaň' },
  { route: '/mapa/palac',   label: 'Myšlenkový Palác',  icon: '☁',  section: 'Kampaň' },
  { route: '/mista',        label: 'Místa',             icon: '📍', section: 'Svět' },
  { route: '/postavy',      label: 'Postavy',           icon: '👤', section: 'Svět' },
  { route: '/frakce',       label: 'Frakce',            icon: '⬡',  section: 'Svět' },
  { route: '/mazlicci',     label: 'Mazlíčci',          icon: '🐾', section: 'Svět' },
  { route: '/druhy',        label: 'Druhy',             icon: '🧬', section: 'Kompendium' },
  { route: '/panteon',      label: 'Panteon',           icon: '✨', section: 'Kompendium' },
  { route: '/artefakty',    label: 'Artefakty',         icon: '🗝', section: 'Kompendium' },
  { route: '/historie',     label: 'Historie',          icon: '📜', section: 'Kompendium' },
  { route: '/dm',           label: 'DM panel',          icon: '🛡', section: 'DM',         role: 'dm' },
];
