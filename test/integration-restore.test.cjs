'use strict';

// Integration: POST /api/restore (ZIP path).
//  - Round-trip: a backup-shaped ZIP restores collection files into data/.
//  - `auth.json` is deployment config, not campaign data: a restore ZIP
//    carrying one must NOT overwrite the live credential (restoring an old
//    backup would silently roll the password back and rotate the cookie
//    secret → instant DM lockout). Same posture as snapshots
//    (NON_DATA_JSON_FILES). The entry is reported in `skipped`.
//  - Addon CODE (data/addons/**) is likewise refused (RCE-by-restore guard);
//    addon DATA (data/addon-data/**) restores fine.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const os       = require('os');
const path     = require('path');
const { startServer } = require('./helpers/server-process.cjs');
const { createZip } = require('./helpers/zip.cjs');

const DM = 'dm-pw';
async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}

async function postRestore(srv, content, filename = 'backup.zip', type = 'application/zip') {
  const form = new FormData();
  form.append('backup', new Blob([content], { type }), filename);
  return srv.fetch('/api/restore', { method: 'POST', body: form });
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

test('restore: ZIP round-trips collection files but never auth.json or addon code', async () => {
  const srv = await startServer({ dmPassword: DM });
  try {
    await login(srv, DM);

    const zipBuf = await createZip({
      'data/characters.json': [{ id: 'resa_x1', name: 'Restored Resa', visibility: 'public' }],
      'data/auth.json':       { bogus: 'credential-from-old-backup' },
      'data/addons/evil/1111111111111111/server/index.cjs': 'process.exit(1);',
      'data/.runtime/transactions/tx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/journal.json': {
        version: 1,
        id: 'tx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        addonId: 'dm-tools',
        state: 'publishing',
        entries: [{ collection: 'scenarios' }],
      },
      'data/addon-data/demo/rules.json': [{ id: 'grappling' }],
      'data/addon-data/dm-tools/scenarios.json': [{ id: 'restored-secret' }],
    });

    const res = await postRestore(srv, zipBuf);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.format, 'zip');

    // Collection + addon DATA restored.
    const chars = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'characters.json'), 'utf8'));
    assert.equal(chars[0].name, 'Restored Resa');
    const rules = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'addon-data', 'demo', 'rules.json'), 'utf8'));
    assert.equal(rules[0].id, 'grappling');
    const scenarios = JSON.parse(await fsp.readFile(
      path.join(srv.dataDir, 'addon-data', 'dm-tools', 'scenarios.json'),
      'utf8',
    ));
    assert.equal(scenarios[0].id, 'restored-secret');

    // auth.json NOT written from the ZIP.
    let authOnDisk = null;
    try { authOnDisk = await fsp.readFile(path.join(srv.dataDir, 'auth.json'), 'utf8'); }
    catch (e) { assert.equal(e.code, 'ENOENT'); }
    if (authOnDisk !== null) {
      assert.ok(!authOnDisk.includes('credential-from-old-backup'), 'auth.json must not come from the restore ZIP');
    }

    // Addon CODE not planted.
    await assert.rejects(
      fsp.stat(path.join(srv.dataDir, 'addons', 'evil')),
      { code: 'ENOENT' },
      'restore must refuse to write addon code'
    );
    assert.deepEqual(
      await fsp.readdir(path.join(srv.dataDir, '.runtime', 'transactions')),
      [],
      'restore must not plant or execute transaction runtime journals',
    );

    // All refusals surfaced as skipped entries (auth, addon code, transaction runtime).
    assert.ok(body.skipped >= 3, `expected ≥3 skipped entries, got ${body.skipped}`);

    // The DM session survives the restore (cookie secret not rotated).
    const auth = await srv.fetch('/api/auth');
    assert.deepEqual(await auth.json(), { role: 'dm', realRole: 'dm' });
  } finally { await srv.kill(); }
});

test('restore: requires auth', async () => {
  const srv = await startServer({ dmPassword: DM });
  try {
    const res = await postRestore(srv, await createZip({ 'data/characters.json': [] }));
    assert.equal(res.status, 401);
  } finally { await srv.kill(); }
});

test('restore: invalid JSON collection shape cannot partially publish earlier collections', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: {
      'characters.json': [{ id: 'old', name: 'Old character' }],
      'events.json': [{ id: 'old-event', name: 'Old event' }],
    },
  });
  try {
    await login(srv, DM);
    const res = await postRestore(
      srv,
      JSON.stringify({
        characters: [{ id: 'new', name: 'New character' }],
        events: 'not-an-array',
      }),
      'backup.json',
      'application/json',
    );
    assert.equal(res.status, 400);
    const characters = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'characters.json'), 'utf8'));
    const events = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'events.json'), 'utf8'));
    assert.deepEqual(characters.map(({ id, name }) => ({ id, name })), [
      { id: 'old', name: 'Old character' },
    ]);
    assert.deepEqual(events.map(({ id, name }) => ({ id, name })), [
      { id: 'old-event', name: 'Old event' },
    ]);
  } finally {
    await srv.kill();
  }
});

test('restore: invalid ZIP collection shape is rejected before publication', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: {
      'characters.json': [{ id: 'old', name: 'Old character' }],
      'events.json': [{ id: 'old-event', name: 'Old event' }],
    },
  });
  try {
    await login(srv, DM);
    const res = await postRestore(srv, await createZip({
      'data/characters.json': [{ id: 'new', name: 'New character' }],
      'data/events.json': { id: 'not-an-array' },
    }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /events\.json/);

    const characters = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'characters.json'), 'utf8'));
    const events = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'events.json'), 'utf8'));
    assert.equal(characters[0].id, 'old');
    assert.equal(events[0].id, 'old-event');
  } finally {
    await srv.kill();
  }
});

