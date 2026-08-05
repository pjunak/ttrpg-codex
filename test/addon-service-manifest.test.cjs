'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultRegistry,
  exclusiveServiceConflicts,
  installedOptionalMetadata,
  normalizeRegistry,
  normalizeServiceBindings,
  normalizeServices,
  validateManifest,
} = require('../server/addons.cjs');

const manifest = overrides => ({
  id: 'service-addon',
  name: 'Service Addon',
  version: '1.0.0',
  apiVersion: 2,
  hostVersion: '>=1.1.0',
  entry: 'entry.js',
  services: {
    provides: [{ contract: 'codex.example', version: '1.0.0' }],
    consumes: [{ contract: 'codex.other', range: '^2.0.0', cardinality: 'many', required: false }],
  },
  ...overrides,
});

test('service manifest accepts versioned providers and explicit consumers', () => {
  assert.deepEqual(validateManifest(manifest()), { ok: true, errors: [] });
});

test('exclusive service providers require explicit host capability negotiation', () => {
  const services = {
    provides: [{ contract: 'codex.rules', version: '2.0.0', exclusive: true }],
  };
  assert.deepEqual(validateManifest(manifest({
    capabilities: { required: ['services.exclusive-providers'] },
    services,
  })), { ok: true, errors: [] });
  assert.equal(validateManifest(manifest({ services })).ok, false);
  assert.equal(validateManifest(manifest({
    capabilities: { required: ['services.exclusive-providers'] },
    services: { provides: [{ contract: 'codex.rules', version: '2.0.0', exclusive: 'yes' }] },
  })).ok, false);
});

test('exclusive service conflicts are symmetric, deterministic, and ignore same-id updates', () => {
  const exclusive = {
    id: 'new-rules',
    services: { provides: [{ contract: 'codex.rules', version: '2.0.0', exclusive: true }] },
  };
  const ordinary = {
    id: 'old-rules', name: 'Old Rules',
    services: { provides: [{ contract: 'codex.rules', version: '1.0.0' }] },
  };
  assert.deepEqual(exclusiveServiceConflicts(exclusive, [ordinary]), [{
    contract: 'codex.rules', addonId: 'old-rules', addonName: 'Old Rules',
  }]);
  assert.deepEqual(exclusiveServiceConflicts(ordinary, [exclusive]), [{
    contract: 'codex.rules', addonId: 'new-rules', addonName: 'new-rules',
  }]);
  assert.deepEqual(exclusiveServiceConflicts(exclusive, [{ ...ordinary, id: 'new-rules' }]), []);
});

test('service manifest is API-v2 only and rejects ambiguous declarations', () => {
  assert.equal(validateManifest(manifest({ apiVersion: 1 })).ok, false);
  for (const services of [
    [],
    { provides: [{ contract: 'not-namespaced', version: '1.0.0' }] },
    { provides: [{ contract: 'codex.example', version: 'latest' }] },
    { consumes: [{ contract: 'codex.example', range: '^1.0.0', cardinality: 'some', required: false }] },
    { consumes: [{ contract: 'codex.example', range: '^1.0.0', cardinality: 'one' }] },
    { consumes: [{ contract: 'codex.example', range: 'anything', cardinality: 'one', required: false }] },
    { provides: [
      { contract: 'codex.example', version: '1.0.0' },
      { contract: 'codex.example', version: '2.0.0' },
    ] },
  ]) {
    assert.equal(validateManifest(manifest({ services })).ok, false, JSON.stringify(services));
  }
});

test('service declarations persist in installed metadata and normalize on restore', () => {
  const services = manifest().services;
  assert.deepEqual(installedOptionalMetadata(manifest()).services, services);
  assert.deepEqual(normalizeServices({
    provides: [...services.provides, { contract: 'bad', version: '1.0.0' }],
    consumes: services.consumes,
  }), services);

  const registry = normalizeRegistry({
    addons: [{ id: 'service-addon', apiVersion: 2, services }],
    serviceBindings: {
      'service-addon::codex.other': 'provider-addon',
      malformed: 'provider-addon',
    },
  });
  assert.deepEqual(registry.addons[0].services, services);
  assert.deepEqual(registry.serviceBindings, { 'service-addon::codex.other': 'provider-addon' });
});

test('empty and malformed registries always expose a safe service binding map', () => {
  assert.deepEqual(defaultRegistry().serviceBindings, {});
  assert.deepEqual(normalizeRegistry(null).serviceBindings, {});
  assert.deepEqual(normalizeServiceBindings({
    'consumer::codex.example': 'provider',
    'consumer::codex.bad': '__proto__',
  }), { 'consumer::codex.example': 'provider' });
});
