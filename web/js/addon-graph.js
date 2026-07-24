export const GRAPH_FACADE_VERSION = 1;

export const GRAPH_LIMITS = Object.freeze({
  maxNodes: 1000,
  maxEdges: 4000,
  maxIdLength: 128,
  maxLabelLength: 500,
  maxAccessibleLabelLength: 200,
  maxPadding: 200,
});

const REQUIRED_FEATURES = Object.freeze([
  'data',
  'selection',
  'viewport',
  'events',
  'lifecycle',
]);
const EVENTS = new Set(['select', 'unselect', 'activate', 'viewport', 'focus']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const TOKEN_RE = /^[a-z][a-z0-9.-]{1,63}$/;

function graphError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, allowed, what) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw graphError('GRAPH_INVALID_CONFIG', `${what} has unsupported field "${key}"`);
    }
  }
}

function boundedText(value, name, max, { required = false } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') {
    throw graphError('GRAPH_INVALID_DATA', `${name} must be a string`);
  }
  if ((required && !value) || value.length > max) {
    throw graphError('GRAPH_INVALID_DATA', `${name} must contain ${required ? '1' : '0'} to ${max} characters`);
  }
  return value;
}

function normalizedIds(value, knownIds, what) {
  const raw = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(raw)) throw graphError('GRAPH_INVALID_DATA', `${what} must be an id or an array of ids`);
  const ids = [];
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== 'string' || !ID_RE.test(id) || !knownIds.has(id)) {
      throw graphError('GRAPH_INVALID_DATA', `${what} contains an unknown or invalid node id`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function normalizedPadding(value) {
  if (value === undefined) return 40;
  if (!Number.isFinite(value) || value < 0 || value > GRAPH_LIMITS.maxPadding) {
    throw graphError('GRAPH_INVALID_CONFIG', `padding must be between 0 and ${GRAPH_LIMITS.maxPadding}`);
  }
  return value;
}

function publicEvent(event, payload) {
  const source = isPlainObject(payload) ? payload : {};
  const result = { type: event };
  if (event === 'select' || event === 'unselect' || event === 'activate') {
    if (typeof source.nodeId === 'string' && ID_RE.test(source.nodeId)) result.nodeId = source.nodeId;
  }
  if (event !== 'viewport' && Array.isArray(source.selectedIds)) {
    result.selectedIds = source.selectedIds
      .filter(id => typeof id === 'string' && ID_RE.test(id))
      .slice(0, GRAPH_LIMITS.maxNodes);
  }
  if (event === 'viewport' && Number.isFinite(source.zoom)) result.zoom = source.zoom;
  return Object.freeze(result);
}

export function validateGraphData(value) {
  if (!isPlainObject(value)) {
    throw graphError('GRAPH_INVALID_DATA', 'graph data must be an object { nodes, edges }');
  }
  exactFields(value, new Set(['nodes', 'edges']), 'graph data');
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw graphError('GRAPH_INVALID_DATA', 'graph data nodes and edges must be arrays');
  }
  if (value.nodes.length > GRAPH_LIMITS.maxNodes) {
    throw graphError('GRAPH_LIMIT_EXCEEDED', `graph may contain at most ${GRAPH_LIMITS.maxNodes} nodes`);
  }
  if (value.edges.length > GRAPH_LIMITS.maxEdges) {
    throw graphError('GRAPH_LIMIT_EXCEEDED', `graph may contain at most ${GRAPH_LIMITS.maxEdges} edges`);
  }

  const allIds = new Set();
  const nodeIds = new Set();
  const nodes = value.nodes.map((node, index) => {
    if (!isPlainObject(node)) throw graphError('GRAPH_INVALID_DATA', `node ${index} must be an object`);
    exactFields(node, new Set(['id', 'label', 'kind']), `node ${index}`);
    const id = boundedText(node.id, `node ${index} id`, GRAPH_LIMITS.maxIdLength, { required: true });
    if (!ID_RE.test(id)) throw graphError('GRAPH_INVALID_DATA', `node ${index} id has an unsupported shape`);
    if (allIds.has(id)) throw graphError('GRAPH_DUPLICATE_ID', `duplicate graph id "${id}"`);
    const label = boundedText(node.label, `node ${index} label`, GRAPH_LIMITS.maxLabelLength);
    const kind = node.kind === undefined ? '' : boundedText(node.kind, `node ${index} kind`, 64);
    if (kind && !KIND_RE.test(kind)) throw graphError('GRAPH_INVALID_DATA', `node ${index} kind has an unsupported shape`);
    allIds.add(id);
    nodeIds.add(id);
    return Object.freeze({ id, label, kind });
  });

  const edges = value.edges.map((edge, index) => {
    if (!isPlainObject(edge)) throw graphError('GRAPH_INVALID_DATA', `edge ${index} must be an object`);
    exactFields(edge, new Set(['id', 'source', 'target', 'label']), `edge ${index}`);
    const id = boundedText(edge.id, `edge ${index} id`, GRAPH_LIMITS.maxIdLength, { required: true });
    const source = boundedText(edge.source, `edge ${index} source`, GRAPH_LIMITS.maxIdLength, { required: true });
    const target = boundedText(edge.target, `edge ${index} target`, GRAPH_LIMITS.maxIdLength, { required: true });
    if (!ID_RE.test(id) || !ID_RE.test(source) || !ID_RE.test(target)) {
      throw graphError('GRAPH_INVALID_DATA', `edge ${index} contains an unsupported id`);
    }
    if (allIds.has(id)) throw graphError('GRAPH_DUPLICATE_ID', `duplicate graph id "${id}"`);
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      throw graphError('GRAPH_DANGLING_EDGE', `edge "${id}" references a missing node`);
    }
    const label = boundedText(edge.label, `edge ${index} label`, GRAPH_LIMITS.maxLabelLength);
    allIds.add(id);
    return Object.freeze({ id, source, target, label });
  });

  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    nodeIds,
  });
}

