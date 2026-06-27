'use strict';

// Integration: player-as-collaborative-editor semantics under the
// twin-entity model.
//
// Players can edit public content. They CANNOT:
//   - mark anything DM-only (visibility:'dm') — server forces public
//   - touch `linkedTwinId` — server preserves the existing value
//   - write to settings or campaign — DM-only collections
//   - edit any visibility:'dm' entity — 403
// DMs retain full access to everything.
//
// The legacy per-field `secrets` and `[secret]` inline markers were
// fully removed in the twin pivot; tests for those behaviors are
// gone. Twins carry DM lore in a sibling entity instead.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const path     = require('path');
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

async function readEntity(srv, type, id) {
  const file = path.join(srv.dataDir, `${type}.json`);
  const raw  = await fsp.readFile(file, 'utf8');
  const arr  = JSON.parse(raw);
  return Array.isArray(arr) ? arr.find(e => e.id === id) : arr[id];
}

// ── New entity creation ───────────────────────────────────────────

test('player: creates a new character — visibility coerced to public', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: {
          id: 'kira', name: 'Kira', faction: 'neutral',
          description: 'A wandering bard.',
          // Player TRIES to mark DM-only. Server must force to public.
          visibility: 'dm',
        },
      }),
    });
    assert.equal(res.status, 200);
    const stored = await readEntity(srv, 'characters', 'kira');
    assert.equal(stored.visibility, 'public');
    assert.equal(stored.description, 'A wandering bard.');
  } finally { await srv.kill(); }
});

test('player: legacy secrets field on submitted payload is stripped server-side', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, PLAYER);
    await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: {
          id: 'lyra', name: 'Lyra', faction: 'neutral',
          // Stale client sending legacy `secrets` map — server must
          // refuse to persist it.
          secrets: { description: true },
        },
      }),
    });
    const stored = await readEntity(srv, 'characters', 'lyra');
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'secrets'), false);
  } finally { await srv.kill(); }
});

// ── Editing existing public entities ──────────────────────────────

test('player: edits a public entity — visibility preserved (cannot flip)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [{
        id: 'a', name: 'Alice', faction: 'neutral',
        description: 'A merchant.', visibility: 'public',
      }],
    },
  });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: {
          id: 'a', name: 'Alice the Brave', faction: 'neutral',
          description: 'A merchant turned hero.',
          visibility: 'dm', // tampering attempt
        },
      }),
    });
    assert.equal(res.status, 200);
    const stored = await readEntity(srv, 'characters', 'a');
    assert.equal(stored.name, 'Alice the Brave');
    assert.equal(stored.description, 'A merchant turned hero.');
    assert.equal(stored.visibility, 'public');
  } finally { await srv.kill(); }
});

test('player: edit of a twinned public entity preserves linkedTwinId verbatim', async () => {
  // Critical regression test: players don't see linkedTwinId
  // (server strips it), so their submission omits the field. The
  // sanitizer must preserve the existing value or the DM-side link
  // silently dies on the next player edit.
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [
        { id: 'pub', name: 'Stranger', faction: 'neutral',
          description: 'Hooded.', visibility: 'public', linkedTwinId: 'dm_x' },
        { id: 'dm_x', name: 'Frulam', faction: 'cult',
          description: 'DM lore.', visibility: 'dm', linkedTwinId: 'pub' },
      ],
    },
  });
  try {
    await loginAs(srv, PLAYER);
    // Player payload — no linkedTwinId because they can't see it.
    await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: {
          id: 'pub', name: 'Stranger of the North', faction: 'neutral',
          description: 'Updated.', visibility: 'public',
        },
      }),
    });
    const stored = await readEntity(srv, 'characters', 'pub');
    assert.equal(stored.name, 'Stranger of the North');
    assert.equal(stored.linkedTwinId, 'dm_x',
      'linkedTwinId must survive player edits unchanged');
    // DM-side twin also intact.
    const dmTwin = await readEntity(srv, 'characters', 'dm_x');
    assert.equal(dmTwin.linkedTwinId, 'pub');
  } finally { await srv.kill(); }
});

// ── Per-entity addonData (Phase 5) ────────────────────────────────

test('player: edit preserves an addonData namespace it did not send (no drop-by-omission)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [{
        id: 'p', name: 'Pip', faction: 'neutral', visibility: 'public',
        addonData: { 'demo-sheet': { hp: 8, maxHp: 10 } },
      }],
    },
  });
  try {
    await loginAs(srv, PLAYER);
    // A normal player edit whose form doesn't surface addon fields → payload
    // omits addonData. The server must keep the existing namespace.
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: { id: 'p', name: 'Pip the Bold', faction: 'neutral', visibility: 'public' },
      }),
    });
    assert.equal(res.status, 200);
    const stored = await readEntity(srv, 'characters', 'p');
    assert.equal(stored.name, 'Pip the Bold');
    assert.ok(stored.addonData && stored.addonData['demo-sheet'], 'addonData namespace survived');
    assert.equal(stored.addonData['demo-sheet'].hp, 8);
  } finally { await srv.kill(); }
});

