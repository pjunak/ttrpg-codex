'use strict';

class CampaignMutationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CampaignMutationError';
    this.status = status;
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function touchReference(entity, now) {
  entity.updatedAt = now();
  entity.lastChange = { refs: true };
}

function removeId(values, id) {
  if (!Array.isArray(values) || !values.includes(id)) return false;
  const next = values.filter(value => value !== id);
  values.splice(0, values.length, ...next);
  return true;
}

function clearTwin(container, deleted, isKeyed, now) {
  if (!deleted?.linkedTwinId) return false;
  const twin = isKeyed
    ? container[deleted.linkedTwinId]
    : container.find(entity => entity?.id === deleted.linkedTwinId);
  if (!twin) return false;
  delete twin.linkedTwinId;
  touchReference(twin, now);
  return true;
}

function cloneTwin(source, id, now) {
  const twin = { ...source };
  delete twin.id;
  delete twin.linkedTwinId;
  delete twin.updatedAt;
  delete twin.secrets;
  twin.id = id;
  twin.visibility = source.visibility === 'dm' ? 'public' : 'dm';
  twin.updatedAt = now();
  return twin;
}

const ENUM_USAGE = Object.freeze({
  relationshipTypes: Object.freeze([{ collection: 'relationships', field: 'type' }]),
  genders: Object.freeze([{ collection: 'characters', field: 'gender' }]),
  pinTypes: Object.freeze([{ collection: 'locations', field: 'pinType' }]),
  characterStatuses: Object.freeze([{ collection: 'characters', field: 'status' }]),
  eventPriorities: Object.freeze([{ collection: 'events', field: 'priority' }]),
  attitudes: Object.freeze([
    { collection: 'characters', field: 'attitudes' },
    { collection: 'locations', field: 'attitudes' },
    { collection: 'factions', field: 'attitudes' },
  ]),
});

function replaceReference(value, oldId, newId) {
  if (!Array.isArray(value)) {
    return value === oldId
      ? { changed: true, value: newId }
      : { changed: false, value };
  }
  let changed = false;
  const seen = new Set();
  const next = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const id = item === oldId ? newId : item;
      changed ||= id !== item || seen.has(id);
      if (!seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
      continue;
    }
    if (isObject(item)) {
      const id = item.id === oldId ? newId : item.id;
      changed ||= id !== item.id || seen.has(id);
      if (!seen.has(id)) {
        seen.add(id);
        next.push(id === item.id ? item : { ...item, id });
      }
      continue;
    }
    next.push(item);
  }
  return { changed, value: changed ? next : value };
}

class CampaignMutationService {
  constructor({
    readCollection,
    publishCollections,
    createId,
    now = () => Date.now(),
  }) {
    if (typeof readCollection !== 'function'
        || typeof publishCollections !== 'function'
        || typeof createId !== 'function') {
      throw new TypeError('CampaignMutationService requires storage and id adapters');
    }
    this.readCollection = readCollection;
    this.publishCollections = publishCollections;
    this.createId = createId;
    this.now = now;
  }

