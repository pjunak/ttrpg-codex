'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers/server-process.cjs');
const { readZip } = require('./helpers/zip.cjs');

const DM = 'dm-transaction-password';
const PLAYER = 'player-transaction-password';

function registry() {
  const transactionCapabilities = {
    required: ['collections.dm', 'collections.transactions'],
  };
  return {
    schema: 1,
    addons: [
      {
        id: 'tx-fixture',
        name: 'Transaction Fixture',
        version: '1.0.0',
        apiVersion: 2,
        hostVersion: '>=1.0.0',
        capabilities: transactionCapabilities,
        enabled: true,
        entry: 'entry.js',
        activeHash: 'fixture',
        grantedPermissions: ['data:own'],
        collections: [
          { name: 'notes', keyed: false, access: 'public' },
          { name: 'scenarios', keyed: false, access: 'dm' },
          { name: 'vault', keyed: true, access: 'dm' },
        ],
      },
      {
        id: 'tx-other',
        name: 'Other Transaction Fixture',
        version: '1.0.0',
        apiVersion: 2,
        hostVersion: '>=1.0.0',
        capabilities: transactionCapabilities,
        enabled: true,
        entry: 'entry.js',
        activeHash: 'other',
        grantedPermissions: ['data:own'],
        collections: [{ name: 'scenarios', keyed: false, access: 'dm' }],
      },
    ],
    resolutions: {},
    sources: { allow: [] },
  };
}

async function login(srv, password) {
  const response = await srv.fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
}

