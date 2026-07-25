'use strict';

const PARTY_FACTION_ID = 'party';
const CAMPAIGN_SHAPE_MIGRATION_ID = 'campaign-shape-v1';
const CAMPAIGN_COLLECTION_SHAPES = Object.freeze({
  characters: 'array',
  locations: 'array',
  factions: 'object',
  mysteries: 'array',
  artifacts: 'array',
  settings: 'object',
  deletedDefaults: 'object-or-legacy-array',
});

function isKeyedObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createChangeTracker() {
  const touched = new Map();

  return {
    mark(collection, record) {
      if (!touched.has(collection)) touched.set(collection, new Set());
      touched.get(collection).add(record);
    },
    summary() {
      const byCollection = {};
      let changed = 0;
      for (const [collection, records] of touched) {
        byCollection[collection] = records.size;
        changed += records.size;
      }
      return {
        changed,
        byCollection,
        changedCollections: [...touched.keys()],
      };
    },
  };
}

function normalizeAttitudes(value) {
  if (!Array.isArray(value)) return { changed: true, value: [] };

  let changed = false;
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      changed = true;
      if (!entry || entry === 'unknown' || seen.has(entry)) continue;
      seen.add(entry);
      normalized.push({ id: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      changed = true;
      continue;
    }
    if (entry.id === 'unknown' || seen.has(entry.id)) {
      changed = true;
      continue;
    }
    seen.add(entry.id);
    if (Object.prototype.hasOwnProperty.call(entry, 'strength')) {
      const normalizedEntry = { ...entry };
      delete normalizedEntry.strength;
      normalized.push(normalizedEntry);
      changed = true;
    } else {
      normalized.push(entry);
    }
  }
  return { changed, value: changed ? normalized : value };
}

function migrateAttitudeRecords(dataset, tracker) {
  for (const character of dataset.characters || []) {
    if (!character || typeof character !== 'object') continue;
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(character, 'attitude')) {
      const legacy = character.attitude;
      if (
        typeof legacy === 'string'
        && legacy
        && legacy !== 'unknown'
        && (!Array.isArray(character.attitudes) || character.attitudes.length === 0)
      ) {
        character.attitudes = [{ id: legacy }];
      }
      delete character.attitude;
      changed = true;
    }
    const normalized = normalizeAttitudes(character.attitudes);
    if (normalized.changed) {
      character.attitudes = normalized.value;
      changed = true;
    }
    if (changed) tracker.mark('characters', character);
  }

  for (const location of dataset.locations || []) {
    if (!location || typeof location !== 'object') continue;
    const normalized = normalizeAttitudes(location.attitudes);
    if (!normalized.changed) continue;
    location.attitudes = normalized.value;
    tracker.mark('locations', location);
  }

  if (!isKeyedObject(dataset.factions)) return;
  for (const [id, faction] of Object.entries(dataset.factions)) {
    if (!faction || typeof faction !== 'object') continue;
    const normalized = normalizeAttitudes(faction.attitudes);
    if (!normalized.changed) continue;
    faction.attitudes = normalized.value;
    tracker.mark('factions', id);
  }
}

function migrateMapStatuses(dataset, tracker) {
  const attitudeByStatus = {
    visited: 'ally',
    enemy: 'enemy',
    fog: 'unknown',
    known: 'neutral',
  };
  for (const location of dataset.locations || []) {
    if (!location || typeof location !== 'object') continue;
    let changed = false;
    let attitudes = Array.isArray(location.attitudes)
      ? location.attitudes.slice()
      : null;
    if (location.mapStatus) {
      const mapped = attitudeByStatus[location.mapStatus] || 'unknown';
      if (!attitudes || attitudes.length === 0) attitudes = [mapped];
      else if (!attitudes.includes(mapped)) attitudes.push(mapped);
    }
    if (
      attitudes
      && JSON.stringify(location.attitudes || []) !== JSON.stringify(attitudes)
    ) {
      location.attitudes = attitudes;
      changed = true;
    }
    if (location.mapStatus !== undefined) {
      delete location.mapStatus;
      changed = true;
    }
    if (changed) tracker.mark('locations', location);
  }

  if (isKeyedObject(dataset.settings) && Array.isArray(dataset.settings.mapStatuses)) {
    delete dataset.settings.mapStatuses;
    tracker.mark('settings', 'mapStatuses');
  }
}

