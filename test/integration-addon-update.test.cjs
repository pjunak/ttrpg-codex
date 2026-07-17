'use strict';

// Integration: addon update-check + content-addressed rollback (Phase 9).
// Rollback is fully local (registry flip — no network), so it's exercised end
// to end. check-updates' GitHub diff needs the network; the offline-testable
// parts (role gating, empty, local-skip) are covered here.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const path     = require('path');
const { startServer } = require('./helpers/server-process.cjs');

const DM = 'dm-pw', PLAYER = 'player-pw';

async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}
const readReg = async (srv) => JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'addons.json'), 'utf8'));

// An addon with two kept versions; activeHash points at v2.
function twoVersionEntry(over) {
  const ver = (h, v, ts) => ({
    contentHash: h, version: v, sha: (h + '0').padEnd(40, '0'), installedAt: ts,
    entry: 'entry.js', server: null, serverDeps: [], collections: [], dependencies: {},
  });
  return Object.assign({
    id: 'demo', name: 'Demo', version: '2.0.0', apiVersion: 1, enabled: true,
    repo: 'me/demo', ref: 'main', sha: 'hash20'.padEnd(40, '0'),
    entry: 'entry.js', server: null, serverDeps: [], collections: [], dependencies: {},
    activeHash: 'hash2', grantedPermissions: [],
    versions: [ver('hash1', '1.0.0', 1), ver('hash2', '2.0.0', 2)],
  }, over || {});
}
const registry = (addons) => ({ schema: 1, addons, resolutions: {}, sources: { allow: [] } });
// Both version code dirs must exist on disk (rollback checks).
const codeDirs = (id) => ({
  [`addons/${id}/hash1/addon.json`]: { id, version: '1.0.0' },
  [`addons/${id}/hash2/addon.json`]: { id, version: '2.0.0' },
});

test('rollback (no hash) flips activeHash to the previous version + restores its fields', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([twoVersionEntry()]) },
    seedFiles: codeDirs('demo'),
  });
  try {
    await login(srv, DM);
    const r = await srv.fetch('/api/addons/demo/rollback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).version, '1.0.0');

    const reg = await readReg(srv);
    const a = reg.addons.find(x => x.id === 'demo');
    assert.equal(a.activeHash, 'hash1');
    assert.equal(a.version, '1.0.0');
  } finally { await srv.kill(); }
});

test('rollback to a specific kept hash', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([twoVersionEntry({ activeHash: 'hash1', version: '1.0.0' })]) },
    seedFiles: codeDirs('demo'),
  });
  try {
    await login(srv, DM);
    const r = await srv.fetch('/api/addons/demo/rollback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: 'hash2' }),
    });
    assert.equal(r.status, 200);
    assert.equal((await readReg(srv)).addons.find(x => x.id === 'demo').activeHash, 'hash2');
  } finally { await srv.kill(); }
});

test('rollback: single-version addon → 400; unknown addon → 404; missing code dir → 400', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry([
      twoVersionEntry({ id: 'one', versions: [{ contentHash: 'h', version: '1.0.0', installedAt: 1 }], activeHash: 'h' }),
      twoVersionEntry({ id: 'gone' }),   // versions reference hash1/hash2 dirs that we DON'T seed for "gone"
    ]) },
    seedFiles: { 'addons/one/h/addon.json': { id: 'one' } },   // only 'one' gets a dir
  });
  try {
    await login(srv, DM);
    assert.equal((await srv.fetch('/api/addons/one/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    assert.equal((await srv.fetch('/api/addons/nope/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    // 'gone' has 2 versions but no code dirs on disk → target dir missing → 400.
    assert.equal((await srv.fetch('/api/addons/gone/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  } finally { await srv.kill(); }
});

test('rollback + check-updates are DM-only (player/anon 403)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: { 'addons.json': registry([twoVersionEntry()]) },
    seedFiles: codeDirs('demo'),
  });
  try {
    // anonymous
    assert.equal((await srv.fetch('/api/addons/demo/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await srv.fetch('/api/addons/check-updates', { method: 'POST' })).status, 403);
    // player
    await login(srv, PLAYER);
    assert.equal((await srv.fetch('/api/addons/demo/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await srv.fetch('/api/addons/check-updates', { method: 'POST' })).status, 403);
  } finally { await srv.kill(); }
});

test('check-updates: empty + local-installed addons reported without network', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry([
      { id: 'local1', name: 'Local', version: '0.1.0', apiVersion: 1, enabled: true, repo: 'local', activeHash: 'x', versions: [] },
    ]) },
  });
  try {
    await login(srv, DM);
    const j = await (await srv.fetch('/api/addons/check-updates', { method: 'POST' })).json();
    assert.ok(Array.isArray(j.updates));
    const u = j.updates.find(x => x.id === 'local1');
    assert.equal(u.status, 'local');          // dev-installed → no remote to check
    assert.ok(!u.hasUpdate);
  } finally { await srv.kill(); }
});

// ── GET /api/addons `githubTokenConfigured` — DM-only server-config flag ──
// Drives the Manager's 🔑 line (private repos installable?). The route is
// public (client boot), so the flag must be ABSENT for anonymous + player
// and a boolean only for the real DM. Never the token itself.
test('GET /api/addons: githubTokenConfigured is DM-only and true with a token', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    env: { CODEX_GITHUB_TOKEN: 'test-token-abc', GITHUB_TOKEN: '' },
  });
  try {
    let j = await (await srv.fetch('/api/addons')).json();
    assert.equal('githubTokenConfigured' in j, false, 'anonymous sees no server-config flag');
    await login(srv, PLAYER);
    j = await (await srv.fetch('/api/addons')).json();
    assert.equal('githubTokenConfigured' in j, false, 'player sees no server-config flag');
    srv.clearCookies();
    await login(srv, DM);
    j = await (await srv.fetch('/api/addons')).json();
    assert.equal(j.githubTokenConfigured, true, 'DM sees the flag (token set)');
    assert.equal(JSON.stringify(j).includes('test-token-abc'), false, 'the token value itself never leaves the server');
  } finally { await srv.kill(); }
});

test('GET /api/addons: githubTokenConfigured=false when no token is set', async () => {
  // Blank BOTH names explicitly — the helper spreads process.env, so a
  // GITHUB_TOKEN in the developer's shell would otherwise leak in.
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    env: { CODEX_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
  });
  try {
    await login(srv, DM);
    const j = await (await srv.fetch('/api/addons')).json();
    assert.equal(j.githubTokenConfigured, false);
  } finally { await srv.kill(); }
});
