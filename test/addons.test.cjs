const { test } = require('node:test');
const assert    = require('node:assert/strict');
const crypto    = require('node:crypto');
const AdmZip    = require('adm-zip');

const {
  HOST_API_VERSION,
  defaultRegistry, normalizeRegistry,
  validateManifest, matchRepoRule, isAllowed,
  contentHash, extractZip, _safeRel,
} = require('../server/addons.cjs');

// ── validateManifest ──────────────────────────────────────────────
function goodManifest(over = {}) {
  return {
    id: 'dnd5e-sheet', name: 'Sheet', version: '0.1.0',
    apiVersion: HOST_API_VERSION, entry: 'entry.js', ...over,
  };
}

test('validateManifest: accepts a well-formed manifest', () => {
  const v = validateManifest(goodManifest());
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('validateManifest: rejects bad id (uppercase / underscore / proto)', () => {
  for (const id of ['Bad', 'has_underscore', '__proto__', '-leading', 'x'.repeat(40)]) {
    assert.equal(validateManifest(goodManifest({ id })).ok, false, `should reject id "${id}"`);
  }
});

test('validateManifest: rejects an incompatible apiVersion', () => {
  const v = validateManifest(goodManifest({ apiVersion: HOST_API_VERSION + 1 }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /incompatible/);
});

test('validateManifest: rejects a non-semver version and missing name', () => {
  assert.equal(validateManifest(goodManifest({ version: 'v1' })).ok, false);
  assert.equal(validateManifest(goodManifest({ name: '' })).ok, false);
});

test('validateManifest: rejects an unsafe / non-js entry', () => {
  for (const entry of ['../escape.js', '/abs.js', 'entry.txt', 'a/../../b.js']) {
    assert.equal(validateManifest(goodManifest({ entry })).ok, false, `should reject entry "${entry}"`);
  }
  assert.equal(validateManifest(goodManifest({ entry: 'sub/dir/entry.mjs' })).ok, true);
});

test('validateManifest: permissions must be an array; dependencies an object', () => {
  assert.equal(validateManifest(goodManifest({ permissions: 'nope' })).ok, false);
  assert.equal(validateManifest(goodManifest({ dependencies: [] })).ok, false);
  assert.equal(validateManifest(goodManifest({ permissions: ['ui:route'], dependencies: {} })).ok, true);
});

// ── _safeRel ──────────────────────────────────────────────────────
test('_safeRel: rejects traversal, absolute, drive, null byte', () => {
  for (const r of ['../x', 'a/../../b', '/abs', '\\abs', 'C:\\x', 'a\0b']) {
    assert.equal(_safeRel(r), false, `should reject "${r}"`);
  }
  for (const r of ['entry.js', 'sub/dir/x.css', 'a.b.js']) {
    assert.equal(_safeRel(r), true, `should accept "${r}"`);
  }
});

// ── allowlist matching ────────────────────────────────────────────
test('matchRepoRule: exact + owner/* wildcard, no deep wildcard match', () => {
  assert.equal(matchRepoRule('me/addon', 'me/addon'), true);
  assert.equal(matchRepoRule('me/*', 'me/addon'), true);
  assert.equal(matchRepoRule('me/*', 'other/addon'), false);
  assert.equal(matchRepoRule('me/*', 'me/addon/extra'), false);
  assert.equal(matchRepoRule('me/addon', 'me/other'), false);
});

test('isAllowed: empty allowlist denies everything', () => {
  assert.equal(isAllowed(defaultRegistry(), 'me/addon'), false);
  const reg = normalizeRegistry({ sources: { allow: ['me/*'] } });
  assert.equal(isAllowed(reg, 'me/addon'), true);
  assert.equal(isAllowed(reg, 'you/addon'), false);
});

// ── normalizeRegistry ─────────────────────────────────────────────
test('normalizeRegistry: coerces junk into a valid shape', () => {
  const reg = normalizeRegistry(null);
  assert.deepEqual(reg.addons, []);
  assert.deepEqual(reg.sources.allow, []);
  const reg2 = normalizeRegistry({ addons: 'x', sources: { allow: [1, 'me/ok', null] } });
  assert.deepEqual(reg2.addons, []);
  assert.deepEqual(reg2.sources.allow, ['me/ok']);   // non-strings dropped
});

// ── contentHash ───────────────────────────────────────────────────
test('contentHash: deterministic + order-independent + content-sensitive', () => {
  const a = { relpath: 'addon.json', buffer: Buffer.from('{"id":"x"}') };
  const b = { relpath: 'entry.js',   buffer: Buffer.from('export default()=>{}') };
  const h1 = contentHash([a, b], crypto);
  const h2 = contentHash([b, a], crypto);     // reordered
  assert.equal(h1, h2, 'order must not matter');
  const h3 = contentHash([a, { ...b, buffer: Buffer.from('changed') }], crypto);
  assert.notEqual(h1, h3, 'content change must change the hash');
  assert.match(h1, /^[0-9a-f]{16}$/);
});

// ── extractZip ────────────────────────────────────────────────────
function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

test('extractZip: strips the GitHub wrapper dir', () => {
  const buf = zipOf({
    'owner-repo-abc123/addon.json': '{}',
    'owner-repo-abc123/entry.js':   'x',
    'owner-repo-abc123/sub/a.css':  'y',
  });
  const map = extractZip(buf, AdmZip);
  const names = map.map(f => f.relpath).sort();
  assert.deepEqual(names, ['addon.json', 'entry.js', 'sub/a.css']);
});

test('extractZip: leaves a flat (no-wrapper) zip untouched', () => {
  const buf = zipOf({ 'addon.json': '{}', 'entry.js': 'x' });
  const names = extractZip(buf, AdmZip).map(f => f.relpath).sort();
  assert.deepEqual(names, ['addon.json', 'entry.js']);
});

test('extractZip: every emitted path is relative-safe', () => {
  // Whatever the zip carries, nothing that escapes the addon dir may
  // survive (the per-entry _safeRel filter is the guard; server.js also
  // routes each write through _safeJoinIn).
  const buf = zipOf({
    'owner-repo-sha/addon.json':  '{}',
    'owner-repo-sha/sub/ok.js':   'x',
  });
  for (const f of extractZip(buf, AdmZip)) {
    assert.equal(_safeRel(f.relpath), true, `unsafe path leaked: ${f.relpath}`);
    assert.ok(!f.relpath.startsWith('/'));
    assert.ok(!f.relpath.split('/').includes('..'));
  }
});
