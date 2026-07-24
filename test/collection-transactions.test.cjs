'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { PublicationBarrier } = require('../server/publication-barrier.cjs');
const {
  CollectionTransactionManager,
  applyOperations,
  assertSafeJson,
  normalizeCollections,
  normalizeOperations,
  revisionOf,
} = require('../server/collection-transactions.cjs');

test('transaction validation rejects duplicate collections, duplicate writes, and unsafe values', () => {
  assert.throws(() => normalizeCollections(['notes', 'notes']), /duplicate collection/);
  assert.throws(
    () => normalizeOperations([
      { collection: 'notes', op: 'put', id: 'a', value: { name: 'A' } },
      { collection: 'notes', op: 'delete', id: 'a' },
    ], new Set(['notes'])),
    error => error.code === 'TX_DUPLICATE_WRITE',
  );
  const unsafe = JSON.parse('{"safe":{"constructor":{"pollute":true}}}');
  assert.throws(() => assertSafeJson(unsafe), /forbidden key/);
});

test('put/delete operations apply to list and keyed containers without mutating the snapshot', () => {
  const original = new Map([
    ['notes', [{ id: 'old', name: 'Old' }]],
    ['config', { main: { enabled: false } }],
  ]);
  const descriptors = new Map([
    ['notes', { keyed: false }],
    ['config', { keyed: true }],
  ]);
  const operations = normalizeOperations([
    { collection: 'notes', op: 'delete', id: 'old' },
    { collection: 'notes', op: 'put', id: 'new', value: { id: 'new', name: 'New' } },
    { collection: 'config', op: 'put', id: 'main', value: { enabled: true } },
  ], new Set(['notes', 'config']));
  const next = applyOperations(original, descriptors, operations);
  assert.deepEqual(original.get('notes'), [{ id: 'old', name: 'Old' }]);
  assert.deepEqual(next.get('notes'), [{ id: 'new', name: 'New' }]);
  assert.deepEqual(next.get('config'), { main: { enabled: true } });
  assert.notEqual(revisionOf(original.get('notes')), revisionOf(next.get('notes')));
});

