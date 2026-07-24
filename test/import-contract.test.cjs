'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ImportError,
  normalizePlan,
  normalizeProviderDescriptor,
  parseJsonStrict,
} = require('../server/import-contract.cjs');
const Addons = require('../server/addons.cjs');

function addon(overrides = {}) {
  return {
    id: 'fixture-import',
    apiVersion: 2,
    capabilities: {
      required: ['collections.dm', 'collections.transactions', 'imports.providers'],
    },
    grantedPermissions: [
      'server:code',
      'data:own',
      'data:import-provider',
      'data:read:characters',
    ],
    collections: [
      { name: 'items', keyed: false, access: 'dm' },
      { name: 'lookup', keyed: true, access: 'dm' },
    ],
    packageRevision: 'package-a',
    ...overrides,
  };
}

function descriptor(overrides = {}) {
  return {
    id: 'fixture-json',
    apiVersion: 1,
    schemaVersion: 1,
    formats: ['json'],
    reads: [{ scope: 'core', collection: 'characters' }],
    writes: [{ scope: 'addon', addonId: 'fixture-import', collection: 'items' }],
    targetTypes: ['addon-list'],
    limits: { maxInputBytes: 4096, maxRecords: 20 },
    capabilities: ['abort-signal', 'structured-diagnostics'],
    preview: async () => ({ schemaVersion: 1, operations: [] }),
    ...overrides,
  };
}

test('strict JSON parser accepts bounded JSON and reports input statistics', () => {
  const parsed = parseJsonStrict(Buffer.from('{"records":[{"id":"a"},{"id":"b"}]}'));
  assert.deepEqual(parsed.value, { records: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(parsed.stats.records, 2);
  assert.ok(parsed.stats.nodes >= 6);
});

test('strict JSON parser detects nested and escaped duplicate keys before object parsing', () => {
  assert.throws(
    () => parseJsonStrict('{"outer":{"name":1,"n\\u0061me":2}}'),
    error => error instanceof ImportError
      && error.code === 'IMPORT_DUPLICATE_KEY'
      && error.details.path === '$.outer',
  );
});

test('strict JSON parser rejects prototype-pollution keys at any depth', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    assert.throws(
      () => parseJsonStrict(`{"safe":[{"${key}":{"polluted":true}}]}`),
      error => error.code === 'IMPORT_PROTOTYPE_KEY',
    );
  }
  assert.equal({}.polluted, undefined);
});

test('strict JSON parser enforces byte, depth, record, and string limits', () => {
  assert.throws(
    () => parseJsonStrict('{"long":"abcdef"}', { maxInputBytes: 4 }),
    error => error.code === 'IMPORT_INPUT_LIMIT' && error.status === 413,
  );
  assert.throws(
    () => parseJsonStrict('[[[0]]]', { maxDepth: 2 }),
    error => error.code === 'IMPORT_DEPTH_LIMIT',
  );
  assert.throws(
    () => parseJsonStrict('[{"id":1},{"id":2}]', { maxRecords: 1 }),
    error => error.code === 'IMPORT_RECORD_LIMIT',
  );
  assert.throws(
    () => parseJsonStrict('{"long":"abcdef"}', { maxStringChars: 5 }),
    error => error.code === 'IMPORT_STRING_LIMIT',
  );
});

test('provider descriptor validates versioned declarations and explicit core permissions', () => {
  const provider = normalizeProviderDescriptor(addon(), descriptor(), {
    coreCollections: new Set(['characters']),
  });
  assert.equal(provider.key, 'fixture-import:fixture-json');
  assert.deepEqual(provider.formats, ['json']);
  assert.equal(provider.packageRevision, 'package-a');
});

