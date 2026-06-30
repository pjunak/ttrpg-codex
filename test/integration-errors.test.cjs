'use strict';

// Integration: the terminal error handler + the unmatched-/api JSON 404.
//
// Covers two guarantees added alongside the error-handling middleware:
//   1. Upload/body errors surface as clean JSON, not Express's raw HTML 500:
//        - a multer LIMIT_FILE_SIZE on an upload  → 400 JSON
//        - an oversized express.json body         → 413 JSON
//        - a malformed JSON body                  → 400 JSON
//   2. An unknown /api/* path returns a JSON 404 (never the SPA index.html),
//      so a fetch caller hitting a wrong/renamed endpoint gets honest JSON.

const { test }        = require('node:test');
const assert          = require('node:assert/strict');
const { startServer } = require('./helpers/server-process.cjs');

const DM     = 'dm-pass';
const PLAYER = 'player-pass';

async function loginDM(srv) {
  const res = await srv.fetch('/api/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ password: DM }),
  });
  assert.equal(res.status, 200);
}

test('oversized upload → 400 JSON (multer LIMIT_FILE_SIZE), not HTML', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginDM(srv);
    // The icons endpoint caps each file at 2 MB; multer trips
    // LIMIT_FILE_SIZE during PARSE, before the route body runs, so the
    // pin-type id doesn't even need to exist for this assertion.
    const big = Buffer.alloc(2 * 1024 * 1024 + 4096, 0x41);   // > 2 MB
    const form = new FormData();
    form.append('icons', new Blob([big], { type: 'image/png' }), 'huge.png');

    const res = await srv.fetch('/api/icons/whatever', { method: 'POST', body: form });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.match(body.error, /Upload error: LIMIT_FILE_SIZE/);
  } finally { await srv.kill(); }
});

test('oversized JSON body → 413 JSON (entity.too.large)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginDM(srv);
    // express.json is capped at 10 MB; a larger body trips entity.too.large.
    const huge = 'x'.repeat(11 * 1024 * 1024);
    const res  = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'characters', action: 'save', payload: { id: 'a', blob: huge } }),
    });
    assert.equal(res.status, 413);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.match(body.error, /too large/i);
  } finally { await srv.kill(); }
});

test('malformed JSON body → 400 JSON (entity.parse.failed)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginDM(srv);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    '{ this is not valid json ',
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.match(body.error, /Malformed JSON/);
  } finally { await srv.kill(); }
});

test('unknown /api/* GET → 404 JSON, not the SPA index.html', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const res = await srv.fetch('/api/nope');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Not found' });
  } finally { await srv.kill(); }
});

test('unknown /api/* with a non-GET method also → 404 JSON', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginDM(srv);
    const res = await srv.fetch('/api/does-not-exist', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ x: 1 }),
    });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  } finally { await srv.kill(); }
});

test('a real /api route is NOT shadowed by the /api 404 catch-all', async () => {
  // Guard against the catch-all being placed too early: /api/version must
  // still resolve normally.
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const res = await srv.fetch('/api/version');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.hash, /^[0-9a-f]{16}$|^none$/);
  } finally { await srv.kill(); }
});

test('a non-/api deep link still serves the SPA index.html (fallback intact)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const res = await srv.fetch('/some/client/route');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<!DOCTYPE html>/i);
  } finally { await srv.kill(); }
});
