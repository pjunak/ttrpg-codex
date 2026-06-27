'use strict';

// Integration: addon-OWNED collections (Phase 4b-2). An enabled addon that
// declares `collections` in its manifest gets a colon-namespaced wire type
// `addon:<id>:<name>` registered into the server type system at boot, riding
// the generic GET/PATCH /api/data path. The data lives ISOLATED at
// data/addon-data/<id>/<name>.json (not in the flat data root), is public +
// non-visibility-bearing (like pets), and is covered by the data hash +
// snapshots. This guards the riskiest surgery this phase touched: getFile
// routing, ALLOWED/ALL/KEYED type augmentation, and snapshot/hash coverage.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const path     = require('path');
const { startServer } = require('./helpers/server-process.cjs');

const DM     = 'dm-pw';
const PLAYER = 'player-pw';

// A seeded registry with two enabled addons: a list collection (`rules:rules`)
// and a keyed-object collection (`cfg:config`). No code on disk is needed —
// the data path is independent of the client import.
function registry() {
  return {
    schema: 1,
    addons: [
      { id: 'rules', name: 'Rules', version: '0.1.0', apiVersion: 1, enabled: true,
        entry: 'entry.js', activeHash: 'abc', collections: [{ name: 'rules', keyed: false }] },
      { id: 'cfg', name: 'Cfg', version: '0.1.0', apiVersion: 1, enabled: true,
        entry: 'entry.js', activeHash: 'def', collections: [{ name: 'config', keyed: true }] },
    ],
    resolutions: {}, sources: { allow: [] },
  };
}

async function loginAs(srv, password) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(r.status, 200);
}

function patch(srv, type, action, payload) {
  return srv.fetch('/api/data', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, action, payload }),
  });
}

async function readAddonFile(srv, id, name) {
  try {
    const raw = await fsp.readFile(path.join(srv.dataDir, 'addon-data', id, name + '.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

test('addon list collection: PATCH persists to the isolated dir + GET returns it', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: { 'addons.json': registry() } });
  try {
    await loginAs(srv, DM);
    const res = await patch(srv, 'addon:rules:rules', 'save', { id: 'grappling', name: 'Grappling', body: 'Rules text' });
    assert.equal(res.status, 200);

    const onDisk = await readAddonFile(srv, 'rules', 'rules');
    assert.ok(Array.isArray(onDisk), 'stored as an entity-list array');
    assert.equal(onDisk[0].name, 'Grappling');

    const data = await (await srv.fetch('/api/data')).json();
    assert.ok(Array.isArray(data['addon:rules:rules']), 'addon collection present in GET payload');
    assert.equal(data['addon:rules:rules'][0].id, 'grappling');
  } finally { await srv.kill(); }
});

test('addon keyed collection: round-trips as a keyed object; proto keys rejected', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: { 'addons.json': registry() } });
  try {
    await loginAs(srv, DM);
    const ok = await patch(srv, 'addon:cfg:config', 'save', { id: 'main', data: { theme: 'dark' } });
    assert.equal(ok.status, 200);
    const onDisk = await readAddonFile(srv, 'cfg', 'config');
    assert.equal(onDisk.main.theme, 'dark', 'keyed write lands under its id');
    assert.ok(!Array.isArray(onDisk), 'keyed collection is an object, not an array');

    // Prototype-pollution guard extends to addon keyed collections.
    const bad = await patch(srv, 'addon:cfg:config', 'save', { id: '__proto__', data: {} });
    assert.equal(bad.status, 400);
  } finally { await srv.kill(); }
});

test('addon collections are public (player writes, anonymous rejected)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: { 'addons.json': registry() } });
  try {
    // Anonymous write rejected.
    const anon = await patch(srv, 'addon:rules:rules', 'save', { id: 'x', name: 'X' });
    assert.equal(anon.status, 401);

    // Player can write (non-visibility-bearing, like pets).
    await loginAs(srv, PLAYER);
    const player = await patch(srv, 'addon:rules:rules', 'save', { id: 'y', name: 'Y' });
    assert.equal(player.status, 200);
    assert.equal((await readAddonFile(srv, 'rules', 'rules'))[0].name, 'Y');
  } finally { await srv.kill(); }
});

test('an undeclared addon collection is rejected (400 unknown collection)', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: { 'addons.json': registry() } });
  try {
    await loginAs(srv, DM);
    // No addon "ghost" in the registry → its type was never registered.
    const res = await patch(srv, 'addon:ghost:secrets', 'save', { id: 'a' });
    assert.equal(res.status, 400);
  } finally { await srv.kill(); }
});

test('addon collection writes change the data hash (SSE propagation)', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: { 'addons.json': registry() } });
  try {
    await loginAs(srv, DM);
    const before = (await (await srv.fetch('/api/version')).json()).hash;
    await patch(srv, 'addon:rules:rules', 'save', { id: 'a', name: 'A' });
    const after = (await (await srv.fetch('/api/version')).json()).hash;
    assert.notEqual(before, after, 'addon-data write must bust the hash so other clients refetch');
  } finally { await srv.kill(); }
});

test('snapshots cover addon-data: restore brings a deleted addon item back', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: { 'addons.json': registry() } });
  try {
    await loginAs(srv, DM);
    await patch(srv, 'addon:rules:rules', 'save', { id: 'keep', name: 'Keep' });

    // Manual snapshot (bypasses the coalesce window) captures addon-data.
    const snap = await (await srv.fetch('/api/snapshots', { method: 'POST' })).json();
    assert.ok(snap.id, 'snapshot created');

    // Delete the item, confirm it's gone, then restore the snapshot.
    await patch(srv, 'addon:rules:rules', 'delete', { id: 'keep' });
    assert.equal((await readAddonFile(srv, 'rules', 'rules')).length, 0, 'item deleted');

    const r = await srv.fetch(`/api/snapshots/${snap.id}/restore`, { method: 'POST' });
    assert.equal(r.status, 200);
    const restored = await readAddonFile(srv, 'rules', 'rules');
    assert.ok(restored.find(x => x.id === 'keep'), 'addon item restored from snapshot');
  } finally { await srv.kill(); }
});
