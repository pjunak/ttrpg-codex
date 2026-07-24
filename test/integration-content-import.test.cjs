'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('./helpers/server-process.cjs');

const DM_PASSWORD = 'dm-import-password';
const PLAYER_PASSWORD = 'player-import-password';
const ADDON_ID = 'import-fixture';
const PROVIDER_ID = 'fixture-json';
const HASH = '1111111111111111';
const COLLECTION_FILE = path.join('addon-data', ADDON_ID, 'items.json');

const SERVER_CODE = `'use strict';
module.exports.init = host => {
  const target = { scope: 'addon', addonId: '${ADDON_ID}', collection: 'items' };
  host.registerImportProvider({
    id: '${PROVIDER_ID}',
    apiVersion: 1,
    schemaVersion: 1,
    formats: ['json'],
    reads: [target],
    writes: [target],
    targetTypes: ['addon-list'],
    limits: {
      maxInputBytes: 65536,
      maxDepth: 12,
      maxRecords: 100,
      maxStringChars: 8192,
      maxOperations: 100,
      timeoutMs: 2000
    },
    capabilities: ['abort-signal', 'structured-diagnostics'],
    async preview(input, context) {
      context.read(target);
      const records = Array.isArray(input.data && input.data.records) ? input.data.records : [];
      return {
        schemaVersion: 1,
        operations: records.map(record => ({
          target,
          op: 'put',
          id: record.id,
          value: { name: record.name }
        })),
        diagnostics: []
      };
    }
  });
};`;

function addonEntry() {
  return {
    id: ADDON_ID,
    name: 'Import fixture',
    version: '1.0.0',
    apiVersion: 2,
    hostVersion: '>=1.0.0',
    capabilities: {
      required: ['collections.dm', 'collections.transactions', 'imports.providers'],
    },
    enabled: true,
    entry: 'entry.js',
    server: 'server/index.cjs',
    activeHash: HASH,
    grantedPermissions: [
      'server:code',
      'data:own',
      'data:import-provider',
    ],
    serverDeps: [],
    collections: [{ name: 'items', keyed: false, access: 'dm' }],
  };
}

function registry() {
  return {
    schema: 1,
    addons: [addonEntry()],
    resolutions: {},
    sources: { allow: [] },
  };
}

