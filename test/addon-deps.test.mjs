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

test('satisfies: comparators < <= >', () => {
  assert.equal(satisfies('1.0.0', '<2.0.0'),  true);
  assert.equal(satisfies('2.0.0', '<2.0.0'),  false);
  assert.equal(satisfies('2.0.0', '<=2.0.0'), true);
  assert.equal(satisfies('2.0.1', '<=2.0.0'), false);
  assert.equal(satisfies('1.2.4', '>1.2.3'),  true);
  assert.equal(satisfies('1.2.3', '>1.2.3'),  false);
});

test('satisfies: X-ranges lock major / major+minor', () => {
  assert.equal(satisfies('1.9.9', '1.x'),   true);
  assert.equal(satisfies('2.0.0', '1.x'),   false);
  assert.equal(satisfies('1.2.9', '1.2.x'), true);
  assert.equal(satisfies('1.3.0', '1.2.x'), false);
  assert.equal(satisfies('1.0.0', '1.*'),   true);
});

test('satisfies: pre-release tag is treated as its release (documented simplification)', () => {
  // parseVer strips `-alpha`, so a pre-release satisfies a range naming its
  // release. Pinned so the simplification is a known choice, not an accident.
  assert.equal(satisfies('1.2.0-alpha', '^1.2.0'), true);
  assert.equal(satisfies('1.2.3-rc.1', '>=1.2.3'), true);
});

test('satisfies: unparseable RANGES (hyphen / OR) fall through to permissive', () => {
  assert.equal(satisfies('5.0.0', '1.0.0 - 2.0.0'), true);   // hyphen range not parsed → don't block
  assert.equal(satisfies('5.0.0', '^1.0.0 || ^2.0.0'), true); // OR not parsed → don't block
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

test('planLoadOrder: a node DOWNSTREAM of a cycle is blocked but NOT mislabeled cyclic', () => {
  // a⇄b is the real cycle; d depends on a (downstream) — it can't load, but its
  // reason must say "depends on a cycle", and it must NOT appear in cycles[].
  const { order, blocked, cycles } = planLoadOrder([
    { id: 'a', version: '1.0.0', dependencies: { b: '*' } },
    { id: 'b', version: '1.0.0', dependencies: { a: '*' } },
    { id: 'd', version: '1.0.0', dependencies: { a: '*' } },
  ]);
  assert.equal(order.length, 0);
  assert.deepEqual(cycles.sort(), ['a', 'b'], 'only the true cycle members');
  assert.ok(!cycles.includes('d'));
  assert.match(blocked.get('a'), /cykl/);
  assert.match(blocked.get('d'), /v cyklu/);          // "závislost je v cyklu", not "cyklická závislost"
  assert.doesNotMatch(blocked.get('d'), /cyklická/);
});

test('planLoadOrder: a 3-cycle labels all three members', () => {
  const { cycles } = planLoadOrder([
    { id: 'a', version: '1.0.0', dependencies: { b: '*' } },
    { id: 'b', version: '1.0.0', dependencies: { c: '*' } },
    { id: 'c', version: '1.0.0', dependencies: { a: '*' } },
  ]);
  assert.deepEqual(cycles.sort(), ['a', 'b', 'c']);
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

// ── planLoadOrder: optionalDependencies (soft, ordering-only) ──────
test('planLoadOrder: present optional dep orders the dependent AFTER it', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', optionalDependencies: { rules: '>=1.0.0' } },
    { id: 'rules', version: '1.2.0' },
  ]);
  assert.equal(blocked.size, 0);
  assert.deepEqual(order.map(a => a.id), ['rules', 'sheet']);
});

test('planLoadOrder: absent optional dep does NOT block — dependent loads standalone', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', optionalDependencies: { rules: '*' } },
  ]);
  assert.equal(blocked.size, 0);
  assert.deepEqual(order.map(a => a.id), ['sheet']);
});

test('planLoadOrder: version-incompatible optional dep is ignored, never blocks', () => {
  const { order, blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', optionalDependencies: { rules: '>=2.0.0' } },
    { id: 'rules', version: '1.0.0' },
  ]);
  assert.equal(blocked.size, 0, 'an incompatible OPTIONAL dep must not block');
  // No ordering edge is created (treated as absent), so both just load.
  assert.equal(order.length, 2);
});

test('planLoadOrder: a blocked optional dep leaves the dependent loadable standalone', () => {
  // rules hard-needs a missing compendium → rules is blocked; sheet only
  // OPTIONALLY needs rules, so sheet must still load (no transitive block).
  const { order, blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', optionalDependencies: { rules: '*' } },
    { id: 'rules', version: '1.0.0', dependencies: { compendium: '*' } },
  ]);
  assert.ok(blocked.has('rules'));
  assert.ok(!blocked.has('sheet'), 'sheet only soft-uses rules → not transitively blocked');
  assert.deepEqual(order.map(a => a.id), ['sheet']);
});

test('planLoadOrder: an optional-edge cycle is broken (both load), not blocked', () => {
  const { order, blocked, cycles } = planLoadOrder([
    { id: 'a', version: '1.0.0', optionalDependencies: { b: '*' } },
    { id: 'b', version: '1.0.0', optionalDependencies: { a: '*' } },
  ]);
  assert.equal(blocked.size, 0, 'optional ordering must never block');
  assert.equal(cycles.length, 0);
  assert.equal(order.length, 2);
});

test('planLoadOrder: the sheets→core-rules→compendium chain orders correctly', () => {
  // sheet OPTIONALLY uses core-rules; core-rules HARD-needs compendium.
  const { order, blocked } = planLoadOrder([
    { id: 'dnd55e-sheets', version: '0.1.0', optionalDependencies: { 'dnd55e-core-rules': '>=0.1.0' } },
    { id: 'dnd55e-core-rules', version: '0.1.0', dependencies: { 'dnd55e-compendium': '>=0.1.0' } },
    { id: 'dnd55e-compendium', version: '0.1.0' },
  ]);
  assert.equal(blocked.size, 0);
  const pos = Object.fromEntries(order.map((a, i) => [a.id, i]));
  assert.ok(pos['dnd55e-compendium'] < pos['dnd55e-core-rules'], 'compendium before core-rules');
  assert.ok(pos['dnd55e-core-rules'] < pos['dnd55e-sheets'], 'core-rules before sheets');
});

test('planLoadOrder: a HARD dep still blocks even when an optional dep is also present', () => {
  // Regression guard: adding optionalDependencies handling must not weaken
  // hard-dep blocking.
  const { blocked } = planLoadOrder([
    { id: 'sheet', version: '1.0.0', dependencies: { missing: '*' }, optionalDependencies: { rules: '*' } },
    { id: 'rules', version: '1.0.0' },
  ]);
  assert.ok(blocked.has('sheet'));
  assert.match(blocked.get('sheet'), /chybí/);
});
