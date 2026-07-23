'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { startServer } = require('./helpers/server-process.cjs');
const { readZip } = require('./helpers/zip.cjs');

const DM = 'dm-pw';
const HASH = '1111111111111111';

async function login(srv) {
  const res = await srv.fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DM }),
  });
  assert.equal(res.status, 200);
}

const patchCharacter = (srv, character) => srv.fetch('/api/data', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'characters',
    action: 'save',
    payload: character,
  }),
});

async function makeStagingRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'codex-backup-stage-test-'));
}

async function waitForEmpty(dir, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entries = await fsp.readdir(dir).catch(() => []);
    if (entries.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(await fsp.readdir(dir), []);
}

const wedgeEntry = {
  id: 'wedge',
  name: 'Wedge',
  version: '1.0.0',
  apiVersion: 1,
  enabled: true,
  entry: 'entry.js',
  server: 'server/index.cjs',
  activeHash: HASH,
  grantedPermissions: ['server:code'],
  serverDeps: [],
};
const wedgeRegistry = {
  schema: 1,
  addons: [wedgeEntry],
  resolutions: {},
  sources: { allow: [] },
};
const wedgeServer = `'use strict';
module.exports.init = host => {
  host.get('/hold', async (_req, _res) => {
    await host.withLock(() => new Promise(() => {}));
  });
};`;

test('a mutation queued behind a wedged holder gets the deterministic bounded 503', async () => {
  const srv = await startServer({
    dmPassword: DM,
    env: { CODEX_WRITE_LOCK_TIMEOUT_MS: '60' },
    seedData: { 'addons.json': wedgeRegistry },
    seedFiles: { [`addons/wedge/${HASH}/server/index.cjs`]: wedgeServer },
  });
  try {
    await login(srv);
    void srv.fetch('/api/addon/wedge/hold').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 30));

    const started = Date.now();
    const res = await patchCharacter(srv, { id: 'ghost', name: 'Ghost' });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: 'Write lock acquisition timed out',
      code: 'WRITE_LOCK_TIMEOUT',
      timeoutMs: 60,
    });
    assert.ok(elapsed >= 40 && elapsed < 1000, `bounded timeout took ${elapsed}ms`);
    await assert.rejects(fsp.access(path.join(srv.dataDir, 'characters.json')), { code: 'ENOENT' });
  } finally {
    await srv.kill();
  }
});

test('backup is a point-in-time copy while a write races snapshot creation', async () => {
  const stagingRoot = await makeStagingRoot();
  const before = { id: 'hero', name: 'Before', visibility: 'public' };
  const after = { ...before, name: 'After' };
  const srv = await startServer({
    dmPassword: DM,
    env: {
      CODEX_BACKUP_STAGING_DIR: stagingRoot,
      CODEX_BACKUP_TEST_COPY_DELAY_MS: '100',
    },
    seedData: { 'characters.json': [before] },
  });
  try {
    await login(srv);
    const backupPromise = srv.fetch('/api/backup');
    await new Promise(resolve => setTimeout(resolve, 20));
    const writePromise = patchCharacter(srv, after);
    const [backup, write] = await Promise.all([backupPromise, writePromise]);
    assert.equal(backup.status, 200);
    assert.equal(write.status, 200);

    const entries = await readZip(Buffer.from(await backup.arrayBuffer()));
    const characters = entries.find(entry => entry.entryName === 'data/characters.json');
    assert.ok(characters);
    assert.equal(JSON.parse(characters.data.toString('utf8'))[0].name, 'Before');
    assert.equal(JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'characters.json'), 'utf8'))[0].name, 'After');
    await waitForEmpty(stagingRoot);
  } finally {
    await srv.kill();
    await fsp.rm(stagingRoot, { recursive: true, force: true });
  }
});

test('paused backup streaming does not hold the core write lock', async () => {
  const stagingRoot = await makeStagingRoot();
  const srv = await startServer({
    dmPassword: DM,
    env: { CODEX_BACKUP_STAGING_DIR: stagingRoot },
    seedFiles: { 'large.bin': crypto.randomBytes(12 * 1024 * 1024) },
  });
  try {
    await login(srv);
    const responseReady = new Promise((resolve, reject) => {
      const req = http.get(`${srv.baseUrl}/api/backup`, {
        headers: { cookie: srv.cookieValue() },
      }, res => {
        res.pause();
        resolve({ req, res });
      });
      req.on('error', reject);
    });
    const streaming = await responseReady;
    const write = await Promise.race([
      patchCharacter(srv, { id: 'during-stream', name: 'During stream' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('write remained locked by stream')), 1000)),
    ]);
    assert.equal(write.status, 200);
    streaming.res.destroy();
    streaming.req.destroy();
    await waitForEmpty(stagingRoot);
  } finally {
    await srv.kill();
    await fsp.rm(stagingRoot, { recursive: true, force: true });
  }
});

for (const phase of ['copy', 'archive']) {
  test(`backup staging is cleaned after ${phase} failure`, async () => {
    const stagingRoot = await makeStagingRoot();
    const srv = await startServer({
      dmPassword: DM,
      env: {
        CODEX_BACKUP_STAGING_DIR: stagingRoot,
        CODEX_BACKUP_TEST_FAIL_PHASE: phase,
      },
      seedData: { 'characters.json': [] },
    });
    try {
      await login(srv);
      const res = await srv.fetch('/api/backup');
      assert.equal(res.status, 500);
      await waitForEmpty(stagingRoot);
    } finally {
      await srv.kill();
      await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
  });
}
