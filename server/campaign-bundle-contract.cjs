'use strict';

const { filterDatasetForRole } = require('./visibility.cjs');
const { writeRevision } = require('./write-revision.cjs');

const FORMAT = 'ttrpg-codex-campaign-bundle';
const SCHEMA_VERSION = 1;
const MAX_LOGICAL_RECORDS = 128;
const MAX_MATERIALIZED_WRITES = 256;
const COLLECTIONS = Object.freeze(['characters', 'locations', 'relationships']);
const COLLECTION_SET = new Set(COLLECTIONS);
const VISIBILITIES = new Set(['public', 'dm']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REFERENCE_RE = /^[a-z][a-z0-9._-]{1,99}$/;

const ROOT_FIELDS = new Set([
  'format',
  'schemaVersion',
  'generatedAt',
  'records',
  'addonImports',
]);
const RECORD_GROUP_FIELDS = new Set(COLLECTIONS);
const OPERATION_FIELDS = new Set(['ref', 'operation', 'record']);
const CHARACTER_FIELDS = new Set([
  'name', 'title', 'faction', 'status', 'circumstances', 'attitudes',
  'knowledge', 'portrait', 'location', 'description', 'known', 'unknown',
  'tags', 'rank', 'rankChain', 'locationRoles', 'species', 'gender', 'age',
  'visibility',
]);
const LOCATION_FIELDS = new Set([
  'name', 'region', 'description', 'history', 'tags', 'knowledge',
  'parentId', 'connections', 'x', 'y', 'pinType', 'type', 'attitudes',
  'size', 'mapNotes', 'status', 'visibility',
]);
const RELATIONSHIP_FIELDS = new Set([
  'source', 'target', 'type', 'label', 'visibility',
]);
const FIELD_SETS = Object.freeze({
  characters: CHARACTER_FIELDS,
  locations: LOCATION_FIELDS,
  relationships: RELATIONSHIP_FIELDS,
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

function diagnostic(severity, code, message, path) {
  return {
    severity,
    code,
    message,
    ...(path ? { path } : {}),
  };
}

function addDiagnostic(diagnostics, severity, code, message, path) {
  if (diagnostics.length >= 100) return;
  diagnostics.push(diagnostic(severity, code, message, path));
}

function entriesOf(value) {
  if (Array.isArray(value)) {
    return value
      .filter(record => isPlainObject(record) && typeof record.id === 'string')
      .map(record => [record.id, clone(record)]);
  }
  if (!isPlainObject(value)) return [];
  return Object.entries(value)
    .filter(([, record]) => isPlainObject(record))
    .map(([id, record]) => [id, { id, ...clone(record) }]);
}

function mapOf(value) {
  return new Map(entriesOf(value));
}

function relationshipEntriesOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(record => isPlainObject(record))
    .map((record, index) => {
      const identity = relationshipIdentity(record);
      const id = typeof record.id === 'string' && record.id
        ? record.id
        : `relationship:${writeRevision(identity || index)}`;
      return [id, clone(record)];
    });
}

function relationshipMapOf(value) {
  return new Map(relationshipEntriesOf(value));
}

function withoutId(record) {
  const value = clone(record);
  delete value.id;
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectionRef(collection) {
  return Object.freeze({ scope: 'core', collection });
}

function stringField(record, field, diagnostics, path, {
  required = false,
  max = 20_000,
  fallback = '',
} = {}) {
  const value = record[field];
  if (value === undefined || value === null) {
    if (required) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_FIELD_REQUIRED',
        `${field} is required.`,
        [...path, field],
      );
    }
    return fallback;
  }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FIELD_INVALID',
      `${field} must be ${required ? 'a non-empty ' : 'a '}string no longer than ${max} characters.`,
      [...path, field],
    );
    return fallback;
  }
  return value;
}

function stringArray(record, field, diagnostics, path) {
  const value = record[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256
      || value.some(item => typeof item !== 'string' || item.length > 20_000)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FIELD_INVALID',
      `${field} must be an array of at most 256 strings.`,
      [...path, field],
    );
    return [];
  }
  return [...value];
}

