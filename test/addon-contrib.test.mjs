// Tests for the data-driven contribution primitives (Step 1):
//  - Store.getKinds / getKind merge (base/DM settings + addon layer)
//  - the addon test-harness mock recording + smoke for registerSlot and the
//    connection/node/graph-view kind registrations.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Store's IIFE doesn't call browser APIs at import, but _sync + dispatch do.
// Provide harmless globals so any accidental save path won't crash the runner.
globalThis.window = globalThis.window || { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = globalThis.document || { createElement: () => ({}) };

const { Store } = await import('../web/js/store.js');
const { createMockHost, dryRunRegister, smokeRegistrations } = await import('../web/js/addon-test-harness.mjs');

// ── Store.getKinds — data-driven "kinds" merge ──────────────────────

test('getKinds: connections returns the seeded relationship types', () => {
  const kinds = Store.getKinds('connections');
  assert.equal(Array.isArray(kinds), true);
  assert.ok(kinds.some(k => k.id === 'commands'), 'base connection kind "commands" present');
});

test('getKinds: statuses / attitudes / priorities map to their settings categories', () => {
  assert.ok(Store.getKinds('statuses').some(k => k.id === 'alive'),       'seeded status "alive" present');
  assert.ok(Store.getKinds('attitudes').some(k => k.id === 'ally'),       'seeded attitude "ally" present');
  assert.ok(Store.getKinds('priorities').some(k => k.id === 'kritická'),  'seeded priority "kritická" present');
});

test('getKinds: merges the addon layer; base wins on id collision', () => {
  Store.setAddonKindProvider((domain) => domain === 'connections'
    ? [{ id: 'myaddon:rivalry', label: 'Rivalry', color: '#f00', style: 'solid' },
       { id: 'commands', label: 'HIJACKED' }]
    : []);
  try {
    const kinds = Store.getKinds('connections');
    assert.ok(kinds.some(k => k.id === 'myaddon:rivalry'), 'addon kind merged in');
    const commands = kinds.find(k => k.id === 'commands');
    assert.notEqual(commands.label, 'HIJACKED');   // base wins, addon dup dropped
  } finally {
    Store.setAddonKindProvider(null);   // reset so later tests see no provider
  }
});

test('getKinds: provider failure is swallowed (best-effort layer)', () => {
  Store.setAddonKindProvider(() => { throw new Error('boom'); });
  try {
    const kinds = Store.getKinds('connections');
    assert.ok(kinds.some(k => k.id === 'commands'));   // base still returned
  } finally {
    Store.setAddonKindProvider(null);
  }
});

test('getKinds: unknown domain with no provider returns []', () => {
  assert.deepEqual(Store.getKinds('nonsense'), []);
});

test('getKind: orphan-safe for an unknown connection id (rel-type shape)', () => {
  const o = Store.getKind('connections', 'does_not_exist');
  assert.equal(o._orphan, true);
  assert.equal(o.style, 'dashed');           // carries the fields cloudmap needs
  assert.equal(Array.isArray(o.dirs), true);
  assert.equal(o.target, 'character');
});

// ── Addon host harness — new contribution primitives ────────────────

test('mock host records registerSlot + kind registrations', () => {
  const { host, rec } = createMockHost({
    id: 'x',
    permissions: ['ui:slot:timeline', 'kinds:connections', 'kinds:statuses', 'kinds:graph', 'graph:contribute'],
  });
  host.registerSlot('timeline:card:extra', () => ({ html: '<b>hi</b>' }), { order: 5 });
  host.registerConnectionKind({ id: 'rivalry', label: 'Rivalry', color: '#f00', style: 'solid' });
  host.registerKind('statuses', { id: 'petrified', label: 'Petrified', color: '#789', icon: '🗿' });
  host.registerNodeKind({ id: 'spell', cardHTML: () => '<div>spell</div>' });
  host.registerGraphView({ id: 'spellweb', label: 'Spell Web', build: () => ({}) });
  host.registerGraphContributor('vztahy', () => ({ nodes: [], edges: [] }));

  assert.equal(rec.slots.length, 1);
  assert.equal(rec.slots[0].slotId, 'timeline:card:extra');
  assert.equal(rec.connectionKinds.length, 1);
  assert.equal(rec.kinds.length, 1);
  assert.equal(rec.kinds[0].domain, 'statuses');
  assert.equal(rec.kinds[0].def.id, 'petrified');
  assert.equal(rec.nodeKinds.length, 1);
  assert.equal(rec.graphViews.length, 1);
  assert.equal(rec.graphContributors.length, 1);
  assert.equal(rec.graphContributors[0].viewId, 'vztahy');
});

test('smokeRegistrations: passes well-behaved slot/node renderers', () => {
  const { ok, rec, error } = dryRunRegister((host) => {
    host.registerSlot('timeline:card:extra', (ctx) => ({ html: `<i>${ctx.event ? 'ev' : ''}</i>` }));
    host.registerNodeKind({ id: 'ok', cardHTML: (n) => `<div>${n.id}</div>` });
  }, { id: 'good' });
  assert.ok(ok, error);
  assert.equal(smokeRegistrations(rec).ok, true);
});

test('smokeRegistrations: flags a throwing slot renderer', () => {
  const { rec } = dryRunRegister((host) => {
    host.registerSlot('cloudmap:node:badge', () => { throw new Error('boom'); });
  }, { id: 'bad' });
  const sm = smokeRegistrations(rec);
  assert.equal(sm.ok, false);
  assert.ok(sm.failures.some(f => f.kind === 'slot'), 'slot failure surfaced');
});

test('dryRunRegister: a throwing register is caught, not propagated', () => {
  const r = dryRunRegister(() => { throw new Error('nope'); }, { id: 'z' });
  assert.equal(r.ok, false);
  assert.match(r.error, /nope/);
});