test('provider descriptor fails closed for malformed, unsupported, undeclared, and foreign access', () => {
  const policy = { coreCollections: new Set(['characters']) };
  const cases = [
    [descriptor({ id: '__proto__' }), 'IMPORT_PROVIDER_INVALID'],
    [descriptor({ apiVersion: 99 }), 'IMPORT_PROVIDER_UNSUPPORTED'],
    [descriptor({ formats: ['zip'] }), 'IMPORT_PROVIDER_UNSUPPORTED'],
    [descriptor({ capabilities: ['abort-signal', 'unknown'] }), 'IMPORT_PROVIDER_UNSUPPORTED'],
    [descriptor({
      writes: [{ scope: 'addon', addonId: 'fixture-import', collection: 'missing' }],
    }), 'IMPORT_PROVIDER_UNDECLARED'],
    [descriptor({
      writes: [{ scope: 'addon', addonId: 'other-addon', collection: 'items' }],
    }), 'IMPORT_PROVIDER_FOREIGN'],
    [descriptor({
      writes: [{ scope: 'core', collection: 'characters' }],
      targetTypes: ['addon-list'],
    }), 'IMPORT_PROVIDER_FOREIGN'],
  ];
  for (const [candidate, code] of cases) {
    assert.throws(
      () => normalizeProviderDescriptor(addon(), candidate, policy),
      error => error.code === code,
    );
  }
  assert.throws(
    () => normalizeProviderDescriptor(
      addon({ grantedPermissions: ['server:code', 'data:own', 'data:import-provider'] }),
      descriptor(),
      policy,
    ),
    error => error.code === 'IMPORT_PERMISSION',
  );
});

test('provider plans allow only declared put targets and reject protected fields', () => {
  const provider = normalizeProviderDescriptor(addon(), descriptor(), {
    coreCollections: new Set(['characters']),
  });
  const targetTypes = new Map([['addon:fixture-import:items', 'addon-list']]);
  const valid = normalizePlan(provider, {
    schemaVersion: 1,
    operations: [{
      target: { scope: 'addon', addonId: 'fixture-import', collection: 'items' },
      op: 'put',
      id: 'new-item',
      value: { name: 'New item' },
    }],
    diagnostics: [{ severity: 'warning', code: 'FIXTURE_WARNING', message: '<b>plain text</b>' }],
  }, targetTypes);
  assert.equal(valid.operations.length, 1);
  assert.equal(valid.diagnostics[0].message, '<b>plain text</b>');

  for (const field of ['id', 'namespace', 'access', 'revision', 'audit', 'createdBy']) {
    assert.throws(
      () => normalizePlan(provider, {
        schemaVersion: 1,
        operations: [{
          target: { scope: 'addon', addonId: 'fixture-import', collection: 'items' },
          op: 'put',
          id: 'new-item',
          value: { [field]: 'forged' },
        }],
      }, targetTypes),
      error => error.code === 'IMPORT_PROTECTED_FIELD' && error.details.field === field,
    );
  }
  assert.throws(
    () => normalizePlan(provider, {
      schemaVersion: 1,
      operations: [{
        target: { scope: 'addon', addonId: 'fixture-import', collection: 'lookup' },
        op: 'put',
        id: 'x',
        value: { name: 'wrong target' },
      }],
    }, new Map([['addon:fixture-import:lookup', 'addon-keyed']])),
    error => error.code === 'IMPORT_PROVIDER_UNDECLARED',
  );
  assert.throws(
    () => normalizePlan(provider, {
      schemaVersion: 1,
      operations: [{
        target: { scope: 'addon', addonId: 'fixture-import', collection: 'items' },
        op: 'delete',
        id: 'x',
      }],
    }, targetTypes),
    error => error.code === 'IMPORT_PLAN_INVALID',
  );
});

test('imports.providers capability negotiation fails closed without its server, permissions, transaction, or collection contract', () => {
  const manifest = {
    id: 'fixture-import',
    name: 'Fixture import',
    version: '1.0.0',
    apiVersion: 2,
    hostVersion: '>=1.0.0',
    entry: 'entry.js',
    server: 'server/index.cjs',
    capabilities: {
      required: ['collections.transactions', 'imports.providers'],
    },
    permissions: ['server:code', 'data:own', 'data:import-provider'],
    collections: [{ name: 'items', keyed: false }],
  };
  assert.equal(Addons.validateManifest(manifest).ok, true);
  for (const mutate of [
    value => { delete value.server; },
    value => { value.permissions = value.permissions.filter(entry => entry !== 'data:import-provider'); },
    value => { value.capabilities.required = ['imports.providers']; },
    value => { value.collections = []; },
  ]) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    const result = Addons.validateManifest(candidate);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('imports.providers')));
  }
});
