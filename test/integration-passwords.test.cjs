'use strict';

// Integration coverage for POST/GET /api/passwords — the most
// lockout-prone endpoint in the app (writes data/auth.json, rotates the
// cookie-token secret, must invalidate outstanding sessions while
// re-issuing the caller's). Previously untested.

const { test } = require('node:test');
const assert   = require('node:assert');
const fsp      = require('node:fs/promises');
const path     = require('node:path');
const { startServer } = require('./helpers/server-process.cjs');

function login(srv, password) {
  return srv.fetch('/api/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ password }),
  });
}

function setPassword(srv, body) {
  return srv.fetch('/api/passwords', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

function saveCharacter(fetchLike, name) {
  return fetchLike('/api/data', {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      type: 'characters', action: 'save',
      payload: { id: `pwtest_${name}`, name },
    }),
  });
}

test('POST /api/passwords is gated on realRole=dm', async () => {
  const srv = await startServer();
  try {
    // Anonymous
    let res = await setPassword(srv, { role: 'dm', newPassword: 'whatever1', currentPassword: 'dm-pass' });
    assert.ok([401, 403].includes(res.status), `anonymous should be rejected, got ${res.status}`);

    // Player session
    assert.equal((await login(srv, 'player-pass')).status, 200);
    res = await setPassword(srv, { role: 'dm', newPassword: 'whatever1', currentPassword: 'dm-pass' });
    assert.equal(res.status, 403);

    // GET is DM-only too
    res = await srv.fetch('/api/passwords');
    assert.equal(res.status, 403);
  } finally { await srv.kill(); }
});

test('DM password rotation: validates current, invalidates old cookies, re-issues caller', async () => {
  const srv = await startServer();
  try {
    assert.equal((await login(srv, 'dm-pass')).status, 200);

    // Presence flags before rotation: env fallback, nothing stored.
    let flags = await (await srv.fetch('/api/passwords')).json();
    assert.equal(flags.dm.stored, false);
    assert.equal(flags.dm.envFallback, true);

    // Wrong current DM password → rejected, nothing changes.
    let res = await setPassword(srv, { role: 'dm', newPassword: 'new-dm-pass', currentPassword: 'WRONG' });
    assert.equal(res.status, 401);

    // Too-short DM password → 400.
    res = await setPassword(srv, { role: 'dm', newPassword: 'abc', currentPassword: 'dm-pass' });
    assert.equal(res.status, 400);

    // Capture the pre-rotation cookie to impersonate a second, stale client.
    const oldCookie = srv.cookieValue();
    assert.ok(oldCookie.includes('edit_session='), 'expected a session cookie in the jar');

    // Happy path. The response re-issues the caller's cookie (jar updates).
    res = await setPassword(srv, { role: 'dm', newPassword: 'new-dm-pass', currentPassword: 'dm-pass' });
    assert.equal(res.status, 200);

    // Caller's re-issued session still writes fine.
    assert.equal((await saveCharacter(srv.fetch, 'caller_alive')).status, 200);

    // A client still holding the PRE-rotation cookie is locked out.
    const stale = await fetch(`${srv.baseUrl}/api/data`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: oldCookie },
      body:    JSON.stringify({ type: 'characters', action: 'save', payload: { id: 'pwtest_stale', name: 'stale' } }),
    });
    assert.equal(stale.status, 401);

    // auth.json shape on disk — salted hash, never the plaintext.
    const auth = JSON.parse(await fsp.readFile(path.join(srv.dataDir, 'auth.json'), 'utf8'));
    assert.ok(auth.dm && auth.dm.salt && auth.dm.hash && auth.dm.updatedAt, 'auth.json dm credential shape');
    assert.ok(!JSON.stringify(auth).includes('new-dm-pass'), 'plaintext must not be stored');

    // Presence flags after rotation.
    flags = await (await srv.fetch('/api/passwords')).json();
    assert.equal(flags.dm.stored, true);
    assert.equal(flags.dm.envFallback, false);

    // Old password no longer logs in; the new one does.
    srv.clearCookies();
    assert.equal((await login(srv, 'dm-pass')).status, 401);
    assert.equal((await login(srv, 'new-dm-pass')).status, 200);
  } finally { await srv.kill(); }
});

test('player password: set, use, clear back to env fallback', async () => {
  const srv = await startServer();
  try {
    assert.equal((await login(srv, 'dm-pass')).status, 200);

    // Too-short (non-empty) player password → 400.
    let res = await setPassword(srv, { role: 'player', newPassword: 'abc', currentPassword: 'dm-pass' });
    assert.equal(res.status, 400);

    // Set a stored player credential (supersedes the env value).
    res = await setPassword(srv, { role: 'player', newPassword: 'pl-secret-1', currentPassword: 'dm-pass' });
    assert.equal(res.status, 200);

    srv.clearCookies();
    assert.equal((await login(srv, 'pl-secret-1')).status, 200);
    const who = await (await srv.fetch('/api/auth')).json();
    assert.equal(who.role, 'player');
    // Stored credential supersedes the env fallback.
    srv.clearCookies();
    assert.equal((await login(srv, 'player-pass')).status, 401);

    // Clear it (empty newPassword) → env fallback applies again.
    assert.equal((await login(srv, 'dm-pass')).status, 200);
    res = await setPassword(srv, { role: 'player', newPassword: '', currentPassword: 'dm-pass' });
    assert.equal(res.status, 200);

    const flags = await (await srv.fetch('/api/passwords')).json();
    assert.equal(flags.player.stored, false);
    assert.equal(flags.player.envFallback, true);

    srv.clearCookies();
    assert.equal((await login(srv, 'pl-secret-1')).status, 401);
    assert.equal((await login(srv, 'player-pass')).status, 200);
  } finally { await srv.kill(); }
});