function finiteNumber(record, field, diagnostics, path, {
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
} = {}) {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < min || value > max) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FIELD_INVALID',
      `${field} must be a finite number from ${min} to ${max}.`,
      [...path, field],
    );
    return undefined;
  }
  return value;
}

function explicitVisibility(record, diagnostics, path) {
  if (!VISIBILITIES.has(record.visibility)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_VISIBILITY_REQUIRED',
      'visibility must be explicitly set to "public" or "dm".',
      [...path, 'visibility'],
    );
    return 'dm';
  }
  return record.visibility;
}

function validateUnknownFields(record, allowed, diagnostics, path) {
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_UNKNOWN_FIELD',
        `Unknown field "${field}".`,
        [...path, field],
      );
    }
  }
}

function normalizeAttitudes(record, diagnostics, path) {
  const values = record.attitudes;
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 64) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FIELD_INVALID',
      'attitudes must be an array of at most 64 entries.',
      [...path, 'attitudes'],
    );
    return [];
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index++) {
    const item = values[index];
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id
        || Object.keys(item).some(key => key !== 'id')) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_FIELD_INVALID',
        'Each attitude must contain exactly one non-empty string id.',
        [...path, 'attitudes', index],
      );
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push({ id: item.id });
  }
  return result;
}

function normalizeUnknownQuestions(record, diagnostics, path) {
  const values = record.unknown;
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 256) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FIELD_INVALID',
      'unknown must be an array of at most 256 questions.',
      [...path, 'unknown'],
    );
    return [];
  }
  const result = [];
  for (let index = 0; index < values.length; index++) {
    const item = values[index];
    if (!isPlainObject(item)
        || Object.keys(item).some(key => key !== 'text' && key !== 'answer')
        || typeof item.text !== 'string'
        || typeof item.answer !== 'string'
        || item.text.length > 20_000
        || item.answer.length > 20_000) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_FIELD_INVALID',
        'Each unknown entry must contain string text and answer fields.',
        [...path, 'unknown', index],
      );
      continue;
    }
    result.push({ text: item.text, answer: item.answer });
  }
  return result;
}

function normalizeLocationRoles(record, resolveReference, diagnostics, path) {
  const values = record.locationRoles;
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 256) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FIELD_INVALID',
      'locationRoles must be an array of at most 256 entries.',
      [...path, 'locationRoles'],
    );
    return [];
  }
  const result = [];
  for (let index = 0; index < values.length; index++) {
    const item = values[index];
    if (!isPlainObject(item)
        || Object.keys(item).some(key => key !== 'locationId' && key !== 'role')
        || typeof item.role !== 'string'
        || item.role.length > 500) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_FIELD_INVALID',
        'Each location role must contain a typed locationId reference and string role.',
        [...path, 'locationRoles', index],
      );
      continue;
    }
    const locationId = resolveReference(
      item.locationId,
      'locations',
      [...path, 'locationRoles', index, 'locationId'],
    );
    if (locationId) result.push({ locationId, role: item.role });
  }
  return result;
}

function referenceDescriptor(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  if (keys[0] === '$ref' && typeof value.$ref === 'string') {
    return { kind: 'local', ref: value.$ref };
  }
  if (keys[0] === '$id' && isPlainObject(value.$id)
      && Object.keys(value.$id).length === 2
      && typeof value.$id.collection === 'string'
      && typeof value.$id.id === 'string') {
    return {
      kind: 'stored',
      collection: value.$id.collection,
      id: value.$id.id,
    };
  }
  return null;
}

