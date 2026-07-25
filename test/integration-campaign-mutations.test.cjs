'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startServer } = require('./helpers/server-process.cjs');

const fsp = fs.promises;
const DM_PASSWORD = 'dm-pw';

async function login(srv) {
  const response = await srv.fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DM_PASSWORD }),
  });
  assert.equal(response.status, 200);
}

async function patch(srv, type, action, payload) {
  return srv.fetch('/api/data', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, action, payload }),
  });
}

async function read(srv, type) {
  return JSON.parse(await fsp.readFile(path.join(srv.dataDir, `${type}.json`), 'utf8'));
}

test('core compound mutations persist one closed campaign state', async () => {
  const srv = await startServer({
    dmPassword: DM_PASSWORD,
    seedData: {
      'characters.json': [
        {
          id: 'character',
          faction: 'faction',
          location: 'location',
          linkedTwinId: 'character-twin',
        },
        { id: 'character-twin', linkedTwinId: 'character', visibility: 'dm' },
        { id: 'faction-member', faction: 'faction', rank: 'Captain', rankChain: 'army' },
      ],
      'relationships.json': [
        { source: 'character', target: 'other', type: 'ally' },
      ],
      'locations.json': [
        { id: 'location', connections: [] },
        { id: 'peer', connections: [] },
        { id: 'child', parentId: 'location', connections: ['location'] },
      ],
      'events.json': [{
        id: 'event',
        characters: ['character'],
        locations: ['location'],
        mapParentId: 'location',
        mapX: 0.2,
        mapY: 0.3,
      }],
      'mysteries.json': [{
        id: 'mystery',
        characters: ['character'],
        locations: ['location'],
      }],
      'historicalEvents.json': [{
        id: 'history',
        characters: ['character'],
        locations: ['location'],
      }],
      'artifacts.json': [{
        id: 'artifact',
        ownerCharacterId: 'character',
        locationId: 'location',
      }],
      'pets.json': [
        { id: 'character-pet', ownerType: 'character', ownerId: 'character' },
        { id: 'faction-pet', ownerType: 'faction', ownerId: 'faction' },
      ],
      'factions.json': {
        faction: { name: 'Faction' },
      },
      'settings.json': {
        mapViews: [{ id: 'world' }, { id: 'local', parentId: 'location' }],
        mapConfigs: { world: {}, 'local-location': {} },
      },
    },
  });
  try {
    await login(srv);

    let response = await patch(srv, 'locations', 'save', {
      id: 'location',
      connections: ['peer'],
      visibility: 'public',
    });
    assert.equal(response.status, 200);
    let locations = await read(srv, 'locations');
    assert.deepEqual(locations.find(location => location.id === 'peer').connections, ['location']);
    assert.deepEqual(locations.find(location => location.id === 'child').connections, []);

    response = await patch(srv, 'characters', 'delete', { id: 'character' });
    assert.equal(response.status, 200);
    const characters = await read(srv, 'characters');
    assert.equal(characters.some(character => character.id === 'character'), false);
    assert.equal(characters.find(character => character.id === 'character-twin').linkedTwinId, undefined);
    assert.deepEqual(await read(srv, 'relationships'), []);
    assert.deepEqual((await read(srv, 'events'))[0].characters, []);
    assert.deepEqual((await read(srv, 'mysteries'))[0].characters, []);
    assert.deepEqual((await read(srv, 'historicalEvents'))[0].characters, []);
    assert.equal((await read(srv, 'artifacts'))[0].ownerCharacterId, '');
    assert.equal((await read(srv, 'pets'))[0].ownerType, 'none');

    response = await patch(srv, 'locations', 'delete', { id: 'location' });
    assert.equal(response.status, 200);
    locations = await read(srv, 'locations');
    assert.equal(locations.some(location => location.id === 'location'), false);
    assert.equal(locations.find(location => location.id === 'child').parentId, '');
    assert.deepEqual(locations.find(location => location.id === 'peer').connections, []);
    const event = (await read(srv, 'events'))[0];
    assert.deepEqual(event.locations, []);
    assert.equal(event.mapParentId, undefined);
    assert.deepEqual((await read(srv, 'mysteries'))[0].locations, []);
    assert.deepEqual((await read(srv, 'historicalEvents'))[0].locations, []);
    assert.equal((await read(srv, 'artifacts'))[0].locationId, '');
    const settings = await read(srv, 'settings');
    assert.deepEqual(settings.mapViews, [{ id: 'world' }]);
    assert.deepEqual(settings.mapConfigs, { world: {} });

    response = await patch(srv, 'factions', 'delete', { id: 'faction' });
    assert.equal(response.status, 200);
    assert.equal((await read(srv, 'factions')).faction, undefined);
    assert.equal((await read(srv, 'pets'))[1].ownerType, 'none');
    const member = (await read(srv, 'characters'))
      .find(character => character.id === 'faction-member');
    assert.equal(member.faction, 'neutral');
    assert.equal(member.rank, '');
    assert.equal(member.rankChain, '');
  } finally {
    await srv.kill();
  }
});