  async #read(types) {
    const entries = await Promise.all(types.map(async type => [
      type,
      await this.readCollection(type),
    ]));
    return Object.fromEntries(entries);
  }

  async #publish(dataset, changed) {
    if (!changed.size) return { changed: [] };
    const collections = Object.fromEntries(
      [...changed].sort().map(type => [type, dataset[type]]),
    );
    await this.publishCollections(collections);
    return { changed: Object.keys(collections) };
  }

  async mutateTwin({ action, type, sourceId, targetId, keyed }) {
    const container = await this.readCollection(type);
    const expectedShape = keyed ? isObject(container) : Array.isArray(container);
    if (!expectedShape) {
      throw new CampaignMutationError(500, 'CAMPAIGN_DATA_INVALID', `Invalid ${type} collection`);
    }
    const lookup = id => keyed
      ? container[id] || null
      : container.find(entity => entity?.id === id) || null;
    const source = lookup(sourceId);
    if (!source) {
      throw new CampaignMutationError(404, 'SOURCE_NOT_FOUND', 'Source entity not found');
    }

    if (action === 'create') {
      if (source.linkedTwinId) {
        throw new CampaignMutationError(409, 'TWIN_EXISTS', 'Entita už má spárovaný twin.');
      }
      let twinId;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = this.createId(source.name || 'twin');
        if (!lookup(candidate)) {
          twinId = candidate;
          break;
        }
      }
      if (!twinId) {
        throw new CampaignMutationError(500, 'TWIN_ID_COLLISION', 'Twin id collision — try again.');
      }
      const twin = cloneTwin(source, twinId, this.now);
      twin.linkedTwinId = source.id;
      source.linkedTwinId = twin.id;
      source.updatedAt = this.now();
      if (keyed) container[twin.id] = twin;
      else container.push(twin);
      await this.publishCollections({ [type]: container });
      return { twinId: twin.id, twin };
    }

    if (action === 'link') {
      if (typeof targetId !== 'string' || !targetId) {
        throw new CampaignMutationError(400, 'TARGET_REQUIRED', 'Missing targetId');
      }
      if (targetId === sourceId) {
        throw new CampaignMutationError(400, 'TWIN_SELF_LINK', 'Source and target must differ.');
      }
      const target = lookup(targetId);
      if (!target) {
        throw new CampaignMutationError(404, 'TARGET_NOT_FOUND', 'Target entity not found');
      }
      if (source.linkedTwinId || target.linkedTwinId) {
        throw new CampaignMutationError(
          409,
          'TWIN_EXISTS',
          'Jedna nebo obě entity už mají twin — odpárujte ho nejprve.',
        );
      }
      const sourceVisibility = source.visibility === 'dm' ? 'dm' : 'public';
      const targetVisibility = target.visibility === 'dm' ? 'dm' : 'public';
      if (sourceVisibility === targetVisibility) {
        throw new CampaignMutationError(
          400,
          'TWIN_VISIBILITY_INVALID',
          'Twin musí být v opačném prostoru (jeden DM, druhý hráčský).',
        );
      }
      source.linkedTwinId = target.id;
      target.linkedTwinId = source.id;
      source.updatedAt = this.now();
      target.updatedAt = this.now();
      await this.publishCollections({ [type]: container });
      return {};
    }

    if (!source.linkedTwinId) {
      throw new CampaignMutationError(409, 'TWIN_MISSING', 'Entita nemá spárovaný twin.');
    }
    const twin = lookup(source.linkedTwinId);
    delete source.linkedTwinId;
    source.updatedAt = this.now();
    if (twin) {
      delete twin.linkedTwinId;
      twin.updatedAt = this.now();
    }
    await this.publishCollections({ [type]: container });
    return {};
  }

  async saveLocation(incoming, { editablePeer = () => true } = {}) {
    if (!incoming || typeof incoming.id !== 'string' || !incoming.id) {
      throw new CampaignMutationError(400, 'LOCATION_ID_REQUIRED', 'Location id is required');
    }
    const locations = await this.readCollection('locations');
    if (!Array.isArray(locations)) {
      throw new CampaignMutationError(500, 'CAMPAIGN_DATA_INVALID', 'Invalid locations collection');
    }

    const index = locations.findIndex(location => location?.id === incoming.id);
    const existing = index >= 0 ? locations[index] : null;
    const peers = new Map(
      locations
        .filter(location => location?.id && location.id !== incoming.id)
        .map(location => [location.id, location]),
    );
    const preserved = (Array.isArray(existing?.connections) ? existing.connections : [])
      .filter(id => peers.has(id) && !editablePeer(peers.get(id)));
    const connections = [...new Set(
      [
        ...(Array.isArray(incoming.connections) ? incoming.connections : [])
          .filter(id => typeof id === 'string'
            && peers.has(id)
            && editablePeer(peers.get(id))),
        ...preserved,
      ],
    )];
    const location = { ...incoming, connections };
    if (index >= 0) locations[index] = location;
    else locations.push(location);

    for (const peer of locations) {
      if (!peer || peer.id === location.id) continue;
      const shouldConnect = connections.includes(peer.id);
      const current = Array.isArray(peer.connections) ? peer.connections : [];
      const hasConnection = current.includes(location.id);
      if (shouldConnect === hasConnection) continue;
      peer.connections = shouldConnect
        ? [...new Set([...current, location.id])]
        : current.filter(id => id !== location.id);
      touchReference(peer, this.now);
    }

    await this.publishCollections({ locations });
    return { location };
  }

  async deleteEntity(type, id) {
    if (typeof id !== 'string' || !id) {
      throw new CampaignMutationError(400, 'ENTITY_ID_REQUIRED', 'Entity id is required');
    }
    if (type === 'characters') return this.#deleteCharacter(id);
    if (type === 'locations') return this.#deleteLocation(id);
    if (type === 'factions') return this.#deleteFaction(id);
    throw new CampaignMutationError(400, 'DELETE_UNSUPPORTED', `Unsupported compound delete: ${type}`);
  }

  async deleteEnumItem({
    category,
    id,
    replaceWith = '',
    force = false,
    tombstone = false,
  }) {
    const bindings = ENUM_USAGE[category];
    if (!bindings || typeof id !== 'string' || !id
        || typeof replaceWith !== 'string' || replaceWith === id) {
      throw new CampaignMutationError(400, 'ENUM_DELETE_INVALID', 'Invalid enum deletion');
    }
    const types = [...new Set([
      'settings',
      'deletedDefaults',
      ...bindings.map(binding => binding.collection),
    ])];
    const dataset = await this.#read(types);
    if (!isObject(dataset.settings) || !Array.isArray(dataset.settings[category])) {
      throw new CampaignMutationError(400, 'ENUM_CATEGORY_INVALID', 'Invalid enum category');
    }
    if (replaceWith && !dataset.settings[category].some(item => item?.id === replaceWith)) {
      throw new CampaignMutationError(400, 'ENUM_REPLACEMENT_INVALID', 'Replacement enum item not found');
    }

    const usages = [];
    for (const binding of bindings) {
      const collection = dataset[binding.collection];
      const records = Array.isArray(collection)
        ? collection.map(entity => ({ entity, id: entity?.id }))
        : isObject(collection)
          ? Object.entries(collection).map(([key, entity]) => ({ entity, id: key }))
          : [];
      for (const record of records) {
        const value = record.entity?.[binding.field];
        const matches = Array.isArray(value)
          ? value.some(item => (typeof item === 'string' ? item : item?.id) === id)
          : value === id;
        if (matches) {
          usages.push({
            collection: binding.collection,
            field: binding.field,
            id: record.id,
            name: record.entity?.name || record.id,
          });
        }
      }
    }
    if (usages.length && !force && !replaceWith) {
      const error = new CampaignMutationError(409, 'ENUM_IN_USE', 'Enum item is still in use');
      error.usages = usages;
      throw error;
    }

    const changed = new Set(['settings']);
    if (replaceWith) {
      for (const binding of bindings) {
        const collection = dataset[binding.collection];
        const records = Array.isArray(collection)
          ? collection
          : isObject(collection) ? Object.values(collection) : [];
        let collectionChanged = false;
        for (const entity of records) {
          if (!entity) continue;
          const replacement = replaceReference(entity[binding.field], id, replaceWith);
          if (!replacement.changed) continue;
          entity[binding.field] = replacement.value;
          touchReference(entity, this.now);
          collectionChanged = true;
        }
        if (collectionChanged) changed.add(binding.collection);
      }
    }

    dataset.settings[category] = dataset.settings[category]
      .filter(item => item?.id !== id);
    if (tombstone) {
      if (!isObject(dataset.deletedDefaults)) dataset.deletedDefaults = {};
      dataset.deletedDefaults[`settings:${category}:${id}`] = true;
      changed.add('deletedDefaults');
    }
    const result = await this.#publish(dataset, changed);
    return { ...result, usages };
  }

  async #deleteCharacter(id) {
    const dataset = await this.#read([
      'characters',
      'relationships',
      'events',
      'mysteries',
      'historicalEvents',
      'artifacts',
      'pets',
    ]);
    if (!Array.isArray(dataset.characters)) {
      throw new CampaignMutationError(500, 'CAMPAIGN_DATA_INVALID', 'Invalid characters collection');
    }
    const index = dataset.characters.findIndex(character => character?.id === id);
    if (index < 0) return { changed: [] };
    const deleted = dataset.characters[index];
    const changed = new Set(['characters']);
    clearTwin(dataset.characters, deleted, false, this.now);
    dataset.characters.splice(index, 1);

    if (Array.isArray(dataset.relationships)) {
      const next = dataset.relationships.filter(rel => rel?.source !== id && rel?.target !== id);
      if (next.length !== dataset.relationships.length) {
        dataset.relationships = next;
        changed.add('relationships');
      }
    }
    for (const type of ['events', 'mysteries', 'historicalEvents']) {
      if (!Array.isArray(dataset[type])) continue;
      let collectionChanged = false;
      for (const entity of dataset[type]) {
        if (entity && removeId(entity.characters, id)) {
          touchReference(entity, this.now);
          collectionChanged = true;
        }
      }
      if (collectionChanged) changed.add(type);
    }
    if (Array.isArray(dataset.artifacts)) {
      let collectionChanged = false;
      for (const artifact of dataset.artifacts) {
        if (artifact?.ownerCharacterId !== id) continue;
        artifact.ownerCharacterId = '';
        touchReference(artifact, this.now);
        collectionChanged = true;
      }
      if (collectionChanged) changed.add('artifacts');
    }
    if (Array.isArray(dataset.pets)) {
      let collectionChanged = false;
      for (const pet of dataset.pets) {
        if (pet?.ownerType !== 'character' || pet.ownerId !== id) continue;
        pet.ownerType = 'none';
        pet.ownerId = '';
        pet.updatedAt = this.now();
        collectionChanged = true;
      }
      if (collectionChanged) changed.add('pets');
    }
    return this.#publish(dataset, changed);
  }

  async #deleteLocation(id) {
    const dataset = await this.#read([
      'locations',
      'characters',
      'events',
      'mysteries',
      'historicalEvents',
      'artifacts',
      'settings',
    ]);
    if (!Array.isArray(dataset.locations)) {
      throw new CampaignMutationError(500, 'CAMPAIGN_DATA_INVALID', 'Invalid locations collection');
    }
    const index = dataset.locations.findIndex(location => location?.id === id);
    if (index < 0) return { changed: [] };
    const deleted = dataset.locations[index];
    const changed = new Set(['locations']);
    clearTwin(dataset.locations, deleted, false, this.now);
    dataset.locations.splice(index, 1);

    for (const location of dataset.locations) {
      if (!location) continue;
      let touched = removeId(location.connections, id);
      if (location.parentId === id) {
        location.parentId = '';
        touched = true;
      }
      if (touched) touchReference(location, this.now);
    }
    if (Array.isArray(dataset.characters)) {
      let collectionChanged = false;
      for (const character of dataset.characters) {
        if (!character) continue;
        let touched = false;
        if (character.location === id) {
          character.location = '';
          touched = true;
        }
        if (Array.isArray(character.locationRoles)) {
          const next = character.locationRoles.filter(role => role?.locationId !== id);
          if (next.length !== character.locationRoles.length) {
            character.locationRoles = next;
            touched = true;
          }
        }
        if (touched) {
          touchReference(character, this.now);
          collectionChanged = true;
        }
      }
      if (collectionChanged) changed.add('characters');
    }
    for (const type of ['events', 'mysteries', 'historicalEvents']) {
      if (!Array.isArray(dataset[type])) continue;
      let collectionChanged = false;
      for (const entity of dataset[type]) {
        if (!entity) continue;
        let touched = removeId(entity.locations, id);
        if (type === 'events' && entity.mapParentId === id) {
          delete entity.mapParentId;
          delete entity.mapX;
          delete entity.mapY;
          touched = true;
        }
        if (touched) {
          touchReference(entity, this.now);
          collectionChanged = true;
        }
      }
      if (collectionChanged) changed.add(type);
    }
    if (Array.isArray(dataset.artifacts)) {
      let collectionChanged = false;
      for (const artifact of dataset.artifacts) {
        if (artifact?.locationId !== id) continue;
        artifact.locationId = '';
        touchReference(artifact, this.now);
        collectionChanged = true;
      }
      if (collectionChanged) changed.add('artifacts');
    }
    if (isObject(dataset.settings)) {
      let settingsChanged = false;
      if (Array.isArray(dataset.settings.mapViews)) {
        const next = dataset.settings.mapViews.filter(view => view?.parentId !== id);
        if (next.length !== dataset.settings.mapViews.length) {
          dataset.settings.mapViews = next;
          settingsChanged = true;
        }
      }
      if (isObject(dataset.settings.mapConfigs)
          && Object.hasOwn(dataset.settings.mapConfigs, `local-${id}`)) {
        delete dataset.settings.mapConfigs[`local-${id}`];
        settingsChanged = true;
      }
      if (settingsChanged) changed.add('settings');
    }
    return this.#publish(dataset, changed);
  }

  async #deleteFaction(id) {
    const dataset = await this.#read(['factions', 'characters', 'pets']);
    if (!isObject(dataset.factions)) {
      throw new CampaignMutationError(500, 'CAMPAIGN_DATA_INVALID', 'Invalid factions collection');
    }
    const deleted = dataset.factions[id];
    if (!deleted) return { changed: [] };
    const changed = new Set(['factions']);
    clearTwin(dataset.factions, deleted, true, this.now);
    delete dataset.factions[id];

    if (Array.isArray(dataset.characters)) {
      let collectionChanged = false;
      for (const character of dataset.characters) {
        if (character?.faction !== id) continue;
        character.faction = 'neutral';
        character.rank = '';
        character.rankChain = '';
        touchReference(character, this.now);
        collectionChanged = true;
      }
      if (collectionChanged) changed.add('characters');
    }
    if (Array.isArray(dataset.pets)) {
      let collectionChanged = false;
      for (const pet of dataset.pets) {
        if (pet?.ownerType !== 'faction' || pet.ownerId !== id) continue;
        pet.ownerType = 'none';
        pet.ownerId = '';
        pet.updatedAt = this.now();
        collectionChanged = true;
      }
      if (collectionChanged) changed.add('pets');
    }
    return this.#publish(dataset, changed);
  }
}

module.exports = {
  CampaignMutationError,
  CampaignMutationService,
  ENUM_USAGE,
};
