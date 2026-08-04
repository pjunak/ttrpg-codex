import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compatibleServiceProviders,
  normalizeServiceBindings,
  normalizeServiceDeclarations,
  resolveServiceBindings,
  serviceBindingKey,
} from '../web/js/addon-services.js';
import { planLoadOrder } from '../web/js/addon-deps.js';

const provider = (id, version = '1.0.0', contract = 'codex.example') => ({
  id,
  version: '1.0.0',
  services: { provides: [{ contract, version }] },
});
const consumer = (id, overrides = {}) => ({
  id,
  version: '1.0.0',
  services: {
    consumes: [{
      contract: 'codex.example',
      range: '^1.0.0',
      cardinality: 'one',
      required: false,
      ...overrides,
    }],
  },
});

test('service declarations normalize to a small deterministic wire shape', () => {
  assert.deepEqual(normalizeServiceDeclarations({
    provides: [{ contract: 'codex.example', version: '1.2.3', ignored: true }],
    consumes: [{ contract: 'codex.other', range: '^2.0.0', cardinality: 'many', required: true }],
  }), {
    provides: [{ contract: 'codex.example', version: '1.2.3' }],
    consumes: [{ contract: 'codex.other', range: '^2.0.0', cardinality: 'many', required: true }],
  });
});

test('one compatible provider is selected and ordered before its consumer', () => {
  const plan = planLoadOrder([consumer('consumer'), provider('provider')]);
  assert.equal(plan.blocked.size, 0);
  assert.deepEqual(plan.order.map(addon => addon.id), ['provider', 'consumer']);
  assert.deepEqual(plan.services.resolved.get(serviceBindingKey('consumer', 'codex.example')), ['provider']);
});

test('cardinality-one never chooses among multiple providers by source order', () => {
  const list = [consumer('consumer'), provider('provider-b'), provider('provider-a')];
  const plan = planLoadOrder(list);
  assert.equal(plan.blocked.size, 0, 'optional ambiguity keeps the consumer usable without a service');
  assert.deepEqual(plan.services.resolved.get('consumer::codex.example'), []);
  assert.match(plan.services.issues[0].reason, /multiple compatible providers/);
  assert.deepEqual(plan.services.issues[0].candidates.map(candidate => candidate.addonId), ['provider-a', 'provider-b']);
});

test('an explicit binding selects one compatible provider', () => {
  const plan = planLoadOrder(
    [consumer('consumer'), provider('provider-a'), provider('provider-b')],
    { serviceBindings: { 'consumer::codex.example': 'provider-b' } },
  );
  assert.equal(plan.blocked.size, 0);
  assert.deepEqual(plan.services.resolved.get('consumer::codex.example'), ['provider-b']);
  const positions = Object.fromEntries(plan.order.map((addon, index) => [addon.id, index]));
  assert.ok(positions['provider-b'] < positions.consumer);
});

test('a stale explicit binding does not silently switch to another provider', () => {
  const plan = planLoadOrder(
    [consumer('consumer'), provider('provider-a')],
    { serviceBindings: { 'consumer::codex.example': 'missing-provider' } },
  );
  assert.deepEqual(plan.services.resolved.get('consumer::codex.example'), []);
  assert.match(plan.services.issues[0].reason, /configured provider/);
});

test('missing or ambiguous required service blocks the consumer only', () => {
  const missing = planLoadOrder([consumer('consumer', { required: true })]);
  assert.match(missing.blocked.get('consumer'), /required service/);

  const ambiguous = planLoadOrder([
    consumer('consumer', { required: true }),
    provider('provider-a'),
    provider('provider-b'),
  ]);
  assert.match(ambiguous.blocked.get('consumer'), /choose one/);
  assert.deepEqual(ambiguous.order.map(addon => addon.id).sort(), ['provider-a', 'provider-b']);
});

test('cardinality-many resolves every compatible provider in stable id order', () => {
  const servicePlan = resolveServiceBindings([
    consumer('consumer', { cardinality: 'many' }),
    provider('provider-b'),
    provider('old-provider', '0.9.0'),
    provider('provider-a'),
  ]);
  assert.deepEqual(servicePlan.resolved.get('consumer::codex.example'), ['provider-a', 'provider-b']);
});

test('an addon may publish and consume its own cardinality-many service without a graph self-cycle', () => {
  const plan = planLoadOrder([{
    id: 'owner-ui',
    version: '1.0.0',
    services: {
      provides: [{ contract: 'codex.adapters', version: '1.0.0' }],
      consumes: [{ contract: 'codex.adapters', range: '^1.0.0', cardinality: 'many', required: false }],
    },
  }]);
  assert.equal(plan.blocked.size, 0);
  assert.deepEqual(plan.order.map(addon => addon.id), ['owner-ui']);
  assert.deepEqual(plan.services.resolved.get('owner-ui::codex.adapters'), ['owner-ui']);
});

test('cardinality-one candidate discovery includes the consumer\'s own provider', () => {
  const owner = {
    ...consumer('owner'),
    services: {
      provides: [{ contract: 'codex.example', version: '1.0.0' }],
      consumes: [{ contract: 'codex.example', range: '^1.0.0', cardinality: 'one', required: false }],
    },
  };
  assert.deepEqual(
    compatibleServiceProviders([owner, provider('external')], 'codex.example', '^1.0.0')
      .map(candidate => candidate.addon.id),
    ['external', 'owner'],
  );
});

test('required service cycles are blocked; optional cycles are ordering-only', () => {
  const addon = (id, provides, consumes, required) => ({
    id,
    version: '1.0.0',
    services: {
      provides: [{ contract: provides, version: '1.0.0' }],
      consumes: [{ contract: consumes, range: '^1.0.0', cardinality: 'one', required }],
    },
  });
  const required = planLoadOrder([
    addon('a', 'codex.a', 'codex.b', true),
    addon('b', 'codex.b', 'codex.a', true),
  ]);
  assert.deepEqual(required.cycles.sort(), ['a', 'b']);
  assert.equal(required.order.length, 0);

  const optional = planLoadOrder([
    addon('a', 'codex.a', 'codex.b', false),
    addon('b', 'codex.b', 'codex.a', false),
  ]);
  assert.equal(optional.blocked.size, 0);
  assert.equal(optional.order.length, 2);
});

test('registry service bindings discard malformed keys and provider ids', () => {
  assert.deepEqual(normalizeServiceBindings({
    'consumer::codex.example': 'provider',
    nope: 'provider',
    'consumer::codex.other': '../bad',
  }), { 'consumer::codex.example': 'provider' });
});