function buildSource(source, diagnostics) {
  if (!isPlainObject(source)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_DOCUMENT_TYPE',
      'Campaign bundle must be an object.',
      [],
    );
    return null;
  }
  validateUnknownFields(source, ROOT_FIELDS, diagnostics, []);
  if (source.format !== FORMAT) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FORMAT_UNSUPPORTED',
      `format must be "${FORMAT}".`,
      ['format'],
    );
  }
  if (source.schemaVersion !== SCHEMA_VERSION) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_SCHEMA_UNSUPPORTED',
      `schemaVersion must be ${SCHEMA_VERSION}.`,
      ['schemaVersion'],
    );
  }
  if (!Number.isSafeInteger(source.generatedAt) || source.generatedAt < 0) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_TIMESTAMP_INVALID',
      'generatedAt must be a non-negative epoch-millisecond integer.',
      ['generatedAt'],
    );
  }
  if (source.addonImports !== undefined && !Array.isArray(source.addonImports)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_ADDON_IMPORT_INVALID',
      'addonImports must be an array.',
      ['addonImports'],
    );
  }
  if (!isPlainObject(source.records)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_RECORDS_TYPE',
      'records must be an object.',
      ['records'],
    );
    return null;
  }
  validateUnknownFields(source.records, RECORD_GROUP_FIELDS, diagnostics, ['records']);
  return source;
}

function normalizeOperations(source, diagnostics) {
  const result = Object.fromEntries(COLLECTIONS.map(collection => [collection, []]));
  const refs = new Map();
  let logicalCount = 0;

  for (const collection of COLLECTIONS) {
    const values = source?.records?.[collection] ?? [];
    if (!Array.isArray(values)) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_RECORDS_TYPE',
        `records.${collection} must be an array.`,
        ['records', collection],
      );
      continue;
    }
    for (let index = 0; index < values.length; index++) {
      logicalCount++;
      const path = ['records', collection, index];
      const entry = values[index];
      if (!isPlainObject(entry)) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_OPERATION_TYPE',
          'Bundle record operation must be an object.',
          path,
        );
        continue;
      }
      validateUnknownFields(entry, OPERATION_FIELDS, diagnostics, path);
      if (typeof entry.ref !== 'string' || !REFERENCE_RE.test(entry.ref)) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_REFERENCE_INVALID',
          'ref must start with a letter and contain 2-100 lowercase letters, digits, dots, underscores, or hyphens.',
          [...path, 'ref'],
        );
        continue;
      }
      if (refs.has(entry.ref)) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_REFERENCE_DUPLICATE',
          `Duplicate bundle reference "${entry.ref}".`,
          [...path, 'ref'],
        );
        continue;
      }
      if (entry.operation !== 'create') {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_OPERATION_UNSUPPORTED',
          'operation must be "create" in campaign bundle schema version 1.',
          [...path, 'operation'],
        );
      }
      if (!isPlainObject(entry.record)) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_RECORD_TYPE',
          'record must be an object.',
          [...path, 'record'],
        );
        continue;
      }
      validateUnknownFields(
        entry.record,
        FIELD_SETS[collection],
        diagnostics,
        [...path, 'record'],
      );
      const normalized = {
        collection,
        ref: entry.ref,
        operation: entry.operation,
        record: clone(entry.record),
        path,
        id: '',
      };
      refs.set(entry.ref, normalized);
      result[collection].push(normalized);
    }
  }

  if (logicalCount > MAX_LOGICAL_RECORDS) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_RECORD_LIMIT',
      `Campaign bundle schema version 1 supports at most ${MAX_LOGICAL_RECORDS} logical records.`,
      ['records'],
    );
  }
  return { groups: result, refs, logicalCount };
}

function reserveIds(normalized, existing, createId, diagnostics) {
  const used = new Set();
  for (const collection of COLLECTIONS) {
    for (const id of existing[collection].keys()) used.add(id);
  }
  for (const collection of COLLECTIONS) {
    for (const entry of normalized.groups[collection]) {
      const label = typeof entry.record.name === 'string'
        ? entry.record.name
        : (typeof entry.record.label === 'string' ? entry.record.label : entry.ref);
      let id = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = createId(label || entry.ref);
        if (typeof candidate === 'string' && candidate && !FORBIDDEN_KEYS.has(candidate)
            && !used.has(candidate)) {
          id = candidate;
          break;
        }
      }
      if (!id) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_ID_RESERVATION_FAILED',
          `Could not reserve a unique id for "${entry.ref}".`,
          [...entry.path, 'ref'],
        );
        continue;
      }
      entry.id = id;
      used.add(id);
    }
  }
}

