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
  let reconciliations = 0;
  let invalidations = 0;
  const warnings = [];
  const service = createSnapshotService({
    snapshotsDir,
    dataDir,
    atomicWrite,
    trackedDataFiles,
    dataHash: async () => '0123456789abcdef',
    pickKeptSnapshots,
    safeJoinIn,
    reconcileAddons: async () => { reconciliations += 1; },
    invalidateDataHash: () => { invalidations += 1; },
    now: () => timestamp,
    logger: { warn: (...args) => warnings.push(args), error() {} },
  });

  return {
    root,
    dataDir,
    snapshotsDir,
    service,
    advance(ms) { timestamp += ms; },
    counts() { return { reconciliations, invalidations, warnings }; },
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

  const id = await fixture.service.create('transaction', 'dm', {
    transactionCommitId: 'commit-1',
  });
  const snapshot = await fixture.service.read(id);
  assert.equal(snapshot.access, 'dm');
  assert.equal(snapshot.dataHash, '0123456789abcdef');
  assert.deepEqual(snapshot.files['characters.json'], [{ id: 'alice' }]);
  assert.deepEqual(
    snapshot.files['addon-data/example/notes.json'],
    [{ id: 'note-1' }],
  );
  assert.equal(snapshot.files['broken.json'], undefined);
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

  assert.deepEqual(await fixture.service.restore(restorePoint), { ok: true });
  assert.deepEqual(JSON.parse(await fsp.readFile(characters)), [{ id: 'alice' }]);
  assert.deepEqual(JSON.parse(await fsp.readFile(notes)), [{ id: 'note-1' }]);
  await assert.rejects(fsp.stat(locations), { code: 'ENOENT' });
  assert.deepEqual(fixture.counts(), {
    reconciliations: 1,
    invalidations: 1,
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
