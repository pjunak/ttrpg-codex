'use strict';

// ═══════════════════════════════════════════════════════════════
//  VISIBILITY — server-side role-aware filtering of the dataset.
//
//  Players literally cannot see DM content via DevTools because the
//  filtering happens BEFORE the bytes ever leave the server. Under
//  the twin-entity model the visibility model is simpler than it
//  was in the MVP: only two surfaces remain.
//
//    1. Entity-level — `visibility: 'public' | 'dm'`. DM-only
//       entities are dropped from non-DM payloads entirely. DM
//       lore lives in a separate DM-only TWIN entity that is
//       linked to its public counterpart via `linkedTwinId`.
//    2. `linkedTwinId` is DM-only metadata. Stripped from non-DM
//       payloads so players can't infer "this entity has hidden
//       DM lore" from the field's presence.
//
//  Per-field `secrets` and `[secret]…[/secret]` inline markers
//  were removed in the twin-model pivot — DM granular annotations
//  now live in the linked DM twin instead of as flags on public
//  entities. Any residual `secrets` on legacy data is stripped by
//  the startup migration in `server/migrations.cjs`.
//
//  Pure functions. No `fs`, no globals, no module-level state.
//  See test/visibility.test.cjs.
// ═══════════════════════════════════════════════════════════════

// Collections that participate in the visibility model. Everything
// else (settings, deletedDefaults, campaign) is inherently shared
// and bypasses filterForRole.
const VISIBILITY_BEARING = new Set([
  'characters', 'relationships', 'locations', 'events',
  'mysteries', 'factions', 'pantheon', 'artifacts',
  'historicalEvents',
]);

// Keyed-object collections among the visibility-bearing set.
const KEYED_OBJ_VISIBILITY = new Set(['factions']);

// ── Per-entity strip ──────────────────────────────────────────────
// Returns a shallow clone so the caller can keep mutating the result
// safely. For DM viewers this is identity (DM sees everything). For
// non-DM viewers it deletes the DM-only `linkedTwinId` field so the
// presence of a DM twin isn't inferable from the payload shape.
function stripEntityForRole(entity, _collectionName, role) {
  if (!entity || typeof entity !== 'object') return entity;
  if (role === 'dm') return entity;
  const out = { ...entity };
  // Twin link is DM-only metadata. A player with the field present
  // could deduce "this entity has hidden DM content"; strip it.
  delete out.linkedTwinId;
  return out;
}

// ── Container-level filter ────────────────────────────────────────
// Drops DM-only entities, then runs each remaining entity through
// the per-entity strip. Handles both list-shape (array) and keyed-
// object collections. Non-visibility-bearing collections fall
// through unmodified.
function filterForRole(collectionName, container, role) {
  if (role === 'dm') return container;
  if (!VISIBILITY_BEARING.has(collectionName)) return container;
  if (Array.isArray(container)) {
    const out = [];
    for (const e of container) {
      if (!e || typeof e !== 'object') continue;
      if (e.visibility === 'dm') continue;
      out.push(stripEntityForRole(e, collectionName, role));
    }
    return out;
  }
  if (container && typeof container === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(container)) {
      if (!v || typeof v !== 'object') { out[k] = v; continue; }
      if (v.visibility === 'dm') continue;
      out[k] = stripEntityForRole(v, collectionName, role);
    }
    return out;
  }
  return container;
}

module.exports = {
  VISIBILITY_BEARING,
  KEYED_OBJ_VISIBILITY,
  filterForRole,
  stripEntityForRole,
};