function referenceResolver({ normalized, existing, diagnostics }) {
  return (value, requiredCollection, path, { optional = false } = {}) => {
    if ((value === undefined || value === null || value === '') && optional) return '';
    const descriptor = referenceDescriptor(value);
    if (!descriptor) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_REFERENCE_INVALID',
        'Reference must be {"$ref":"local.name"} or {"$id":{"collection":"...","id":"..."}}.',
        path,
      );
      return '';
    }
    if (descriptor.kind === 'local') {
      const entry = normalized.refs.get(descriptor.ref);
      if (!entry) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_REFERENCE_MISSING',
          `Unknown bundle reference "${descriptor.ref}".`,
          path,
        );
        return '';
      }
      if (entry.collection !== requiredCollection) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_REFERENCE_KIND',
          `Reference "${descriptor.ref}" targets ${entry.collection}, not ${requiredCollection}.`,
          path,
        );
        return '';
      }
      return entry.id;
    }
    if (descriptor.collection !== requiredCollection) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_REFERENCE_KIND',
        `Stored reference targets ${descriptor.collection}, not ${requiredCollection}.`,
        path,
      );
      return '';
    }
    if (!existing[requiredCollection].has(descriptor.id)) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_REFERENCE_MISSING',
        `Stored ${requiredCollection} record "${descriptor.id}" does not exist.`,
        path,
      );
      return '';
    }
    return descriptor.id;
  };
}

function normalizeCharacter(entry, context) {
  const { diagnostics, resolveReference, generatedAt, existing } = context;
  const record = entry.record;
  const path = [...entry.path, 'record'];
  const faction = stringField(record, 'faction', diagnostics, path, { fallback: 'neutral', max: 200 });
  const visibility = explicitVisibility(record, diagnostics, path);
  if (faction === 'party' && visibility === 'dm') {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_PARTY_VISIBILITY',
      'Party characters must be public.',
      [...path, 'visibility'],
    );
  }
  if (faction !== 'neutral' && faction !== 'party' && !existing.factions.has(faction)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_FACTION_MISSING',
      `Faction "${faction}" does not exist.`,
      [...path, 'faction'],
    );
  }
  const status = stringField(record, 'status', diagnostics, path, { fallback: 'alive', max: 200 });
  if (context.characterStatuses.size && !context.characterStatuses.has(status)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_CHARACTER_STATUS_INVALID',
      `Character status "${status}" is not configured.`,
      [...path, 'status'],
    );
  }
  const location = resolveReference(
    record.location,
    'locations',
    [...path, 'location'],
    { optional: true },
  );
  const knowledge = finiteNumber(record, 'knowledge', diagnostics, path, { min: 0, max: 4 });
  const value = {
    name: stringField(record, 'name', diagnostics, path, { required: true, max: 500 }),
    title: stringField(record, 'title', diagnostics, path, { max: 2_000 }),
    faction,
    status,
    circumstances: stringField(record, 'circumstances', diagnostics, path),
    attitudes: normalizeAttitudes(record, diagnostics, path),
    knowledge: knowledge ?? 0,
    portrait: stringField(record, 'portrait', diagnostics, path, { max: 2_000 }),
    location,
    description: stringField(record, 'description', diagnostics, path, { max: 256 * 1024 }),
    known: stringArray(record, 'known', diagnostics, path),
    unknown: normalizeUnknownQuestions(record, diagnostics, path),
    tags: stringArray(record, 'tags', diagnostics, path),
    rank: stringField(record, 'rank', diagnostics, path, { max: 500 }),
    rankChain: stringField(record, 'rankChain', diagnostics, path, { max: 500 }),
    locationRoles: normalizeLocationRoles(record, resolveReference, diagnostics, path),
    species: stringField(record, 'species', diagnostics, path, { max: 500 }),
    gender: stringField(record, 'gender', diagnostics, path, { max: 500 }),
    age: stringField(record, 'age', diagnostics, path, { max: 500 }),
    visibility,
    updatedAt: generatedAt,
    lastChange: { created: true },
  };
  return { id: entry.id, ...value };
}

