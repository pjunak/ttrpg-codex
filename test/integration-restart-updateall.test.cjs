'use strict';

// Integration: POST /api/restart (DM-only self-restart, gated on RESTARTABLE) and
// POST /api/addons/update-all (DM-only bulk update; local/dev addons skipped).
//
// The default test env is NOT restartable (no /.dockerenv, CODEX_RESTARTABLE
// unset), so /api/restart returns 400 for the DM instead of exiting. (Even if it
// did exit, the server runs as a CHILD process — see helpers/server-process.cjs —
// so the runner is never killed.) update-all is exercised against a local-only
// addon, which is skipped without any GitHub fetch.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { startServer } = require('./helpers/server-process.cjs');

const DM = 'dm-pw', PLAYER = 'player-pw';
const localAddon = {
  id: 'sheet', name: 'Sheet', version: '0.1.0', apiVersion: 1, enabled: true,
  activeHash: 'h1', entry: 'entry.js', server: null,
  repo: 'local', ref: 'local', sha: 'local', grantedPermissions: [],
};
const seed = () => ({ 'addons.json': { schema: 1, addons: [localAddon], resolutions: {}, sources: { allow: [] } } });

async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}
const post = (srv, path) => srv.fetch(path, { method: 'POST' });

test('GET /api/version reports canRestart=false in a non-Docker test env', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: seed() });
  try {
    const v = await (await srv.fetch('/api/version')).json();
    assert.equal(v.canRestart, false, 'no /.dockerenv + no CODEX_RESTARTABLE → not restartable');
  } finally { await srv.kill(); }
});

test('GET /api/version reports canRestart=true when CODEX_RESTARTABLE=1', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: seed(), env: { CODEX_RESTARTABLE: '1' } });
  try {
    const v = await (await srv.fetch('/api/version')).json();
    assert.equal(v.canRestart, true, 'explicit opt-in env enables restartability');
  } finally { await srv.kill(); }
});

test('POST /api/restart: anonymous + player → 403; DM → 400 when not restartable (no exit)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: seed() });
  try {
    assert.equal((await post(srv, '/api/restart')).status, 403);
    await login(srv, PLAYER);
    assert.equal((await post(srv, '/api/restart')).status, 403);
    await login(srv, DM);
    const r = await post(srv, '/api/restart');
    assert.equal(r.status, 400, 'DM gets 400 (not a restart) because the env is not restartable');
    assert.match((await r.json()).error || '', /[Rr]estart/);
  } finally { await srv.kill(); }
});

test('POST /api/addons/update-all: anonymous + player → 403', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER, seedData: seed() });
  try {
    assert.equal((await post(srv, '/api/addons/update-all')).status, 403);
    await login(srv, PLAYER);
    assert.equal((await post(srv, '/api/addons/update-all')).status, 403);
  } finally { await srv.kill(); }
});

test('POST /api/addons/update-all: DM with only a local addon → 200, skipped (no network)', async () => {
  const srv = await startServer({ dmPassword: DM, seedData: seed() });
  try {
    await login(srv, DM);
    const r = await post(srv, '/api/addons/update-all');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.updated, [], 'nothing updated');
    assert.equal(body.errors.length, 0, 'no per-addon errors');
    assert.equal(body.skipped.length, 1);
    assert.equal(body.skipped[0].reason, 'local', 'the dev-installed addon is skipped, not fetched');
    assert.equal(body.serverChanged, false);
  } finally { await srv.kill(); }
});