test('restore: candidate migrations complete before the overlay becomes live', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: {
      'settings.json': { theme: 'classic' },
      'mysteries.json': [{ id: 'kept', name: 'Overlay survivor' }],
    },
  });
  try {
    await login(srv, DM);
    const res = await postRestore(srv, await createZip({
      'data/characters.json': [{ id: 'legacy-character', name: 'Legacy' }],
      'data/events.json': [{ id: 'legacy-event', sitting: 0 }],
      'data/deletedDefaults.json': ['legacy:item'],
    }));
    assert.equal(res.status, 200);

    const characters = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'characters.json'), 'utf8'));
    const events = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'events.json'), 'utf8'));
    const tombstones = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'deletedDefaults.json'), 'utf8'));
    const settings = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'settings.json'), 'utf8'));
    const mysteries = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'mysteries.json'), 'utf8'));

    assert.equal(characters[0].visibility, 'public');
    assert.deepEqual(characters[0].attitudes, []);
    assert.equal(events[0].visibility, 'public');
    assert.equal(events[0].sitting, 1);
    assert.deepEqual(tombstones, { 'legacy:item': true });
    assert.equal(settings.theme, 'classic');
    assert.equal(mysteries[0].id, 'kept');
  } finally {
    await srv.kill();
  }
});

test('restore: a failed pre-restore snapshot leaves live data unchanged', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: {
      'characters.json': [{ id: 'old', name: 'Old character' }],
    },
  });
  try {
    await login(srv, DM);
    await fsp.writeFile(path.join(srv.dataDir, 'broken.json'), '{', 'utf8');

    const res = await postRestore(
      srv,
      JSON.stringify({
        characters: [{ id: 'new', name: 'New character' }],
      }),
      'backup.json',
      'application/json',
    );

    assert.equal(res.status, 500);
    const characters = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'characters.json'), 'utf8'));
    assert.deepEqual(characters.map(({ id, name }) => ({ id, name })), [
      { id: 'old', name: 'Old character' },
    ]);
  } finally {
    await srv.kill();
  }
});

test('restore: startup recovery completes an interrupted multi-file publication', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-restore-recovery-data-'));
  const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-restore-recovery-snaps-'));
  let crashed;
  let recovered;
  try {
    crashed = await startServer({
      dataDir,
      snapshotsDir,
      dmPassword: DM,
      seedData: {
        'characters.json': [{ id: 'old', name: 'Old character' }],
        'events.json': [{ id: 'old-event', name: 'Old event' }],
      },
      env: { CODEX_RESTORE_CRASH_PHASE: 'publish:0:after' },
    });
    await login(crashed, DM);
    await assert.rejects(postRestore(crashed, await createZip({
      'data/characters.json': [{ id: 'new', name: 'New character' }],
      'data/events.json': [{ id: 'new-event', name: 'New event' }],
    })));
    await crashed.kill();

    recovered = await startServer({ dataDir, snapshotsDir, dmPassword: DM });
    const characters = JSON.parse(await fsp.readFile(path.join(dataDir, 'characters.json'), 'utf8'));
    const events = JSON.parse(await fsp.readFile(path.join(dataDir, 'events.json'), 'utf8'));
    assert.deepEqual(characters.map(({ id, name }) => ({ id, name })), [
      { id: 'new', name: 'New character' },
    ]);
    assert.deepEqual(events.map(({ id, name }) => ({ id, name })), [
      { id: 'new-event', name: 'New event' },
    ]);
    assert.deepEqual(
      await fsp.readdir(path.join(dataDir, '.runtime', 'restores')),
      [],
      'recovered restore journal is cleaned after the complete state is durable',
    );
  } finally {
    if (crashed) await crashed.kill();
    if (recovered) await recovered.kill();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fsp.rm(snapshotsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('restore: static campaign files are hidden until the whole publication completes', async () => {
  const controlDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-restore-control-'));
  const reached = path.join(controlDir, 'publish_0_after.reached');
  const release = path.join(controlDir, 'publish_0_after.release');
  const srv = await startServer({
    dmPassword: DM,
    seedFiles: {
      'maps/a.txt': 'old a',
      'maps/b.txt': 'old b',
    },
    env: {
      CODEX_RESTORE_PAUSE_PHASE: 'publish:0:after',
      CODEX_RESTORE_CONTROL_DIR: controlDir,
    },
  });
  try {
    await login(srv, DM);
    const restorePromise = postRestore(srv, await createZip({
      'data/maps/a.txt': 'new a',
      'data/maps/b.txt': 'new b',
    }));
    await waitForFile(reached);

    let readSettled = false;
    const readPromise = srv.fetch('/maps/a.txt').then(async response => {
      readSettled = true;
      return response.text();
    });
    await new Promise(resolve => { setTimeout(resolve, 100); });
    assert.equal(readSettled, false, 'static read must wait behind restore publication');

    await fsp.writeFile(release, '', 'utf8');
    assert.equal((await restorePromise).status, 200);
    assert.equal(await readPromise, 'new a');
    assert.equal(await (await srv.fetch('/maps/b.txt')).text(), 'new b');
  } finally {
    await fsp.writeFile(release, '', 'utf8').catch(() => {});
    await srv.kill();
    await fsp.rm(controlDir, { recursive: true, force: true });
  }
});