function normalizeLocation(entry, context) {
  const { diagnostics, resolveReference, generatedAt } = context;
  const record = entry.record;
  const path = [...entry.path, 'record'];
  const x = finiteNumber(record, 'x', diagnostics, path, { min: 0, max: 1 });
  const y = finiteNumber(record, 'y', diagnostics, path, { min: 0, max: 1 });
  if ((x === undefined) !== (y === undefined)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_PIN_COORDINATES_INCOMPLETE',
      'Map placement requires both x and y.',
      path,
    );
  }
  const parentId = resolveReference(
    record.parentId,
    'locations',
    [...path, 'parentId'],
    { optional: true },
  );
  const connections = [];
  if (record.connections !== undefined) {
    if (!Array.isArray(record.connections) || record.connections.length > 256) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_FIELD_INVALID',
        'connections must be an array of at most 256 typed location references.',
        [...path, 'connections'],
      );
    } else {
      const seen = new Set();
      for (let index = 0; index < record.connections.length; index++) {
        const id = resolveReference(
          record.connections[index],
          'locations',
          [...path, 'connections', index],
        );
        if (id && !seen.has(id)) {
          seen.add(id);
          connections.push(id);
        }
      }
    }
  }
  if (parentId === entry.id || connections.includes(entry.id)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_LOCATION_SELF_REFERENCE',
      'A location cannot be its own parent or connection.',
      path,
    );
  }
  const pinType = stringField(record, 'pinType', diagnostics, path, {
    fallback: x === undefined ? '' : 'custom',
    max: 200,
  });
  if (pinType && !context.pinTypes.has(pinType)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_PIN_TYPE_INVALID',
      `Pin type "${pinType}" is not configured.`,
      [...path, 'pinType'],
    );
  }
  const size = finiteNumber(record, 'size', diagnostics, path, { min: 14, max: 64 });
  const knowledge = finiteNumber(record, 'knowledge', diagnostics, path, { min: 0, max: 4 });
  const value = {
    id: entry.id,
    name: stringField(record, 'name', diagnostics, path, { required: true, max: 500 }),
    region: stringField(record, 'region', diagnostics, path, { max: 2_000 }),
    description: stringField(record, 'description', diagnostics, path, { max: 256 * 1024 }),
    history: stringField(record, 'history', diagnostics, path, { max: 256 * 1024 }),
    tags: stringArray(record, 'tags', diagnostics, path),
    knowledge: knowledge ?? 0,
    parentId,
    connections,
    pinType,
    type: stringField(record, 'type', diagnostics, path, { fallback: '', max: 500 }),
    attitudes: normalizeAttitudes(record, diagnostics, path),
    mapNotes: stringField(record, 'mapNotes', diagnostics, path, { max: 256 * 1024 }),
    status: stringField(record, 'status', diagnostics, path, { max: 500 }),
    visibility: explicitVisibility(record, diagnostics, path),
    updatedAt: generatedAt,
    lastChange: { created: true },
  };
  if (x !== undefined && y !== undefined) {
    value.x = x;
    value.y = y;
  }
  if (size !== undefined) value.size = size;
  return value;
}

function targetCollectionForRelationship(type, relationshipTypes) {
  return relationshipTypes.get(type) === 'location' ? 'locations' : 'characters';
}

function normalizeRelationship(entry, context) {
  const { diagnostics, resolveReference } = context;
  const record = entry.record;
  const path = [...entry.path, 'record'];
  const type = stringField(record, 'type', diagnostics, path, { required: true, max: 200 });
  if (context.relationshipTypes.size && !context.relationshipTypes.has(type)) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_RELATIONSHIP_TYPE_INVALID',
      `Relationship type "${type}" is not configured.`,
      [...path, 'type'],
    );
  }
  const targetCollection = targetCollectionForRelationship(type, context.relationshipTypes);
  const source = resolveReference(record.source, 'characters', [...path, 'source']);
  const target = resolveReference(record.target, targetCollection, [...path, 'target']);
  if (source && target && targetCollection === 'characters' && source === target) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_RELATIONSHIP_SELF_REFERENCE',
      'A character relationship cannot target the same character.',
      path,
    );
  }
  return {
    id: entry.id,
    source,
    target,
    type,
    label: stringField(record, 'label', diagnostics, path, { max: 2_000 }),
    visibility: explicitVisibility(record, diagnostics, path),
  };
}

