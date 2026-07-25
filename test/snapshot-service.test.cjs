'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fsp = fs.promises;

const { createSnapshotService } = require('../server/snapshot-service.cjs');
const { pickKeptSnapshots, safeJoinIn } = require('../server-utils.cjs');

async function createFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-snapshots-'));
  const dataDir = path.join(root, 'data');
  const snapshotsDir = path.join(root, 'snapshots');
  await fsp.mkdir(path.join(dataDir, 'addon-data', 'example'), {
    recursive: true,
  });
  await fsp.mkdir(snapshotsDir, { recursive: true });

  async function atomicWrite(target, content) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }

  async function trackedDataFiles() {
    const files = [];
    for (const name of await fsp.readdir(dataDir)) {
      if (name.endsWith('.json') && name !== 'auth.json') {
        files.push({ key: name, abs: path.join(dataDir, name) });
      }
    }
    const addonRoot = path.join(dataDir, 'addon-data');
    for (const addonId of await fsp.readdir(addonRoot)) {
      const addonDir = path.join(addonRoot, addonId);
      for (const name of await fsp.readdir(addonDir)) {
        if (name.endsWith('.json')) {
          files.push({
            key: `addon-data/${addonId}/${name}`,
            abs: path.join(addonDir, name),
          });
        }
      }
    }
    return files;
  }

  let timestamp = Date.parse('2026-07-25T12:00:00.000Z');
  let publications = 0;
  const warnings = [];
  const service = createSnapshotService({
    snapshotsDir,
    atomicWrite,
    trackedDataFiles,
    dataHash: async () => '0123456789abcdef',
    pickKeptSnapshots,
    publishRestore: async files => {
      publications += 1;
      for (const [key, value] of Object.entries(files)) {
        const target = safeJoinIn(dataDir, key);
        assert.ok(target);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, JSON.stringify(value, null, 2));
      }
      for (const { key, abs } of await trackedDataFiles()) {
        if (!Object.prototype.hasOwnProperty.call(files, key)) {
          await fsp.unlink(abs).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
      return { restoreId: 'restore-fixture' };
    },
    now: () => timestamp,
    logger: { warn: (...args) => warnings.push(args), error() {} },
  });

  return {
    root,
    dataDir,
    snapshotsDir,
    service,
    advance(ms) { timestamp += ms; },
    counts() { return { publications, warnings }; },
  };
}

test('snapshot service creates role-aware recovery points and coalesces automatic saves', async t => {
  const fixture = await createFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  await fsp.writeFile(
    path.join(fixture.dataDir, 'characters.json'),
    JSON.stringify([{ id: 'alice' }]),
  );
  await fsp.writeFile(
    path.join(fixture.dataDir, 'addon-data', 'example', 'notes.json'),
    JSON.stringify([{ id: 'note-1' }]),
  );
  await fsp.writeFile(path.join(fixture.dataDir, 'broken.json'), '{');

  await assert.rejects(
    fixture.service.create('transaction', 'dm', {
      transactionCommitId: 'commit-1',
    }),
    error => {
      assert.equal(error.code, 'SNAPSHOT_SOURCE_INVALID');
      assert.match(error.message, /broken\.json/);
      return true;
    },
  );
  assert.deepEqual(await fixture.service.files(), []);
  await fsp.unlink(path.join(fixture.dataDir, 'broken.json'));

  const id = await fixture.service.create('transaction', 'dm', {
    transactionCommitId: 'commit-1',
  });
  const snapshot = await fixture.service.read(id);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.access, 'dm');
  assert.equal(snapshot.dataHash, '0123456789abcdef');
  assert.deepEqual(snapshot.files['characters.json'], [{ id: 'alice' }]);
  assert.deepEqual(
    snapshot.files['addon-data/example/notes.json'],
    [{ id: 'note-1' }],
  );
  assert.match(snapshot.fileDigests['characters.json'], /^[0-9a-f]{64}$/);
  assert.equal(await fixture.service.hasTransaction('commit-1'), true);

  assert.equal(await fixture.service.maybeCreate(), null);
  fixture.advance(60_001);
  assert.match(await fixture.service.maybeCreate(), /^snapshot-.*\.json$/);

  const metadata = await fixture.service.metadata(id);
  assert.equal(metadata.reason, 'transaction');
  assert.equal(metadata.access, 'dm');
  assert.ok(metadata.size > 0);
});

