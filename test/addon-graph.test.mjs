import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_FACADE_VERSION,
  GRAPH_LIMITS,
  createGraphFacade,
  createGraphImplementationRegistry,
  validateGraphData,
} from '../web/js/addon-graph.js';
import {
  createMockHost,
  disposeMockHost,
} from '../web/js/addon-test-harness.mjs';

const require = createRequire(import.meta.url);
const { validateManifest } = require('../server/addons.cjs');

function graphData(label = 'Alpha') {
  return {
    nodes: [
      { id: 'alpha', label, kind: 'planned' },
      { id: 'beta', label: 'Beta', kind: 'active' },
    ],
    edges: [
      { id: 'alpha-beta', source: 'alpha', target: 'beta', label: 'then' },
    ],
  };
}

function adapter(id = 'fake', overrides = {}) {
  const instances = [];
  return {
    instances,
    descriptor: {
      id,
      minFacadeVersion: 1,
      maxFacadeVersion: 1,
      features: ['data', 'selection', 'viewport', 'events', 'lifecycle'],
      layouts: ['grid', 'dagre'],
      async create(spec) {
        const listeners = new Map();
        const instance = {
          ...spec,
          destroyed: 0,
          calls: [],
          emit(event, payload) {
            for (const listener of listeners.get(event) || []) listener(payload);
          },
        };
        instances.push(instance);
        return {
          update(data, layout) {
            instance.calls.push(['update', data, layout]);
            if (overrides.failUpdate) throw new Error('adapter update failed');
          },
          select(ids) { instance.calls.push(['select', ids]); },
          focus(ids, padding) { instance.calls.push(['focus', ids, padding]); },
          fit(ids, padding) { instance.calls.push(['fit', ids, padding]); },
          on(event, handler) {
            const entries = listeners.get(event) || new Set();
            entries.add(handler);
            listeners.set(event, entries);
            return () => entries.delete(handler);
          },
          destroy() {
            instance.destroyed++;
            listeners.clear();
          },
        };
      },
      ...overrides.descriptor,
    },
  };
}

function facadeFor(registry, addonId = 'alpha') {
  return createGraphFacade({
    addonId,
    negotiated: true,
    permitted: true,
    registry,
    ownsContainer: container => container?.owner === addonId,
  });
}

function manifest(overrides = {}) {
  return {
    id: 'graph-addon',
    name: 'Graph addon',
    version: '1.0.0',
    apiVersion: 2,
    hostVersion: '>=1.0.0',
    entry: 'entry.js',
    capabilities: { required: ['lifecycle.dispose', 'graphs.facade'] },
    permissions: ['ui:graph'],
    ...overrides,
  };
}

test('graphs.facade capability requires API v2, lifecycle, and ui:graph permission', () => {
  assert.equal(validateManifest(manifest()).ok, true);
  assert.match(
    validateManifest(manifest({ permissions: [] })).errors.join('; '),
    /graphs\.facade.*ui:graph/,
  );
  assert.match(
    validateManifest(manifest({
      capabilities: { required: ['graphs.facade'] },
    })).errors.join('; '),
    /graphs\.facade.*lifecycle\.dispose/,
  );
  assert.match(
    validateManifest(manifest({ apiVersion: 1, hostVersion: '*' })).errors.join('; '),
    /graphs\.facade.*apiVersion 2/,
  );
});

test('global registry rejects duplicate and incompatible implementations and selects by facade compatibility', () => {
  const registry = createGraphImplementationRegistry();
  const first = adapter('first');
  registry.register(first.descriptor);
  assert.throws(() => registry.register(first.descriptor), error => error.code === 'GRAPH_DUPLICATE_IMPLEMENTATION');
  assert.throws(
    () => registry.register(adapter('future', {
      descriptor: { minFacadeVersion: 2, maxFacadeVersion: 2 },
    }).descriptor),
    error => error.code === 'GRAPH_INCOMPATIBLE_IMPLEMENTATION',
  );
  assert.equal(registry.select({ version: 1, layout: 'dagre' }).id, 'first');
  assert.equal(registry.select({ version: 2 }), null);
  assert.equal(GRAPH_FACADE_VERSION, 1);
  assert.equal('implementationVersion' in registry.describe()[0], false);
});

