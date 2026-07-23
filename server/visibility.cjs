'use strict';

// ═══════════════════════════════════════════════════════════════
//  VISIBILITY — server-side role-aware filtering of the dataset.
//
//  Players literally cannot see DM content via DevTools because the
//  filtering happens BEFORE the bytes ever leave the server. Visibility
//  is a closed graph: after hidden entities are removed, every documented
//  cross-collection reference is checked against the surviving ID sets.
//
//    1. Entity-level — `visibility: 'public' | 'dm'`. DM-only
//       entities are dropped from non-DM payloads entirely. DM
//       lore lives in a separate DM-only TWIN entity that is
//       linked to its public counterpart via `linkedTwinId`.
//    2. `linkedTwinId` is DM-only metadata. Stripped from non-DM
//       payloads so players can't infer "this entity has hidden
//       DM lore" from the field's presence.
//
//  DM granular annotations live in the linked DM twin rather than as
//  per-field `secrets` or `[secret]…[/secret]` inline markers on public
//  entities. Any residual `secrets` on legacy data is stripped by
//  the startup migration in `server/migrations.cjs`.
//
//  Addon API v1 collections are public and schema-opaque (their manifest
//  declares only name + keyed shape), so there are no addon reference or
//  visibility fields that this module can safely interpret yet.
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

// -- Dataset-level closure -------------------------------------------------

const ID_COLLECTIONS = [
  'characters', 'locations', 'events', 'mysteries', 'factions',
  'pantheon', 'artifacts', 'historicalEvents',
];

const BUILTIN_REL_TARGETS = new Map([
  ['mission', 'location'],
]);

function _idsFor(collectionName, container) {
  const ids = new Set();
  if (Array.isArray(container)) {
    for (const entity of container) {
      if (entity && typeof entity === 'object' && typeof entity.id === 'string') {
        ids.add(entity.id);
      }
    }
    return ids;
  }
  if (container && typeof container === 'object') {
    for (const [key, entity] of Object.entries(container)) {
      // Faction references use the keyed-object key. Also accept an explicit
      // record id for legacy/hand-authored data so either canonical form closes.
      ids.add(key);
      if (entity && typeof entity === 'object' && typeof entity.id === 'string') {
        ids.add(entity.id);
      }
    }
  }
  return ids;
}

function _withoutInvalidScalar(entity, field, visibleIds) {
  if (!entity || typeof entity !== 'object') return entity;
  const value = entity[field];
  if (value == null || value === '' || visibleIds.has(value)) return entity;
  const out = { ...entity };
  delete out[field];
  return out;
}

function _withClosedIdArray(entity, field, visibleIds) {
  if (!entity || typeof entity !== 'object' || !Array.isArray(entity[field])) return entity;
  const next = entity[field].filter(id => typeof id === 'string' && visibleIds.has(id));
  if (next.length === entity[field].length) return entity;
  return { ...entity, [field]: next };
}

function _withoutHiddenAuditRefs(entity, hiddenIds) {
  if (!entity || typeof entity !== 'object' || !Array.isArray(entity.lastChange?.fields)) return entity;
  const fields = entity.lastChange.fields.filter(change => {
    if (!change || typeof change !== 'object') return true;
    return !hiddenIds.has(change.from) && !hiddenIds.has(change.to);
  });
  if (fields.length === entity.lastChange.fields.length) return entity;
  return { ...entity, lastChange: { ...entity.lastChange, fields } };
}

function _mapEntities(container, fn) {
  if (Array.isArray(container)) return container.map(fn);
  if (!container || typeof container !== 'object') return container;
  return Object.fromEntries(Object.entries(container).map(([key, value]) => [key, fn(value)]));
}

function _relationshipTargetKinds(settings) {
  const targets = new Map(BUILTIN_REL_TARGETS);
  const types = settings && Array.isArray(settings.relationshipTypes)
    ? settings.relationshipTypes
    : [];
  for (const type of types) {
    if (!type || typeof type.id !== 'string') continue;
    targets.set(type.id, type.target === 'location' ? 'location' : 'character');
  }
  return targets;
}

function _closeRelationships(relationships, ids, settings) {
  if (!Array.isArray(relationships)) return relationships;
  const targets = _relationshipTargetKinds(settings);
  return relationships.filter(rel => {
    if (!rel || typeof rel !== 'object' || !ids.characters.has(rel.source)) return false;
    const targetIds = targets.get(rel.type) === 'location' ? ids.locations : ids.characters;
    return targetIds.has(rel.target);
  });
}

function _closeCharacters(container, ids) {
  return _mapEntities(container, entity => {
    let out = _withoutInvalidScalar(entity, 'faction', ids.factions);
    out = _withoutInvalidScalar(out, 'location', ids.locations);
    if (Array.isArray(out?.locationRoles)) {
      const roles = out.locationRoles.filter(role =>
        role && typeof role === 'object' && ids.locations.has(role.locationId));
      if (roles.length !== out.locationRoles.length) out = { ...out, locationRoles: roles };
    }
    return out;
  });
}

