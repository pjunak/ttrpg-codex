'use strict';

// Integration: addon backup coverage and version pruning.
//  - GET /api/backup zips the WHOLE data/ dir, so addon-data, the addon
//    registry, AND addon code are already in the backup (blanket include).
//  - A boot sweep prunes old addon code dirs down to the kept-K versions[]
//    (+ activeHash) so they don't accumulate; only content-hash-shaped dirs
//    and a stale `.incoming` are ever removed.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const os       = require('os');
const path     = require('path');
const { startServer } = require('./helpers/server-process.cjs');
const { readZip } = require('./helpers/zip.cjs');

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
      { id: 'dm-tools', name: 'DM Tools', version: '0.1.0', apiVersion: 2,
        hostVersion: '>=1.0.0', capabilities: { required: ['collections.dm'] },
        enabled: true, entry: 'entry.js', activeHash: HASH,
        collections: [{ name: 'scenarios', keyed: false, access: 'dm' }] },
    ]) },
    seedFiles: {
      'addon-data/demo/rules.json':       [{ id: 'grappling' }],
      'addon-data/dm-tools/scenarios.json': [{ id: 'secret-scenario' }],
      [`addons/demo/${HASH}/entry.js`]:   'export default () => {};',
    },
  });
  try {
    await login(srv, DM);
    const res = await srv.fetch('/api/backup');
    assert.equal(res.status, 200);
    const entries = await readZip(Buffer.from(await res.arrayBuffer()));
    const names = entries.map(e => e.entryName);
    assert.ok(names.includes('data/addons.json'),                  'registry in backup');
    assert.ok(names.includes('data/addon-data/demo/rules.json'),   'addon data in backup');
    assert.ok(names.includes('data/addon-data/dm-tools/scenarios.json'), 'DM-only addon data in DM backup');
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
      'addons/.incoming-abcdef123456/entry.js': 'x',
    },
  });
  try {
    const subs = (await fsp.readdir(path.join(srv.dataDir, 'addons', 'demo'))).sort();
    assert.deepEqual(subs, [KEEP_A, KEEP_B], 'only kept-K version dirs survive (stale + .incoming pruned)');
    await assert.rejects(
      () => fsp.access(path.join(srv.dataDir, 'addons', '.incoming-abcdef123456')),
      { code: 'ENOENT' },
      'id-agnostic extraction staging from a crashed install is pruned',
    );
  } finally { await srv.kill(); }
});

test('boot sweep preserves addon code reachable from a retained snapshot', async () => {
  const ACTIVE = '1111111111111111';
  const SNAPSHOT_ONLY = '2222222222222222';
  const STALE = '9999999999999999';
  const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-addon-prune-snaps-'));
  const snapshotId = 'snapshot-2026-07-25T12-00-00-000Z.json';
  await fsp.writeFile(path.join(snapshotsDir, snapshotId), JSON.stringify({
    id: snapshotId,
    createdAt: '2026-07-25T12:00:00.000Z',
    files: {
      'addons.json': registry([{
        id: 'demo',
        activeHash: SNAPSHOT_ONLY,
        versions: [{ contentHash: SNAPSHOT_ONLY, version: '1.0.0' }],
      }]),
    },
  }));

  const srv = await startServer({
    snapshotsDir,
    dmPassword: DM,
    seedData: { 'addons.json': registry([{
      id: 'demo',
      name: 'Demo',
      version: '2.0.0',
      apiVersion: 1,
      enabled: true,
      entry: 'entry.js',
      activeHash: ACTIVE,
      versions: [{ contentHash: ACTIVE, version: '2.0.0' }],
    }]) },
    seedFiles: {
      [`addons/demo/${ACTIVE}/entry.js`]: 'x',
      [`addons/demo/${SNAPSHOT_ONLY}/entry.js`]: 'x',
      [`addons/demo/${STALE}/entry.js`]: 'x',
    },
  });
  try {
    const subs = (await fsp.readdir(path.join(srv.dataDir, 'addons', 'demo'))).sort();
    assert.deepEqual(subs, [ACTIVE, SNAPSHOT_ONLY]);
  } finally {
    await srv.kill();
    await fsp.rm(snapshotsDir, { recursive: true, force: true });
  }
});

test('uninstall retains snapshot-reachable code until the recovery point is removed', async () => {
  const HASH = '1111111111111111';
  const STALE = '9999999999999999';
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-addon-uninstall-data-'));
  const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-addon-uninstall-snaps-'));
  const snapshotId = 'snapshot-2026-07-25T12-00-00-000Z.json';
  await fsp.writeFile(path.join(snapshotsDir, snapshotId), JSON.stringify({
    id: snapshotId,
    createdAt: '2026-07-25T12:00:00.000Z',
    files: {
      'addons.json': registry([{
        id: 'demo',
        activeHash: HASH,
        versions: [{ contentHash: HASH, version: '1.0.0' }],
      }]),
    },
  }));

  let srv;
  try {
    srv = await startServer({
      dataDir,
      snapshotsDir,
      dmPassword: DM,
      seedData: { 'addons.json': registry([{
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        apiVersion: 1,
        enabled: true,
        entry: 'entry.js',
        activeHash: HASH,
        versions: [{ contentHash: HASH, version: '1.0.0' }],
      }]) },
      seedFiles: {
        [`addons/demo/${HASH}/entry.js`]: 'x',
        [`addons/demo/${STALE}/entry.js`]: 'x',
      },
    });
    await login(srv, DM);
    assert.equal((await srv.fetch('/api/addons/demo', { method: 'DELETE' })).status, 200);
    assert.deepEqual(await fsp.readdir(path.join(dataDir, 'addons', 'demo')), [HASH]);

    assert.equal((await srv.fetch(`/api/snapshots/${snapshotId}`, { method: 'DELETE' })).status, 200);
    await srv.kill();
    srv = await startServer({ dataDir, snapshotsDir, dmPassword: DM });
    assert.deepEqual(await fsp.readdir(path.join(dataDir, 'addons', 'demo')), []);
  } finally {
    if (srv) await srv.kill();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(snapshotsDir, { recursive: true, force: true });
  }
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
