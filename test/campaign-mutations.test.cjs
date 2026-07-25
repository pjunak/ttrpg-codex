'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  CampaignMutationError,
  CampaignMutationService,
  ENUM_USAGE,
} = require('../server/campaign-mutations.cjs');

function fixture(seed, ids = ['generated-twin']) {
  const data = structuredClone(seed);
  const publications = [];
  const service = new CampaignMutationService({
    readCollection: async type => data[type] ?? (type === 'factions' || type === 'settings' ? {} : []),
    publishCollections: async collections => {
      publications.push(structuredClone(collections));
      Object.assign(data, structuredClone(collections));
    },
    createId: () => ids.shift() || 'fallback-twin',
    now: () => 123,
  });
  return { data, publications, service };
}

test('location save owns connection symmetry and preserves non-editable peers', async () => {
  const { data, publications, service } = fixture({
    locations: [
      { id: 'a', connections: ['hidden', 'removed'] },
      { id: 'kept', connections: [] },
      { id: 'removed', connections: ['a'] },
      { id: 'hidden', visibility: 'dm', connections: ['a'] },
    ],
  });

  await service.saveLocation(
    { id: 'a', connections: ['kept', 'hidden', 'missing'] },
    { editablePeer: peer => peer.visibility !== 'dm' },
  );

  assert.deepEqual(data.locations.find(location => location.id === 'a').connections, ['kept', 'hidden']);
  assert.deepEqual(data.locations.find(location => location.id === 'kept').connections, ['a']);
  assert.deepEqual(data.locations.find(location => location.id === 'removed').connections, []);
  assert.deepEqual(data.locations.find(location => location.id === 'hidden').connections, ['a']);
  assert.equal(data.locations.find(location => location.id === 'kept').lastChange.refs, true);
  assert.equal(publications.length, 1);
  assert.deepEqual(Object.keys(publications[0]), ['locations']);
});

test('character deletion closes every documented core reference in one publication', async () => {
  const { data, publications, service } = fixture({
    characters: [
      { id: 'gone', linkedTwinId: 'twin' },
      { id: 'twin', linkedTwinId: 'gone' },
    ],
    relationships: [
      { source: 'gone', target: 'twin', type: 'ally' },
      { source: 'twin', target: 'other', type: 'ally' },
    ],
    events: [{ id: 'event', characters: ['gone', 'twin'] }],
    mysteries: [{ id: 'mystery', characters: ['gone'] }],
    historicalEvents: [{ id: 'history', characters: ['gone'] }],
    artifacts: [{ id: 'artifact', ownerCharacterId: 'gone' }],
    pets: [{ id: 'pet', ownerType: 'character', ownerId: 'gone' }],
  });

  const result = await service.deleteEntity('characters', 'gone');

  assert.deepEqual(result.changed, [
    'artifacts',
    'characters',
    'events',
    'historicalEvents',
    'mysteries',
    'pets',
    'relationships',
  ]);
  assert.equal(data.characters.length, 1);
  assert.equal(data.characters[0].linkedTwinId, undefined);
  assert.equal(data.relationships.length, 1);
  assert.deepEqual(data.events[0].characters, ['twin']);
  assert.deepEqual(data.mysteries[0].characters, []);
  assert.deepEqual(data.historicalEvents[0].characters, []);
  assert.equal(data.artifacts[0].ownerCharacterId, '');
  assert.deepEqual(
    { ownerType: data.pets[0].ownerType, ownerId: data.pets[0].ownerId },
    { ownerType: 'none', ownerId: '' },
  );
  assert.equal(publications.length, 1);
});

test('location deletion clears hierarchy, map, character, lore, artifact, and setting references', async () => {
  const { data, service } = fixture({
    locations: [
      { id: 'gone', linkedTwinId: 'twin' },
      { id: 'twin', linkedTwinId: 'gone', parentId: 'gone', connections: ['gone'] },
    ],
    characters: [{
      id: 'character',
      location: 'gone',
      locationRoles: [{ locationId: 'gone', role: 'guard' }],
    }],
    events: [{
      id: 'event',
      locations: ['gone'],
      mapParentId: 'gone',
      mapX: 0.2,
      mapY: 0.3,
    }],
    mysteries: [{ id: 'mystery', locations: ['gone'] }],
    historicalEvents: [{ id: 'history', locations: ['gone'] }],
    artifacts: [{ id: 'artifact', locationId: 'gone' }],
    settings: {
      mapViews: [{ id: 'world' }, { id: 'local', parentId: 'gone' }],
      mapConfigs: { world: {}, 'local-gone': {} },
    },
  });

  await service.deleteEntity('locations', 'gone');

  assert.equal(data.locations.length, 1);
  assert.equal(data.locations[0].linkedTwinId, undefined);
  assert.equal(data.locations[0].parentId, '');
  assert.deepEqual(data.locations[0].connections, []);
  assert.equal(data.characters[0].location, '');
  assert.deepEqual(data.characters[0].locationRoles, []);
  assert.deepEqual(data.events[0].locations, []);
  assert.equal(data.events[0].mapParentId, undefined);
  assert.equal(data.events[0].mapX, undefined);
  assert.deepEqual(data.mysteries[0].locations, []);
  assert.deepEqual(data.historicalEvents[0].locations, []);
  assert.equal(data.artifacts[0].locationId, '');
  assert.deepEqual(data.settings.mapViews, [{ id: 'world' }]);
  assert.deepEqual(data.settings.mapConfigs, { world: {} });
});