function migrateCapturedCharacters(dataset, tracker) {
  for (const character of dataset.characters || []) {
    if (!character || typeof character !== 'object' || character.status !== 'captured') continue;
    character.status = 'alive';
    if (!character.circumstances) character.circumstances = 'Zajat/a';
    tracker.mark('characters', character);
  }
}

function migrateAttitudeSettings(dataset, tracker) {
  const settings = dataset.settings;
  if (!isKeyedObject(settings) || !Array.isArray(settings.attitudes)) return;

  const canWriteTombstones = dataset.deletedDefaults === undefined
    || isKeyedObject(dataset.deletedDefaults);
  const dropIds = canWriteTombstones ? new Set(['unknown', PARTY_FACTION_ID]) : new Set();
  const removedIds = new Set(
    settings.attitudes
      .map(attitude => attitude?.id)
      .filter(id => dropIds.has(id)),
  );
  settings.attitudes = settings.attitudes.filter(attitude => !dropIds.has(attitude?.id));
  if (removedIds.size > 0) {
    if (dataset.deletedDefaults === undefined) dataset.deletedDefaults = {};
    for (const id of removedIds) {
      dataset.deletedDefaults[`settings:attitudes:${id}`] = true;
      tracker.mark('deletedDefaults', `settings:attitudes:${id}`);
    }
    tracker.mark('settings', 'attitudes');
  }

  for (const attitude of settings.attitudes) {
    if (!attitude || typeof attitude !== 'object' || typeof attitude.strength === 'number') continue;
    attitude.strength = 1;
    tracker.mark('settings', 'attitudes');
  }
}

function migratePinTypes(dataset, tracker) {
  const pinTypes = dataset.settings?.pinTypes;
  if (!Array.isArray(pinTypes)) return;

  const sizeByPriority = { 1: 36, 2: 30, 3: 26 };
  let changed = false;
  for (const pinType of pinTypes) {
    if (!pinType || typeof pinType !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(pinType, 'priority')) {
      if (typeof pinType.size !== 'number') {
        pinType.size = sizeByPriority[pinType.priority] || 28;
      }
      delete pinType.priority;
      changed = true;
    } else if (typeof pinType.size !== 'number') {
      pinType.size = 28;
      changed = true;
    }

    const iconConfig = pinType.iconConfig;
    if (!iconConfig || typeof iconConfig !== 'object') continue;
    if (iconConfig.strategy === 'state') {
      iconConfig.strategy = 'single';
      changed = true;
    }
    for (const file of iconConfig.files || []) {
      if (!file || typeof file !== 'object' || !Object.prototype.hasOwnProperty.call(file, 'stateId')) {
        continue;
      }
      delete file.stateId;
      changed = true;
    }
  }
  if (changed) tracker.mark('settings', 'pinTypes');
}

function migrateLocationFields(dataset, tracker) {
  const sizeByPriority = { 1: 36, 2: 30, 3: 26 };
  for (const location of dataset.locations || []) {
    if (!location || typeof location !== 'object') continue;
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(location, 'priority')) {
      if (typeof location.size !== 'number' && sizeByPriority[location.priority]) {
        location.size = sizeByPriority[location.priority];
      }
      delete location.priority;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(location, 'status')) {
      delete location.status;
      changed = true;
    }
    if (changed) tracker.mark('locations', location);
  }
}

function migrateRetiredSettings(dataset, tracker) {
  if (!isKeyedObject(dataset.settings)) return;
  for (const category of ['locationStatuses', 'artifactStates']) {
    if (!Object.prototype.hasOwnProperty.call(dataset.settings, category)) continue;
    delete dataset.settings[category];
    tracker.mark('settings', category);
  }
}

function migrateArtifactFields(dataset, tracker) {
  for (const artifact of dataset.artifacts || []) {
    if (!artifact || typeof artifact !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(artifact, 'state')) continue;
    delete artifact.state;
    tracker.mark('artifacts', artifact);
  }
}

