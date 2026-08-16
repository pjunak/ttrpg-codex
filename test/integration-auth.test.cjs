'use strict';

// Integration: end-to-end authentication and role flow.
// Boots a real server child process per test (isolated tempdirs, two
// shared passwords) and exercises /api/login, /api/auth, /api/view-as,
// /api/view-as-dm, /api/logout. Validates cookie format, rate-limit
// path, and the impersonation tier.

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const { startServer } = require('./helpers/server-process.cjs');

const DM     = 'super-secret-dm';
const PLAYER = 'players-only';

test('anonymous: /api/auth reports null role + null realRole', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const res  = await srv.fetch('/api/auth');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.role,     null);
    assert.equal(body.realRole, null);
  } finally { await srv.kill(); }
});

test('login as DM: cookie has dm.dm.<64-hex> shape, /api/auth reflects role', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const login = await srv.fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: DM }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.deepEqual(loginBody, { ok: true, role: 'dm' });

    const cookie = srv.cookieValue();
    // Cookie shape: edit_session=<realRole>.<role>.<64-hex>
    assert.match(cookie, /^edit_session=dm\.dm\.[0-9a-f]{64}$/);

    const auth = await srv.fetch('/api/auth');
    assert.deepEqual(await auth.json(), { role: 'dm', realRole: 'dm' });
  } finally { await srv.kill(); }
});

test('login as player: cookie has player.player.<64-hex> shape', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const login = await srv.fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: PLAYER }),
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { ok: true, role: 'player' });
    assert.match(srv.cookieValue(), /^edit_session=player\.player\.[0-9a-f]{64}$/);
  } finally { await srv.kill(); }
});

test('login: wrong password rejected with 401', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const res = await srv.fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(res.status, 401);
    // No cookie was set.
    assert.equal(srv.cookieValue(), '');
  } finally { await srv.kill(); }
});

test('login: empty password is rejected (does not match empty PLAYER_PASSWORD)', async () => {
  // PLAYER_PASSWORD unset → player login disabled. An empty body must
  // not become a valid player auth via _safeEq('', '') = true.
  const srv = await startServer({ dmPassword: DM, playerPassword: '' });
  try {
    const res = await srv.fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: '' }),
    });
    assert.equal(res.status, 401);
  } finally { await srv.kill(); }
});

test('view-as: DM impersonates player; cookie keeps realRole=dm', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    // Log in as DM.
    await srv.fetch('/api/login', {
      method:  'POST', headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: DM }),
    });
    // Flip to player.
    const flip = await srv.fetch('/api/view-as', { method: 'POST' });
    assert.equal(flip.status, 200);
    assert.deepEqual(await flip.json(), { ok: true, role: 'player', realRole: 'dm' });

    // Cookie now has the dm.player.<token> shape.
    assert.match(srv.cookieValue(), /^edit_session=dm\.player\.[0-9a-f]{64}$/);

    // /api/auth reflects effective + real role.
    const auth = await srv.fetch('/api/auth');
    assert.deepEqual(await auth.json(), { role: 'player', realRole: 'dm' });
  } finally { await srv.kill(); }
});

test('view-as: player cannot impersonate DM (realRole !== dm rejected)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    // Log in as player.
    await srv.fetch('/api/login', {
      method:  'POST', headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: PLAYER }),
    });
    const flip = await srv.fetch('/api/view-as', { method: 'POST' });
    assert.equal(flip.status, 403);
  } finally { await srv.kill(); }
});

test('view-as-dm: DM in player mode flips back to DM', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await srv.fetch('/api/login', {
      method:  'POST', headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: DM }),
    });
    await srv.fetch('/api/view-as',    { method: 'POST' });
    const back = await srv.fetch('/api/view-as-dm', { method: 'POST' });
    assert.equal(back.status, 200);
    assert.deepEqual(await back.json(), { ok: true, role: 'dm', realRole: 'dm' });
    assert.match(srv.cookieValue(), /^edit_session=dm\.dm\.[0-9a-f]{64}$/);
  } finally { await srv.kill(); }
});

test('player preview token scopes one tab to player access without replacing the DM cookie', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await srv.fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DM }),
    });
    const dmCookie = srv.cookieValue();
    const issue = await srv.fetch('/api/player-preview', { method: 'POST' });
    assert.equal(issue.status, 200);
    const { token, expiresAt } = await issue.json();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Number.isFinite(expiresAt), true);
    assert.equal(srv.cookieValue(), dmCookie, 'issuing a preview does not replace the DM cookie');

    const previewAuth = await srv.fetch('/api/auth', {
      headers: { 'X-Codex-Player-Preview': token },
    });
    assert.deepEqual(await previewAuth.json(), {
      role: 'player', realRole: 'player', playerPreview: true,
    });
    const previewQueryAuth = await srv.fetch(`/api/auth?playerPreviewToken=${encodeURIComponent(token)}`);
    assert.deepEqual(await previewQueryAuth.json(), {
      role: 'player', realRole: 'player', playerPreview: true,
    });

    const privileged = await srv.fetch('/api/passwords', {
      headers: { 'X-Codex-Player-Preview': token },
    });
    assert.equal(privileged.status, 403, 'preview token carries no real-DM authority');

    const dmAuth = await srv.fetch('/api/auth');
    assert.deepEqual(await dmAuth.json(), { role: 'dm', realRole: 'dm' });
    assert.equal(srv.cookieValue(), dmCookie, 'the original tab remains a DM session');
  } finally { await srv.kill(); }
});