function relationshipIdentity(record) {
  return `${record.source}\0${record.target}\0${record.type}`;
}

function detectLocationCycles(locations, diagnostics) {
  const completed = new Set();
  for (const location of locations.values()) {
    if (completed.has(location.id)) continue;
    const visiting = new Map();
    let current = location;
    while (current?.parentId && locations.has(current.parentId)) {
      if (visiting.has(current.id)) {
        addDiagnostic(
          diagnostics,
          'error',
          'BUNDLE_LOCATION_CYCLE',
          `Location hierarchy contains a cycle at "${current.id}".`,
          ['records', 'locations'],
        );
        break;
      }
      if (completed.has(current.id)) break;
      visiting.set(current.id, true);
      current = locations.get(current.parentId);
    }
    for (const id of visiting.keys()) completed.add(id);
  }
}

function validateLocationMaps(locations, incomingIds, diagnostics) {
  for (const id of incomingIds) {
    const location = locations.get(id);
    if (!location || location.x === undefined || !location.parentId) continue;
    const parent = locations.get(location.parentId);
    if (!parent?.localMap) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_MAP_PARENT_INVALID',
        `Location "${location.name || id}" is placed on a parent without a local map.`,
        ['records', 'locations'],
      );
    }
  }
}

function validateVisibility(candidate, changed, relationshipTypes, diagnostics) {
  const check = (source, target, label) => {
    if (!source || !target || source.visibility !== 'public' || target.visibility !== 'dm') return;
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_VISIBILITY_REFERENCE',
      `Public ${label} "${source.name || source.label || source.id}" references DM-only "${target.name || target.id}".`,
      ['records'],
    );
  };
  for (const id of changed.characters) {
    const character = candidate.characters.get(id);
    check(character, candidate.locations.get(character?.location), 'character');
    for (const role of character?.locationRoles || []) {
      check(character, candidate.locations.get(role.locationId), 'character');
    }
  }
  for (const id of changed.locations) {
    const location = candidate.locations.get(id);
    check(location, candidate.locations.get(location?.parentId), 'location');
    for (const peerId of location?.connections || []) {
      check(location, candidate.locations.get(peerId), 'location');
    }
  }
  for (const id of changed.relationships) {
    const relationship = candidate.relationships.get(id);
    if (!relationship || relationship.visibility !== 'public') continue;
    const targetCollection = targetCollectionForRelationship(
      relationship.type,
      relationshipTypes,
    );
    check(
      relationship,
      candidate.characters.get(relationship.source),
      'relationship',
    );
    check(
      relationship,
      candidate[targetCollection].get(relationship.target),
      'relationship',
    );
  }
}

function materializeDataset(snapshot, candidate) {
  const dataset = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.startsWith('core:')) continue;
    dataset[key.slice('core:'.length)] = clone(value);
  }
  dataset.characters = [...candidate.characters.values()].map(clone);
  dataset.locations = [...candidate.locations.values()].map(clone);
  dataset.relationships = [...candidate.relationships.values()].map(clone);
  return dataset;
}

function changedPlayerProjection(playerDataset, operations) {
  const result = {
    characters: [],
    locations: [],
    relationships: [],
  };
  const byId = {
    characters: mapOf(playerDataset.characters),
    locations: mapOf(playerDataset.locations),
    relationships: mapOf(playerDataset.relationships),
  };
  for (const operation of operations) {
    const collection = operation.target.collection;
    if (!COLLECTION_SET.has(collection)) continue;
    const value = byId[collection].get(operation.id);
    if (value) result[collection].push(value);
  }
  return result;
}

