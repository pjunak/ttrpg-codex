'use strict';

// Content-group toggles (manifest `contentGroups` + registry
// `disabledContentGroups`) — the DM's per-sourcebook on/off switches for a
// content addon. Unit: manifest validation, registry coercion, and the two
// pure tree helpers. Integration: the served endpoints filter live after a
// POST /api/addons/:id/content-groups, field-less records always survive,
// and the endpoint is DM-only.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const {
  HOST_API_VERSION, validateManifest, normalizeRegistry,
  normalizeContentGroups, normalizeDisabledContentGroups,
} = require('../server/addons.cjs');
const { loadContentTree, groupValues, filterContentTree } = require('../server/addon-content.cjs');
const { startServer } = require('./helpers/server-process.cjs');

function goodManifest(over = {}) {
  return {
    id: 'books', name: 'Books', version: '0.1.0',
    apiVersion: HOST_API_VERSION, entry: 'entry.js', ...over,
  };
}

// ── validateManifest ──────────────────────────────────────────────
test('validateManifest: accepts contentGroups {field,label} and bare {field}', () => {
  assert.deepEqual(validateManifest(goodManifest({
    contentDir: 'data', contentGroups: { field: 'book', label: 'Sourcebooks' },
  })).errors, []);
  assert.deepEqual(validateManifest(goodManifest({
    contentDir: 'data', contentGroups: { field: 'book' },
  })).errors, []);
});

test('validateManifest: rejects malformed contentGroups', () => {
  const bad = (cg) => validateManifest(goodManifest({ contentDir: 'data', contentGroups: cg })).errors.length > 0;
  assert.ok(bad('book'),                          'string is not an object');
  assert.ok(bad(['book']),                        'array is not an object');
  assert.ok(bad({}),                              'field is required');
  assert.ok(bad({ field: 'has spaces' }),         'field grammar enforced');
  assert.ok(bad({ field: 'a'.repeat(41) }),       'field length capped');
  assert.ok(bad({ field: 'book', label: 'x'.repeat(61) }), 'label length capped');
});

// ── registry coercion ─────────────────────────────────────────────
test('normalizeContentGroups / normalizeDisabledContentGroups coerce junk', () => {
  assert.deepEqual(normalizeContentGroups({ field: 'book', label: 'Books' }), { field: 'book', label: 'Books' });
  assert.equal(normalizeContentGroups({ field: 'not valid!' }), null);
  assert.equal(normalizeContentGroups('book'), null);
  assert.equal(normalizeContentGroups(undefined), null);
  assert.deepEqual(normalizeDisabledContentGroups(['mm', 'mm', 7, '', 'phb']), ['mm', 'phb']);
  assert.deepEqual(normalizeDisabledContentGroups('mm'), []);
  assert.deepEqual(normalizeDisabledContentGroups(undefined), []);
});

test('normalizeRegistry: carries contentGroups, defaults disabledContentGroups', () => {
  const reg = normalizeRegistry({ schema: 1, addons: [
    { id: 'books', contentGroups: { field: 'book' }, disabledContentGroups: ['mm', 'mm'] },
    { id: 'plain' },
  ] });
  assert.deepEqual(reg.addons[0].contentGroups, { field: 'book', label: '' });
  assert.deepEqual(reg.addons[0].disabledContentGroups, ['mm']);
  assert.equal(reg.addons[1].contentGroups, undefined);
  assert.deepEqual(reg.addons[1].disabledContentGroups, []);
});

// ── pure tree helpers ─────────────────────────────────────────────
const TREE = { content: {
  spell:   [{ id: 's1', book: 'phb' }, { id: 's2', book: 'mm' }],
  rule:    [{ id: 'r1' }],                       // no field → never filterable
  monster: [{ id: 'm1', book: 'mm' }],
} };

test('groupValues: distinct values with counts from the unfiltered tree', () => {
  assert.deepEqual(groupValues(TREE, 'book'), [
    { id: 'mm', count: 2, label: 'mm' },      // no same-kind record → raw id
    { id: 'phb', count: 1, label: 'phb' },
  ]);
});

test('groupValues: a record of the field-named kind labels its group', () => {
  const labeled = { content: {
    ...TREE.content,
    book: [
      { id: 'phb', kind: 'book', name: "Player's Handbook" },
      { id: 'mm',  kind: 'book', name: '   ' },   // blank name → fall back to id
    ],
  } };
  assert.deepEqual(groupValues(labeled, 'book'), [
    { id: 'mm', count: 2, label: 'mm' },
    { id: 'phb', count: 1, label: "Player's Handbook" },
  ]);
});

