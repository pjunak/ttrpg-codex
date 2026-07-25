'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fsp = fs.promises;

const { CAMPAIGN_MIGRATIONS } = require('../server/migrations.cjs');
const {
  RestoreCandidateError,
  prepareRestoreCandidate,
  validateRestoreCandidate,
} = require('../server/restore-candidate.cjs');
const { isSnapshotFileKey } = require('../server/snapshot-service.cjs');

const CORE_SHAPES = Object.freeze({
  characters: 'array',
  events: 'array',
  settings: 'object',
  deletedDefaults: 'object-or-legacy-array',
});

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-restore-candidate-'));
  const candidateDir = path.join(root, 'candidate');
  const liveDir = path.join(root, 'live');
  await Promise.all([
    fsp.mkdir(candidateDir, { recursive: true }),
    fsp.mkdir(liveDir, { recursive: true }),
  ]);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { candidateDir, liveDir };
}

async function writeJson(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split('/'));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(value, null, 2), 'utf8');
  return target;
}

test('candidate validation rejects malformed JSON and known collection shape mismatches', async t => {
  const { candidateDir } = await fixture(t);
  await fsp.writeFile(path.join(candidateDir, 'characters.json'), '{', 'utf8');

  await assert.rejects(
    validateRestoreCandidate({
      candidateDir,
      paths: ['characters.json'],
      isAuthoritativePath: isSnapshotFileKey,
      coreShapes: CORE_SHAPES,
    }),
    error => error instanceof RestoreCandidateError
      && error.code === 'RESTORE_JSON_INVALID'
      && error.relativePath === 'characters.json',
  );

  await writeJson(candidateDir, 'characters.json', {});
  await assert.rejects(
    validateRestoreCandidate({
      candidateDir,
      paths: ['characters.json'],
      isAuthoritativePath: isSnapshotFileKey,
      coreShapes: CORE_SHAPES,
    }),
    error => error instanceof RestoreCandidateError
      && error.code === 'RESTORE_SHAPE_INVALID',
  );
});

test('candidate validation derives addon collection shapes from the restored registry', async t => {
  const { candidateDir } = await fixture(t);
  await writeJson(candidateDir, 'addons.json', {
    addons: [{
      id: 'dm-tools',
      collections: [
        { name: 'scenarios', keyed: false },
        { name: 'notes', keyed: true },
      ],
    }],
  });
  await writeJson(candidateDir, 'addon-data/dm-tools/scenarios.json', {});
  await writeJson(candidateDir, 'addon-data/dm-tools/notes.json', []);

  await assert.rejects(
    validateRestoreCandidate({
      candidateDir,
      paths: [
        'addons.json',
        'addon-data/dm-tools/scenarios.json',
        'addon-data/dm-tools/notes.json',
      ],
      isAuthoritativePath: isSnapshotFileKey,
      coreShapes: CORE_SHAPES,
    }),
    error => error instanceof RestoreCandidateError
      && error.code === 'RESTORE_SHAPE_INVALID'
      && error.relativePath === 'addon-data/dm-tools/notes.json',
  );
});

test('preparation overlays live JSON, runs the shared migrations, and returns canonical paths', async t => {
  const { candidateDir, liveDir } = await fixture(t);
  await writeJson(candidateDir, 'characters.json', [{ id: 'hero' }]);
  await writeJson(candidateDir, 'events.json', [{ id: 'session', sitting: 0 }]);
  await writeJson(candidateDir, 'deletedDefaults.json', ['legacy:item']);
  const settings = await writeJson(liveDir, 'settings.json', { theme: 'classic' });

  const result = await prepareRestoreCandidate({
    candidateDir,
    paths: ['events.json', 'characters.json', 'deletedDefaults.json'],
    liveFiles: [
      { key: 'settings.json', abs: settings },
    ],
    isAuthoritativePath: isSnapshotFileKey,
    coreShapes: CORE_SHAPES,
    migrations: CAMPAIGN_MIGRATIONS,
  });

  assert.deepEqual(result.paths, [
    'characters.json',
    'deletedDefaults.json',
    'events.json',
    'settings.json',
  ]);
  assert.equal(result.migrationResults.length, CAMPAIGN_MIGRATIONS.length);
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(candidateDir, 'characters.json'), 'utf8')),
    [{ id: 'hero', visibility: 'public', attitudes: [] }],
  );
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(candidateDir, 'events.json'), 'utf8')),
    [{ id: 'session', sitting: 1, visibility: 'public' }],
  );
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(candidateDir, 'deletedDefaults.json'), 'utf8')),
    { 'legacy:item': true },
  );
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(candidateDir, 'settings.json'), 'utf8')),
    { theme: 'classic' },
  );
});

test('preparation rejects migration writes outside authoritative campaign JSON', async t => {
  const { candidateDir } = await fixture(t);
  await writeJson(candidateDir, 'characters.json', []);

  await assert.rejects(
    prepareRestoreCandidate({
      candidateDir,
      paths: ['characters.json'],
      liveFiles: [],
      isAuthoritativePath: isSnapshotFileKey,
      coreShapes: CORE_SHAPES,
      migrations: [{
        id: 'bad',
        run: async (root, { atomicWrite }) => {
          await atomicWrite(path.join(root, 'media.bin'), 'bad');
          return { changed: 1 };
        },
      }],
    }),
    error => error instanceof RestoreCandidateError
      && error.code === 'RESTORE_MIGRATION_PATH_INVALID',
  );
});
