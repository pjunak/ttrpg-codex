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

// ── Fixture tree mirroring a book addon's layout. ─────────────────────────
function makeTree(files = {}) {
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
  for (const [rel, value] of Object.entries(files)) write(rel, value);
  return root;
}

test('loadContentTree: groups by record kind (dir-name fallback), indexes, and counts', () => {
  const { content, index, kinds, count } = loadContentTree(makeTree());
  assert.equal(count, 4);
  assert.deepEqual(kinds, ['monsters', 'spell', 'subclass'], 'kind field wins; dir name is the fallback');
  assert.equal(content.spell.length, 2);
  assert.deepEqual(content.spell.map(s => s.id), ['bless', 'fireball'], 'sorted by id (deterministic)');
  assert.equal(content.subclass[0].classId, 'cleric', 'nested records found');
  assert.equal(content.monsters[0].id, 'aboleth', 'kind-less record under its dir name');
  assert.equal(index.spell.fireball.level, 3, 'per-kind id index built');
  assert.equal(index.spell.nope, undefined);
});

test('loadContentTree: malformed files reject the whole package with safe diagnostics', () => {
  const root = makeTree({
    'rules/broken.json': '{ not valid json',
    'rules/array.json': [],
    'rules/missing-id.json': { kind: 'rule', name: 'No identity' },
    'rules/invalid-kind.json': { id: 'bad-kind', kind: '' },
  });
  assert.throws(
    () => loadContentTree(root),
    error => {
      assert.equal(error.code, 'ADDON_CONTENT_INVALID');
      assert.deepEqual(
        error.diagnostics.map(diagnostic => diagnostic.code).sort(),
        ['CONTENT_ID_INVALID', 'CONTENT_JSON_INVALID', 'CONTENT_KIND_INVALID', 'CONTENT_RECORD_INVALID'],
      );
      assert.ok(error.diagnostics.every(diagnostic => !path.isAbsolute(diagnostic.path)));
      return true;
    },
  );
});

test('loadContentTree: missing roots and non-directory roots reject the package', () => {
  assert.throws(
    () => loadContentTree(path.join(os.tmpdir(), 'nope-' + Date.now())),
    error => error.code === 'ADDON_CONTENT_INVALID'
      && error.diagnostics[0].code === 'CONTENT_DIR_MISSING',
  );
  const file = path.join(makeTree(), 'not-a-directory');
  fs.writeFileSync(file, '{}');
  assert.throws(
    () => loadContentTree(file),
    error => error.code === 'ADDON_CONTENT_INVALID'
      && error.diagnostics[0].code === 'CONTENT_DIR_NOT_DIRECTORY',
  );
});

test('loadContentTree: duplicate identities reject instead of overwriting', () => {
  const duplicate = makeTree({
    'other/fireball-copy.json': { id: 'fireball', kind: 'spell', name: 'Duplicate' },
  });
  assert.throws(
    () => loadContentTree(duplicate),
    error => error.code === 'ADDON_CONTENT_INVALID'
      && error.diagnostics[0].code === 'CONTENT_DUPLICATE_ID'
      && new Set([error.diagnostics[0].path, error.diagnostics[0].relatedPath]).size === 2,
  );

  const differentKind = makeTree({
    'rules/fireball.json': { id: 'fireball', kind: 'rule', name: 'Same id, distinct kind' },
  });
  const tree = loadContentTree(differentKind);
  assert.equal(tree.index.spell.fireball.name, 'Fireball');
  assert.equal(tree.index.rule.fireball.name, 'Same id, distinct kind');
});

test('loadContentTree: root-level records must declare kind', () => {
  assert.throws(
    () => loadContentTree(makeTree({ 'orphan.json': { id: 'orphan' } })),
    error => error.code === 'ADDON_CONTENT_INVALID'
      && error.diagnostics[0].code === 'CONTENT_KIND_REQUIRED',
  );
  const tree = loadContentTree(makeTree({
    'rule.json': { id: 'root-rule', kind: 'rule', name: 'Root rule' },
  }));
  assert.equal(tree.index.rule['root-rule'].name, 'Root rule');
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
