import { test } from 'node:test';
import assert from 'node:assert/strict';
import { satisfies, planLoadOrder, depRange } from '../web/js/addon-deps.js';

// ── satisfies ─────────────────────────────────────────────────────
test('satisfies: common range forms', () => {
  assert.equal(satisfies('1.2.3', ''),        true);
  assert.equal(satisfies('1.2.3', '*'),       true);
  assert.equal(satisfies('1.2.3', '>=1.2.0'), true);
  assert.equal(satisfies('1.1.0', '>=1.2.0'), false);
  assert.equal(satisfies('1.5.0', '^1.2.0'),  true);
  assert.equal(satisfies('2.0.0', '^1.2.0'),  false);
  assert.equal(satisfies('1.2.9', '~1.2.0'),  true);
  assert.equal(satisfies('1.3.0', '~1.2.0'),  false);
  assert.equal(satisfies('1.2.3', '1.2.3'),   true);
  assert.equal(satisfies('1.2.4', '1.2.3'),   false);
  assert.equal(satisfies('garbage', '>=1.0.0'), true);  // unparseable → don't block
});

test('satisfies: caret on 0.x locks the leftmost non-zero (semver-correct)', () => {
  // ^0.2.3 = >=0.2.3 <0.3.0  (lock MINOR when major is 0) — the early-addon case.
  assert.equal(satisfies('0.2.3', '^0.2.3'), true);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.2.2', '^0.2.3'), false);   // below the floor
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);   // minor bumped
  assert.equal(satisfies('0.9.0', '^0.2.3'), false);   // regression guard — was wrongly true
  assert.equal(satisfies('1.0.0', '^0.2.3'), false);
  // ^0.0.3 = exactly 0.0.3 (lock patch).
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  // ^M.m.p (major > 0) keeps the major-lock behaviour.
  assert.equal(satisfies('1.9.9', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
});

test('depRange: string and object forms', () => {
  assert.equal(depRange('^1.0.0'), '^1.0.0');
  assert.equal(depRange({ range: '>=2.0.0', repo: 'me/dice' }), '>=2.0.0');
  assert.equal(depRange({}), '');
  assert.equal(depRange(null), '');
});

// ── planLoadOrder ─────────────────────────────────────────────────
test('planLoadOrder: dependency loads before dependent', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', dependencies: { dice: '>=1.0.0' } },
    { id: 'dice',  version: '1.2.0', dependencies: {} },
  ]);
  assert.equal(blocked.size, 0);
  assert.deepEqual(order.map(a => a.id), ['dice', 'sheet']);
});

test('planLoadOrder: missing dependency blocks the dependent', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', dependencies: { dice: '*' } },
  ]);
  assert.equal(order.length, 0);
  assert.ok(blocked.has('sheet'));
  assert.match(blocked.get('sheet'), /chybí/);
});

test('planLoadOrder: incompatible version blocks only the dependent', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', dependencies: { dice: '>=2.0.0' } },
    { id: 'dice',  version: '1.0.0', dependencies: {} },
  ]);
  assert.ok(blocked.has('sheet'));
  assert.ok(!blocked.has('dice'));
  assert.deepEqual(order.map(a => a.id), ['dice']);
});

test('planLoadOrder: a dependent of a blocked addon is transitively blocked', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'a', version: '1.0.0', dependencies: { missing: '*' } },
    { id: 'b', version: '1.0.0', dependencies: { a: '*' } },
  ]);
  assert.equal(order.length, 0);
  assert.ok(blocked.has('a') && blocked.has('b'));
});

test('planLoadOrder: a cycle blocks every addon in it', () => {
  const { order, blocked, cycles } = planLoadOrder([
    { id: 'a', version: '1.0.0', dependencies: { b: '*' } },
    { id: 'b', version: '1.0.0', dependencies: { a: '*' } },
  ]);
  assert.equal(order.length, 0);
  assert.deepEqual(cycles.sort(), ['a', 'b']);
  assert.match(blocked.get('a'), /cykl/);
});

test('planLoadOrder: independent addons all load', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'x', version: '1.0.0', dependencies: {} },
    { id: 'y', version: '1.0.0' },
  ]);
  assert.equal(blocked.size, 0);
  assert.equal(order.length, 2);
});

test('planLoadOrder: a diamond loads the root first, leaf last', () => {
  // d depends on b + c, which both depend on a.
  const { order, blocked } = planLoadOrder([
    { id: 'd', version: '1.0.0', dependencies: { b: '*', c: '*' } },
    { id: 'b', version: '1.0.0', dependencies: { a: '*' } },
    { id: 'c', version: '1.0.0', dependencies: { a: '*' } },
    { id: 'a', version: '1.0.0', dependencies: {} },
  ]);
  assert.equal(blocked.size, 0);
  const pos = Object.fromEntries(order.map((a, i) => [a.id, i]));
  assert.ok(pos.a < pos.b && pos.a < pos.c && pos.b < pos.d && pos.c < pos.d);
});