test('facade mounts, updates, selects, focuses, fits, emits safe events, and destroys idempotently', async () => {
  const registry = createGraphImplementationRegistry();
  const fake = adapter();
  registry.register(fake.descriptor);
  const facade = facadeFor(registry);
  const container = { owner: 'alpha' };
  const handle = await facade.mount(container, {
    ...graphData(),
    layout: { name: 'dagre', rankDir: 'LR' },
    accessibleLabel: 'Scenario graph',
    fitPadding: 24,
  });
  assert.deepEqual(Object.keys(handle).sort(), ['destroy', 'fit', 'focus', 'on', 'select', 'update']);
  assert.equal(fake.instances[0].accessibleLabel, 'Scenario graph');
  handle.update(graphData('Updated'), { layout: 'grid' });
  handle.select('alpha');
  handle.focus(['beta'], { padding: 12 });
  handle.fit(undefined, { padding: 8 });
  const events = [];
  const unsubscribe = handle.on('select', event => events.push(event));
  fake.instances[0].emit('select', { nodeId: 'alpha', raw: undefined });
  assert.deepEqual(events[0], { nodeId: 'alpha', type: 'select' });
  unsubscribe();
  fake.instances[0].emit('select', { nodeId: 'beta' });
  assert.equal(events.length, 1);
  handle.destroy();
  handle.destroy();
  assert.equal(fake.instances[0].destroyed, 1);
  assert.throws(() => handle.fit(), error => error.code === 'GRAPH_DISPOSED');
});

test('graph validation rejects invalid nodes, duplicate ids, dangling edges, hostile structure, and limits', () => {
  assert.throws(
    () => validateGraphData({ nodes: [{ id: '<bad>', label: 'x' }], edges: [] }),
    error => error.code === 'GRAPH_INVALID_DATA',
  );
  assert.throws(
    () => validateGraphData({
      nodes: [{ id: 'same', label: 'One' }, { id: 'same', label: 'Two' }],
      edges: [],
    }),
    error => error.code === 'GRAPH_DUPLICATE_ID',
  );
  assert.throws(
    () => validateGraphData({
      nodes: [{ id: 'one', label: 'One' }],
      edges: [{ id: 'missing', source: 'one', target: 'two' }],
    }),
    error => error.code === 'GRAPH_DANGLING_EDGE',
  );
  assert.throws(
    () => validateGraphData({
      nodes: [{ id: 'one', label: '<img onerror=alert(1)>', html: '<b>x</b>' }],
      edges: [],
    }),
    error => error.code === 'GRAPH_INVALID_CONFIG',
  );
  assert.throws(
    () => validateGraphData({
      nodes: Array.from({ length: GRAPH_LIMITS.maxNodes + 1 }, (_, index) => ({
        id: `node-${index}`,
        label: '',
      })),
      edges: [],
    }),
    error => error.code === 'GRAPH_LIMIT_EXCEEDED',
  );
});

test('owned-container and unsupported layout enforcement fail before adapter access', async () => {
  const registry = createGraphImplementationRegistry();
  const fake = adapter();
  registry.register(fake.descriptor);
  const facade = facadeFor(registry);
  await assert.rejects(
    facade.mount({ owner: 'other' }, { ...graphData(), layout: 'grid' }),
    error => error.code === 'GRAPH_CONTAINER_NOT_OWNED',
  );
  await assert.rejects(
    facade.mount({ owner: 'alpha' }, { ...graphData(), layout: 'circle' }),
    error => error.code === 'GRAPH_UNSUPPORTED_LAYOUT',
  );
  assert.equal(fake.instances.length, 0);
});

