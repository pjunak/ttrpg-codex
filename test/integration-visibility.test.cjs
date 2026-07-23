'use strict';

// Integration: end-to-end visibility filtering through the live
// HTTP stack. Boots the real server, seeds DM-only / public /
// twinned records, and asserts what reaches the player wire.
//
// The player projection is a closed graph:
//   1. DM-only entities are absent.
//   2. `linkedTwinId` is absent on every surviving entity.
//   3. Documented reference fields contain only surviving entity ids.

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const { startServer } = require('./helpers/server-process.cjs');

const DM     = 'dm-pw';
const PLAYER = 'player-pw';

async function loginAs(srv, password) {
  const res = await srv.fetch('/api/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ password }),
  });
  assert.equal(res.status, 200, 'login failed');
}

async function fetchData(srv) {
  const res = await srv.fetch('/api/data');
  assert.equal(res.status, 200);
  return await res.json();
}

function commonSeed() {
  return {
    'characters.json': [
      {
        id: 'pub_alice',
        name: 'Alice',
        faction: 'neutral',
        description: 'A merchant.',
        visibility: 'public',
      },
      {
        id: 'dm_villain',
        name: 'The Villain',
        faction: 'cult_high',
        description: 'Plot-twist material.',
        visibility: 'dm',
      },
      {
        id: 'pub_twinned',
        name: 'Stranger',
        faction: 'neutral',
        description: 'A hooded figure.',
        visibility: 'public',
        linkedTwinId: 'dm_twinned',
      },
      {
        id: 'dm_twinned',
        name: 'Frulam Mondath',
        faction: 'cult_high',
        description: 'Wearer of Purple.',
        visibility: 'dm',
        linkedTwinId: 'pub_twinned',
      },
    ],
    'factions.json': {
      neutral:   { id: 'neutral',   name: 'Neutral',   description: 'Public.', visibility: 'public' },
      cult_high: { id: 'cult_high', name: 'Hidden Cult', description: 'DM-only.', visibility: 'dm' },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

test('GET /api/data: anonymous receives player-filtered payload (no DM-only entities, no linkedTwinId)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: commonSeed() });
  try {
    const data = await fetchData(srv);
    const ids = data.characters.map(c => c.id);
    assert.equal(ids.includes('dm_villain'),  false);
    assert.equal(ids.includes('dm_twinned'),  false);
    // pub_twinned IS visible but the linkedTwinId pointing at the DM
    // sibling must NOT be in the payload — players shouldn't be able
    // to infer that this entity has DM lore.
    const stranger = data.characters.find(c => c.id === 'pub_twinned');
    assert.ok(stranger, 'public twin should be visible to player');
    assert.equal(Object.prototype.hasOwnProperty.call(stranger, 'linkedTwinId'), false,
      'linkedTwinId must be stripped from player payload');
    // DM-only faction missing.
    assert.equal(Object.prototype.hasOwnProperty.call(data.factions, 'cult_high'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data.factions, 'neutral'),   true);
  } finally { await srv.kill(); }
});

test('GET /api/data: player session matches anonymous behavior', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: commonSeed() });
  try {
    await loginAs(srv, PLAYER);
    const data = await fetchData(srv);
    const ids = data.characters.map(c => c.id);
    assert.equal(ids.includes('dm_villain'), false);
    assert.equal(ids.includes('dm_twinned'), false);
  } finally { await srv.kill(); }
});

test('GET /api/data: DM session receives EVERY entity + linkedTwinId intact', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: commonSeed() });
  try {
    await loginAs(srv, DM);
    const data = await fetchData(srv);
    assert.equal(data.characters.length, 4);
    const stranger = data.characters.find(c => c.id === 'pub_twinned');
    const frulam   = data.characters.find(c => c.id === 'dm_twinned');
    assert.equal(stranger.linkedTwinId, 'dm_twinned');
    assert.equal(frulam.linkedTwinId,   'pub_twinned');
    // DM-only faction present.
    assert.equal(Object.prototype.hasOwnProperty.call(data.factions, 'cult_high'), true);
  } finally { await srv.kill(); }
});

test('GET /api/data: DM impersonating player gets the player-filtered payload', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: commonSeed() });
  try {
    await loginAs(srv, DM);
    await srv.fetch('/api/view-as', { method: 'POST' });
    const data = await fetchData(srv);
    const ids = data.characters.map(c => c.id);
    assert.equal(ids.includes('dm_villain'), false, 'impersonation must hide DM content');
    const stranger = data.characters.find(c => c.id === 'pub_twinned');
    assert.equal(Object.prototype.hasOwnProperty.call(stranger, 'linkedTwinId'), false);
  } finally { await srv.kill(); }
});

