'use strict';

// Integration: the `pets` (Mazlíčci) collection is a plain PUBLIC list
// collection — added only to ALLOWED_TYPES + ALL_TYPES. It is NOT
// visibility-bearing, so:
//   - any authed role (player or DM) can create / edit / delete pets,
//   - GET /api/data returns pets to every caller (no role filtering),
//   - anonymous writes are still rejected.
// This guards the server-side wiring most likely to silently break
// (forgetting `pets` in one of the two type registries).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const path     = require('path');
const { startServer } = require('./helpers/server-process.cjs');

const DM     = 'dm-pw';
const PLAYER = 'player-pw';

async function loginAs(srv, password) {
  const r = await srv.fetch('/api/login', {
    method:  'POST', headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ password }),
  });
  assert.equal(r.status, 200);
}

async function readPet(srv, id) {
  try {
    const raw = await fsp.readFile(path.join(srv.dataDir, 'pets.json'), 'utf8');
    return JSON.parse(raw).find(p => p.id === id) || null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function savePet(srv, pet) {
  return srv.fetch('/api/data', {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ type: 'pets', action: 'save', payload: pet }),
  });
}

test('player: can create a pet (pets is in ALLOWED_TYPES)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, PLAYER);
    const res = await savePet(srv, { id: 'rex', name: 'Rex', icon: '🐺', ownerType: 'party', ownerId: '' });
    assert.equal(res.status, 200);
    const stored = await readPet(srv, 'rex');
    assert.ok(stored, 'pet persisted to pets.json');
    assert.equal(stored.name, 'Rex');
    assert.equal(stored.ownerType, 'party');
  } finally { await srv.kill(); }
});

test('DM: can create a pet', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, DM);
    const res = await savePet(srv, { id: 'shadow', name: 'Shadow', ownerType: 'faction', ownerId: 'cult' });
    assert.equal(res.status, 200);
    assert.equal((await readPet(srv, 'shadow')).ownerType, 'faction');
  } finally { await srv.kill(); }
});

test('GET /api/data returns pets to anonymous/player AND DM (not visibility-filtered)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: { 'pets.json': [{ id: 'mascot', name: 'Mascot', ownerType: 'party', ownerId: '' }] },
  });
  try {
    // Anonymous caller is treated as a player — pets must still come through.
    const anon = await (await srv.fetch('/api/data')).json();
    assert.ok(Array.isArray(anon.pets), 'pets present in payload');
    assert.ok(anon.pets.find(p => p.id === 'mascot'), 'anonymous/player sees the pet');

    await loginAs(srv, DM);
    const dm = await (await srv.fetch('/api/data')).json();
    assert.ok(dm.pets.find(p => p.id === 'mascot'), 'DM sees the pet too');
  } finally { await srv.kill(); }
});

test('player: can delete a pet', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: { 'pets.json': [{ id: 'gone', name: 'Gone', ownerType: 'none', ownerId: '' }] },
  });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'pets', action: 'delete', payload: { id: 'gone' } }),
    });
    assert.equal(res.status, 200);
    assert.equal(await readPet(srv, 'gone'), null, 'pet removed from disk');
  } finally { await srv.kill(); }
});

test('anonymous: cannot create a pet (401)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const res = await savePet(srv, { id: 'x', name: 'X', ownerType: 'none', ownerId: '' });
    assert.equal(res.status, 401);
    assert.equal(await readPet(srv, 'x'), null);
  } finally { await srv.kill(); }
});
