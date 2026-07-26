import assert from 'node:assert/strict';
import test from 'node:test';

import { createCytoscapeGraphAdapter } from '../web/js/addon-graph-cytoscape.js';
import {
  createGraphFacade,
  createGraphImplementationRegistry,
} from '../web/js/addon-graph.js';

class Element {
  constructor(data, group, emitEvent, position = { x: 0, y: 0 }) {
    this.dataValue = data;
    this.group = group;
    this.emitEvent = emitEvent;
    this.selected = false;
    this.positionValue = { ...position };
  }
  id() { return this.dataValue.id; }
  select() { this.selected = true; return this; }
  unselect() { this.selected = false; return this; }
  emit(name) { this.emitEvent(name, this); return this; }
  position() { return { ...this.positionValue }; }
}

class Collection extends Array {
  static get [Symbol.species]() { return Array; }
  filter(callback) { return Collection.from(Array.prototype.filter.call(this, callback)); }
  first() { return Collection.from(this.length ? [this[0]] : []); }
  eq(index) { return Collection.from(this[index] ? [this[index]] : []); }
  select() { this.forEach(element => element.select()); return this; }
  unselect() { this.forEach(element => element.unselect()); return this; }
  emit(name) { this.forEach(element => element.emit(name)); return this; }
  remove() { this.splice(0); return this; }
}

function containerFixture() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    owner: 'addon',
    textContent: 'Loading',
    focused: false,
    getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: name => attributes.delete(name),
    addEventListener(name, handler) {
      const entries = listeners.get(name) || new Set();
      entries.add(handler);
      listeners.set(name, entries);
    },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    focus() { this.focused = true; },
    emit(name, event = {}) { for (const handler of listeners.get(name) || []) handler(event); },
    attributes,
  };
}

function fakeRuntime() {
  const state = {
    configs: [],
    layouts: [],
    destroyed: 0,
    fit: [],
    center: [],
    resize: 0,
    listeners: [],
  };
  const runtime = config => {
    state.configs.push(config);
    const emitEvent = (name, target) => {
      for (const listener of state.listeners) {
        if (listener.name === name && (!listener.selector || target.group === 'nodes')) {
          listener.handler({ target });
        }
      }
    };
    let elements = Collection.from(config.elements.map(
      item => new Element(item.data, item.group, emitEvent, item.position),
    ));
    const cy = {
      elements: () => elements,
      nodes: () => Collection.from(elements.filter(item => item.group === 'nodes')),
      add(items) {
        elements.push(...items.map(item => new Element(item.data, item.group, emitEvent, item.position)));
      },
      batch(callback) { callback(); },
      layout(options) {
        state.layouts.push(options);
        let stopped = false;
        let onStop = null;
        return {
          one(name, handler) { if (name === 'layoutstop') onStop = handler; },
          run() { if (!stopped) onStop?.(); },
          stop() { stopped = true; },
        };
      },
      fit(target, padding) { state.fit.push([target?.map?.(item => item.id()) || [], padding]); },
      center(target) { state.center.push(target?.map?.(item => item.id()) || []); },
      style() { return { fromJson: () => ({ update() {} }) }; },
      resize() { state.resize++; },
      zoom: () => 1.5,
      on(name, selector, handler) {
        if (typeof selector === 'function') state.listeners.push({ name, handler: selector });
        else state.listeners.push({ name, selector, handler });
      },
      off(name, selector, handler) {
        const actualHandler = typeof selector === 'function' ? selector : handler;
        state.listeners = state.listeners.filter(listener => listener.name !== name || listener.handler !== actualHandler);
      },
      $(selector) {
        if (selector === 'node:selected') return Collection.from(
          elements.filter(item => item.group === 'nodes' && item.selected),
        );
        return Collection.from([]);
      },
      destroy() { state.destroyed++; },
    };
    state.cy = cy;
    return cy;
  };
  return { runtime, state };
}

test('private Cytoscape adapter mounts fixed styles, supports facade operations, and fully cleans up', async t => {
  const previous = {
    getComputedStyle: globalThis.getComputedStyle,
    matchMedia: globalThis.matchMedia,
    ResizeObserver: globalThis.ResizeObserver,
    MutationObserver: globalThis.MutationObserver,
    document: globalThis.document,
  };
  const observers = { resize: 0, mutation: 0 };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: name => `token(${name})`,
  });
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { observers.resize++; }
    disconnect() { observers.resize--; }
  };
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { observers.mutation++; }
    disconnect() { observers.mutation--; }
  };
  globalThis.document = { documentElement: {} };
  t.after(() => Object.assign(globalThis, previous));

  const { runtime, state } = fakeRuntime();
  const registry = createGraphImplementationRegistry();
  registry.register(createCytoscapeGraphAdapter(runtime));
  const facade = createGraphFacade({
    addonId: 'addon',
    negotiated: true,
    permitted: true,
    registry,
    ownsContainer: container => container.owner === 'addon',
  });
  const container = containerFixture();
  const hostile = '<img src=x onerror=alert(1)>';
  const handle = await facade.mount(container, {
    nodes: [
      { id: 'one', label: hostile, kind: 'planned', position: { x: 24, y: 48 } },
      { id: 'two', label: 'Two', kind: 'active' },
    ],
    edges: [{ id: 'edge', source: 'one', target: 'two', label: '<script>x</script>' }],
    layout: { name: 'dagre', rankDir: 'LR' },
    accessibleLabel: 'Decision graph',
    fitPadding: 16,
  });

  assert.equal(state.configs.length, 1);
  assert.equal(state.configs[0].elements[0].data.label, hostile);
  assert.deepEqual(state.configs[0].elements[0].position, { x: 24, y: 48 });
  assert.equal(state.configs[0].style.some(rule => typeof rule.selector === 'string' && rule.selector === 'node'), true);
  assert.equal(state.layouts[0].name, 'dagre');
  assert.equal(state.layouts[0].animate, false);
  assert.equal(container.attributes.get('role'), 'region');
  assert.equal(container.attributes.get('aria-label'), 'Decision graph');
  assert.equal(observers.resize, 1);
  assert.equal(observers.mutation, 1);
  assert.equal('cy' in handle, false);
  assert.equal(facade.status().features.includes('node-drag'), true);
  assert.equal(facade.status().layouts.includes('preset'), true);

  handle.select('one');
  const activated = [];
  handle.on('activate', event => activated.push(event));
  let prevented = false;
  container.emit('keydown', {
    key: 'Enter',
    preventDefault() { prevented = true; },
  });
  assert.deepEqual(activated, [{ type: 'activate', nodeId: 'one', selectedIds: ['one'] }]);
  assert.equal(prevented, true);
  const moved = [];
  handle.on('move', event => moved.push(event));
  state.cy.nodes().first()[0].positionValue = { x: 90, y: 110 };
  state.cy.nodes().first().emit('dragfree');
  assert.deepEqual(moved, [{
    type: 'move',
    nodeId: 'one',
    position: { x: 90, y: 110 },
    selectedIds: ['one'],
  }]);
  handle.focus('two', { padding: 12 });
  handle.fit(undefined, { padding: 8 });
  handle.update({
    nodes: [{ id: 'replacement', label: 'Replacement', kind: 'completed' }],
    edges: [],
  }, { layout: 'grid' });
  assert.equal(state.layouts.at(-1).name, 'grid');
  assert.equal(container.focused, true);

  handle.destroy();
  handle.destroy();
  assert.equal(state.destroyed, 1);
  assert.equal(observers.resize, 0);
  assert.equal(observers.mutation, 0);
  assert.equal(container.textContent, '');
  assert.equal(container.attributes.has('role'), false);
});
