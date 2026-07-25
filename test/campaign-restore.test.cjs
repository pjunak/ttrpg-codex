'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { CampaignRestoreManager } = require('../server/campaign-restore.cjs');
const { PublicationBarrier } = require('../server/publication-barrier.cjs');

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-restore-manager-'));
  const dataDir = path.join(root, 'data');
  const candidateDir = path.join(root, 'candidate');
  const runtimeDir = path.join(dataDir, '.runtime', 'restores');
  await Promise.all([
    fsp.mkdir(dataDir, { recursive: true }),
    fsp.mkdir(candidateDir, { recursive: true }),
    fsp.mkdir(runtimeDir, { recursive: true }),
  ]);
  const effects = [];
  const manager = new CampaignRestoreManager({
    dataDir,
    candidateDir,
    runtimeDir,
    publicationBarrier: new PublicationBarrier(),
    onCommit: async result => { effects.push(result); },
    onRecoveredCommit: async result => { effects.push(result); },
    ...options,
  });
  return {
    root,
    dataDir,
    candidateDir,
    runtimeDir,
    effects,
    manager,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

async function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

test('campaign restore publishes a complete overlay and applies effects once', async () => {
  const f = await fixture();
  try {
    await write(f.dataDir, 'characters.json', 'old characters');
    await write(f.dataDir, 'untouched.json', 'untouched');
    await write(f.candidateDir, 'characters.json', 'new characters');
    await write(f.candidateDir, 'maps/world.bin', Buffer.from([0, 1, 2, 3]));

    const result = await f.manager.commit({
      candidateDir: f.candidateDir,
      paths: ['maps/world.bin', 'characters.json'],
    });

    assert.equal(await fsp.readFile(path.join(f.dataDir, 'characters.json'), 'utf8'), 'new characters');
    assert.equal(await fsp.readFile(path.join(f.dataDir, 'untouched.json'), 'utf8'), 'untouched');
    assert.deepEqual(await fsp.readFile(path.join(f.dataDir, 'maps', 'world.bin')), Buffer.from([0, 1, 2, 3]));
    assert.deepEqual(result.paths, ['characters.json', 'maps/world.bin']);
    assert.equal(f.effects.length, 1);
    assert.deepEqual(await fsp.readdir(f.runtimeDir), []);
  } finally {
    await f.cleanup();
  }
});

test('campaign restore publishes removals in the same journaled operation', async () => {
  const f = await fixture();
  try {
    await write(f.dataDir, 'characters.json', 'old characters');
    await write(f.dataDir, 'locations.json', 'old locations');
    await write(f.candidateDir, 'characters.json', 'new characters');

    const result = await f.manager.commit({
      candidateDir: f.candidateDir,
      paths: ['characters.json'],
      removePaths: ['locations.json'],
    });

    assert.equal(
      await fsp.readFile(path.join(f.dataDir, 'characters.json'), 'utf8'),
      'new characters',
    );
    await assert.rejects(fsp.stat(path.join(f.dataDir, 'locations.json')), {
      code: 'ENOENT',
    });
    assert.deepEqual(result.paths, ['characters.json', 'locations.json']);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('campaign restore rolls every file back when publication fails', async () => {
  const f = await fixture({
    fault: async phase => {
      if (phase === 'publish:1:after') throw new Error('injected publication failure');
    },
  });
  try {
    await write(f.dataDir, 'a.json', 'old a');
    await write(f.candidateDir, 'a.json', 'new a');
    await write(f.candidateDir, 'b.json', 'new b');

    await assert.rejects(
      f.manager.commit({ candidateDir: f.candidateDir, paths: ['a.json', 'b.json'] }),
      /injected publication failure/,
    );

    assert.equal(await fsp.readFile(path.join(f.dataDir, 'a.json'), 'utf8'), 'old a');
    await assert.rejects(fsp.stat(path.join(f.dataDir, 'b.json')), { code: 'ENOENT' });
    assert.equal(f.effects.length, 0);
    assert.deepEqual(await fsp.readdir(f.runtimeDir), []);
  } finally {
    await f.cleanup();
  }
});

test('campaign restore rolls a published removal back after failure', async () => {
  const f = await fixture({
    fault: async phase => {
      if (phase === 'publish:1:after') throw new Error('injected removal failure');
    },
  });
  try {
    await write(f.dataDir, 'a.json', 'old a');
    await write(f.dataDir, 'b.json', 'old b');
    await write(f.candidateDir, 'a.json', 'new a');

    await assert.rejects(
      f.manager.commit({
        candidateDir: f.candidateDir,
        paths: ['a.json'],
        removePaths: ['b.json'],
      }),
      /injected removal failure/,
    );

    assert.equal(await fsp.readFile(path.join(f.dataDir, 'a.json'), 'utf8'), 'old a');
    assert.equal(await fsp.readFile(path.join(f.dataDir, 'b.json'), 'utf8'), 'old b');
    assert.equal(f.effects.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('startup recovery rolls a prepared restore forward idempotently', async () => {
  const f = await fixture();
  try {
    const id = 'restore-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const restoreDir = path.join(f.runtimeDir, id);
    await write(f.dataDir, 'characters.json', 'old');
    await write(restoreDir, 'original/characters.json', 'old');
    await write(restoreDir, 'next/characters.json', 'new');
    await write(restoreDir, 'journal.json', JSON.stringify({
      version: 1,
      id,
      state: 'prepared',
      entries: [{ path: 'characters.json', originalExists: true }],
    }));

    const result = await f.manager.recover();

    assert.deepEqual(result.committed, [id]);
    assert.equal(await fsp.readFile(path.join(f.dataDir, 'characters.json'), 'utf8'), 'new');
    assert.equal(f.effects.length, 1);
    assert.deepEqual(await f.manager.recover(), { committed: [], rolledBack: [], cleaned: [] });
  } finally {
    await f.cleanup();
  }
});

test('startup recovery completes a prepared removal', async () => {
  const f = await fixture();
  try {
    const id = 'restore-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const restoreDir = path.join(f.runtimeDir, id);
    await write(f.dataDir, 'locations.json', 'old locations');
    await write(restoreDir, 'original/locations.json', 'old locations');
    await write(restoreDir, 'journal.json', JSON.stringify({
      version: 1,
      id,
      state: 'prepared',
      entries: [{ path: 'locations.json', originalExists: true, remove: true }],
    }));

    const result = await f.manager.recover();

    assert.deepEqual(result.committed, [id]);
    await assert.rejects(fsp.stat(path.join(f.dataDir, 'locations.json')), {
      code: 'ENOENT',
    });
    assert.equal(f.effects.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('startup recovery completes an interrupted rollback', async () => {
  const f = await fixture();
  try {
    const id = 'restore-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const restoreDir = path.join(f.runtimeDir, id);
    await write(f.dataDir, 'characters.json', 'partially published');
    await write(restoreDir, 'original/characters.json', 'old');
    await write(restoreDir, 'next/characters.json', 'new');
    await write(restoreDir, 'journal.json', JSON.stringify({
      version: 1,
      id,
      state: 'rolling-back',
      entries: [{ path: 'characters.json', originalExists: true }],
    }));

    const result = await f.manager.recover();

    assert.deepEqual(result.rolledBack, [id]);
    assert.equal(await fsp.readFile(path.join(f.dataDir, 'characters.json'), 'utf8'), 'old');
    assert.equal(f.effects.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('startup recovery refuses an unsafe journal path', async () => {
  const f = await fixture();
  try {
    const id = 'restore-cccccccccccccccccccccccccccccccc';
    const restoreDir = path.join(f.runtimeDir, id);
    await write(restoreDir, 'journal.json', JSON.stringify({
      version: 1,
      id,
      state: 'prepared',
      entries: [{ path: '../outside.json', originalExists: false }],
    }));

    await assert.rejects(f.manager.recover(), error => {
      assert.equal(error.code, 'RESTORE_JOURNAL_INVALID');
      assert.match(error.message, /Unsafe restore journal/);
      return true;
    });
    assert.ok(await fsp.stat(restoreDir), 'unsafe journal must remain available for diagnosis');
  } finally {
    await f.cleanup();
  }
});

test('a completed restore journal never overwrites a later write during cleanup recovery', async () => {
  const f = await fixture();
  try {
    const id = 'restore-dddddddddddddddddddddddddddddddd';
    const restoreDir = path.join(f.runtimeDir, id);
    await write(f.dataDir, 'characters.json', 'later write');
    await write(restoreDir, 'original/characters.json', 'before restore');
    await write(restoreDir, 'next/characters.json', 'restored value');
    await write(restoreDir, 'journal.json', JSON.stringify({
      version: 1,
      id,
      state: 'committed',
      effectsApplied: true,
      entries: [{ path: 'characters.json', originalExists: true }],
    }));

    assert.deepEqual((await f.manager.recover()).committed, [id]);
    assert.equal(await fsp.readFile(path.join(f.dataDir, 'characters.json'), 'utf8'), 'later write');
  } finally {
    await f.cleanup();
  }
});