test('an invalid preview token fails closed instead of falling back to the DM cookie', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await srv.fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DM }),
    });
    const auth = await srv.fetch('/api/auth', {
      headers: { 'X-Codex-Player-Preview': 'invalid-preview-token' },
    });
    assert.deepEqual(await auth.json(), { role: null, realRole: null });
    const emptyQuery = await srv.fetch('/api/auth?playerPreviewToken=');
    assert.deepEqual(await emptyQuery.json(), { role: null, realRole: null });
  } finally { await srv.kill(); }
});

test('only an effective DM can issue a player preview token', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await srv.fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PLAYER }),
    });
    const issue = await srv.fetch('/api/player-preview', { method: 'POST' });
    assert.equal(issue.status, 401);
  } finally { await srv.kill(); }
});

test('logout: clears the cookie; subsequent /api/auth reports anonymous', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await srv.fetch('/api/login', {
      method:  'POST', headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: DM }),
    });
    await srv.fetch('/api/logout', { method: 'POST' });
    // The Set-Cookie clears it; the helper updated the jar.
    // Now hit /api/auth fresh — should be anonymous.
    const auth = await srv.fetch('/api/auth');
    assert.deepEqual(await auth.json(), { role: null, realRole: null });
  } finally { await srv.kill(); }
});

test('forged cookie: tampered token returns anonymous (timing-safe rejection)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    // Inject a hand-crafted dm.dm cookie with a wrong (but well-formed)
    // hex token. Without knowing DM_PASSWORD, the attacker can't compute
    // the right hash, so _resolveRole returns null.
    const fake = 'dm.dm.' + '0'.repeat(64);
    const res = await srv.fetch('/api/auth', { headers: { cookie: 'edit_session=' + fake } });
    assert.deepEqual(await res.json(), { role: null, realRole: null });
  } finally { await srv.kill(); }
});

test('legacy cookie shape (single hex token): rejected as malformed', async () => {
  // Old cookie format pre-DM-mode was just SHA256(password). After the
  // upgrade, every existing session must be invalidated — defence
  // against accidentally treating an old cookie as authoritative.
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const legacy = '0123456789abcdef'.repeat(4); // 64-char hex, no dots
    const res = await srv.fetch('/api/auth', { headers: { cookie: 'edit_session=' + legacy } });
    assert.deepEqual(await res.json(), { role: null, realRole: null });
  } finally { await srv.kill(); }
});

test('rate limiter: blocks after 10 failures in the window', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    let lastStatus = 200;
    for (let i = 0; i < 11; i++) {
      const res = await srv.fetch('/api/login', {
        method:  'POST', headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: 'nope' + i }),
      });
      lastStatus = res.status;
    }
    // After ≥10 failures the next attempt should be 429.
    assert.equal(lastStatus, 429, 'expected rate-limit on 11th attempt');
  } finally { await srv.kill(); }
});

test('PATCH /api/data without DM session is rejected with 401', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    // No login at all.
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'characters', action: 'save', payload: { id: 'x', name: 'X' }}),
    });
    assert.equal(res.status, 401);
  } finally { await srv.kill(); }
});

test('PATCH /api/data with player session is ACCEPTED for public content', async () => {
  // Under the dual-role write model, players are collaborative
  // editors of public content. Only DM-only stuff (settings, campaign,
  // DM-only entities, [secret] markers) is off-limits.
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await srv.fetch('/api/login', {
      method:  'POST', headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: PLAYER }),
    });
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'characters', action: 'save', payload: { id: 'x', name: 'X', faction: 'neutral' }}),
    });
    assert.equal(res.status, 200);
  } finally { await srv.kill(); }
});

test('PATCH /api/data with DM-impersonating-player session: player-level write access', async () => {
  // Important: write gates check req.role (effective), not realRole.
  // A DM in "view as player" gets exactly what a player gets — they
  // CAN write to public content but lose access to DM-only writes.
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await srv.fetch('/api/login', {
      method:  'POST', headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: DM }),
    });
    await srv.fetch('/api/view-as', { method: 'POST' });
    // Public write: accepted.
    const ok = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'characters', action: 'save', payload: { id: 'x', name: 'X', faction: 'neutral' }}),
    });
    assert.equal(ok.status, 200, 'effective role player can write public content');
    // Settings write: rejected (DM-only type).
    const deny = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'settings', action: 'save', payload: { id: 'attitudes', data: [] }}),
    });
    assert.equal(deny.status, 403, 'effective role player cannot write settings');
  } finally { await srv.kill(); }
});

test('EDIT_PASSWORD back-compat alias still grants DM access', async () => {
  // Simulate an old deployment that only set EDIT_PASSWORD. _dmPassword
  // falls back to it.
  const srv = await startServer({
    dmPassword:     undefined,
    playerPassword: PLAYER,
    env: { EDIT_PASSWORD: 'legacy-pw', DM_PASSWORD: '' },
  });
  try {
    const res = await srv.fetch('/api/login', {
      method:  'POST', headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: 'legacy-pw' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, role: 'dm' });
  } finally { await srv.kill(); }
});
