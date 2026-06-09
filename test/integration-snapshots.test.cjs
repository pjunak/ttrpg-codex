'use strict';

// Integration: the snapshot / restore system — the project's primary
// data-recovery mechanism, and (until now) the highest-risk untested
// server logic.
//
// Covers:
//   1. Manual POST /api/snapshots bypasses the 60 s coalesce window
//      (a fresh migration snapshot must NOT suppress a manual one).
//   2. Role gating: GET + POST /api/snapshots are open to any authed
//      role; restore / revert-last / delete are DM-only; anonymous is
//      locked out of all of them.
//   3. Restore round-trip rolls `data/` back to a snapshot AND records
//      a `pre-restore` snapshot so the restore itself is undoable.
//   4. DELETE removes a snapshot file; unknown id → 404.
//
// Restore points are created via the manual endpoint (which bypasses
// coalescing) so the tests stay deterministic — they never depend on
// wall-clock timing relative to the 60 s window.

const { test }        = require('node:test');
const assert          = require('node:assert/strict');
const fsp             = require('fs').promises;
const path            = require('path');
const { startServer } = require('./helpers/server-process.cjs');

const DM     = 'dm-pw';
const PLAYER = 'player-pw';

async function loginAs(srv, password) {
  const r = await srv.fetch('/api/login', {
    method:  'POST', headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ password }),
  });
  assert.equal(r.status, 200);
}

async function saveCharacter(srv, payload) {
  const r = await srv.fetch('/api/data', {
    method:  'PATCH', headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ type: 'characters', action: 'save', payload }),
  });
  assert.equal(r.status, 200);
}

async function readCharacters(srv) {
  const raw = await fsp.readFile(path.join(srv.dataDir, 'characters.json'), 'utf8');
  return JSON.parse(raw);
}

async function listSnapshots(srv) {
  const r = await srv.fetch('/api/snapshots');
  assert.equal(r.status, 200);
  const { snapshots } = await r.json();
  return snapshots;
}

// ── 1. Manual snapshot bypasses the coalesce window ────────────────

test('snapshots: manual POST bypasses the 60 s coalesce window', async () => {
  // Seeding triggers a migration snapshot at boot, so a "recent"
  // snapshot already exists. A manual snapshot taken seconds later
  // must still be created (the coalesce window only suppresses the
  // automatic save-driven snapshots).
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: { 'characters.json': [{ id: 'alice', name: 'Alice', faction: 'neutral' }] },
  });
  try {
    await loginAs(srv, DM);
    const before = await listSnapshots(srv);
    assert.ok(before.length >= 1, 'migration snapshot should exist after a seeded boot');

    const r = await srv.fetch('/api/snapshots', { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.match(body.id, /^snapshot-.*\.json$/);

    const after = await listSnapshots(srv);
    assert.equal(after.length, before.length + 1, 'manual snapshot was not coalesced away');
    assert.equal(after.filter(s => s.reason === 'manual').length, 1);
  } finally { await srv.kill(); }
});

// ── 2. Role gating ─────────────────────────────────────────────────

test('snapshots: list + create are open to players; restore/revert/delete are DM-only', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, PLAYER);

    // A player can list and pin a known-good point.
    assert.equal((await srv.fetch('/api/snapshots')).status, 200);
    const created = await srv.fetch('/api/snapshots', { method: 'POST' });
    assert.equal(created.status, 200);
    const { id } = await created.json();

    // But not run the destructive operations.
    assert.equal((await srv.fetch(`/api/snapshots/${id}/restore`, { method: 'POST' })).status, 401);
    assert.equal((await srv.fetch('/api/snapshots/revert-last/1', { method: 'POST' })).status, 401);
    assert.equal((await srv.fetch(`/api/snapshots/${id}`, { method: 'DELETE' })).status, 401);
  } finally { await srv.kill(); }
});

test('snapshots: anonymous callers cannot list or create', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    srv.clearCookies();
    assert.equal((await srv.fetch('/api/snapshots')).status, 401);
    assert.equal((await srv.fetch('/api/snapshots', { method: 'POST' })).status, 401);
  } finally { await srv.kill(); }
});

// ── 3. Restore round-trip + pre-restore snapshot ───────────────────

test('snapshots: restore rolls data back and records a pre-restore snapshot', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: { 'characters.json': [{ id: 'alice', name: 'Alice', faction: 'neutral' }] },
  });
  try {
    await loginAs(srv, DM);

    // Pin the Alice-only state. (Manual snapshot bypasses coalesce, so
    // this captures exactly the current data regardless of timing.)
    const pin = await srv.fetch('/api/snapshots', { method: 'POST' });
    const { id: restorePoint } = await pin.json();

    // Add Bob — coalesced under the just-taken manual snapshot, so no
    // extra automatic snapshot is written.
    await saveCharacter(srv, { id: 'bob', name: 'Bob', faction: 'neutral' });
    let chars = await readCharacters(srv);
    assert.equal(chars.length, 2, 'Bob was added');

    // Roll back to the pinned point.
    const restore = await srv.fetch(`/api/snapshots/${restorePoint}/restore`, { method: 'POST' });
    assert.equal(restore.status, 200);

    chars = await readCharacters(srv);
    assert.ok(chars.find(c => c.id === 'alice'), 'Alice survives the restore');
    assert.equal(chars.find(c => c.id === 'bob'), undefined, 'Bob is rolled back');

    // The restore must itself be undoable — a pre-restore snapshot
    // capturing the Alice+Bob state should now exist.
    const snaps = await listSnapshots(srv);
    assert.ok(snaps.some(s => s.reason === 'pre-restore'),
      'restore should capture a pre-restore snapshot');
  } finally { await srv.kill(); }
});

test('snapshots: restoring an unknown id returns 404', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, DM);
    const r = await srv.fetch('/api/snapshots/snapshot-does-not-exist.json/restore', { method: 'POST' });
    assert.equal(r.status, 404);
  } finally { await srv.kill(); }
});

// ── 4. Delete ──────────────────────────────────────────────────────

test('snapshots: DM can delete a snapshot; deleting an unknown id is 404', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, DM);
    const { id } = await (await srv.fetch('/api/snapshots', { method: 'POST' })).json();

    const del = await srv.fetch(`/api/snapshots/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const remaining = await listSnapshots(srv);
    assert.equal(remaining.find(s => s.id === id), undefined, 'deleted snapshot is gone from the list');

    const again = await srv.fetch(`/api/snapshots/${id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
  } finally { await srv.kill(); }
});