function transactionRequest(srv, addonId, body) {
  return srv.fetch(`/api/addons/${addonId}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function begin(srv, collections, addonId = 'tx-fixture') {
  const response = await transactionRequest(srv, addonId, {
    mode: 'begin',
    collections,
    timeoutMs: 5000,
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function commit(srv, transactionId, operations, addonId = 'tx-fixture') {
  return transactionRequest(srv, addonId, {
    mode: 'commit',
    transactionId,
    operations,
  });
}

function patch(srv, type, action, payload) {
  return srv.fetch('/api/data', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, action, payload }),
  });
}

async function readAddonFile(dataDir, addonId, name) {
  try {
    return JSON.parse(await fsp.readFile(
      path.join(dataDir, 'addon-data', addonId, `${name}.json`),
      'utf8',
    ));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(filePath);
      return;
    } catch {
      await new Promise(resolve => { setTimeout(resolve, 10); });
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

const seedFiles = {
  'addon-data/tx-fixture/notes.json': [{ id: 'n1', name: 'Initial note' }],
  'addon-data/tx-fixture/scenarios.json': [{ id: 's1', name: 'Initial scenario' }],
  'addon-data/tx-fixture/vault.json': { main: { value: 1 } },
  'addon-data/tx-other/scenarios.json': [{ id: 'same', name: 'Other addon state' }],
};

test('transaction commits list and keyed collections from one consistent snapshot', async () => {
  const srv = await startServer({
    dmPassword: DM,
    playerPassword: PLAYER,
    seedData: { 'addons.json': registry() },
    seedFiles,
  });
  try {
    await login(srv, DM);
    const opened = await begin(srv, ['notes', 'scenarios', 'vault']);
    assert.equal(opened.snapshot.notes[0].name, 'Initial note');
    assert.equal(opened.snapshot.scenarios[0].name, 'Initial scenario');
    assert.equal(opened.snapshot.vault.main.value, 1);
    assert.equal(new Set(Object.values(opened.revisions)).size, 3);

    const response = await commit(srv, opened.transactionId, [
      { collection: 'notes', op: 'put', id: 'n2', value: { name: 'Committed note' } },
      { collection: 'scenarios', op: 'delete', id: 's1' },
      { collection: 'vault', op: 'put', id: 'main', value: { value: 2 } },
    ]);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.commitId);
    assert.deepEqual(result.changed, ['notes', 'scenarios', 'vault']);
    assert.deepEqual(result.collections.notes, [
      { id: 'n1', name: 'Initial note' },
      { name: 'Committed note', id: 'n2' },
    ]);
    assert.deepEqual(result.collections.scenarios, []);
    assert.deepEqual(result.collections.vault, { main: { value: 2 } });

    assert.deepEqual(await readAddonFile(srv.dataDir, 'tx-fixture', 'scenarios'), []);
    assert.deepEqual(await readAddonFile(srv.dataDir, 'tx-fixture', 'vault'), { main: { value: 2 } });
    assert.equal((await readAddonFile(srv.dataDir, 'tx-other', 'scenarios'))[0].name, 'Other addon state');

    const snapshots = (await fsp.readdir(srv.snapshotsDir)).filter(name => name.endsWith('.json'));
    assert.equal(snapshots.length, 1, 'one logical transaction creates one audit snapshot');
  } finally {
    await srv.kill();
  }
});

test('stale read-set revision conflicts before any transaction write', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry() },
    seedFiles,
  });
  try {
    await login(srv, DM);
    const opened = await begin(srv, ['notes', 'vault']);
    assert.equal((await patch(
      srv,
      'addon:tx-fixture:notes',
      'save',
      { id: 'outside', name: 'Concurrent mutation' },
    )).status, 200);
    const response = await commit(srv, opened.transactionId, [
      { collection: 'vault', op: 'put', id: 'main', value: { value: 99 } },
    ]);
    const conflict = await response.json();
    assert.equal(response.status, 409);
    assert.equal(conflict.code, 'TX_CONFLICT');
    assert.equal(conflict.details.collection, 'notes');
    assert.deepEqual(await readAddonFile(srv.dataDir, 'tx-fixture', 'vault'), { main: { value: 1 } });
  } finally {
    await srv.kill();
  }
});

test('authorization, ownership, duplicate-write validation, and one-shot leases fail closed', async () => {
  const srv = await startServer({
    dmPassword: DM,
    playerPassword: PLAYER,
    seedData: { 'addons.json': registry() },
    seedFiles,
  });
  try {
    await login(srv, PLAYER);
    const publicRead = await begin(srv, ['notes']);
    assert.equal(publicRead.snapshot.notes[0].id, 'n1');
    const hidden = await transactionRequest(srv, 'tx-fixture', {
      mode: 'begin',
      collections: ['scenarios'],
    });
    assert.equal(hidden.status, 404);
    const foreign = await transactionRequest(srv, 'tx-fixture', {
      mode: 'begin',
      collections: ['addon:tx-other:scenarios'],
    });
    assert.equal(foreign.status, 404);

    srv.clearCookies();
    await login(srv, DM);
    const opened = await begin(srv, ['notes']);
    const duplicate = await commit(srv, opened.transactionId, [
      { collection: 'notes', op: 'put', id: 'same', value: { name: 'First' } },
      { collection: 'notes', op: 'delete', id: 'same' },
    ]);
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).code, 'TX_DUPLICATE_WRITE');
    assert.equal((await readAddonFile(srv.dataDir, 'tx-fixture', 'notes')).length, 1);

    const retry = await commit(srv, opened.transactionId, [
      { collection: 'notes', op: 'put', id: 'late', value: { name: 'Late' } },
    ]);
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).code, 'TX_EXPIRED');
  } finally {
    await srv.kill();
  }
});

for (const phase of [
  'stage:1:after',
  'journal:prepared:after',
  'publish:1:before',
  'publish:1:after',
]) {
  test(`injected ${phase} failure leaves every collection at its pre-transaction state`, async () => {
    const srv = await startServer({
      dmPassword: DM,
      seedData: { 'addons.json': registry() },
      seedFiles,
      env: { CODEX_TX_FAIL_PHASE: phase },
    });
    try {
      await login(srv, DM);
      const opened = await begin(srv, ['notes', 'vault']);
      const response = await commit(srv, opened.transactionId, [
        { collection: 'notes', op: 'put', id: 'failed', value: { name: 'Failed' } },
        { collection: 'vault', op: 'put', id: 'main', value: { value: 77 } },
      ]);
      assert.equal(response.status, 500);
      assert.deepEqual(await readAddonFile(srv.dataDir, 'tx-fixture', 'notes'), [
        { id: 'n1', name: 'Initial note' },
      ]);
      assert.deepEqual(await readAddonFile(srv.dataDir, 'tx-fixture', 'vault'), {
        main: { value: 1 },
      });
      const runtime = path.join(srv.dataDir, '.runtime', 'transactions');
      assert.deepEqual(await fsp.readdir(runtime), []);
    } finally {
      await srv.kill();
    }
  });
}

for (const phase of ['journal:prepared:after', 'publish:0:after', 'journal:committed:after']) {
  test(`startup recovery completes an interrupted commit after ${phase}`, async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-restart-data-'));
    const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-restart-snaps-'));
    let crashed;
    let recovered;
    try {
      crashed = await startServer({
        dataDir,
        snapshotsDir,
        dmPassword: DM,
        seedData: { 'addons.json': registry() },
        seedFiles,
        env: { CODEX_TX_CRASH_PHASE: phase },
      });
      await login(crashed, DM);
      const opened = await begin(crashed, ['notes', 'vault']);
      await assert.rejects(
        commit(crashed, opened.transactionId, [
          { collection: 'notes', op: 'put', id: 'recovered', value: { name: 'Recovered' } },
          { collection: 'vault', op: 'put', id: 'main', value: { value: 42 } },
        ]),
      );
      await crashed.kill();
      crashed = null;

      recovered = await startServer({
        dataDir,
        snapshotsDir,
        dmPassword: DM,
      });
      await login(recovered, DM);
      assert.equal(
        (await readAddonFile(dataDir, 'tx-fixture', 'notes')).find(item => item.id === 'recovered').name,
        'Recovered',
      );
      assert.deepEqual(await readAddonFile(dataDir, 'tx-fixture', 'vault'), {
        main: { value: 42 },
      });
      assert.deepEqual(await fsp.readdir(path.join(dataDir, '.runtime', 'transactions')), []);
      if (phase === 'publish:0:after') {
        await recovered.kill();
        recovered = await startServer({
          dataDir,
          snapshotsDir,
          dmPassword: DM,
        });
        assert.equal(
          (await readAddonFile(dataDir, 'tx-fixture', 'notes'))
            .filter(item => item.id === 'recovered').length,
          1,
          'a second recovery sweep is an idempotent no-op',
        );
        assert.deepEqual(await fsp.readdir(path.join(dataDir, '.runtime', 'transactions')), []);
      }
    } finally {
      if (crashed) await crashed.kill();
      if (recovered) await recovered.kill();
      await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await fsp.rm(snapshotsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

test('startup recovery rolls back an interrupted rolling-back journal', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-rollback-data-'));
  const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-rollback-snaps-'));
  let crashed;
  let recovered;
  try {
    crashed = await startServer({
      dataDir,
      snapshotsDir,
      dmPassword: DM,
      seedData: { 'addons.json': registry() },
      seedFiles,
      env: {
        CODEX_TX_FAIL_PHASE: 'publish:1:after',
        CODEX_TX_CRASH_PHASE: 'rollback:0:after',
      },
    });
    await login(crashed, DM);
    const opened = await begin(crashed, ['notes', 'vault']);
    await assert.rejects(
      commit(crashed, opened.transactionId, [
        { collection: 'notes', op: 'put', id: 'rolled-back', value: { name: 'Rollback' } },
        { collection: 'vault', op: 'put', id: 'main', value: { value: 55 } },
      ]),
    );
    await crashed.kill();
    crashed = null;

    recovered = await startServer({
      dataDir,
      snapshotsDir,
      dmPassword: DM,
    });
    assert.deepEqual(await readAddonFile(dataDir, 'tx-fixture', 'notes'), [
      { id: 'n1', name: 'Initial note' },
    ]);
    assert.deepEqual(await readAddonFile(dataDir, 'tx-fixture', 'vault'), {
      main: { value: 1 },
    });
    assert.deepEqual(await fsp.readdir(path.join(dataDir, '.runtime', 'transactions')), []);
  } finally {
    if (crashed) await crashed.kill();
    if (recovered) await recovered.kill();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fsp.rm(snapshotsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ordinary readers and backup cannot observe or capture a partially published transaction', async () => {
  const controlDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-control-'));
  const reached = path.join(controlDir, 'publish_0_after.reached');
  const release = path.join(controlDir, 'publish_0_after.release');
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry() },
    seedFiles,
    env: {
      CODEX_TX_PAUSE_PHASE: 'publish:0:after',
      CODEX_TX_CONTROL_DIR: controlDir,
    },
  });
  try {
    await login(srv, DM);
    const opened = await begin(srv, ['notes', 'vault']);
    const commitPromise = commit(srv, opened.transactionId, [
      { collection: 'notes', op: 'put', id: 'barrier', value: { name: 'Barrier result' } },
      { collection: 'vault', op: 'put', id: 'main', value: { value: 88 } },
    ]);
    await waitForFile(reached);

    const dataPromise = srv.fetch('/api/data').then(response => response.json());
    const backupPromise = srv.fetch('/api/backup').then(async response => ({
      status: response.status,
      entries: await readZip(Buffer.from(await response.arrayBuffer())),
    }));
    await fsp.writeFile(release, '', 'utf8');

    const committed = await commitPromise;
    assert.equal(committed.status, 200);
    const [data, backup] = await Promise.all([dataPromise, backupPromise]);
    assert.equal(data['addon:tx-fixture:notes'].some(item => item.id === 'barrier'), true);
    assert.equal(data['addon:tx-fixture:vault'].main.value, 88);
    assert.equal(backup.status, 200);
    const names = backup.entries.map(entry => entry.entryName);
    assert.equal(names.some(name => name.includes('.runtime/')), false);
    const notesEntry = backup.entries.find(entry =>
      entry.entryName === 'data/addon-data/tx-fixture/notes.json');
    const vaultEntry = backup.entries.find(entry =>
      entry.entryName === 'data/addon-data/tx-fixture/vault.json');
    assert.equal(JSON.parse(notesEntry.data).some(item => item.id === 'barrier'), true);
    assert.equal(JSON.parse(vaultEntry.data).main.value, 88);
  } finally {
    await srv.kill();
    await fsp.rm(controlDir, { recursive: true, force: true });
  }
});

test('ordinary readers remain blocked until an in-barrier rollback is complete', async () => {
  const controlDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-rollback-control-'));
  const reached = path.join(controlDir, 'rollback_0_after.reached');
  const release = path.join(controlDir, 'rollback_0_after.release');
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry() },
    seedFiles,
    env: {
      CODEX_TX_FAIL_PHASE: 'publish:1:after',
      CODEX_TX_PAUSE_PHASE: 'rollback:0:after',
      CODEX_TX_CONTROL_DIR: controlDir,
    },
  });
  try {
    await login(srv, DM);
    const opened = await begin(srv, ['notes', 'vault']);
    const commitPromise = commit(srv, opened.transactionId, [
      { collection: 'notes', op: 'put', id: 'partial', value: { name: 'Partial' } },
      { collection: 'vault', op: 'put', id: 'main', value: { value: 66 } },
    ]);
    await waitForFile(reached);
    const dataPromise = srv.fetch('/api/data').then(response => response.json());
    await fsp.writeFile(release, '', 'utf8');
    const response = await commitPromise;
    assert.equal(response.status, 500);
    const data = await dataPromise;
    assert.deepEqual(data['addon:tx-fixture:notes'], [{ id: 'n1', name: 'Initial note' }]);
    assert.deepEqual(data['addon:tx-fixture:vault'], { main: { value: 1 } });
  } finally {
    await srv.kill();
    await fsp.rm(controlDir, { recursive: true, force: true });
  }
});

test('a disconnected client before the durable commit point cannot produce a ghost commit', async () => {
  const controlDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tx-abort-'));
  const reached = path.join(controlDir, 'stage_0_after.reached');
  const release = path.join(controlDir, 'stage_0_after.release');
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry() },
    seedFiles,
    env: {
      CODEX_TX_PAUSE_PHASE: 'stage:0:after',
      CODEX_TX_CONTROL_DIR: controlDir,
    },
  });
  try {
    await login(srv, DM);
    const opened = await begin(srv, ['notes']);
    const controller = new AbortController();
    const request = fetch(`${srv.baseUrl}/api/addons/tx-fixture/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: srv.cookieValue(),
      },
      body: JSON.stringify({
        mode: 'commit',
        transactionId: opened.transactionId,
        operations: [
          { collection: 'notes', op: 'put', id: 'ghost', value: { name: 'Ghost' } },
        ],
      }),
      signal: controller.signal,
    });
    await waitForFile(reached);
    controller.abort();
    await assert.rejects(request, error => error.name === 'AbortError');
    await fsp.writeFile(release, '', 'utf8');

    const followup = await begin(srv, ['notes']);
    await transactionRequest(srv, 'tx-fixture', {
      mode: 'cancel',
      transactionId: followup.transactionId,
    });
    assert.equal(followup.snapshot.notes.some(item => item.id === 'ghost'), false);
    assert.deepEqual(await fsp.readdir(path.join(srv.dataDir, '.runtime', 'transactions')), []);
  } finally {
    await srv.kill();
    await fsp.rm(controlDir, { recursive: true, force: true });
  }
});