test('filterContentTree: drops disabled groups, keeps field-less records, empties kinds', () => {
  const t = filterContentTree(TREE, 'book', ['mm']);
  assert.deepEqual(Object.keys(t.content).sort(), ['rule', 'spell']);
  assert.deepEqual(t.content.spell.map(r => r.id), ['s1'], 'mm spell dropped');
  assert.deepEqual(t.content.rule.map(r => r.id),  ['r1'], 'field-less kept');
  assert.equal(t.content.monster, undefined, 'kind emptied by the filter disappears');
  assert.equal(t.count, 2);
  assert.equal(filterContentTree(TREE, 'book', []), TREE, 'empty off-list is identity');
});

// ── integration: live filtering through the served endpoints ─────
const DM = 'dm-pw';
const HASH = '1111111111111111';
async function login(srv, pw) {
  const r = await srv.fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  assert.equal(r.status, 200);
}
const registry = (addons) => ({ schema: 1, addons, resolutions: {}, sources: { allow: [] } });

test('content-groups: POST filters the served tree live; DM-only; round-trips', async () => {
  const srv = await startServer({
    dmPassword: DM,
    seedData: { 'addons.json': registry([{
      id: 'books', name: 'Books', version: '1.0.0', apiVersion: 1, enabled: true,
      entry: 'entry.js', contentDir: 'content', activeHash: HASH,
      contentGroups: { field: 'book', label: 'Sourcebooks' },
      versions: [{ contentHash: HASH, version: '1.0.0' }],
    }]) },
    seedFiles: {
      [`addons/books/${HASH}/entry.js`]:                    'export default () => {};',
      [`addons/books/${HASH}/content/spell/s1.json`]:       { id: 's1', kind: 'spell', name: 'One', book: 'phb' },
      [`addons/books/${HASH}/content/spell/s2.json`]:       { id: 's2', kind: 'spell', name: 'Two', book: 'mm' },
      [`addons/books/${HASH}/content/rule/r1.json`]:        { id: 'r1', kind: 'rule',  name: 'NoBook' },
      // A record of the field-named kind labels its group in the Manager.
      [`addons/books/${HASH}/content/book/phb.json`]:       { id: 'phb', kind: 'book', name: "Player's Handbook" },
    },
  });
  try {
    // Default: everything serves.
    let content = await (await srv.fetch('/api/addon/books/content')).json();
    assert.equal(content.spell.length, 2);
    assert.equal(content.rule.length, 1);

    // Anonymous / non-DM cannot toggle.
    const anon = await srv.fetch('/api/addons/books/content-groups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: ['mm'] }),
    });
    assert.ok(anon.status === 401 || anon.status === 403, `anon rejected (${anon.status})`);

    await login(srv, DM);

    // The Manager payload lists the groups with unfiltered counts; a value
    // backed by a same-kind record shows its full name, others the raw id.
    let list = await (await srv.fetch('/api/addons')).json();
    let entry = list.addons.find(a => a.id === 'books');
    assert.deepEqual(entry.contentGroups.values, [
      { id: 'mm', count: 1, label: 'mm' },
      { id: 'phb', count: 1, label: "Player's Handbook" },
    ]);
    assert.deepEqual(entry.contentGroups.disabled, []);

    // Disable 'mm' → served tree filters immediately, field-less records stay.
    const set = await srv.fetch('/api/addons/books/content-groups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: ['mm'] }),
    });
    assert.equal(set.status, 200);
    content = await (await srv.fetch('/api/addon/books/content')).json();
    assert.deepEqual(content.spell.map(r => r.id), ['s1']);
    assert.equal(content.rule.length, 1, 'field-less record survives');
    const item = await srv.fetch('/api/addon/books/item/spell/s2');
    assert.equal(item.status, 404, 'filtered record is gone from /item too');
    // Counts in the Manager payload stay unfiltered; disabled list reflects state.
    list = await (await srv.fetch('/api/addons')).json();
    entry = list.addons.find(a => a.id === 'books');
    assert.deepEqual(entry.contentGroups.disabled, ['mm']);
    assert.deepEqual(entry.contentGroups.values, [
      { id: 'mm', count: 1, label: 'mm' },
      { id: 'phb', count: 1, label: "Player's Handbook" },
    ]);

    // Re-enable → everything back (nothing was deleted).
    await srv.fetch('/api/addons/books/content-groups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: [] }),
    });
    content = await (await srv.fetch('/api/addon/books/content')).json();
    assert.equal(content.spell.length, 2);

    // An addon without contentGroups rejects the toggle.
    const none = await srv.fetch('/api/addons/nope/content-groups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: [] }),
    });
    assert.equal(none.status, 404);
  } finally { await srv.kill(); }
});