function planCampaignBundle(source, {
  snapshot,
  createId,
} = {}) {
  if (!isPlainObject(snapshot) || typeof createId !== 'function') {
    throw new TypeError('planCampaignBundle requires a snapshot and createId adapter');
  }
  const diagnostics = [];
  const validSource = buildSource(source, diagnostics);
  const normalized = normalizeOperations(validSource, diagnostics);
  const existing = {
    characters: mapOf(snapshot['core:characters']),
    locations: mapOf(snapshot['core:locations']),
    relationships: relationshipMapOf(snapshot['core:relationships']),
    factions: mapOf(snapshot['core:factions']),
  };
  reserveIds(normalized, existing, createId, diagnostics);
  const resolveReference = referenceResolver({ normalized, existing, diagnostics });
  const settings = isPlainObject(snapshot['core:settings'])
    ? snapshot['core:settings']
    : {};
  const pinTypes = new Set(
    Array.isArray(settings.pinTypes)
      ? settings.pinTypes.map(item => item?.id).filter(id => typeof id === 'string')
      : [],
  );
  const characterStatuses = new Set(
    Array.isArray(settings.characterStatuses)
      ? settings.characterStatuses.map(item => item?.id).filter(id => typeof id === 'string')
      : [],
  );
  const relationshipTypes = new Map(
    Array.isArray(settings.relationshipTypes)
      ? settings.relationshipTypes
        .filter(item => item && typeof item.id === 'string')
        .map(item => [item.id, item.target === 'location' ? 'location' : 'character'])
      : [],
  );
  const generatedAt = Number.isSafeInteger(validSource?.generatedAt)
    && validSource.generatedAt >= 0
    ? validSource.generatedAt
    : 0;
  const context = {
    diagnostics,
    resolveReference,
    generatedAt,
    existing,
    pinTypes,
    characterStatuses,
    relationshipTypes,
  };
  const candidate = {
    characters: new Map(existing.characters),
    locations: new Map(existing.locations),
    relationships: new Map(existing.relationships),
  };
  const changed = {
    characters: new Set(),
    locations: new Set(),
    relationships: new Set(),
  };
  const direct = {
    characters: new Set(),
    locations: new Set(),
    relationships: new Set(),
  };

  for (const entry of normalized.groups.characters) {
    if (!entry.id) continue;
    const value = normalizeCharacter(entry, context);
    candidate.characters.set(entry.id, value);
    changed.characters.add(entry.id);
    direct.characters.add(entry.id);
  }
  for (const entry of normalized.groups.locations) {
    if (!entry.id) continue;
    const value = normalizeLocation(entry, context);
    candidate.locations.set(entry.id, value);
    changed.locations.add(entry.id);
    direct.locations.add(entry.id);
  }

  detectLocationCycles(candidate.locations, diagnostics);
  validateLocationMaps(candidate.locations, direct.locations, diagnostics);

  for (const id of direct.locations) {
    const location = candidate.locations.get(id);
    if (!location) continue;
    for (const peerId of location.connections || []) {
      const peer = candidate.locations.get(peerId);
      if (!peer) continue;
      const current = Array.isArray(peer.connections) ? peer.connections : [];
      if (current.includes(id)) continue;
      candidate.locations.set(peerId, {
        ...peer,
        connections: [...current, id],
        updatedAt: generatedAt,
        lastChange: { refs: true },
      });
      changed.locations.add(peerId);
    }
  }

  const relationshipIdentities = new Map();
  for (const relationship of candidate.relationships.values()) {
    if (!relationship?.source || !relationship?.target || !relationship?.type) continue;
    relationshipIdentities.set(relationshipIdentity(relationship), relationship.id || '');
  }
  for (const entry of normalized.groups.relationships) {
    if (!entry.id) continue;
    const value = normalizeRelationship(entry, context);
    const identity = relationshipIdentity(value);
    if (relationshipIdentities.has(identity)) {
      addDiagnostic(
        diagnostics,
        'error',
        'BUNDLE_RELATIONSHIP_DUPLICATE',
        'A relationship with the same source, target, and type already exists.',
        [...entry.path, 'record'],
      );
      continue;
    }
    relationshipIdentities.set(identity, entry.id);
    candidate.relationships.set(entry.id, value);
    changed.relationships.add(entry.id);
    direct.relationships.add(entry.id);
  }

  validateVisibility(candidate, changed, relationshipTypes, diagnostics);

  const operations = [];
  const changes = [];
  for (const collection of COLLECTIONS) {
    for (const id of changed[collection]) {
      const after = candidate[collection].get(id);
      const before = existing[collection].get(id) || null;
      if (before && sameJson(before, after)) continue;
      const sourceEntry = normalized.groups[collection].find(entry => entry.id === id);
      const derived = !direct[collection].has(id);
      operations.push({
        target: collectionRef(collection),
        op: 'put',
        id,
        value: withoutId(after),
        meta: {
          status: before ? 'update' : 'create',
          derived,
          ...(sourceEntry ? { sourceRef: sourceEntry.ref } : {}),
        },
      });
      changes.push({
        collection,
        id,
        status: before ? 'update' : 'create',
        derived,
        ...(sourceEntry ? { sourceRef: sourceEntry.ref } : {}),
        before,
        after: clone(after),
      });
    }
  }
  if (operations.length > MAX_MATERIALIZED_WRITES) {
    addDiagnostic(
      diagnostics,
      'error',
      'BUNDLE_OPERATION_LIMIT',
      `Expanded bundle exceeds ${MAX_MATERIALIZED_WRITES} materialized writes.`,
      ['records'],
    );
  }

  const dmDataset = materializeDataset(snapshot, candidate);
  const playerDataset = filterDatasetForRole(clone(dmDataset), 'player');
  const references = [];
  for (const collection of COLLECTIONS) {
    for (const entry of normalized.groups[collection]) {
      if (!entry.id) continue;
      references.push({ ref: entry.ref, collection, id: entry.id });
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    operations,
    diagnostics,
    review: {
      format: FORMAT,
      logicalRecordCount: normalized.logicalCount,
      materializedWriteCount: operations.length,
      references,
      changes,
      playerProjection: changedPlayerProjection(playerDataset, operations),
    },
  };
}

function inventoryRecord(collection, id, record) {
  const value = isPlainObject(record) ? record : {};
  const result = {
    id,
    label: typeof value.name === 'string'
      ? value.name
      : (typeof value.title === 'string' ? value.title : id),
    revision: writeRevision(record),
  };
  if (Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0) {
    result.updatedAt = value.updatedAt;
  }
  if (VISIBILITIES.has(value.visibility)) result.visibility = value.visibility;
  if (typeof value.linkedTwinId === 'string' && value.linkedTwinId) {
    result.linkedTwinId = value.linkedTwinId;
  }
  if (collection === 'locations') {
    if (typeof value.parentId === 'string' && value.parentId) result.parentId = value.parentId;
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
      result.placement = { x: value.x, y: value.y };
    }
    if (typeof value.localMap === 'string' && value.localMap) result.hasLocalMap = true;
  }
  if (collection === 'relationships') {
    result.source = value.source || '';
    result.target = value.target || '';
    result.type = value.type || '';
  }
  return result;
}

