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

export function valueAtPath(source, path) {
  if (!Array.isArray(path)) return undefined;
  return path.reduce((value, segment) => value?.[segment], source);
}

export function setValueAtPath(source, path, value) {
  if (!isObject(source) || !Array.isArray(path) || !path.length) {
    throw new TypeError('Import source path is unavailable');
  }
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  let parent = source;
  for (const segment of path.slice(0, -1)) {
    if (forbidden.has(String(segment)) || (!isObject(parent) && !Array.isArray(parent))) {
      throw new TypeError('Import source path is unsafe');
    }
    parent = parent[segment];
  }
  const leaf = path.at(-1);
  if (forbidden.has(String(leaf)) || (!isObject(parent) && !Array.isArray(parent))) {
    throw new TypeError('Import source path is unsafe');
  }
  parent[leaf] = value;
}

export function locateChangeSource(source, change) {
  if (!isObject(source) || !isObject(change)) return null;
  if (typeof change.sourceRef === 'string' && change.sourceRef) {
    const records = source.records?.[change.collection];
    const index = Array.isArray(records)
      ? records.findIndex(entry => entry?.ref === change.sourceRef && isObject(entry.record))
      : -1;
    if (index >= 0) {
      const path = ['records', change.collection, index, 'record'];
      return { path, value: valueAtPath(source, path) };
    }
  }

  const addonId = change.contributor?.addonId;
  const contributorId = change.contributor?.id;
  if (typeof addonId !== 'string' || typeof contributorId !== 'string') return null;
  const imports = source.addonImports;
  const importIndex = Array.isArray(imports)
    ? imports.findIndex(entry => entry?.addonId === addonId
      && entry?.contributorId === contributorId
      && isObject(entry.document))
    : -1;
  if (importIndex < 0) return null;
  const document = imports[importIndex].document;
  const collection = String(change.collection || '').split(':').at(-1);
  const arrays = Object.entries(document)
    .filter(([, value]) => Array.isArray(value));
  const preferred = arrays.filter(([key]) => collection === key || collection.endsWith(`_${key}`));
  const matches = [...preferred, ...arrays.filter(entry => !preferred.includes(entry))]
    .map(([key, records]) => ({
      key,
      index: records.findIndex(record => isObject(record) && record.id === change.id),
    }))
    .filter(match => match.index >= 0);
  if (!matches.length) return null;
  const match = matches[0];
  const path = ['addonImports', importIndex, 'document', match.key, match.index];
  return { path, value: valueAtPath(source, path) };
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
  const flowNodes = new Map();
  const flowEdges = [];
  const itemsById = new Map(items.map(item => [item.id, item]));

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

  const flowEndpointNode = endpoint => {
    if (!isObject(endpoint)) return '';
    if (endpoint.scope === 'planning' && typeof endpoint.itemId === 'string') {
      const item = itemsById.get(endpoint.itemId);
      const section = endpoint.sectionId
        ? (item?.sections || []).find(value => value.id === endpoint.sectionId)
        : null;
      const id = section
        ? `planning:${endpoint.itemId}:section:${endpoint.sectionId}`
        : `planning:${endpoint.itemId}`;
      if (!flowNodes.has(id)) {
        const itemLabel = labelOf(item, endpoint.itemId);
        const sectionLabel = section ? labelOf(section, section.id) : '';
        flowNodes.set(id, {
          id,
          recordId: endpoint.itemId,
          sectionId: section?.id || '',
          scope: 'planning',
          kind: item?.kind || 'note',
          endpointKind: section ? 'section' : 'item',
          label: sectionLabel || itemLabel,
          graphLabel: section ? `${itemLabel}\n${sectionLabel}` : itemLabel,
          parentLabel: section ? itemLabel : '',
        });
      }
      return id;
    }
    const id = endpointNode(endpoint);
    const node = nodes.get(id);
    if (node && !flowNodes.has(id)) flowNodes.set(id, { ...clone(node), graphLabel: node.label });
    return id;
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
    if (link.type === 'precedes' || link.type === 'branches') {
      const flowSource = flowEndpointNode(link.source);
      const flowTarget = flowEndpointNode(link.target);
      if (flowSource && flowTarget) {
        flowEdges.push({
          id: `flow-link:${link.id}`,
          recordId: link.id,
          source: flowSource,
          target: flowTarget,
          type: link.type,
          label: labelOf(link, link.type),
          notes: typeof link.notes === 'string' ? link.notes : '',
        });
      }
    }
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

  const decisionNodes = new Set(flowEdges
    .filter(edge => edge.type === 'branches')
    .map(edge => edge.source));
  return {
    items,
    links,
    nodes: [...nodes.values()],
    edges,
    flowNodes: [...flowNodes.values()].map(node => ({
      ...node,
      decision: decisionNodes.has(node.id),
    })),
    flowEdges,
  };
}