function migratePartyFaction(dataset, tracker) {
  if (!isKeyedObject(dataset.factions)) return;
  const faction = dataset.factions[PARTY_FACTION_ID];
  if (!faction || typeof faction !== 'object') return;
  const canWriteSettings = dataset.settings === undefined || isKeyedObject(dataset.settings);
  const canWriteTombstones = dataset.deletedDefaults === undefined
    || isKeyedObject(dataset.deletedDefaults);
  if (!canWriteSettings || !canWriteTombstones) return;

  if (dataset.settings === undefined) dataset.settings = {};
  if (dataset.deletedDefaults === undefined) dataset.deletedDefaults = {};
  dataset.settings.playerParty = {
    name: faction.name || 'Our Party',
    icon: faction.badge || '🛡',
    badge: faction.badge || '🛡',
    color: faction.color || '#F5F0E4',
    textColor: faction.textColor || '#1a1410',
  };
  dataset.deletedDefaults['factions:party'] = true;
  delete dataset.factions[PARTY_FACTION_ID];
  tracker.mark('settings', 'playerParty');
  tracker.mark('deletedDefaults', 'factions:party');
  tracker.mark('factions', PARTY_FACTION_ID);
}

function migratePartyAttitudes(dataset, tracker) {
  const strip = attitudes => attitudes.filter(attitude => (
    typeof attitude === 'string'
      ? attitude !== PARTY_FACTION_ID
      : attitude?.id !== PARTY_FACTION_ID
  ));

  for (const character of dataset.characters || []) {
    if (!character || typeof character !== 'object' || !Array.isArray(character.attitudes)) continue;
    if (character.faction === PARTY_FACTION_ID && character.attitudes.length > 0) {
      character.attitudes = [];
      tracker.mark('characters', character);
      continue;
    }
    const next = strip(character.attitudes);
    if (next.length !== character.attitudes.length) {
      character.attitudes = next;
      tracker.mark('characters', character);
    }
  }
  for (const location of dataset.locations || []) {
    if (!location || typeof location !== 'object' || !Array.isArray(location.attitudes)) continue;
    const next = strip(location.attitudes);
    if (next.length !== location.attitudes.length) {
      location.attitudes = next;
      tracker.mark('locations', location);
    }
  }
  if (!isKeyedObject(dataset.factions)) return;
  for (const [id, faction] of Object.entries(dataset.factions)) {
    if (!faction || typeof faction !== 'object' || !Array.isArray(faction.attitudes)) continue;
    const next = strip(faction.attitudes);
    if (next.length !== faction.attitudes.length) {
      faction.attitudes = next;
      tracker.mark('factions', id);
    }
  }
}

function migrateQuestionEntries(dataset, tracker) {
  const normalize = entry => {
    if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
      if (typeof entry.answer === 'string') return { changed: false, value: entry };
      entry.answer = '';
      return { changed: true, value: entry };
    }
    if (typeof entry === 'string') {
      return { changed: true, value: { text: entry, answer: '' } };
    }
    return { changed: true, value: { text: '', answer: '' } };
  };

  for (const mystery of dataset.mysteries || []) {
    if (!mystery || typeof mystery !== 'object' || !Array.isArray(mystery.questions)) continue;
    let changed = false;
    const questions = mystery.questions.map(entry => {
      const result = normalize(entry);
      changed ||= result.changed;
      return result.value;
    });
    if (changed) {
      mystery.questions = questions;
      tracker.mark('mysteries', mystery);
    }
  }
  for (const character of dataset.characters || []) {
    if (!character || typeof character !== 'object' || !Array.isArray(character.unknown)) continue;
    let changed = false;
    const unknown = character.unknown.map(entry => {
      const result = normalize(entry);
      changed ||= result.changed;
      return result.value;
    });
    if (changed) {
      character.unknown = unknown;
      tracker.mark('characters', character);
    }
  }
}

function migrateCampaignShape(dataset) {
  const tracker = createChangeTracker();
  if (Array.isArray(dataset.deletedDefaults)) {
    dataset.deletedDefaults = Object.fromEntries(
      dataset.deletedDefaults.map(key => [key, true]),
    );
    tracker.mark('deletedDefaults', 'shape');
  }
  migrateCapturedCharacters(dataset, tracker);
  migrateMapStatuses(dataset, tracker);
  migrateAttitudeRecords(dataset, tracker);
  migrateAttitudeSettings(dataset, tracker);
  migratePinTypes(dataset, tracker);
  migrateLocationFields(dataset, tracker);
  migrateArtifactFields(dataset, tracker);
  migrateRetiredSettings(dataset, tracker);
  migratePartyFaction(dataset, tracker);
  migratePartyAttitudes(dataset, tracker);
  migrateQuestionEntries(dataset, tracker);
  return tracker.summary();
}

module.exports = {
  CAMPAIGN_COLLECTION_SHAPES,
  CAMPAIGN_SHAPE_MIGRATION_ID,
  isKeyedObject,
  migrateCampaignShape,
};
