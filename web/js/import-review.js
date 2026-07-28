function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function coordinate(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('Import placement coordinates must be finite numbers from 0 to 1');
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function applyLocationAdjustments(source, adjustments) {
  const next = clone(source);
  const locations = next?.records?.locations;
  if (!isObject(next) || !Array.isArray(locations)) {
    throw new TypeError('Campaign bundle locations are unavailable');
  }
  const entries = adjustments instanceof Map
    ? [...adjustments.entries()]
    : Object.entries(adjustments || {});
  const byRef = new Map(locations
    .filter(operation => isObject(operation) && typeof operation.ref === 'string')
    .map(operation => [operation.ref, operation]));

  for (const [ref, placement] of entries) {
    const operation = byRef.get(ref);
    if (!operation || !isObject(operation.record)) {
      throw new TypeError(`Campaign bundle location "${ref}" is unavailable`);
    }
    operation.record.x = coordinate(placement?.x);
    operation.record.y = coordinate(placement?.y);
  }
  return next;
}

function labelOf(value, fallback) {
  for (const field of ['title', 'name', 'label']) {
    if (typeof value?.[field] === 'string' && value[field].trim()) return value[field].trim();
  }
  return fallback;
}

function planningCollection(collection, name) {
  return typeof collection === 'string' && collection.endsWith(`:${name}`);
}

export function buildStoryReview(changes, {
  coreLabel = (_collection, id) => id,
  relationshipTarget = () => 'characters',
} = {}) {
  const values = Array.isArray(changes) ? changes : [];
  const items = values
    .filter(change => planningCollection(change.collection, 'planning_items') && isObject(change.after))
    .map(change => ({ id: change.id, ...clone(change.after) }));
  const links = values
    .filter(change => planningCollection(change.collection, 'planning_links') && isObject(change.after))
    .map(change => ({ id: change.id, ...clone(change.after) }));
  const nodes = new Map();
  const edges = [];

  const addNode = node => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return node.id;
  };
  for (const item of items) {
    addNode({
      id: `planning:${item.id}`,
      recordId: item.id,
      scope: 'planning',
      kind: item.kind || 'note',
      label: labelOf(item, item.id),
    });
  }

  const endpointNode = endpoint => {
    if (!isObject(endpoint)) return '';
    if (endpoint.scope === 'planning' && typeof endpoint.itemId === 'string') {
      const id = `planning:${endpoint.itemId}`;
      addNode({
        id,
        recordId: endpoint.itemId,
        scope: 'planning',
        kind: 'note',
        label: endpoint.itemId,
      });
      return id;
    }
    if (endpoint.scope === 'core'
        && typeof endpoint.collection === 'string'
        && typeof endpoint.id === 'string') {
      const id = `core:${endpoint.collection}:${endpoint.id}`;
      addNode({
        id,
        recordId: endpoint.id,
        scope: 'core',
        kind: endpoint.collection,
        label: coreLabel(endpoint.collection, endpoint.id) || endpoint.id,
      });
      return id;
    }
    if (endpoint.scope === 'external'
        && typeof endpoint.addonId === 'string'
        && typeof endpoint.id === 'string') {
      const id = `external:${endpoint.addonId}:${endpoint.kind || 'record'}:${endpoint.id}`;
      addNode({
        id,
        recordId: endpoint.id,
        scope: 'external',
        kind: endpoint.kind || 'record',
        label: endpoint.label || endpoint.id,
      });
      return id;
    }
    return '';
  };

  for (const link of links) {
    const source = endpointNode(link.source);
    const target = endpointNode(link.target);
    if (!source || !target) continue;
    edges.push({
      id: `planning-link:${link.id}`,
      recordId: link.id,
      source,
      target,
      type: link.type || 'related',
      label: labelOf(link, link.type || ''),
      sourceSectionId: link.source?.sectionId || '',
      targetSectionId: link.target?.sectionId || '',
      notes: typeof link.notes === 'string' ? link.notes : '',
    });
  }

  for (const change of values) {
    if (change.collection !== 'relationships' || !isObject(change.after)) continue;
    const relationship = change.after;
    if (typeof relationship.source !== 'string' || typeof relationship.target !== 'string') continue;
    const source = endpointNode({
      scope: 'core',
      collection: 'characters',
      id: relationship.source,
    });
    const target = endpointNode({
      scope: 'core',
      collection: relationshipTarget(relationship.type),
      id: relationship.target,
    });
    edges.push({
      id: `core-relationship:${change.id}`,
      recordId: change.id,
      source,
      target,
      type: relationship.type || 'related',
      label: labelOf(relationship, relationship.type || ''),
      sourceSectionId: '',
      targetSectionId: '',
      notes: '',
    });
  }

  return {
    items,
    links,
    nodes: [...nodes.values()],
    edges,
  };
}
