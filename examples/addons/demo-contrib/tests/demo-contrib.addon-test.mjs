// Tier-B CLIENT self-test for the demo-contrib addon, against the published
// host test harness. Declared in addon.json as `tests.client`. Run standalone:
//   node --test examples/addons/demo-contrib/tests/demo-contrib.addon-test.mjs
// (It lives outside test/, so the project's `npm test` does NOT auto-run it —
//  but test/addon-contrib.test.mjs imports the same entry for CI coverage.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dryRunRegister, smokeRegistrations } from '../../../../web/js/addon-test-harness.mjs';
import register from '../entry.js';

const META = { id: 'demo-contrib', permissions: ['ui:slot:timeline', 'kinds:connections', 'kinds:statuses', 'kinds:graph', 'graph:contribute'] };

test('demo-contrib: register is clean + wires the expected surface', () => {
  const { ok, rec, error } = dryRunRegister(register, META);
  assert.ok(ok, error);
  assert.ok(rec.slots.some(s => s.slotId === 'timeline:card:extra'),    'a timeline card slot');
  assert.ok(rec.slots.some(s => s.slotId === 'timeline:column:footer'), 'a timeline column slot');
  assert.ok(rec.connectionKinds.some(k => k.id === 'rivalry'),          'a custom connection kind');
  assert.ok(rec.kinds.some(k => k.domain === 'statuses' && k.def.id === 'petrified'), 'a custom status kind via registerKind');
  assert.ok(rec.nodeKinds.some(k => k.id === 'marker'),                 'a custom mind-map node kind');
  assert.ok(rec.graphContributors.some(c => c.viewId === 'vztahy'),     'a graph contributor on vztahy');
});

test('demo-contrib: renderers survive the smoke pass', () => {
  const { rec } = dryRunRegister(register, META);
  const smoke = smokeRegistrations(rec);
  assert.ok(smoke.ok, JSON.stringify(smoke.failures));
});
