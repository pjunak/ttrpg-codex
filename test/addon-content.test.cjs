'use strict';

// Unit tests for host-served declarative addon content (manifest `contentDir`):
// the pure tree reader in server/addon-content.cjs + the manifest validation
// of the contentDir field in server/addons.cjs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadContentTree } = require('../server/addon-content.cjs');
const { validateManifest } = require('../server/addons.cjs');

// ── Fixture tree mirroring a book addon's layout (incl. a nested dir + a
//    kind-field-less record + a corrupt file). ─────────────────────────────
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-content-'));
  const write = (rel, obj) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  };
  write('spells/fireball.json', { id: 'fireball', kind: 'spell', name: 'Fireball', level: 3 });
  write('spells/bless.json', { id: 'bless', kind: 'spell', name: 'Bless', level: 1 });
  // nested per owning class — kind field still wins
  write('subclasses/cleric/life-domain.json', { id: 'life-domain', kind: 'subclass', name: 'Life Domain', classId: 'cleric' });
  // NO kind field → grouped under the top-level dir name
  write('monsters/aboleth.json', { id: 'aboleth', name: 'Aboleth' });
  // corrupt file — skipped, never fatal
  write('rules/broken.json', '{ not valid json');
  return root;
}

test('loadContentTree: groups by record kind (dir-name fallback), skips corrupt, counts', () => {
  const { content, index, kinds, count } = loadContentTree(makeTree());
  assert.equal(count, 4, 'four valid records (corrupt skipped)');
  assert.deepEqual(kinds, ['monsters', 'spell', 'subclass'], 'kind field wins; dir name is the fallback');
  assert.equal(content.spell.length, 2);
  assert.deepEqual(content.spell.map(s => s.id), ['bless', 'fireball'], 'sorted by id (deterministic)');
  assert.equal(content.subclass[0].classId, 'cleric', 'nested records found');
  assert.equal(content.monsters[0].id, 'aboleth', 'kind-less record under its dir name');
  assert.equal(index.spell.fireball.level, 3, 'per-kind id index built');
  assert.equal(index.spell.nope, undefined);
});

test('loadContentTree: a missing root yields empty content, never throws', () => {
  const { content, index, kinds, count } = loadContentTree(path.join(os.tmpdir(), 'nope-' + Date.now()));
  assert.deepEqual(content, {});
  assert.deepEqual(index, {});
  assert.deepEqual(kinds, []);
  assert.equal(count, 0);
});

// ── Manifest validation of contentDir ─────────────────────────────
const BASE = { id: 'book', name: 'Book', version: '0.1.0', apiVersion: 1, entry: 'entry.js' };

test('validateManifest: contentDir accepts a safe relative dir, is optional', () => {
  assert.ok(validateManifest({ ...BASE }).ok, 'omitted → fine');
  assert.ok(validateManifest({ ...BASE, contentDir: 'data' }).ok, 'plain dir → fine');
  assert.ok(validateManifest({ ...BASE, contentDir: 'content/records' }).ok, 'nested relative path → fine');
});

test('validateManifest: contentDir rejects traversal / absolute / empty / non-string', () => {
  for (const bad of ['../outside', '/abs', 'C:/abs', '', '  ', 42, {}]) {
    const r = validateManifest({ ...BASE, contentDir: bad });
    assert.ok(!r.ok, `contentDir ${JSON.stringify(bad)} must be rejected`);
    assert.ok(r.errors.some(e => /contentDir/.test(e)), 'error names the field');
  }
});
