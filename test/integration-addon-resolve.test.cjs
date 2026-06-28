'use strict';

// Integration: POST /api/addons/resolve — DM-only fragment-override conflict
// resolution (Phase 6). Writes resolutions[target] into data/addons.json and
// surfaces the map on GET /api/addons so the client host applies the winner.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { startServer } = require('./helpers/server-process.cjs');

const DM = 'dm-pw', PLAYER = 'player-pw';
// A 'sheet' addon is installed so it's a VALID resolution winner (the server
// rejects a winner that isn't installed — see the dedicated test below).
const sheetAddon = { id: 'sheet', name: 'Sheet', version: '0.1.0', apiVersion: 1, enabled: true, activeHash: 'h1', entry: 'entry.js', grantedPermissions: [] };
const seed = () => ({ 'addons.json': { schema: 1, addons: [sheetAddon], resolutions: {}, sources: { allow: [] } } });

async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}
function resolve(srv, body) {
  return srv.fetch('/api/addons/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const getResolutions = async (srv) => (await (await srv.fetch('/api/addons')).json()).resolutions;

test('DM resolve sets resolutions[target] and it shows on GET /api/addons', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: seed() });
  try {
    await login(srv, DM);
    const r = await resolve(srv, { target: 'characters:body', winner: 'sheet' });
    assert.equal(r.status, 200);
    assert.equal((await getResolutions(srv))['characters:body'], 'sheet');
  } finally { await srv.kill(); }
});

test('winner:null forces built-in; absent winner clears the resolution', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: seed() });
  try {
    await login(srv, DM);
    await resolve(srv, { target: 'characters:body', winner: null });
    let res = await getResolutions(srv);
    assert.equal(res['characters:body'], null);
    assert.ok('characters:body' in res, 'null is a stored value (force built-in), not a clear');

    await resolve(srv, { target: 'characters:body' });   // no winner → clear
    res = await getResolutions(srv);
    assert.equal('characters:body' in res, false);
  } finally { await srv.kill(); }
});

test('player + anonymous cannot resolve (403)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: seed() });
  try {
    assert.equal((await resolve(srv, { target: 'characters:body', winner: 'sheet' })).status, 403);
    await login(srv, PLAYER);
    assert.equal((await resolve(srv, { target: 'characters:body', winner: 'sheet' })).status, 403);
  } finally { await srv.kill(); }
});

test('a forbidden target key is rejected (400)', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: seed() });
  try {
    await login(srv, DM);
    assert.equal((await resolve(srv, { target: '__proto__', winner: 'sheet' })).status, 400);
  } finally { await srv.kill(); }
});

test('a winner that is not installed is rejected (400) — no silent no-op resolution', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: seed() });
  try {
    await login(srv, DM);
    // 'ghost' isn't in the registry — resolving to it would otherwise read as
    // resolved while applying nothing.
    assert.equal((await resolve(srv, { target: 'characters:body', winner: 'ghost' })).status, 400);
    assert.equal('characters:body' in (await getResolutions(srv)), false, 'nothing was written');
    // but the real installed addon resolves fine:
    assert.equal((await resolve(srv, { target: 'characters:body', winner: 'sheet' })).status, 200);
  } finally { await srv.kill(); }
});