test('player: edit can UPDATE a namespace it sends, while others are preserved', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [{
        id: 'q', name: 'Quill', faction: 'neutral', visibility: 'public',
        addonData: { 'demo-sheet': { hp: 5, maxHp: 10 }, 'other': { note: 'keep' } },
      }],
    },
  });
  try {
    await loginAs(srv, PLAYER);
    // Active-sheet write (e.g. patchAddonData) sends ONLY the sheet namespace.
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: {
          id: 'q', name: 'Quill', faction: 'neutral', visibility: 'public',
          addonData: { 'demo-sheet': { hp: 4, maxHp: 10 } },
        },
      }),
    });
    assert.equal(res.status, 200);
    const stored = await readEntity(srv, 'characters', 'q');
    assert.equal(stored.addonData['demo-sheet'].hp, 4, 'sent namespace updated');
    assert.equal(stored.addonData['other'].note, 'keep', 'unsent namespace preserved');
  } finally { await srv.kill(); }
});

// ── DM-only entity protection ─────────────────────────────────────

test('player: cannot edit a DM-only entity (403)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [{
        id: 'villain', name: 'Villain', faction: 'cult',
        description: 'Plot.', visibility: 'dm',
      }],
    },
  });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: { id: 'villain', name: 'Tampered', faction: 'cult' },
      }),
    });
    assert.equal(res.status, 403);
    const stored = await readEntity(srv, 'characters', 'villain');
    assert.equal(stored.name, 'Villain');
  } finally { await srv.kill(); }
});

// ── DM-only types ────────────────────────────────────────────────

test('player: cannot write to settings (DM-only type)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'settings', action: 'save',
        payload: { id: 'attitudes', data: [{ id: 'rogue', label: 'Rogue' }] },
      }),
    });
    assert.equal(res.status, 403);
  } finally { await srv.kill(); }
});

test('player: cannot rename the campaign (campaign is DM-only)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'campaign', action: 'save',
        payload: { id: 'main', data: { name: 'Hacked!', tagline: '' } },
      }),
    });
    assert.equal(res.status, 403);
  } finally { await srv.kill(); }
});

// ── DM retains full access ────────────────────────────────────────

test('DM: can still mark new entities DM-only (regression)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    await loginAs(srv, DM);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: { id: 'shadow', name: 'Shadow', faction: 'cult', visibility: 'dm' },
      }),
    });
    assert.equal(res.status, 200);
    const stored = await readEntity(srv, 'characters', 'shadow');
    assert.equal(stored.visibility, 'dm');
  } finally { await srv.kill(); }
});

test('DM: can still edit a DM-only entity (regression)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [{ id: 'v', name: 'V', faction: 'cult', visibility: 'dm' }],
    },
  });
  try {
    await loginAs(srv, DM);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: { id: 'v', name: 'V Edited', faction: 'cult', visibility: 'dm' },
      }),
    });
    assert.equal(res.status, 200);
  } finally { await srv.kill(); }
});

// ── Visibility-flip guard (both roles) ───────────────────────────

test('visibility flip on a twinned entity is rejected (400)', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [
        { id: 'pub', name: 'Pub', faction: 'neutral', visibility: 'public', linkedTwinId: 'dm_x' },
        { id: 'dm_x', name: 'Dm', faction: 'cult',    visibility: 'dm',     linkedTwinId: 'pub' },
      ],
    },
  });
  try {
    await loginAs(srv, DM);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'characters', action: 'save',
        payload: { id: 'pub', name: 'Pub', faction: 'neutral', visibility: 'dm', linkedTwinId: 'dm_x' },
      }),
    });
    assert.equal(res.status, 400);
  } finally { await srv.kill(); }
});

// ── Anonymous still cannot write ──────────────────────────────────

test('anonymous: PATCH /api/data still rejected (401)', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'characters', action: 'save', payload: { id: 'x', name: 'X' }}),
    });
    assert.equal(res.status, 401);
  } finally { await srv.kill(); }
});

// ── Relationships ─────────────────────────────────────────────────

test('player: can create a new relationship between two public characters', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [
        { id: 'a', name: 'A', faction: 'neutral', visibility: 'public' },
        { id: 'b', name: 'B', faction: 'neutral', visibility: 'public' },
      ],
    },
  });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'relationships', action: 'save',
        payload: { source: 'a', target: 'b', type: 'ally' },
      }),
    });
    assert.equal(res.status, 200);
  } finally { await srv.kill(); }
});

test('player: cannot edit an existing DM-only relationship', async () => {
  const srv = await startServer({
    dmPassword: DM, playerPassword: PLAYER,
    seedData: {
      'characters.json': [
        { id: 'a', name: 'A', faction: 'neutral', visibility: 'public' },
        { id: 'b', name: 'B', faction: 'neutral', visibility: 'public' },
      ],
      'relationships.json': [
        { source: 'a', target: 'b', type: 'commands', visibility: 'dm' },
      ],
    },
  });
  try {
    await loginAs(srv, PLAYER);
    const res = await srv.fetch('/api/data', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'relationships', action: 'save',
        payload: { source: 'a', target: 'b', type: 'commands', label: 'tampered' },
      }),
    });
    assert.equal(res.status, 403);
  } finally { await srv.kill(); }
});