test('player location saves preserve hidden DM peer connections', async () => {
  const srv = await startServer({
    dmPassword: DM_PASSWORD,
    playerPassword: 'player-pw',
    seedData: {
      'locations.json': [
        { id: 'public', visibility: 'public', connections: ['hidden'] },
        { id: 'hidden', visibility: 'dm', connections: ['public'] },
      ],
    },
  });
  try {
    const loginResponse = await srv.fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'player-pw' }),
    });
    assert.equal(loginResponse.status, 200);

    const response = await patch(srv, 'locations', 'save', {
      id: 'public',
      visibility: 'public',
      connections: [],
    });
    assert.equal(response.status, 200);
    const locations = await read(srv, 'locations');
    assert.deepEqual(locations.find(location => location.id === 'public').connections, ['hidden']);
    assert.deepEqual(locations.find(location => location.id === 'hidden').connections, ['public']);
  } finally {
    await srv.kill();
  }
});

test('compound mutation failure rolls every affected collection back', async () => {
  const srv = await startServer({
    dmPassword: DM_PASSWORD,
    env: { CODEX_MUTATION_FAIL_PHASE: 'publish:1:after' },
    seedData: {
      'characters.json': [{ id: 'kept' }],
      'relationships.json': [{ source: 'kept', target: 'other', type: 'ally' }],
      'events.json': [{ id: 'event', characters: ['kept'] }],
    },
  });
  try {
    await login(srv);
    const response = await patch(srv, 'characters', 'delete', { id: 'kept' });
    assert.equal(response.status, 500);
    assert.equal((await read(srv, 'characters'))[0].id, 'kept');
    assert.equal((await read(srv, 'relationships'))[0].source, 'kept');
    assert.deepEqual((await read(srv, 'events'))[0].characters, ['kept']);
    assert.deepEqual(
      await fsp.readdir(path.join(srv.dataDir, '.runtime', 'mutations')),
      [],
    );
  } finally {
    await srv.kill();
  }
});

test('startup completes an interrupted compound mutation before serving data', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-mutation-data-'));
  const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-mutation-snaps-'));
  let crashed;
  let recovered;
  try {
    crashed = await startServer({
      dataDir,
      snapshotsDir,
      dmPassword: DM_PASSWORD,
      env: { CODEX_MUTATION_CRASH_PHASE: 'journal:prepared:after' },
      seedData: {
        'characters.json': [{ id: 'gone' }],
        'events.json': [{ id: 'event', characters: ['gone'] }],
      },
    });
    await login(crashed);
    await assert.rejects(patch(crashed, 'characters', 'delete', { id: 'gone' }));
    await crashed.kill();

    recovered = await startServer({ dataDir, snapshotsDir, dmPassword: DM_PASSWORD });
    assert.deepEqual(await read(recovered, 'characters'), []);
    assert.deepEqual((await read(recovered, 'events'))[0].characters, []);
    assert.deepEqual(
      await fsp.readdir(path.join(dataDir, '.runtime', 'mutations')),
      [],
    );
  } finally {
    if (crashed) await crashed.kill();
    if (recovered) await recovered.kill();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fsp.rm(snapshotsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('enum replacement publishes definitions, usages, and tombstones atomically', async () => {
  const srv = await startServer({
    dmPassword: DM_PASSWORD,
    seedData: {
      'settings.json': { genders: [{ id: 'old' }, { id: 'new' }] },
      'deletedDefaults.json': {},
      'characters.json': [{ id: 'character', gender: 'old' }],
    },
  });
  try {
    await login(srv);
    const response = await srv.fetch('/api/campaign/enums/genders/old', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replaceWith: 'new', tombstone: true }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).usages.length, 1);
    assert.deepEqual((await read(srv, 'settings')).genders, [{ id: 'new' }]);
    assert.equal((await read(srv, 'characters'))[0].gender, 'new');
    assert.equal(
      (await read(srv, 'deletedDefaults'))['settings:genders:old'],
      true,
    );
  } finally {
    await srv.kill();
  }
});