test('faction deletion neutralizes members and preserves pets as unowned', async () => {
  const { data, service } = fixture({
    factions: {
      gone: { name: 'Gone', linkedTwinId: 'twin' },
      twin: { name: 'Twin', linkedTwinId: 'gone' },
    },
    characters: [{ id: 'member', faction: 'gone', rank: 'Captain', rankChain: 'army' }],
    pets: [{ id: 'pet', ownerType: 'faction', ownerId: 'gone' }],
  });

  await service.deleteEntity('factions', 'gone');

  assert.equal(data.factions.gone, undefined);
  assert.equal(data.factions.twin.linkedTwinId, undefined);
  assert.deepEqual(
    {
      faction: data.characters[0].faction,
      rank: data.characters[0].rank,
      rankChain: data.characters[0].rankChain,
    },
    { faction: 'neutral', rank: '', rankChain: '' },
  );
  assert.equal(data.pets[0].ownerType, 'none');
  assert.equal(data.pets[0].ownerId, '');
});

test('twin operations share one validator and one collection publication', async () => {
  const { data, service } = fixture({
    mysteries: [
      { id: 'public', name: 'Secret', visibility: 'public' },
      { id: 'dm-existing', name: 'Existing', visibility: 'dm' },
    ],
  });

  const created = await service.mutateTwin({
    action: 'create',
    type: 'mysteries',
    sourceId: 'public',
    keyed: false,
  });
  assert.equal(created.twinId, 'generated-twin');
  assert.equal(data.mysteries[0].linkedTwinId, 'generated-twin');
  assert.equal(data.mysteries[2].linkedTwinId, 'public');
  assert.equal(data.mysteries[2].visibility, 'dm');

  await assert.rejects(
    service.mutateTwin({
      action: 'link',
      type: 'mysteries',
      sourceId: 'public',
      targetId: 'dm-existing',
      keyed: false,
    }),
    error => error instanceof CampaignMutationError
      && error.status === 409
      && error.code === 'TWIN_EXISTS',
  );

  await service.mutateTwin({
    action: 'unlink',
    type: 'mysteries',
    sourceId: 'public',
    keyed: false,
  });
  assert.equal(data.mysteries[0].linkedTwinId, undefined);
  assert.equal(data.mysteries[2].linkedTwinId, undefined);
});

test('enum replacement, definition removal, and tombstone publish together', async () => {
  const { data, publications, service } = fixture({
    settings: {
      attitudes: [{ id: 'old' }, { id: 'new' }],
    },
    deletedDefaults: {},
    characters: [{ id: 'character', attitudes: [{ id: 'old' }, { id: 'new' }] }],
    locations: [{ id: 'location', attitudes: [{ id: 'old' }] }],
    factions: { faction: { attitudes: [{ id: 'old' }] } },
  });

  const result = await service.deleteEnumItem({
    category: 'attitudes',
    id: 'old',
    replaceWith: 'new',
    tombstone: true,
  });

  assert.equal(result.usages.length, 3);
  assert.deepEqual(data.settings.attitudes, [{ id: 'new' }]);
  assert.deepEqual(data.characters[0].attitudes, [{ id: 'new' }]);
  assert.deepEqual(data.locations[0].attitudes, [{ id: 'new' }]);
  assert.deepEqual(data.factions.faction.attitudes, [{ id: 'new' }]);
  assert.equal(data.deletedDefaults['settings:attitudes:old'], true);
  assert.equal(publications.length, 1);
  assert.deepEqual(Object.keys(publications[0]).sort(), [
    'characters',
    'deletedDefaults',
    'factions',
    'locations',
    'settings',
  ]);
});

test('enum deletion refuses live references without force or replacement', async () => {
  const { service } = fixture({
    settings: { genders: [{ id: 'old' }] },
    deletedDefaults: {},
    characters: [{ id: 'character', gender: 'old' }],
  });

  await assert.rejects(
    service.deleteEnumItem({ category: 'genders', id: 'old' }),
    error => error instanceof CampaignMutationError
      && error.code === 'ENUM_IN_USE'
      && error.usages.length === 1,
  );
});

test('server and browser enum usage descriptors remain identical', async () => {
  const dataModule = await import(
    `${pathToFileURL(path.join(__dirname, '..', 'web', 'js', 'data.js')).href}?enum-parity`
  );
  assert.deepEqual(ENUM_USAGE, dataModule.SETTINGS_USAGE_MAP);
});