const LAYOUT_FIELDS = Object.freeze({
  grid: new Set(['name', 'rows', 'cols']),
  circle: new Set(['name', 'clockwise']),
  concentric: new Set(['name', 'minNodeSpacing']),
  breadthfirst: new Set(['name', 'directed', 'circle']),
  dagre: new Set(['name', 'rankDir', 'rankSep', 'nodeSep', 'edgeSep']),
});

function boundedLayoutNumber(value, name, min, max, integer = false) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw graphError('GRAPH_INVALID_CONFIG', `${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function validateGraphLayout(value, supportedLayouts) {
  const source = typeof value === 'string' ? { name: value } : value;
  if (!isPlainObject(source) || typeof source.name !== 'string' || !LAYOUT_FIELDS[source.name]) {
    throw graphError('GRAPH_UNSUPPORTED_LAYOUT', 'layout name is unsupported');
  }
  if (!supportedLayouts.includes(source.name)) {
    throw graphError('GRAPH_UNSUPPORTED_LAYOUT', `layout "${source.name}" is unavailable`);
  }
  exactFields(source, LAYOUT_FIELDS[source.name], `layout "${source.name}"`);
  const layout = { name: source.name };
  if (source.name === 'grid') {
    const rows = boundedLayoutNumber(source.rows, 'layout.rows', 1, GRAPH_LIMITS.maxNodes, true);
    const cols = boundedLayoutNumber(source.cols, 'layout.cols', 1, GRAPH_LIMITS.maxNodes, true);
    if (rows !== undefined) layout.rows = rows;
    if (cols !== undefined) layout.cols = cols;
  } else if (source.name === 'circle') {
    if (source.clockwise !== undefined && typeof source.clockwise !== 'boolean') {
      throw graphError('GRAPH_INVALID_CONFIG', 'layout.clockwise must be a boolean');
    }
    if (source.clockwise !== undefined) layout.clockwise = source.clockwise;
  } else if (source.name === 'concentric') {
    const spacing = boundedLayoutNumber(source.minNodeSpacing, 'layout.minNodeSpacing', 0, 500);
    if (spacing !== undefined) layout.minNodeSpacing = spacing;
  } else if (source.name === 'breadthfirst') {
    for (const key of ['directed', 'circle']) {
      if (source[key] !== undefined && typeof source[key] !== 'boolean') {
        throw graphError('GRAPH_INVALID_CONFIG', `layout.${key} must be a boolean`);
      }
      if (source[key] !== undefined) layout[key] = source[key];
    }
  } else if (source.name === 'dagre') {
    if (source.rankDir !== undefined && !['TB', 'BT', 'LR', 'RL'].includes(source.rankDir)) {
      throw graphError('GRAPH_INVALID_CONFIG', 'layout.rankDir must be TB, BT, LR, or RL');
    }
    if (source.rankDir !== undefined) layout.rankDir = source.rankDir;
    for (const key of ['rankSep', 'nodeSep', 'edgeSep']) {
      const number = boundedLayoutNumber(source[key], `layout.${key}`, 0, 500);
      if (number !== undefined) layout[key] = number;
    }
  }
  return Object.freeze(layout);
}

function validateMountSpec(value, supportedLayouts) {
  if (!isPlainObject(value)) throw graphError('GRAPH_INVALID_CONFIG', 'mount options must be an object');
  exactFields(value, new Set(['nodes', 'edges', 'layout', 'accessibleLabel', 'fitPadding']), 'mount options');
  const graph = validateGraphData({ nodes: value.nodes, edges: value.edges });
  const layout = validateGraphLayout(value.layout || 'grid', supportedLayouts);
  const accessibleLabel = boundedText(
    value.accessibleLabel,
    'accessibleLabel',
    GRAPH_LIMITS.maxAccessibleLabelLength,
  );
  const fitPadding = normalizedPadding(value.fitPadding);
  return Object.freeze({ graph, layout, accessibleLabel, fitPadding });
}

export function createGraphImplementationRegistry() {
  const implementations = new Map();

  function register(adapter) {
    if (!isPlainObject(adapter)) throw graphError('GRAPH_INVALID_IMPLEMENTATION', 'graph adapter must be an object');
    exactFields(adapter, new Set([
      'id', 'minFacadeVersion', 'maxFacadeVersion', 'features', 'layouts', 'create',
    ]), 'graph adapter');
    if (typeof adapter.id !== 'string' || !TOKEN_RE.test(adapter.id)) {
      throw graphError('GRAPH_INVALID_IMPLEMENTATION', 'graph adapter id is invalid');
    }
    if (implementations.has(adapter.id)) {
      throw graphError('GRAPH_DUPLICATE_IMPLEMENTATION', `graph adapter "${adapter.id}" is already registered`);
    }
    if (!Number.isInteger(adapter.minFacadeVersion) || !Number.isInteger(adapter.maxFacadeVersion)
        || adapter.minFacadeVersion < 1 || adapter.maxFacadeVersion < adapter.minFacadeVersion) {
      throw graphError('GRAPH_INVALID_IMPLEMENTATION', 'graph adapter facade-version range is invalid');
    }
    if (GRAPH_FACADE_VERSION < adapter.minFacadeVersion || GRAPH_FACADE_VERSION > adapter.maxFacadeVersion) {
      throw graphError('GRAPH_INCOMPATIBLE_IMPLEMENTATION', `graph adapter "${adapter.id}" does not support facade version ${GRAPH_FACADE_VERSION}`);
    }
    if (!Array.isArray(adapter.features) || !adapter.features.length
        || adapter.features.some(feature => typeof feature !== 'string' || !TOKEN_RE.test(feature))) {
      throw graphError('GRAPH_INVALID_IMPLEMENTATION', 'graph adapter features are invalid');
    }
    if (!Array.isArray(adapter.layouts) || !adapter.layouts.length
        || adapter.layouts.some(layout => typeof layout !== 'string' || !LAYOUT_FIELDS[layout])) {
      throw graphError('GRAPH_INVALID_IMPLEMENTATION', 'graph adapter layouts are invalid');
    }
    if (typeof adapter.create !== 'function') {
      throw graphError('GRAPH_INVALID_IMPLEMENTATION', 'graph adapter create must be a function');
    }
    const features = Object.freeze([...new Set(adapter.features)]);
    const layouts = Object.freeze([...new Set(adapter.layouts)]);
    const normalized = Object.freeze({
      id: adapter.id,
      minFacadeVersion: adapter.minFacadeVersion,
      maxFacadeVersion: adapter.maxFacadeVersion,
      features,
      layouts,
      create: adapter.create,
    });
    implementations.set(normalized.id, normalized);
    return normalized;
  }

  function select({ version = GRAPH_FACADE_VERSION, features = REQUIRED_FEATURES, layout } = {}) {
    for (const adapter of implementations.values()) {
      if (version < adapter.minFacadeVersion || version > adapter.maxFacadeVersion) continue;
      if (features.some(feature => !adapter.features.includes(feature))) continue;
      if (layout && !adapter.layouts.includes(layout)) continue;
      return adapter;
    }
    return null;
  }

  function describe() {
    return Object.freeze([...implementations.values()].map(adapter => Object.freeze({
      id: adapter.id,
      minFacadeVersion: adapter.minFacadeVersion,
      maxFacadeVersion: adapter.maxFacadeVersion,
      features: adapter.features,
      layouts: adapter.layouts,
    })));
  }

  return Object.freeze({ register, select, describe });
}

export const graphImplementationRegistry = createGraphImplementationRegistry();

export function createGraphFacade({
  addonId,
  negotiated,
  permitted,
  registry = graphImplementationRegistry,
  ownsContainer,
}) {
  let disposed = false;
  let epoch = 0;
  const records = new Set();
  const byContainer = new Map();

  function requireAccess() {
    if (!negotiated) throw graphError('GRAPH_CAPABILITY_REQUIRED', 'Addon did not negotiate graphs.facade');
    if (!permitted) throw graphError('GRAPH_PERMISSION_REQUIRED', 'Addon does not have permission ui:graph');
    if (disposed) throw graphError('GRAPH_DISPOSED', 'Graph facade is disposed');
  }

  function implementationFor(layout) {
    const adapter = registry.select({ layout });
    if (adapter) return adapter;
    if (!registry.select()) throw graphError('GRAPH_UNAVAILABLE', 'No compatible graph implementation is available');
    throw graphError('GRAPH_UNSUPPORTED_LAYOUT', `layout "${layout}" is unavailable`);
  }

  function failAdapter(record, operation, error) {
    destroyRecord(record);
    throw graphError('GRAPH_ADAPTER_FAILED', `Graph adapter failed during ${operation}`, error);
  }

  function destroyRecord(record) {
    if (!record || record.destroyed) return;
    record.destroyed = true;
    for (const unsubscribe of [...record.unsubscribers].reverse()) {
      try { unsubscribe(); } catch {}
    }
    record.unsubscribers.clear();
    try { record.implementation?.destroy(); } catch {}
    records.delete(record);
    if (byContainer.get(record.container) === record) byContainer.delete(record.container);
  }

  function publicHandle(record) {
    const call = (operation, fn) => {
      if (record.destroyed || disposed) throw graphError('GRAPH_DISPOSED', 'Graph handle is disposed');
      try { return fn(); } catch (error) { return failAdapter(record, operation, error); }
    };
    return Object.freeze({
      update(data, options = {}) {
        return call('update', () => {
          if (!isPlainObject(options)) throw graphError('GRAPH_INVALID_CONFIG', 'update options must be an object');
          exactFields(options, new Set(['layout']), 'update options');
          const graph = validateGraphData(data);
          const layout = options.layout === undefined
            ? record.layout
            : validateGraphLayout(options.layout, record.adapter.layouts);
          record.implementation.update(graph, layout);
          record.graph = graph;
          record.layout = layout;
        });
      },
      select(ids) {
        return call('select', () => record.implementation.select(
          normalizedIds(ids, record.graph.nodeIds, 'select'),
        ));
      },
      focus(ids, options = {}) {
        return call('focus', () => {
          if (!isPlainObject(options)) throw graphError('GRAPH_INVALID_CONFIG', 'focus options must be an object');
          exactFields(options, new Set(['padding']), 'focus options');
          record.implementation.focus(
            normalizedIds(ids, record.graph.nodeIds, 'focus'),
            normalizedPadding(options.padding),
          );
        });
      },
      fit(ids, options = {}) {
        return call('fit', () => {
          if (!isPlainObject(options)) throw graphError('GRAPH_INVALID_CONFIG', 'fit options must be an object');
          exactFields(options, new Set(['padding']), 'fit options');
          const normalized = ids === undefined || ids === null
            ? []
            : normalizedIds(ids, record.graph.nodeIds, 'fit');
          record.implementation.fit(normalized, normalizedPadding(options.padding));
        });
      },
      on(event, handler) {
        return call('subscribe', () => {
          if (!EVENTS.has(event)) throw graphError('GRAPH_UNSUPPORTED_EVENT', `event "${event}" is unsupported`);
          if (typeof handler !== 'function') throw graphError('GRAPH_INVALID_CONFIG', 'event handler must be a function');
          const unsubscribe = record.implementation.on(event, payload => {
            if (!record.destroyed && !disposed) handler(publicEvent(event, payload));
          });
          if (typeof unsubscribe !== 'function') {
            throw graphError('GRAPH_ADAPTER_FAILED', 'Graph adapter did not return an unsubscribe function');
          }
          let active = true;
          const scoped = () => {
            if (!active) return;
            active = false;
            record.unsubscribers.delete(scoped);
            unsubscribe();
          };
          record.unsubscribers.add(scoped);
          return scoped;
        });
      },
      destroy() {
        destroyRecord(record);
      },
    });
  }

  async function mount(container, options) {
    requireAccess();
    if (typeof ownsContainer !== 'function' || !ownsContainer(container, addonId)) {
      throw graphError('GRAPH_CONTAINER_NOT_OWNED', 'Graph container is outside the addon-owned page subtree');
    }
    const basicAdapter = registry.select();
    if (!basicAdapter) throw graphError('GRAPH_UNAVAILABLE', 'No compatible graph implementation is available');
    const supportedLayouts = [...new Set(registry.describe()
      .filter(adapter => GRAPH_FACADE_VERSION >= adapter.minFacadeVersion
        && GRAPH_FACADE_VERSION <= adapter.maxFacadeVersion
        && REQUIRED_FEATURES.every(feature => adapter.features.includes(feature)))
      .flatMap(adapter => adapter.layouts))];
    const spec = validateMountSpec(options, supportedLayouts);
    const adapter = implementationFor(spec.layout.name);
    destroyRecord(byContainer.get(container));
    const record = {
      adapter,
      container,
      destroyed: false,
      epoch,
      graph: spec.graph,
      layout: spec.layout,
      implementation: null,
      unsubscribers: new Set(),
    };
    records.add(record);
    byContainer.set(container, record);
    let implementation;
    try {
      implementation = await adapter.create({
        container,
        graph: spec.graph,
        layout: spec.layout,
        accessibleLabel: spec.accessibleLabel,
        fitPadding: spec.fitPadding,
      });
    } catch (error) {
      destroyRecord(record);
      throw graphError('GRAPH_ADAPTER_FAILED', 'Graph adapter failed during mount', error);
    }
    if (!implementation || typeof implementation !== 'object'
        || ['update', 'select', 'focus', 'fit', 'on', 'destroy']
          .some(method => typeof implementation[method] !== 'function')) {
      try { implementation?.destroy?.(); } catch {}
      destroyRecord(record);
      throw graphError('GRAPH_ADAPTER_FAILED', 'Graph adapter returned an invalid handle');
    }
    record.implementation = implementation;
    if (disposed || record.destroyed || record.epoch !== epoch) {
      try { implementation.destroy(); } catch {}
      destroyRecord(record);
      throw graphError('GRAPH_DISPOSED', 'Graph mount was superseded before completion');
    }
    return publicHandle(record);
  }

  function available() {
    return negotiated && permitted && !disposed && !!registry.select();
  }

  function status() {
    const adapter = registry.select();
    return Object.freeze({
      apiVersion: GRAPH_FACADE_VERSION,
      available: available(),
      features: adapter ? adapter.features : Object.freeze([]),
      layouts: adapter ? adapter.layouts : Object.freeze([]),
      limits: GRAPH_LIMITS,
    });
  }

  function disposeMounted() {
    epoch++;
    for (const record of [...records]) destroyRecord(record);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeMounted();
  }

  return Object.freeze({
    apiVersion: GRAPH_FACADE_VERSION,
    available,
    status,
    mount,
    disposeMounted,
    dispose,
  });
}
