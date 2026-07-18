'use strict';

// Integration: the DM-stored GitHub token (data/secrets.json), settable from
// the addon install wizard via POST /api/addons/github-token.
//  - Gating: real-DM only; anonymous rejected; malformed shapes → 400.
//  - Round-trip: set → { configured:true, source:'stored' } + persisted on
//    disk; clear → source drops back to env/none and the key is removed.
//  - Secrecy: the token value NEVER appears in any API payload, and
//    `secrets.json` NEVER rides into the /api/backup ZIP (this also guards
//    that the installed archiver version still honours the directory()
//    entry filter) — nor does the token value under any entry name.
//  - Restore: a crafted ZIP carrying data/secrets.json is refused
//    (NON_DATA_JSON_FILES — same posture as auth.json), counted in `skipped`,
//    and the live stored token survives untouched.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const path     = require('path');
const AdmZip   = require('adm-zip');
const { startServer } = require('./helpers/server-process.cjs');

const DM    = 'dm-pw';
const TOKEN = 'ghp_integrationTestToken1234567890abcd';

async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}

const postToken = (srv, token) => srv.fetch('/api/addons/github-token', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token }),
});

test('github-token: DM-only set/clear; never echoed; excluded from backup + refused by restore', async () => {
  // Blank the env tokens so a CI environment's GITHUB_TOKEN can't leak into
  // the child and make the configured/source assertions non-deterministic.
  const srv = await startServer({
    dmPassword: DM,
    env: { CODEX_GITHUB_TOKEN: '', GITHUB_TOKEN: '' },
  });
  try {
    // Anonymous cannot touch the token.
    const anon = await postToken(srv, TOKEN);
    assert.ok(anon.status === 401 || anon.status === 403, `anon rejected (${anon.status})`);

    await login(srv, DM);

    // Shape guard: spaces / too-short values are 400, nothing is written.
    assert.equal((await postToken(srv, 'has spaces in it')).status, 400);
    assert.equal((await postToken(srv, 'x')).status, 400);

    // Set → configured via 'stored', persisted on disk.
    const set = await postToken(srv, TOKEN);
    assert.equal(set.status, 200);
    assert.deepEqual(await set.json(), { ok: true, configured: true, source: 'stored' });
    const secrets = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'secrets.json'), 'utf8'));
    assert.equal(secrets.githubToken, TOKEN);

    // The Manager payload reports state but NEVER the value.
    const listRaw = await (await srv.fetch('/api/addons')).text();
    assert.ok(!listRaw.includes(TOKEN), 'token value must never appear in an API payload');
    const list = JSON.parse(listRaw);
    assert.equal(list.githubTokenConfigured, true);
    assert.equal(list.githubTokenSource, 'stored');

    // Backup ZIP: secrets.json is excluded; the token value appears nowhere.
    const bres = await srv.fetch('/api/backup');
    assert.equal(bres.status, 200);
    const zip   = new AdmZip(Buffer.from(await bres.arrayBuffer()));
    const names = zip.getEntries().map(e => e.entryName.replace(/\\/g, '/'));
    assert.ok(names.length > 0, 'backup ZIP is non-empty');
    assert.ok(!names.includes('data/secrets.json'),
      `secrets.json must not ride into backups (got: ${names.join(', ')})`);
    for (const e of zip.getEntries()) {
      assert.ok(!e.getData().toString('utf8').includes(TOKEN),
        `token value leaked into backup entry ${e.entryName}`);
    }

    // Restore: a crafted data/secrets.json entry is refused (skipped), the
    // live token survives; a normal collection file still restores.
    const evil = new AdmZip();
    evil.addFile('data/secrets.json', Buffer.from(JSON.stringify({ githubToken: 'ghp_EVILEVILEVILEVILEVIL111111' })));
    evil.addFile('data/characters.json', Buffer.from('[]'));
    const form = new FormData();
    form.append('backup', new Blob([evil.toBuffer()], { type: 'application/zip' }), 'backup.zip');
    const rres = await srv.fetch('/api/restore', { method: 'POST', body: form });
    assert.equal(rres.status, 200);
    const rj = await rres.json();
    assert.ok(rj.skipped >= 1, `secrets.json entry counted in skipped (got ${rj.skipped})`);
    const after = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'secrets.json'), 'utf8'));
    assert.equal(after.githubToken, TOKEN, 'stored token untouched by restore');

    // Clear → no stored token, and (env blanked) not configured at all.
    const clr = await postToken(srv, '');
    assert.equal(clr.status, 200);
    assert.deepEqual(await clr.json(), { ok: true, configured: false, source: null });
    const cleared = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'secrets.json'), 'utf8'));
    assert.ok(!('githubToken' in cleared), 'clear removes the key');
  } finally { await srv.kill(); }
});

test('github-token: env fallback reports source "env"; stored token wins over it', async () => {
  const srv = await startServer({
    dmPassword: DM,
    env: { CODEX_GITHUB_TOKEN: 'ghp_envTokenEnvTokenEnvToken12345678', GITHUB_TOKEN: '' },
  });
  try {
    await login(srv, DM);

    let list = await (await srv.fetch('/api/addons')).json();
    assert.equal(list.githubTokenConfigured, true);
    assert.equal(list.githubTokenSource, 'env');

    // Storing a token flips the source to 'stored' (it takes precedence).
    assert.equal((await postToken(srv, TOKEN)).status, 200);
    list = await (await srv.fetch('/api/addons')).json();
    assert.equal(list.githubTokenSource, 'stored');

    // Clearing falls back to the env token — still configured.
    const clr = await (await postToken(srv, '')).json();
    assert.deepEqual(clr, { ok: true, configured: true, source: 'env' });
  } finally { await srv.kill(); }
});