test('snapshot service restores core and addon data, removes newer files, and can delete points', async t => {
  const fixture = await createFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  const characters = path.join(fixture.dataDir, 'characters.json');
  const notes = path.join(
    fixture.dataDir,
    'addon-data',
    'example',
    'notes.json',
  );
  const locations = path.join(fixture.dataDir, 'locations.json');
  await fsp.writeFile(characters, JSON.stringify([{ id: 'alice' }]));
  await fsp.writeFile(notes, JSON.stringify([{ id: 'note-1' }]));

  const restorePoint = await fixture.service.create('manual');
  fixture.advance(1);
  await fsp.writeFile(characters, JSON.stringify([{ id: 'bob' }]));
  await fsp.writeFile(notes, JSON.stringify([{ id: 'note-2' }]));
  await fsp.writeFile(locations, JSON.stringify([{ id: 'new-place' }]));

  assert.deepEqual(await fixture.service.restore(restorePoint), {
    ok: true,
    restoreId: 'restore-fixture',
  });
  assert.deepEqual(JSON.parse(await fsp.readFile(characters)), [{ id: 'alice' }]);
  assert.deepEqual(JSON.parse(await fsp.readFile(notes)), [{ id: 'note-1' }]);
  await assert.rejects(fsp.stat(locations), { code: 'ENOENT' });
  assert.deepEqual(fixture.counts(), {
    publications: 1,
    warnings: [],
  });

  const files = await fixture.service.files();
  assert.ok(files.some(file => file !== restorePoint));
  assert.deepEqual(await fixture.service.remove(restorePoint), { ok: true });
  assert.deepEqual(await fixture.service.remove(restorePoint), {
    ok: false,
    missing: true,
  });
  assert.deepEqual(await fixture.service.remove('***'), {
    ok: false,
    invalid: true,
  });
});

test('snapshot service rejects a digest mismatch before publication', async t => {
  const fixture = await createFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  await fsp.writeFile(
    path.join(fixture.dataDir, 'characters.json'),
    JSON.stringify([{ id: 'alice' }]),
  );
  const id = await fixture.service.create('manual');
  const file = path.join(fixture.snapshotsDir, id);
  const tampered = JSON.parse(await fsp.readFile(file, 'utf8'));
  tampered.files['characters.json'][0].id = 'mallory';
  await fsp.writeFile(file, JSON.stringify(tampered));

  assert.equal(await fixture.service.read(id), null);
  assert.equal(await fixture.service.metadata(id), null);
  assert.deepEqual(await fixture.service.restore(id), {
    ok: false,
    error: 'Snapshot nenalezen',
  });
  assert.deepEqual(fixture.counts(), { publications: 0, warnings: [] });
});

test('snapshot service keeps legacy recovery points readable', async t => {
  const fixture = await createFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  await fsp.writeFile(
    path.join(fixture.dataDir, 'characters.json'),
    JSON.stringify([{ id: 'alice' }]),
  );
  const id = await fixture.service.create('manual');
  const file = path.join(fixture.snapshotsDir, id);
  const legacy = JSON.parse(await fsp.readFile(file, 'utf8'));
  delete legacy.version;
  delete legacy.fileDigests;
  delete legacy.reason;
  delete legacy.access;
  await fsp.writeFile(file, JSON.stringify(legacy));

  const snapshot = await fixture.service.read(id);
  assert.equal(snapshot.reason, 'save');
  assert.equal(snapshot.access, 'public');
  assert.deepEqual(snapshot.files['characters.json'], [{ id: 'alice' }]);
});

test('snapshot service reports every addon code hash reachable from retained recovery points', async t => {
  const fixture = await createFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  const addonsFile = path.join(fixture.dataDir, 'addons.json');
  await fsp.writeFile(addonsFile, JSON.stringify({
    addons: [{
      id: 'example',
      activeHash: '1111111111111111',
      versions: [{ contentHash: '2222222222222222' }],
    }],
  }));
  await fixture.service.create('manual');

  fixture.advance(1);
  await fsp.writeFile(addonsFile, JSON.stringify({
    addons: [{
      id: 'example',
      activeHash: '3333333333333333',
      versions: [{ contentHash: 'not-a-content-hash' }],
    }],
  }));
  await fixture.service.create('manual');

  const references = await fixture.service.referencedAddonHashes();
  assert.deepEqual([...references.get('example')].sort(), [
    '1111111111111111',
    '2222222222222222',
    '3333333333333333',
  ]);
});
