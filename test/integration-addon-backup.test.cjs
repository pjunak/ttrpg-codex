'use strict';

// Integration: addon backup coverage + version pruning (Phase 10).
//  - GET /api/backup zips the WHOLE data/ dir, so addon-data, the addon
//    registry, AND addon code are already in the backup (blanket include).
//  - A boot sweep prunes old addon code dirs down to the kept-K versions[]
//    (+ activeHash) so they don't accumulate; only content-hash-shaped dirs
//    and a stale `.incoming` are ever removed.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const path     = require('path');
const AdmZip   = require('adm-zip');
const { startServer } = require('./helpers/server-process.cjs');

const DM = 'dm-pw';
async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}
const registry = (addons) => ({ schema: 1, addons, resolutions: {}, sources: { allow: [] } });

test('GET /api/backup includes addon-data, the registry, and addon code', async () => {
  const HASH = '1111111111111111';
  const srv = await startServer({
    dmPassword: DM,
    seedData:  { 'addons.json': registry([
      { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, enabled: true,
        entry: 'entry.js', activeHash: HASH, versions: [{ contentHash: HASH, version: '1.0.0' }] },
    ]) },
    seedFiles: {
      'addon-data/demo/rules.json':       [{ id: 'grappling' }],
      [`addons/demo/${HASH}/entry.js`]:   'export default () => {};',
    },
  });
  try {
    await login(srv, DM);
    const res = await srv.fetch('/api/backup');
    assert.equal(res.status, 200);
    const zip   = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map(e => e.entryName.replace(/\\/g, '/'));
    assert.ok(names.includes('data/addons.json'),                  'registry in backup');
    assert.ok(names.includes('data/addon-data/demo/rules.json'),   'addon data in backup');
    assert.ok(names.includes(`data/addons/demo/${HASH}/entry.js`), 'addon code in backup');
  } finally { await srv.kill(); }
});

test('boot sweep prunes stale version dirs + .incoming, keeps the kept-K', async () => {
  const KEEP_A = '1111111111111111';
  const KEEP_B = '2222222222222222';   // activeHash
  const STALE  = '9999999999999999';   // 16-hex, not in versions[] → pruned
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry([
      { id: 'demo', name: 'Demo', version: '2.0.0', apiVersion: 1, enabled: true,
        entry: 'entry.js', activeHash: KEEP_B,
        versions: [{ contentHash: KEEP_A, version: '1.0.0' }, { contentHash: KEEP_B, version: '2.0.0' }] },
    ]) },
    seedFiles: {
      [`addons/demo/${KEEP_A}/entry.js`]:   'x',
      [`addons/demo/${KEEP_B}/entry.js`]:   'x',
      [`addons/demo/${STALE}/entry.js`]:    'x',
      'addons/demo/.incoming/entry.js':     'x',
    },
  });
  try {
    const subs = (await fsp.readdir(path.join(srv.dataDir, 'addons', 'demo'))).sort();
    assert.deepEqual(subs, [KEEP_A, KEEP_B], 'only kept-K version dirs survive (stale + .incoming pruned)');
  } finally { await srv.kill(); }
});

test('a non-hash-shaped dir is left untouched (defence — never over-prune)', async () => {
  const KEEP = '1111111111111111';
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry([
      { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, enabled: true,
        entry: 'entry.js', activeHash: KEEP, versions: [{ contentHash: KEEP, version: '1.0.0' }] },
    ]) },
    seedFiles: {
      [`addons/demo/${KEEP}/entry.js`]:  'x',
      'addons/demo/not-a-hash/keepme':   'x',   // not 16-hex, not .incoming → untouched
    },
  });
  try {
    const subs = (await fsp.readdir(path.join(srv.dataDir, 'addons', 'demo'))).sort();
    assert.deepEqual(subs, [KEEP, 'not-a-hash']);
  } finally { await srv.kill(); }
});