test('GET /api/data: raw bytes do NOT contain any DM-only substring (no DevTools leak)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: commonSeed() });
  try {
    const res  = await srv.fetch('/api/data');
    const text = await res.text();
    assert.equal(text.includes('Plot-twist material'),  false, 'DM-only entity description leaked');
    assert.equal(text.includes('Wearer of Purple'),     false, 'DM-only twin description leaked');
    assert.equal(text.includes('dm_twinned'),           false, 'DM-only entity id leaked via linkedTwinId');
    assert.equal(text.includes('linkedTwinId'),         false, 'linkedTwinId field leaked');
    assert.equal(text.includes('Hidden Cult'),          false, 'DM-only faction name leaked');
    // Sanity: public content IS in the response.
    assert.equal(text.includes('A merchant'), true);
    assert.equal(text.includes('A hooded figure'), true);
  } finally { await srv.kill(); }
});

test('GET /api/data: player wire is closed over all documented cross-collection references', async () => {
  const addonRegistry = {
    schema: 1,
    addons: [{
      id: 'notes', name: 'Notes', version: '0.1.0', apiVersion: 1,
      enabled: true, entry: 'entry.js', activeHash: 'abc',
      collections: [{ name: 'notes', keyed: false }],
    }],
    resolutions: {}, sources: { allow: [] },
  };
  const seedData = {
    'addons.json': addonRegistry,
    'characters.json': [
      { id: 'char_public', name: 'Public Character', faction: 'faction_hidden',
        location: 'loc_hidden', locationRoles: [{ locationId: 'loc_hidden', role: 'spy' }],
        lastChange: { fields: [{ key: 'faction', from: 'faction_hidden', to: 'neutral' }] },
        visibility: 'public' },
      { id: 'char_hidden', name: 'Hidden Character', faction: 'faction_hidden', visibility: 'dm' },
    ],
    'factions.json': {
      faction_public: { id: 'faction_public', name: 'Public Faction', visibility: 'public' },
      faction_hidden: { id: 'faction_hidden', name: 'Hidden Faction', visibility: 'dm' },
    },
    'locations.json': [
      { id: 'loc_public', name: 'Public Location', parentId: 'loc_hidden',
        connections: ['loc_hidden'], characters: ['char_hidden'], visibility: 'public' },
      { id: 'loc_hidden', name: 'Hidden Location', visibility: 'dm' },
    ],
    'events.json': [
      { id: 'event_public', name: 'Public Event', characters: ['char_hidden'],
        locations: ['loc_hidden'], mapParentId: 'loc_hidden', visibility: 'public' },
      { id: 'event_hidden', name: 'Hidden Event', visibility: 'dm' },
    ],
    'mysteries.json': [
      { id: 'mystery_public', name: 'Public Mystery', characters: ['char_hidden'],
        locations: ['loc_hidden'], visibility: 'public' },
      { id: 'mystery_hidden', name: 'Hidden Mystery', visibility: 'dm' },
    ],
    'relationships.json': [
      { id: 'hidden-character-edge', source: 'char_public', target: 'char_hidden', type: 'ally', visibility: 'public' },
      { id: 'hidden-location-edge', source: 'char_public', target: 'loc_hidden', type: 'mission', visibility: 'public' },
    ],
    'artifacts.json': [
      { id: 'artifact_public', name: 'Public Artifact', ownerCharacterId: 'char_hidden',
        locationId: 'loc_hidden', visibility: 'public' },
    ],
    'historicalEvents.json': [
      { id: 'history_public', name: 'Public History', characters: ['char_hidden'],
        locations: ['loc_hidden'], visibility: 'public' },
    ],
    'pets.json': [
      { id: 'pet_public', name: 'Public Pet', ownerType: 'faction', ownerId: 'faction_hidden' },
    ],
    'settings.json': {
      relationshipTypes: [{ id: 'ally', target: 'character' }, { id: 'mission', target: 'location' }],
      mapViews: [{ id: 'hidden-map-view', parentId: 'loc_hidden' }],
      mapConfigs: { 'local-loc_hidden': { zoomScaleRatio: 1 } },
    },
  };
  const srv = await startServer({
    dmPassword: DM,
    playerPassword: PLAYER,
    seedData,
    seedFiles: {
      'addon-data/notes/notes.json': [{ id: 'addon_public', body: 'Public addon record' }],
    },
  });
  try {
    const playerRes = await srv.fetch('/api/data');
    const playerText = await playerRes.text();
    for (const hidden of [
      'char_hidden', 'faction_hidden', 'loc_hidden', 'event_hidden', 'mystery_hidden',
      'Hidden Character', 'Hidden Faction', 'Hidden Location', 'Hidden Event', 'Hidden Mystery',
    ]) {
      assert.equal(playerText.includes(hidden), false, `${hidden} leaked in raw player bytes`);
    }

    const player = JSON.parse(playerText);
    const character = player.characters[0];
    assert.equal(Object.hasOwn(character, 'faction'), false);
    assert.equal(Object.hasOwn(character, 'location'), false);
    assert.deepEqual(character.locationRoles, []);
    assert.deepEqual(character.lastChange.fields, []);
    assert.deepEqual(player.locations[0].connections, []);
    assert.deepEqual(player.locations[0].characters, []);
    assert.deepEqual(player.events[0].characters, []);
    assert.deepEqual(player.events[0].locations, []);
    assert.equal(Object.hasOwn(player.events[0], 'mapParentId'), false);
    assert.deepEqual(player.mysteries[0].characters, []);
    assert.deepEqual(player.mysteries[0].locations, []);
    assert.deepEqual(player.relationships, []);
    assert.equal(Object.hasOwn(player.artifacts[0], 'ownerCharacterId'), false);
    assert.equal(Object.hasOwn(player.artifacts[0], 'locationId'), false);
    assert.deepEqual(player.historicalEvents[0].characters, []);
    assert.deepEqual(player.historicalEvents[0].locations, []);
    assert.deepEqual(player.pets[0], { id: 'pet_public', name: 'Public Pet', ownerType: 'none', ownerId: '' });
    assert.deepEqual(player.settings.mapViews, []);
    assert.deepEqual(player.settings.mapConfigs, {});
    assert.deepEqual(player['addon:notes:notes'], [{ id: 'addon_public', body: 'Public addon record' }]);

    await loginAs(srv, DM);
    const dm = await fetchData(srv);
    assert.equal(dm.characters[0].faction, 'faction_hidden');
    assert.equal(dm.characters[0].location, 'loc_hidden');
    assert.deepEqual(dm.relationships.map(r => r.id), ['hidden-character-edge', 'hidden-location-edge']);
    assert.equal(dm.artifacts[0].ownerCharacterId, 'char_hidden');
    assert.equal(dm.settings.mapViews[0].parentId, 'loc_hidden');
    assert.equal(dm.settings.mapConfigs['local-loc_hidden'].zoomScaleRatio, 1);
  } finally { await srv.kill(); }
});

