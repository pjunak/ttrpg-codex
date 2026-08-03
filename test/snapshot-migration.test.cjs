'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  migrateLegacySnapshots,
  moveSnapshotFile,
} = require('../server/snapshot-migration.cjs');

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-snapshot-migration-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test('moveSnapshotFile durably copies then removes the source on EXDEV', async t => {
  const root = await temporaryRoot(t);
  const source = path.join(root, 'legacy', 'snapshot-a.json');
  const target = path.join(root, 'current', 'snapshot-a.json');
  await fsp.mkdir(path.dirname(source), { recursive: true });
  await fsp.writeFile(source, '{"campaign":"tiamat"}', 'utf8');

  await moveSnapshotFile(source, target, {
    rename: async () => {
      const error = new Error('cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    },
  });

  assert.equal(await fsp.readFile(target, 'utf8'), '{"campaign":"tiamat"}');
  await assert.rejects(fsp.access(source), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readdir(path.dirname(target)), ['snapshot-a.json']);
});

test('migrateLegacySnapshots moves snapshots and leaves unrelated legacy files alone', async t => {
  const root = await temporaryRoot(t);
  const legacyDir = path.join(root, 'data', 'snapshots');
  const snapshotsDir = path.join(root, 'data-snapshots');
  await fsp.mkdir(legacyDir, { recursive: true });
  await fsp.writeFile(path.join(legacyDir, 'snapshot-a.json'), '{"ok":true}', 'utf8');
  await fsp.writeFile(path.join(legacyDir, 'README.txt'), 'keep', 'utf8');
  const messages = { log: [], warn: [] };

  const result = await migrateLegacySnapshots({
    legacyDir,
    snapshotsDir,
    logger: {
      log: message => messages.log.push(message),
      warn: message => messages.warn.push(message),
    },
  });

  assert.deepEqual(result, { found: true, moved: 1, duplicates: 0, failed: 0 });
  assert.equal(await fsp.readFile(path.join(snapshotsDir, 'snapshot-a.json'), 'utf8'), '{"ok":true}');
  assert.equal(await fsp.readFile(path.join(legacyDir, 'README.txt'), 'utf8'), 'keep');
  assert.equal(messages.log.length, 1);
  assert.deepEqual(messages.warn, []);
});

test('migrateLegacySnapshots retains a failed source and reports an incomplete migration', async t => {
  const root = await temporaryRoot(t);
  const legacyDir = path.join(root, 'data', 'snapshots');
  const snapshotsDir = path.join(root, 'data-snapshots');
  const source = path.join(legacyDir, 'snapshot-a.json');
  await fsp.mkdir(legacyDir, { recursive: true });
  await fsp.writeFile(source, '{"ok":true}', 'utf8');
  const messages = { log: [], warn: [] };

  const result = await migrateLegacySnapshots({
    legacyDir,
    snapshotsDir,
    moveFile: async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
    logger: {
      log: message => messages.log.push(message),
      warn: message => messages.warn.push(message),
    },
  });

  assert.deepEqual(result, { found: true, moved: 0, duplicates: 0, failed: 1 });
  assert.equal(await fsp.readFile(source, 'utf8'), '{"ok":true}');
  assert.deepEqual(messages.log, []);
  assert.match(messages.warn.at(-1), /incomplete: 1 snapshot/);
});