test('two addons share one registry without sharing graph state or disposal', async () => {
  const registry = createGraphImplementationRegistry();
  const fake = adapter();
  registry.register(fake.descriptor);
  const first = facadeFor(registry, 'first');
  const second = facadeFor(registry, 'second');
  const firstHandle = await first.mount({ owner: 'first' }, { ...graphData(), layout: 'grid' });
  await second.mount({ owner: 'second' }, { ...graphData('Second'), layout: 'grid' });
  firstHandle.destroy();
  assert.equal(fake.instances[0].destroyed, 1);
  assert.equal(fake.instances[1].destroyed, 0);
  second.dispose();
  assert.equal(fake.instances[1].destroyed, 1);
});

test('adapter failure destroys only the affected graph', async () => {
  const registry = createGraphImplementationRegistry();
  const fake = adapter('failing', { failUpdate: true });
  registry.register(fake.descriptor);
  const first = facadeFor(registry, 'first');
  const second = facadeFor(registry, 'second');
  const broken = await first.mount({ owner: 'first' }, { ...graphData(), layout: 'grid' });
  const healthy = await second.mount({ owner: 'second' }, { ...graphData(), layout: 'grid' });
  assert.throws(() => broken.update(graphData('Boom')), error => error.code === 'GRAPH_ADAPTER_FAILED');
  assert.equal(fake.instances[0].destroyed, 1);
  assert.equal(fake.instances[1].destroyed, 0);
  healthy.fit();
});

test('disposal during asynchronous mount prevents stale work from reviving a graph', async () => {
  let resolveMount;
  let destroyed = 0;
  const registry = createGraphImplementationRegistry();
  registry.register({
    id: 'delayed',
    minFacadeVersion: 1,
    maxFacadeVersion: 1,
    features: ['data', 'selection', 'viewport', 'events', 'lifecycle'],
    layouts: ['grid'],
    create: () => new Promise(resolve => {
      resolveMount = () => resolve({
        update() {}, select() {}, focus() {}, fit() {}, on() { return () => {}; },
        destroy() { destroyed++; },
      });
    }),
  });
  const facade = facadeFor(registry);
  const pending = facade.mount({ owner: 'alpha' }, { ...graphData(), layout: 'grid' });
  facade.disposeMounted();
  resolveMount();
  await assert.rejects(pending, error => error.code === 'GRAPH_DISPOSED');
  assert.equal(destroyed, 1);
});

test('repeated mount in one container replaces the old graph without listeners or instances leaking', async () => {
  const registry = createGraphImplementationRegistry();
  const fake = adapter();
  registry.register(fake.descriptor);
  const facade = facadeFor(registry);
  const container = { owner: 'alpha' };
  const first = await facade.mount(container, { ...graphData(), layout: 'grid' });
  first.on('select', () => {});
  await facade.mount(container, { ...graphData('Replacement'), layout: 'grid' });
  assert.equal(fake.instances[0].destroyed, 1);
  assert.equal(fake.instances[1].destroyed, 0);
  facade.disposeMounted();
  assert.equal(fake.instances[1].destroyed, 1);
});

test('authoring harness matches facade negotiation, fake behavior, ownership, and disposal', async () => {
  const meta = manifest();
  const { host, rec } = createMockHost(meta, { isDM: true });
  assert.equal(host.graphs.apiVersion, GRAPH_FACADE_VERSION);
  assert.equal(host.graphs.available(), true);
  const handle = await host.graphs.mount(
    { addonId: 'graph-addon' },
    { ...graphData(), layout: 'grid' },
  );
  handle.select('alpha');
  assert.deepEqual(rec.graphInstances[0].selected, ['alpha']);
  assert.equal('implementation' in host.graphs, false);
  await disposeMockHost(rec);
  assert.equal(rec.graphInstances[0].destroyed, true);

  const unavailable = createMockHost(meta, { isDM: true, graphUnavailable: true });
  assert.equal(unavailable.host.graphs.available(), false);
  await assert.rejects(
    unavailable.host.graphs.mount(
      { addonId: 'graph-addon' },
      { ...graphData(), layout: 'grid' },
    ),
    error => error.code === 'GRAPH_UNAVAILABLE',
  );
});
