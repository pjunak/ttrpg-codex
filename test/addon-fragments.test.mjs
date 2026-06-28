// Unit tests for the pure fragment-override engine (Phase 6). No DOM needed.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyFragmentOps, listConflicts } from '../web/js/addon-fragments.js';

const frags = () => ([
  { id: 'characters:section:vazby', html: '<vazby>' },
  { id: 'characters:section:otazky', html: '<otazky>' },
  { id: 'characters:body', html: '<body>' },
]);

test('no claims → fragments returned unchanged', () => {
  const r = applyFragmentOps(frags(), [], {});
  assert.deepEqual(r.fragments.map(f => f.html), ['<vazby>', '<otazky>', '<body>']);
  assert.equal(r.conflicts.length, 0);
});

test('replace: a single exclusive claim wins and receives the original html', () => {
  const claims = [{ addonId: 'a', target: 'characters:body', op: 'replace', render: (html) => `WRAP(${html})` }];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, 'WRAP(<body>)');
  assert.equal(r.conflicts.length, 0);
});

test('hide: removes the fragment html', () => {
  const claims = [{ addonId: 'a', target: 'characters:section:vazby', op: 'hide' }];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.fragments.find(f => f.id === 'characters:section:vazby').html, '');
});

test('two exclusive claims on one target, UNRESOLVED → conflict, built-in kept', () => {
  const claims = [
    { addonId: 'a', target: 'characters:body', op: 'replace', render: () => 'A' },
    { addonId: 'b', target: 'characters:body', op: 'replace', render: () => 'B' },
  ];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, '<body>', 'built-in is the safe default');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].target, 'characters:body');
  assert.deepEqual(r.conflicts[0].claimants.map(c => c.addonId).sort(), ['a', 'b']);
});

test('resolved conflict → the chosen addon wins, no conflict reported', () => {
  const claims = [
    { addonId: 'a', target: 'characters:body', op: 'replace', render: () => 'A' },
    { addonId: 'b', target: 'characters:body', op: 'replace', render: () => 'B' },
  ];
  const r = applyFragmentOps(frags(), claims, { 'characters:body': 'b' });
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, 'B');
  assert.equal(r.conflicts.length, 0);
});

test('resolution null → built-in forced even with claims', () => {
  const claims = [{ addonId: 'a', target: 'characters:body', op: 'replace', render: () => 'A' }];
  const r = applyFragmentOps(frags(), claims, { 'characters:body': null });
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, '<body>');
});

test('resolution pointing at a now-absent claimant → built-in (not a crash)', () => {
  const claims = [
    { addonId: 'a', target: 'characters:body', op: 'replace', render: () => 'A' },
    { addonId: 'b', target: 'characters:body', op: 'replace', render: () => 'B' },
  ];
  const r = applyFragmentOps(frags(), claims, { 'characters:body': 'gone' });
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, '<body>');
});

test('wrap: stackable, ordered, composes with the inner html (no conflict)', () => {
  const claims = [
    { addonId: 'a', target: 'characters:body', op: 'wrap', order: 2, render: (h) => `[a${h}a]` },
    { addonId: 'b', target: 'characters:body', op: 'wrap', order: 1, render: (h) => `(b${h}b)` },
  ];
  const r = applyFragmentOps(frags(), claims, {});
  // order 1 (b) applies first, then order 2 (a) wraps that.
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, '[a(b<body>b)a]');
  assert.equal(r.conflicts.length, 0);
});

test('wrap on a hidden fragment is skipped (nothing to wrap)', () => {
  const claims = [
    { addonId: 'a', target: 'characters:section:vazby', op: 'hide' },
    { addonId: 'b', target: 'characters:section:vazby', op: 'wrap', render: (h) => `X${h}X` },
  ];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.fragments.find(f => f.id === 'characters:section:vazby').html, '');
});

test('insert: multiple at one anchor are deterministically ordered by `order`; empties skipped', () => {
  const claims = [
    { addonId: 'b', target: 'characters:body', op: 'insert', position: 'after', order: 2, render: () => 'SECOND' },
    { addonId: 'a', target: 'characters:body', op: 'insert', position: 'after', order: 1, render: () => 'FIRST' },
    { addonId: 'c', target: 'characters:body', op: 'insert', position: 'after', render: () => '' }, // empty → no slot
  ];
  const r = applyFragmentOps(frags(), claims, {});
  assert.deepEqual(r.fragments.map(f => f.html), ['<vazby>', '<otazky>', '<body>', 'FIRST', 'SECOND']);
});

