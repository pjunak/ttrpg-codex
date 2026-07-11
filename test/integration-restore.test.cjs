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
const path     = require('path');
const AdmZip   = require('adm-zip');
const { startServer } = require('./helpers/server-process.cjs');

const DM = 'dm-pw';
async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}

function zipWith(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)));
  }
  return zip.toBuffer();
}

async function postRestore(srv, zipBuf) {
  const form = new FormData();
  form.append('backup', new Blob([zipBuf], { type: 'application/zip' }), 'backup.zip');
  return srv.fetch('/api/restore', { method: 'POST', body: form });
}

test('restore: ZIP round-trips collection files but never auth.json or addon code', async () => {
  const srv = await startServer({ dmPassword: DM });
  try {
    await login(srv, DM);

    const zipBuf = zipWith({
      'data/characters.json': [{ id: 'resa_x1', name: 'Restored Resa', visibility: 'public' }],
      'data/auth.json':       { bogus: 'credential-from-old-backup' },
      'data/addons/evil/1111111111111111/server/index.cjs': 'process.exit(1);',
      'data/addon-data/demo/rules.json': [{ id: 'grappling' }],
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

    // Both refusals surfaced as skipped entries (auth.json + addon code).
    assert.ok(body.skipped >= 2, `expected ≥2 skipped entries, got ${body.skipped}`);

    // The DM session survives the restore (cookie secret not rotated).
    const auth = await srv.fetch('/api/auth');
    assert.deepEqual(await auth.json(), { role: 'dm', realRole: 'dm' });
  } finally { await srv.kill(); }
});

test('restore: requires auth', async () => {
  const srv = await startServer({ dmPassword: DM });
  try {
    const res = await postRestore(srv, zipWith({ 'data/characters.json': [] }));
    assert.equal(res.status, 401);
  } finally { await srv.kill(); }
});