function buildImportInventory(collections, {
  selected = COLLECTIONS,
  includeBodies = false,
  collectionRevisions = {},
  campaignRevision = '',
  providers = [],
} = {}) {
  const records = {};
  for (const collection of selected) {
    if (!COLLECTION_SET.has(collection)) continue;
    const entries = collection === 'relationships'
      ? relationshipEntriesOf(collections[collection])
      : entriesOf(collections[collection]);
    records[collection] = entries.map(([id, record]) => ({
      ...inventoryRecord(collection, id, record),
      ...(includeBodies ? { record } : {}),
    }));
  }
  return {
    format: 'ttrpg-codex-import-inventory',
    schemaVersion: 1,
    campaignRevision,
    collectionRevisions: Object.fromEntries(
      Object.entries(collectionRevisions)
        .filter(([collection]) => Object.hasOwn(records, collection)),
    ),
    providers: clone(providers),
    records,
  };
}

module.exports = {
  COLLECTIONS,
  FORMAT,
  MAX_LOGICAL_RECORDS,
  MAX_MATERIALIZED_WRITES,
  SCHEMA_VERSION,
  buildImportInventory,
  inventoryRecord,
  isPlainObject,
  planCampaignBundle,
  referenceDescriptor,
  relationshipIdentity,
};
