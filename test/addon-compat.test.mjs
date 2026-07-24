import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vectors from './addon-compat-vectors.json' with { type: 'json' };
import { testRange as browserTestRange, compatibilityErrors as browserErrors } from '../web/js/addon-compat.js';

const require = createRequire(import.meta.url);
const server = require('../server/addon-compat.cjs');
const { validateManifest } = require('../server/addons.cjs');
const base = (over = {}) => ({
  id: 'compat-addon', name: 'Compat', version: '1.0.0', apiVersion: 1,
  hostVersion: '>=1.0.0', entry: 'entry.js', ...over,
});

test('server and browser compatibility adapters share strict range decisions', () => {
  for (const vector of vectors) {
    const expected = { valid: vector.valid, matches: vector.matches };
    assert.deepEqual(server.testRange(vector.version, vector.range), expected);
    assert.deepEqual(browserTestRange(vector.version, vector.range), expected);
  }
});

test('API v1 remains supported and API v2 loads without capabilities', () => {
  assert.equal(validateManifest(base()).ok, true);
  assert.equal(validateManifest(base({ apiVersion: 2 })).ok, true);
});

test('compatibility inputs fail closed', () => {
  assert.equal(validateManifest(base({ hostVersion: '>=2.0.0' })).ok, false);
  assert.equal(validateManifest(base({ hostVersion: 'latest' })).ok, false);
  assert.equal(validateManifest(base({ dependencies: { Bad_ID: '^1.0.0' } })).ok, false);
  assert.equal(validateManifest(base({ dependencies: { provider: '1 - 2' } })).ok, false);
  assert.equal(server.testRange('v1.0.0', '*').matches, false);
});

test('capabilities and collection security semantics fail closed', () => {
  assert.equal(validateManifest(base({ capabilities: { required: [] } })).ok, false);
  assert.equal(validateManifest(base({ apiVersion: 2, capabilities: { required: ['collections.dm'] } })).ok, true);
  assert.equal(validateManifest(base({ apiVersion: 2, capabilities: { optional: ['collections.dm'] } })).ok, true);
  assert.equal(validateManifest(base({ apiVersion: 2, capabilities: { optional: ['unknown.cap'] } })).ok, false);
  assert.equal(validateManifest(base({ apiVersion: 2, capabilities: { optional: ['collections.dm'], required: ['collections.dm'] } })).ok, false);
  assert.equal(validateManifest(base({ collections: [{ name: 'secret', access: 'dm' }] })).ok, false);
  assert.equal(validateManifest(base({ apiVersion: 2, collections: [{ name: 'secret', access: 'dm' }] })).ok, false);
  assert.equal(validateManifest(base({
    apiVersion: 2,
    capabilities: { required: ['collections.dm'] },
    collections: [{ name: 'secret', keyed: false, access: 'dm' }],
  })).ok, true);
  assert.equal(validateManifest(base({
    apiVersion: 2,
    capabilities: { required: ['collections.dm'] },
    collections: [{ name: 'secret', keyed: 'false', access: 'dm' }],
  })).ok, false);
  assert.equal(validateManifest(base({ apiVersion: 2, collections: [{ name: 'x', mysteryAccess: true }] })).ok, false);
});

test('server and browser reject the same runtime manifest', () => {
  const manifest = base({ apiVersion: 2, capabilities: { required: ['unknown.cap'] } });
  assert.deepEqual(browserErrors(manifest), server.compatibilityErrors(manifest));
});

test('a host without collections.dm rejects a DM collection manifest', () => {
  const manifest = base({
    apiVersion: 2,
    capabilities: { required: ['collections.dm'] },
    collections: [{ name: 'secret', access: 'dm' }],
  });
  const incapable = new Set(['lifecycle.dispose', 'content.revision']);
  assert.match(server.compatibilityErrors(manifest, incapable).join('; '), /collections\.dm.*unavailable/);
  assert.deepEqual(browserErrors(manifest, incapable), server.compatibilityErrors(manifest, incapable));
});
