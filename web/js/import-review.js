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
  const sourceCollection = {
    planning_items: 'items',
    planning_flow_links: 'flowLinks',
    planning_references: 'references',
    planning_consequences: 'consequences',
    dm_notes: 'notes',
  }[collection] || collection;
  const arrays = Object.entries(document)
    .filter(([, value]) => Array.isArray(value));
  const exact = arrays.filter(([key]) => sourceCollection === key);
  const compatible = arrays.filter(([key]) => (
    sourceCollection !== key && (collection === key || collection.endsWith(`_${key}`))
  ));
  const prioritized = [...exact, ...compatible];
  const matches = [...prioritized, ...arrays.filter(entry => !prioritized.includes(entry))]
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

export function locatePlanningDocument(source) {
  if (!isObject(source) || !Array.isArray(source.addonImports)) return null;
  const index = source.addonImports.findIndex(entry => (
    entry?.addonId === 'dm-tools'
    && entry?.contributorId === 'planning'
    && entry?.document?.format === 'dm-tools-planning'
    && entry?.document?.schemaVersion === 2
  ));
  if (index < 0) return null;
  const path = ['addonImports', index, 'document'];
  return { path, document: valueAtPath(source, path) };
}

export function buildStoryReview(changes, {
  coreLabel = (_collection, id) => id,
  relationshipTarget = () => 'characters',
  planningDocument = null,
} = {}) {
  const values = Array.isArray(changes) ? changes : [];
  const source = planningDocument?.format === 'dm-tools-planning'
    && planningDocument?.schemaVersion === 2
    ? planningDocument
    : null;
  const records = (sourceField, collection) => (
    source && Array.isArray(source[sourceField])
      ? source[sourceField].filter(isObject).map(clone)
      : values
        .filter(change => planningCollection(change.collection, collection)
          && isObject(change.after))
        .map(change => ({ id: change.id, ...clone(change.after) }))
  );
  const items = records('items', 'planning_items');
  const flowLinks = records('flowLinks', 'planning_flow_links');
  const references = records('references', 'planning_references');
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
    const parent = itemsById.get(item.parentId);
    addNode({
      id: `planning:${item.id}`,
      recordId: item.id,
      scope: 'planning',
      kind: item.kind || 'event',
      label: labelOf(item, item.id),
      parentId: item.parentId || '',
      parentLabel: labelOf(parent, ''),
      eventType: item.eventType || '',
      branchType: item.branchType || '',
    });
  }

  const endpointNode = target => {
    if (!isObject(target)) return '';
    if (target.scope === 'planning' && typeof target.itemId === 'string') {
      const id = `planning:${target.itemId}`;
      const item = itemsById.get(target.itemId);
      const parent = itemsById.get(item?.parentId);
      addNode({
        id,
        recordId: target.itemId,
        scope: 'planning',
        kind: item?.kind || 'event',
        label: labelOf(item, target.itemId),
        parentId: item?.parentId || '',
        parentLabel: labelOf(parent, ''),
        eventType: item?.eventType || '',
        branchType: item?.branchType || '',
      });
      return id;
    }
    if (target.scope === 'core'
        && typeof target.collection === 'string'
        && typeof target.id === 'string') {
      const id = `core:${target.collection}:${target.id}`;
      addNode({
        id,
        recordId: target.id,
        scope: 'core',
        kind: target.collection,
        label: coreLabel(target.collection, target.id) || target.id,
      });
      return id;
    }
    if (target.scope === 'external'
        && typeof target.addonId === 'string'
        && typeof target.id === 'string') {
      const id = `external:${target.addonId}:${target.kind || 'record'}:${target.id}`;
      addNode({
        id,
        recordId: target.id,
        scope: 'external',
        kind: target.kind || 'record',
        label: target.label || target.id,
      });
      return id;
    }
    return '';
  };

  const flowEndpointNode = itemId => {
    if (typeof itemId !== 'string') return '';
    const item = itemsById.get(itemId);
    if (item) {
      const parent = itemsById.get(item?.parentId);
      const id = `planning:${itemId}`;
      if (!flowNodes.has(id)) {
        const itemLabel = labelOf(item, itemId);
        const parentLabel = labelOf(parent, '');
        flowNodes.set(id, {
          id,
          recordId: itemId,
          scope: 'planning',
          kind: item.kind || 'event',
          eventType: item?.eventType || '',
          branchType: item?.branchType || '',
          label: itemLabel,
          graphLabel: parentLabel ? `${parentLabel}\n${itemLabel}` : itemLabel,
          parentLabel,
        });
      }
      return id;
    }
    return '';
  };

  for (const link of flowLinks) {
    const sourceEndpoint = { scope: 'planning', itemId: link.sourceId };
    const targetEndpoint = { scope: 'planning', itemId: link.targetId };
    const source = endpointNode(sourceEndpoint);
    const target = endpointNode(targetEndpoint);
    if (!source || !target) continue;
    const edge = {
      id: `planning-flow:${link.id}`,
      recordId: link.id,
      source,
      target,
      type: link.kind || 'continues',
      label: labelOf(link, link.kind || 'continues'),
      sourceSectionId: '',
      targetSectionId: '',
      notes: '',
    };
    edges.push(edge);
    const flowSource = flowEndpointNode(link.sourceId);
    const flowTarget = flowEndpointNode(link.targetId);
    if (flowSource && flowTarget) {
      flowEdges.push({
        ...edge,
        id: `flow-link:${link.id}`,
        source: flowSource,
        target: flowTarget,
      });
    }
  }

  for (const reference of references) {
    const source = endpointNode({ scope: 'planning', itemId: reference.itemId });
    const target = endpointNode(reference.target);
    if (!source || !target) continue;
    edges.push({
      id: `planning-reference:${reference.id}`,
      recordId: reference.id,
      source,
      target,
      type: reference.relation || 'related',
      label: labelOf(reference, reference.relation || 'related'),
      notes: typeof reference.notes === 'string' ? reference.notes : '',
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
      notes: '',
    });
  }

  const decisionNodes = new Set(flowEdges
    .filter(edge => edge.type === 'option')
    .map(edge => edge.source));
  for (const item of items) {
    if (item.kind === 'branch') decisionNodes.add(`planning:${item.id}`);
  }
  return {
    items,
    links: flowLinks,
    references,
    roots: items.filter(item => !item.parentId),
    nodes: [...nodes.values()],
    edges,
    flowNodes: [...flowNodes.values()].map(node => ({
      ...node,
      decision: decisionNodes.has(node.id),
    })),
    flowEdges,
  };
}