test('expired transaction lease cannot later commit', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-expiry-'));
  const addonDataDir = path.join(root, 'addon-data');
  const runtimeDir = path.join(root, '.runtime', 'transactions');
  const notesPath = path.join(addonDataDir, 'fixture', 'notes.json');
  await fsp.mkdir(path.dirname(notesPath), { recursive: true });
  await fsp.writeFile(notesPath, '[]', 'utf8');
  let now = 1000;
  const manager = new CollectionTransactionManager({
    runtimeDir,
    addonDataDir,
    publicationBarrier: new PublicationBarrier(),
    now: () => now,
    resolveCollection: (_addonId, name) => ({
      name,
      keyed: false,
      access: 'public',
      path: notesPath,
    }),
  });
  try {
    const opened = await manager.begin({
      addonId: 'fixture',
      role: 'dm',
      collections: ['notes'],
      timeoutMs: 250,
    });
    now = opened.deadline;
    await assert.rejects(
      manager.commit({
        addonId: 'fixture',
        role: 'dm',
        transactionId: opened.transactionId,
        operations: [
          { collection: 'notes', op: 'put', id: 'ghost', value: { name: 'Ghost' } },
        ],
      }),
      error => error.code === 'TX_EXPIRED',
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(notesPath, 'utf8')), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recovery cleans journal-less preparation but refuses to guess from a malformed journal', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-invalid-'));
  const runtimeDir = path.join(root, '.runtime', 'transactions');
  const addonDataDir = path.join(root, 'addon-data');
  const abandoned = path.join(runtimeDir, 'tx-11111111111111111111111111111111');
  const invalid = path.join(runtimeDir, 'tx-22222222222222222222222222222222');
  await fsp.mkdir(abandoned, { recursive: true });
  await fsp.mkdir(invalid, { recursive: true });
  await fsp.writeFile(path.join(abandoned, 'notes.next.json'), '[]', 'utf8');
  await fsp.writeFile(path.join(invalid, 'journal.json'), '{"state":"publishing"}', 'utf8');
  const manager = new CollectionTransactionManager({
    runtimeDir,
    addonDataDir,
    publicationBarrier: new PublicationBarrier(),
    resolveCollection: () => {
      throw new Error('not used during recovery');
    },
  });
  try {
    await assert.rejects(
      manager.recover(),
      error => error.code === 'TX_JOURNAL_INVALID' && /Unsafe transaction journal/.test(error.message),
    );
    await assert.rejects(fsp.stat(abandoned), { code: 'ENOENT' });
    assert.equal((await fsp.stat(invalid)).isDirectory(), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recovery preserves and rejects an unparsable durable journal', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-corrupt-'));
  const runtimeDir = path.join(root, '.runtime', 'transactions');
  const addonDataDir = path.join(root, 'addon-data');
  const invalid = path.join(runtimeDir, 'tx-33333333333333333333333333333333');
  await fsp.mkdir(invalid, { recursive: true });
  await fsp.writeFile(path.join(invalid, 'journal.json'), '{"state":', 'utf8');
  const manager = new CollectionTransactionManager({
    runtimeDir,
    addonDataDir,
    publicationBarrier: new PublicationBarrier(),
    resolveCollection: () => {
      throw new Error('not used during recovery');
    },
  });
  try {
    await assert.rejects(
      manager.recover(),
      error => error.code === 'TX_JOURNAL_INVALID' && /invalid JSON/.test(error.message),
    );
    assert.equal((await fsp.stat(invalid)).isDirectory(), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a failed rollback poisons reads and preserves a recoverable rolling-back journal', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-rollback-fail-'));
  const runtimeDir = path.join(root, '.runtime', 'transactions');
  const addonDataDir = path.join(root, 'addon-data');
  const notesPath = path.join(addonDataDir, 'fixture', 'notes.json');
  const vaultPath = path.join(addonDataDir, 'fixture', 'vault.json');
  await fsp.mkdir(path.dirname(notesPath), { recursive: true });
  await fsp.writeFile(notesPath, JSON.stringify([{ id: 'old', value: 1 }]), 'utf8');
  await fsp.writeFile(vaultPath, JSON.stringify({ main: { value: 1 } }), 'utf8');
  const barrier = new PublicationBarrier();
  let fatalError;
  const descriptor = (_addonId, name) => ({
    name,
    keyed: name === 'vault',
    access: 'public',
    path: name === 'vault' ? vaultPath : notesPath,
  });
  const manager = new CollectionTransactionManager({
    runtimeDir,
    addonDataDir,
    publicationBarrier: barrier,
    resolveCollection: descriptor,
    fault: phase => {
      if (phase === 'publish:1:after' || phase === 'rollback:0:before') {
        throw new Error(`fault:${phase}`);
      }
    },
    onFatal: error => { fatalError = error; },
  });
  try {
    const opened = await manager.begin({
      addonId: 'fixture',
      role: 'dm',
      collections: ['notes', 'vault'],
    });
    await assert.rejects(
      manager.commit({
        addonId: 'fixture',
        role: 'dm',
        transactionId: opened.transactionId,
        operations: [
          { collection: 'notes', op: 'put', id: 'new', value: { value: 2 } },
          { collection: 'vault', op: 'put', id: 'main', value: { value: 2 } },
        ],
      }),
      error => error.code === 'TX_COMMIT_FAILED' && Boolean(error.rollbackError),
    );
    assert.match(fatalError.message, /startup recovery required/);
    await assert.rejects(barrier.read(() => 'unsafe'), /startup recovery required/);
    const pending = (await fsp.readdir(runtimeDir)).filter(name => /^tx-[0-9a-f]{32}$/.test(name));
    assert.equal(pending.length, 1);
    const journal = JSON.parse(await fsp.readFile(path.join(runtimeDir, pending[0], 'journal.json'), 'utf8'));
    assert.equal(journal.state, 'rolling-back');

    const recovery = new CollectionTransactionManager({
      runtimeDir,
      addonDataDir,
      publicationBarrier: new PublicationBarrier(),
      resolveCollection: descriptor,
    });
    assert.deepEqual((await recovery.recover()).rolledBack, pending);
    assert.deepEqual(JSON.parse(await fsp.readFile(notesPath, 'utf8')), [{ id: 'old', value: 1 }]);
    assert.deepEqual(JSON.parse(await fsp.readFile(vaultPath, 'utf8')), { main: { value: 1 } });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

const FAILURE_BOUNDARIES = [
  'stage:0:before',
  'stage:0:after',
  'stage:1:before',
  'stage:1:after',
  'journal:prepared:before',
  'journal:prepared:after',
  'journal:publishing:before',
  'journal:publishing:after',
  'publish:0:before',
  'publish:0:after',
  'publish:1:before',
  'publish:1:after',
  'journal:committed:before',
  'journal:committed:after',
  'cleanup:before',
  'cleanup:after',
];

for (const phase of FAILURE_BOUNDARIES) {
  test(`deterministic ${phase} fault resolves to one complete state`, async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-boundary-'));
    const runtimeDir = path.join(root, '.runtime', 'transactions');
    const addonDataDir = path.join(root, 'addon-data');
    const notesPath = path.join(addonDataDir, 'fixture', 'notes.json');
    const vaultPath = path.join(addonDataDir, 'fixture', 'vault.json');
    await fsp.mkdir(path.dirname(notesPath), { recursive: true });
    await fsp.writeFile(notesPath, JSON.stringify([{ id: 'old', value: 1 }]), 'utf8');
    await fsp.writeFile(vaultPath, JSON.stringify({ main: { value: 1 } }), 'utf8');
    let effects = 0;
    const manager = new CollectionTransactionManager({
      runtimeDir,
      addonDataDir,
      publicationBarrier: new PublicationBarrier(),
      resolveCollection: (_addonId, name) => ({
        name,
        keyed: name === 'vault',
        access: 'public',
        path: name === 'vault' ? vaultPath : notesPath,
      }),
      fault: current => {
        if (current === phase) throw new Error(`fault:${phase}`);
      },
      onCommit: async () => { effects++; },
    });
    try {
      const opened = await manager.begin({
        addonId: 'fixture',
        role: 'dm',
        collections: ['notes', 'vault'],
      });
      let result;
      let failure;
      try {
        result = await manager.commit({
          addonId: 'fixture',
          role: 'dm',
          transactionId: opened.transactionId,
          operations: [
            { collection: 'notes', op: 'put', id: 'new', value: { value: 2 } },
            { collection: 'vault', op: 'put', id: 'main', value: { value: 2 } },
          ],
        });
      } catch (error) {
        failure = error;
      }
      const committed = phase === 'journal:committed:after'
        || phase === 'cleanup:before'
        || phase === 'cleanup:after';
      const notes = JSON.parse(await fsp.readFile(notesPath, 'utf8'));
      const vault = JSON.parse(await fsp.readFile(vaultPath, 'utf8'));
      if (committed) {
        assert.equal(result.ok, true);
        assert.equal(failure, undefined);
        assert.equal(notes.some(record => record.id === 'new'), true);
        assert.equal(vault.main.value, 2);
        assert.equal(effects, 1);
      } else {
        assert.equal(result, undefined);
        assert.equal(failure.code, 'TX_COMMIT_FAILED');
        assert.deepEqual(notes, [{ id: 'old', value: 1 }]);
        assert.deepEqual(vault, { main: { value: 1 } });
        assert.equal(effects, 0);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
}