function _closeLocations(container, ids) {
  return _mapEntities(container, entity => {
    let out = _withoutInvalidScalar(entity, 'parentId', ids.locations);
    out = _withClosedIdArray(out, 'connections', ids.locations);
    // Deprecated but still accepted on old data; it must not leak hidden ids.
    return _withClosedIdArray(out, 'characters', ids.characters);
  });
}

function _closeCharacterLocationArrays(container, ids) {
  return _mapEntities(container, entity => {
    let out = _withClosedIdArray(entity, 'characters', ids.characters);
    return _withClosedIdArray(out, 'locations', ids.locations);
  });
}

function _closeEvents(container, ids) {
  return _mapEntities(_closeCharacterLocationArrays(container, ids), entity =>
    _withoutInvalidScalar(entity, 'mapParentId', ids.locations));
}

function _closeArtifacts(container, ids) {
  return _mapEntities(container, entity => {
    let out = _withoutInvalidScalar(entity, 'ownerCharacterId', ids.characters);
    return _withoutInvalidScalar(out, 'locationId', ids.locations);
  });
}

function _closePets(container, ids) {
  if (!Array.isArray(container)) return container;
  return container.map(pet => {
    if (!pet || typeof pet !== 'object') return pet;
    const ownerIds = pet.ownerType === 'character'
      ? ids.characters
      : (pet.ownerType === 'faction' ? ids.factions : null);
    if (!ownerIds || !pet.ownerId || ownerIds.has(pet.ownerId)) return pet;
    return { ...pet, ownerType: 'none', ownerId: '' };
  });
}

function _closeSettings(settings, ids) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  let out = settings;
  if (Array.isArray(settings.mapViews)) {
    const mapViews = settings.mapViews.filter(view =>
      !view || typeof view !== 'object' || !view.parentId || ids.locations.has(view.parentId));
    if (mapViews.length !== settings.mapViews.length) out = { ...out, mapViews };
  }
  if (settings.mapConfigs && typeof settings.mapConfigs === 'object' && !Array.isArray(settings.mapConfigs)) {
    const mapConfigs = Object.fromEntries(Object.entries(settings.mapConfigs).filter(([mapId]) =>
      !mapId.startsWith('local-') || ids.locations.has(mapId.slice('local-'.length))));
    if (Object.keys(mapConfigs).length !== Object.keys(settings.mapConfigs).length) {
      out = { ...out, mapConfigs };
    }
  }
  return out;
}

/**
 * Filter a complete campaign payload for a role and close all documented core
 * references over the surviving entity graph. DM access is strict identity:
 * the original object and every nested record remain untouched.
 */
function filterDatasetForRole(dataset, role) {
  if (role === 'dm' || !dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    return dataset;
  }

  // Pass one: remove hidden records from every visibility-bearing collection.
  // Dynamic addon collections ride this loop too; API v1 defines them as public
  // and schema-opaque, so filterForRole intentionally preserves them.
  const out = {};
  for (const [collection, container] of Object.entries(dataset)) {
    out[collection] = filterForRole(collection, container, role);
  }

  // Pass two: build the survivor sets before inspecting a single reference.
  const ids = {};
  const originalIds = {};
  for (const collection of ID_COLLECTIONS) {
    ids[collection] = _idsFor(collection, out[collection]);
    originalIds[collection] = _idsFor(collection, dataset[collection]);
  }
  // `neutral` (no faction) and `party` (the player-party identity) are
  // reserved character.faction values, not records in factions.json.
  ids.factions.add('neutral');
  ids.factions.add('party');
  const hiddenIds = new Set();
  for (const collection of ID_COLLECTIONS) {
    for (const id of originalIds[collection]) {
      if (!ids[collection].has(id)) hiddenIds.add(id);
    }
  }

  if (Object.hasOwn(out, 'characters')) out.characters = _closeCharacters(out.characters, ids);
  if (Object.hasOwn(out, 'locations')) out.locations = _closeLocations(out.locations, ids);
  if (Object.hasOwn(out, 'events')) out.events = _closeEvents(out.events, ids);
  if (Object.hasOwn(out, 'mysteries')) out.mysteries = _closeCharacterLocationArrays(out.mysteries, ids);
  if (Object.hasOwn(out, 'historicalEvents')) {
    out.historicalEvents = _closeCharacterLocationArrays(out.historicalEvents, ids);
  }
  if (Object.hasOwn(out, 'artifacts')) out.artifacts = _closeArtifacts(out.artifacts, ids);
  if (Object.hasOwn(out, 'pets')) out.pets = _closePets(out.pets, ids);
  if (Object.hasOwn(out, 'settings')) out.settings = _closeSettings(out.settings, ids);
  if (Object.hasOwn(out, 'relationships')) {
    out.relationships = _closeRelationships(out.relationships, ids, out.settings);
  }

  // lastChange stores scalar before/after values. Remove audit entries that
  // would otherwise re-introduce an id hidden by the graph closure.
  for (const collection of ID_COLLECTIONS) {
    if (Object.hasOwn(out, collection)) {
      out[collection] = _mapEntities(out[collection], entity =>
        _withoutHiddenAuditRefs(entity, hiddenIds));
    }
  }

  return out;
}

module.exports = {
  VISIBILITY_BEARING,
  KEYED_OBJ_VISIBILITY,
  filterForRole,
  filterDatasetForRole,
  stripEntityForRole,
};