test('PATCH+GET round-trip: DM creates a DM-only char, player view never sees it', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, DM);
    const patch = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: {
          id: 'spy_42', name: 'Hidden Spy', faction: 'cult_high',
          description: 'Sold the queen out.',
          visibility: 'dm',
        },
      }),
    });
    assert.equal(patch.status, 200);

    const dmData = await fetchData(srv);
    assert.equal(dmData.characters.find(c => c.id === 'spy_42').name, 'Hidden Spy');

    srv.clearCookies();
    const playerData = await fetchData(srv);
    assert.equal(playerData.characters.find(c => c.id === 'spy_42'), undefined);
  } finally { await srv.kill(); }
});

test('PATCH /api/data: PC (faction=party) cannot be marked DM-only (server enforces)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, DM);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: { id: 'pc_kira', name: 'Kira', faction: 'party', visibility: 'dm' },
      }),
    });
    assert.equal(res.status, 400);
  } finally { await srv.kill(); }
});

test('Settings collection is not filtered (shared metadata)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'settings.json': {
        attitudes: [{ id: 'ally', label: 'Spojenec' }],
      },
    },
  });
  try {
    const data = await fetchData(srv);
    assert.deepEqual(data.settings.attitudes, [{ id: 'ally', label: 'Spojenec' }]);
  } finally { await srv.kill(); }
});

test('Relationships: DM-only relationship hidden from player payload', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [
        { id: 'a', name: 'A', faction: 'neutral', visibility: 'public' },
        { id: 'b', name: 'B', faction: 'neutral', visibility: 'public' },
      ],
      'relationships.json': [
        { source: 'a', target: 'b', type: 'ally',     visibility: 'public' },
        { source: 'a', target: 'b', type: 'commands', visibility: 'dm'     },
      ],
    },
  });
  try {
    await loginAs(srv, DM);
    const dmData = await fetchData(srv);
    assert.equal(dmData.relationships.length, 2);
    srv.clearCookies();
    const playerData = await fetchData(srv);
    assert.equal(playerData.relationships.length, 1);
    assert.equal(playerData.relationships[0].type, 'ally');
  } finally { await srv.kill(); }
});