function seedFiles() {
  return {
    [`addons/${ADDON_ID}/${HASH}/server/index.cjs`]: SERVER_CODE,
    [COLLECTION_FILE]: [],
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

function uploadBody(value, name = 'input.json', mime = 'application/json') {
  const form = new FormData();
  form.append('addonId', ADDON_ID);
  form.append('providerId', PROVIDER_ID);
  form.append('format', 'json');
  form.append('input', new Blob([value], { type: mime }), name);
  return form;
}

async function createJob(srv, value, name, mime) {
  const response = await srv.fetch('/api/content-import/jobs', {
    method: 'POST',
    body: uploadBody(value, name, mime),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.job;
}

test('real server import flow is DM-only, preview is read-only, and commit uses F2 exactly once', async () => {
  const srv = await startServer({
    dmPassword: DM_PASSWORD,
    playerPassword: PLAYER_PASSWORD,
    seedData: { 'addons.json': registry() },
    seedFiles: seedFiles(),
  });
  try {
    assert.equal((await srv.fetch('/api/content-import/providers')).status, 403);
    await login(srv, PLAYER_PASSWORD);
    assert.equal((await srv.fetch('/api/content-import/providers')).status, 403);

    srv.clearCookies();
    await login(srv, DM_PASSWORD);
    let response = await srv.fetch('/api/content-import/providers');
    assert.equal(response.status, 200);
    const providers = (await response.json()).providers;
    assert.deepEqual(providers.map(entry => `${entry.addonId}:${entry.id}`), [
      `${ADDON_ID}:${PROVIDER_ID}`,
    ]);

    response = await srv.fetch('/api/view-as', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await srv.fetch('/api/content-import/providers')).status, 403);
    const playerHashBefore = (await (await srv.fetch('/api/version')).json()).hash;
    assert.equal((await srv.fetch('/api/view-as-dm', { method: 'POST' })).status, 200);

    const beforeVersion = await (await srv.fetch('/api/version')).json();
    const beforeSnapshots = (await (await srv.fetch('/api/snapshots')).json()).snapshots;
    const job = await createJob(
      srv,
      JSON.stringify({ records: [{ id: 'alpha', name: 'Alpha' }] }),
      'misleading.txt',
      'text/plain',
    );
    response = await srv.fetch(`/api/content-import/jobs/${job.id}/preview`, { method: 'POST' });
    const preview = await response.json();
    assert.equal(response.status, 200, JSON.stringify(preview));
    assert.equal(preview.plan.operations[0].id, 'alpha');
    assert.equal(preview.plan.operations[0].value.name, 'Alpha');
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(srv.dataDir, COLLECTION_FILE), 'utf8')),
      [],
    );
    assert.equal((await (await srv.fetch('/api/version')).json()).hash, beforeVersion.hash);
    assert.deepEqual((await (await srv.fetch('/api/snapshots')).json()).snapshots, beforeSnapshots);

    response = await srv.fetch(`/api/content-import/jobs/${job.id}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    const committed = await response.json();
    assert.equal(response.status, 200, JSON.stringify(committed));
    response = await srv.fetch(`/api/content-import/jobs/${job.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).job.result, committed);
    assert.equal(committed.operationCount, 1);
    assert.ok(committed.commitId);
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(srv.dataDir, COLLECTION_FILE), 'utf8')),
      [{ id: 'alpha', name: 'Alpha' }],
    );
    assert.notEqual((await (await srv.fetch('/api/version')).json()).hash, beforeVersion.hash);
    const afterSnapshots = (await (await srv.fetch('/api/snapshots')).json()).snapshots;
    assert.equal(afterSnapshots.length, beforeSnapshots.length + 1);
    assert.equal(afterSnapshots.at(-1).reason, 'transaction');
    assert.equal((await srv.fetch('/api/view-as', { method: 'POST' })).status, 200);
    assert.equal((await (await srv.fetch('/api/version')).json()).hash, playerHashBefore);
    assert.equal((await srv.fetch('/api/view-as-dm', { method: 'POST' })).status, 200);

    response = await srv.fetch(`/api/content-import/jobs/${job.id}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'IMPORT_TOKEN_USED');
  } finally {
    await srv.kill();
  }
});

test('real server rejects stale/unsafe previews, supports cancellation, and cleans restart input', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-import-data-'));
  const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-import-snaps-'));
  const importDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-import-input-'));
  const activeImportDir = path.join(
    importDir,
    `campaign-${crypto.createHash('sha256')
      .update(path.resolve(dataDir))
      .digest('hex')
      .slice(0, 16)}`,
  );
  let srv;
  try {
    srv = await startServer({
      dataDir,
      snapshotsDir,
      dmPassword: DM_PASSWORD,
      playerPassword: PLAYER_PASSWORD,
      env: { CODEX_IMPORT_TEMP_DIR: importDir },
      seedData: { 'addons.json': registry() },
      seedFiles: seedFiles(),
    });
    await login(srv, DM_PASSWORD);

    const unsafe = await createJob(
      srv,
      '{"records":[{"id":"a","name":"A","nested":{"x":1,"x":2}}]}',
    );
    let response = await srv.fetch(`/api/content-import/jobs/${unsafe.id}/preview`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'IMPORT_DUPLICATE_KEY');
    assert.deepEqual(await fsp.readdir(activeImportDir), []);

    const stale = await createJob(srv, '{"records":[{"id":"stale","name":"Stale"}]}');
    response = await srv.fetch(`/api/content-import/jobs/${stale.id}/preview`, { method: 'POST' });
    const preview = await response.json();
    assert.equal(response.status, 200);
    response = await srv.fetch('/api/data', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: `addon:${ADDON_ID}:items`,
        action: 'save',
        payload: { id: 'concurrent', name: 'Concurrent' },
      }),
    });
    assert.equal(response.status, 200);
    response = await srv.fetch(`/api/content-import/jobs/${stale.id}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'IMPORT_REVISION_CONFLICT');

    const cancelled = await createJob(srv, '{"records":[]}');
    response = await srv.fetch(`/api/content-import/jobs/${cancelled.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).job.state, 'cancelled');
    assert.deepEqual(await fsp.readdir(activeImportDir), []);

    await createJob(srv, '{"records":[{"id":"restart","name":"Restart"}]}');
    assert.equal((await fsp.readdir(activeImportDir)).length, 1);
    await srv.kill();
    srv = await startServer({
      dataDir,
      snapshotsDir,
      dmPassword: DM_PASSWORD,
      playerPassword: PLAYER_PASSWORD,
      env: { CODEX_IMPORT_TEMP_DIR: importDir },
    });
    assert.deepEqual(await fsp.readdir(activeImportDir), []);
    await login(srv, DM_PASSWORD);
    assert.equal((await srv.fetch('/api/content-import/providers')).status, 200);
  } finally {
    if (srv) await srv.kill();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(snapshotsDir, { recursive: true, force: true });
    await fsp.rm(importDir, { recursive: true, force: true });
  }
});