test('insert before/after splices sibling fragments at the anchor', () => {
  const claims = [
    { addonId: 'a', target: 'characters:body', op: 'insert', position: 'after',  render: () => 'AFTER' },
    { addonId: 'a', target: 'characters:body', op: 'insert', position: 'before', render: () => 'BEFORE' },
  ];
  const r = applyFragmentOps(frags(), claims, {});
  const htmls = r.fragments.map(f => f.html);
  assert.deepEqual(htmls, ['<vazby>', '<otazky>', 'BEFORE', '<body>', 'AFTER']);
});

test('a claim targeting a missing fragment is reported as unmatched', () => {
  const claims = [{ addonId: 'a', target: 'characters:section:ghost', op: 'replace', render: () => 'X' }];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.unmatched.length, 1);
  assert.deepEqual(r.unmatched[0], { addonId: 'a', target: 'characters:section:ghost', op: 'replace' });
});

test('a throwing render degrades to built-in and is collected as a failure', () => {
  const claims = [{ addonId: 'a', target: 'characters:body', op: 'replace', render: () => { throw new Error('boom'); } }];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, '<body>');
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].addonId, 'a');
});

test('ctx (entity) is threaded into render with the fragment target added', () => {
  let seen = null;
  const claims = [{ addonId: 'a', target: 'characters:body', op: 'replace', render: (h, ctx) => { seen = ctx; return 'X'; } }];
  applyFragmentOps(frags(), claims, {}, { entity: { id: 'kira' }, kind: 'characters' });
  assert.equal(seen.entity.id, 'kira');
  assert.equal(seen.kind, 'characters');
  assert.equal(seen.target, 'characters:body');
});

test('one addon claiming TWO exclusive ops on one target is NOT a conflict (its dup is a failure)', () => {
  const claims = [
    { addonId: 'a', target: 'characters:body', op: 'replace', render: () => 'A' },
    { addonId: 'a', target: 'characters:body', op: 'hide' },   // same addon's 2nd exclusive claim
  ];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, 'A', 'first exclusive applies, not a stalemate');
  assert.equal(r.conflicts.length, 0, 'one addon can not conflict with itself');
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].addonId, 'a');
  assert.equal(listConflicts(claims, {}).length, 0, 'and it is not a standing Manager conflict');
});

test('wrap: equal order falls back to a deterministic addonId tiebreak', () => {
  // Registration order is reversed (z before a) to prove the OUTPUT order is by
  // addonId, not by load/registration order.
  const claims = [
    { addonId: 'z', target: 'characters:body', op: 'wrap', order: 1, render: (h) => `z(${h})` },
    { addonId: 'a', target: 'characters:body', op: 'wrap', order: 1, render: (h) => `a(${h})` },
  ];
  const r = applyFragmentOps(frags(), claims, {});
  // addonId asc → a applies first (inner), z second (outer).
  assert.equal(r.fragments.find(f => f.id === 'characters:body').html, 'z(a(<body>))');
});

test('insert: equal order falls back to a deterministic addonId tiebreak', () => {
  const claims = [
    { addonId: 'b', target: 'characters:body', op: 'insert', position: 'after', order: 1, render: () => 'B' },
    { addonId: 'a', target: 'characters:body', op: 'insert', position: 'after', order: 1, render: () => 'A' },
  ];
  const r = applyFragmentOps(frags(), claims, {});
  assert.deepEqual(r.fragments.map(f => f.html), ['<vazby>', '<otazky>', '<body>', 'A', 'B']);
});

test('insert with no render fn is reported as a failure, not silently dropped', () => {
  const claims = [{ addonId: 'a', target: 'characters:body', op: 'insert', position: 'after' }];
  const r = applyFragmentOps(frags(), claims, {});
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].op, 'insert');
  assert.deepEqual(r.fragments.map(f => f.html), ['<vazby>', '<otazky>', '<body>'], 'nothing inserted');
});

// ── listConflicts (the Manager's eager source) ────────────────────
test('listConflicts: only ≥2 exclusive claims on a target count', () => {
  const claims = [
    { addonId: 'a', target: 't1', op: 'replace' },
    { addonId: 'b', target: 't1', op: 'hide' },     // conflict with a
    { addonId: 'c', target: 't2', op: 'replace' },  // single → no conflict
    { addonId: 'd', target: 't3', op: 'wrap' },     // wrap never conflicts
    { addonId: 'e', target: 't3', op: 'wrap' },
  ];
  const out = listConflicts(claims, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].target, 't1');
  assert.equal(out[0].resolved, undefined);
});

test('listConflicts: reflects an existing resolution', () => {
  const claims = [
    { addonId: 'a', target: 't1', op: 'replace' },
    { addonId: 'b', target: 't1', op: 'replace' },
  ];
  assert.equal(listConflicts(claims, { t1: 'a' })[0].resolved, 'a');
  assert.equal(listConflicts(claims, { t1: null })[0].resolved, null);
});
