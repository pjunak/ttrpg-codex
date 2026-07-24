'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const {
  TIMELINE_SITTING_MIGRATION_ID,
  runTimelineSittingMigration,
} = require('../server/migrations.cjs');

async function withEvents(events, callback) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'timeline-migration-'));
  const file = path.join(dir, 'events.json');
  await fsp.writeFile(file, JSON.stringify(events, null, 2), 'utf8');
  try {
    await callback({ dir, file });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('timeline migration: zero becomes one while valid, missing, and null sittings stay unchanged', async () => {
  const original = [
    { id: 'legacy', name: 'Legacy', sitting: 0, order: 4, tags: ['keep'] },
    { id: 'valid-one', name: 'One', sitting: 1, order: 2 },
    { id: 'valid-later', name: 'Later', sitting: 7, order: 1 },
    { id: 'missing', name: 'Missing', order: 3 },
    { id: 'null', name: 'Null', sitting: null, order: 5 },
  ];

  await withEvents(original, async ({ dir, file }) => {
    const result = await runTimelineSittingMigration(dir);
    const migrated = JSON.parse(await fsp.readFile(file, 'utf8'));

    assert.equal(result.id, TIMELINE_SITTING_MIGRATION_ID);
    assert.equal(result.changed, 1);
    assert.equal(migrated[0].sitting, 1);
    assert.deepEqual(migrated.slice(1), original.slice(1));
    assert.deepEqual(
      { ...migrated[0], sitting: 0 },
      original[0],
      'all unrelated event fields remain byte-equivalent as data',
    );
  });
});

test('timeline migration: repeated execution is a no-op with no second write', async () => {
  await withEvents([{ id: 'legacy', sitting: 0, payload: { untouched: true } }], async ({ dir, file }) => {
    let writes = 0;
    const atomicWrite = async (target, content) => {
      writes++;
      await fsp.writeFile(target, content, 'utf8');
    };

    const first = await runTimelineSittingMigration(dir, { atomicWrite });
    const afterFirst = await fsp.readFile(file, 'utf8');
    const second = await runTimelineSittingMigration(dir, { atomicWrite });
    const afterSecond = await fsp.readFile(file, 'utf8');

    assert.equal(first.changed, 1);
    assert.equal(second.changed, 0);
    assert.equal(writes, 1);
    assert.equal(afterSecond, afterFirst);
  });
});

test('timeline migration: missing events collection is an idempotent no-op', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'timeline-migration-empty-'));
  try {
    assert.deepEqual(await runTimelineSittingMigration(dir), {
      id: TIMELINE_SITTING_MIGRATION_ID,
      changed: 0,
      byCollection: {},
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
