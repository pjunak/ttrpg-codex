'use strict';

// Integration: server-side addons (Phase 7). At boot the host loads an enabled
// addon's server/index.cjs (when `server:code` is granted + serverDeps are
// vetted) and mounts its routes under the namespaced prefix /api/addon/<id>/*.
// Covers: routing + isolated data writes, server:code gating, serverDeps
// blocking, error + namespace isolation (a throwing init never crashes boot),
// and the disabled state.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const path     = require('path');
const { startServer } = require('./helpers/server-process.cjs');

const DM = 'dm-pw';

// A minimal server module: GET /roll returns fixed JSON + writes the addon's
// own isolated data; echoes the caller role.
const GOOD_SERVER = `'use strict';
module.exports.init = (host) => {
  host.get('/roll', async (req, res) => {
    await host.data.write('log', { last: 42 });
    res.json({ ok: true, value: 42, by: req.role || 'anon' });
  });
};`;

const THROWS_ON_INIT = `'use strict';
module.exports.init = () => { throw new Error('boom at init'); };`;

// Probes the readCollection gate: a real granted collection works, but `auth`
// (password hashes) is refused even WITH a data:read:auth grant.
const READER_SERVER = `'use strict';
module.exports.init = (host) => {
  host.get('/probe', async (req, res) => {
    let charsOk = false, authBlocked = false;
    try { await host.readCollection('characters'); charsOk = true; } catch (_) {}
    try { await host.readCollection('auth'); } catch (_) { authBlocked = true; }
    res.json({ charsOk, authBlocked });
  });
};`;

function entry(over) {
  return Object.assign({
    id: 'dice', name: 'Dice', version: '0.1.0', apiVersion: 1, enabled: true,
    entry: 'entry.js', server: 'server/index.cjs', activeHash: 'h1',
    grantedPermissions: ['server:code'], serverDeps: [],
  }, over || {});
}
const registry = (addons) => ({ schema: 1, addons, resolutions: {}, sources: { allow: [] } });
const codeOf   = (id, code) => ({ [`addons/${id}/h1/server/index.cjs`]: code });
const addonsList = async (srv) => (await (await srv.fetch('/api/addons')).json()).addons;

test('enabled server addon: routes mount + isolated data write + namespace isolation', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([entry()]) },
    seedFiles: codeOf('dice', GOOD_SERVER),
  });
  try {
    const r = await srv.fetch('/api/addon/dice/roll');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).value, 42);

    // The write landed in the addon's ISOLATED dir.
    const log = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'addon-data', 'dice', 'log.json'), 'utf8'));
    assert.equal(log.last, 42);

    // Unknown addon prefix + unmatched sub-path → JSON 404 (never the SPA index).
    assert.equal((await srv.fetch('/api/addon/ghost/roll')).status, 404);
    const miss = await srv.fetch('/api/addon/dice/nope');
    assert.equal(miss.status, 404);
    assert.ok((miss.headers.get('content-type') || '').includes('application/json'));

    const a = (await addonsList(srv)).find(x => x.id === 'dice');
    assert.equal(a.server, true);
    assert.equal(a.serverState, 'loaded');
  } finally { await srv.kill(); }
});

test('server:code not granted → not loaded (404) + reported blocked', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([entry({ grantedPermissions: [] })]) },
    seedFiles: codeOf('dice', GOOD_SERVER),
  });
  try {
    assert.equal((await srv.fetch('/api/addon/dice/roll')).status, 404);
    assert.equal((await addonsList(srv)).find(x => x.id === 'dice').serverState, 'blocked');
  } finally { await srv.kill(); }
});

test('serverDeps with a non-vetted lib → blocked (404)', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([entry({ serverDeps: ['totally-not-vetted'] })]) },
    seedFiles: codeOf('dice', GOOD_SERVER),
  });
  try {
    assert.equal((await srv.fetch('/api/addon/dice/roll')).status, 404);
    assert.equal((await addonsList(srv)).find(x => x.id === 'dice').serverState, 'blocked');
  } finally { await srv.kill(); }
});

test('a throwing init is isolated: server boots, other addon still serves', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([entry({ id: 'bad' }), entry({ id: 'good' })]) },
    seedFiles: Object.assign({}, codeOf('bad', THROWS_ON_INIT), codeOf('good', GOOD_SERVER)),
  });
  try {
    assert.equal((await srv.fetch('/api/version')).status, 200);          // boot survived
    assert.equal((await srv.fetch('/api/addon/bad/roll')).status, 404);   // failed addon serves nothing
    assert.equal((await srv.fetch('/api/addon/good/roll')).status, 200);  // co-installed addon unaffected
    const list = await addonsList(srv);
    assert.equal(list.find(x => x.id === 'bad').serverState, 'error');
    assert.equal(list.find(x => x.id === 'good').serverState, 'loaded');
  } finally { await srv.kill(); }
});

test('readCollection: a granted real collection works, but auth.json is refused', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: {
      'addons.json': registry([entry({ id: 'reader', grantedPermissions: ['server:code', 'data:read:characters', 'data:read:auth'] })]),
      'characters.json': [{ id: 'a', name: 'A' }],
    },
    seedFiles: codeOf('reader', READER_SERVER),
  });
  try {
    const j = await (await srv.fetch('/api/addon/reader/probe')).json();
    assert.equal(j.charsOk, true,     'reads a real collection it was granted');
    assert.equal(j.authBlocked, true, 'cannot read auth.json even with a data:read:auth grant');
  } finally { await srv.kill(); }
});

test('a disabled server addon serves nothing (404) + reports disabled', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([entry({ enabled: false })]) },
    seedFiles: codeOf('dice', GOOD_SERVER),
  });
  try {
    assert.equal((await srv.fetch('/api/addon/dice/roll')).status, 404);
    assert.equal((await addonsList(srv)).find(x => x.id === 'dice').serverState, 'disabled');
  } finally { await srv.kill(); }
});
