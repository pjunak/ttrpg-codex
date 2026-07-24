'use strict';

const crypto = require('node:crypto');

const PROVIDER_API_VERSION = 1;
const PLAN_VERSION = 1;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const COLLECTION_RE = /^[a-z0-9][a-zA-Z0-9_]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROVIDER_CAPABILITIES = new Set(['abort-signal', 'structured-diagnostics']);
const TARGET_TYPES = new Set(['addon-list', 'addon-keyed']);
const INPUT_FORMATS = new Set(['json']);

const LIMITS = Object.freeze({
  maxInputBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxRecords: 10_000,
  maxStringChars: 256 * 1024,
  maxNodes: 100_000,
  maxOperations: 256,
  maxDiagnostics: 100,
  maxDiagnosticChars: 2_000,
  timeoutMs: 5_000,
  maxTimeoutMs: 10_000,
  jobTtlMs: 5 * 60_000,
  maxJobs: 128,
  maxJobsPerAddon: 32,
  maxJobsPerProvider: 16,
  maxConcurrentPerAddon: 4,
  maxConcurrentPerProvider: 2,
  addonRateBurst: 10,
  addonRateRefillMs: 10_000,
  rateBurst: 5,
  rateRefillMs: 10_000,
});

const PROTECTED_FIELDS = Object.freeze([
  'id',
  'addonId',
  'namespace',
  'access',
  'revision',
  '_revision',
  'audit',
  '_audit',
  'createdBy',
  'updatedBy',
]);

class ImportError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return structuredClone(value);
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new ImportError('IMPORT_VALIDATION', 'Value must be JSON-serializable');
  }
}

function assertSafeJson(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ImportError('IMPORT_VALIDATION', `${label} contains a non-finite number`);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    throw new ImportError('IMPORT_VALIDATION', `${label} contains a non-JSON value`);
  }
  if (seen.has(value)) throw new ImportError('IMPORT_VALIDATION', `${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJson(entry, `${label}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) {
      throw new ImportError('IMPORT_VALIDATION', `${label} must use plain objects`);
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ImportError('IMPORT_PROTOTYPE_KEY', `${label} contains forbidden key "${key}"`);
      }
      assertSafeJson(value[key], `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function _jsonPath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function parseJsonStrict(input, requestedLimits = {}) {
  const limits = { ...LIMITS, ...requestedLimits };
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  if (bytes.byteLength > limits.maxInputBytes) {
    throw new ImportError(
      'IMPORT_INPUT_LIMIT',
      `Input exceeds ${limits.maxInputBytes} bytes`,
      413,
      { limit: 'maxInputBytes', maximum: limits.maxInputBytes },
    );
  }

  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError('IMPORT_JSON_INVALID', 'Input is not valid UTF-8 JSON');
  }

  let index = 0;
  let nodes = 0;
  let records = 0;
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  const fail = (code, message, details) => {
    throw new ImportError(code, message, 400, { offset: index, ...details });
  };
  const whitespace = () => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index++;
  };
  const string = (path) => {
    const start = index;
    index++;
    let escaped = false;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      const ch = source[index++];
      if (!escaped && ch === '"') {
        let value;
        try { value = JSON.parse(source.slice(start, index)); }
        catch { fail('IMPORT_JSON_INVALID', `Invalid JSON string at ${path}`); }
        if (value.length > limits.maxStringChars) {
          fail('IMPORT_STRING_LIMIT', `String at ${path} exceeds ${limits.maxStringChars} characters`, {
            path,
            maximum: limits.maxStringChars,
          });
        }
        return value;
      }
      if (!escaped && code < 0x20) fail('IMPORT_JSON_INVALID', `Control character in string at ${path}`);
      if (!escaped && ch === '\\') escaped = true;
      else escaped = false;
    }
    fail('IMPORT_JSON_INVALID', `Unterminated JSON string at ${path}`);
  };

  const value = (depth, path, arrayRecord = false) => {
    if (depth > limits.maxDepth) {
      fail('IMPORT_DEPTH_LIMIT', `JSON nesting exceeds ${limits.maxDepth}`, {
        path,
        maximum: limits.maxDepth,
      });
    }
    nodes++;
    if (nodes > limits.maxNodes) {
      fail('IMPORT_NODE_LIMIT', `JSON value count exceeds ${limits.maxNodes}`, {
        maximum: limits.maxNodes,
      });
    }
    if (arrayRecord) {
      records++;
      if (records > limits.maxRecords) {
        fail('IMPORT_RECORD_LIMIT', `JSON record count exceeds ${limits.maxRecords}`, {
          maximum: limits.maxRecords,
        });
      }
    }
    whitespace();
    const ch = source[index];
    if (ch === '"') return string(path);
    if (ch === '{') {
      index++;
      const result = {};
      const seen = new Set();
      whitespace();
      if (source[index] === '}') { index++; return result; }
      while (index < source.length) {
        if (source[index] !== '"') fail('IMPORT_JSON_INVALID', `Expected an object key at ${path}`);
        const key = string(path);
        if (FORBIDDEN_KEYS.has(key)) {
          fail('IMPORT_PROTOTYPE_KEY', `Forbidden key "${key}" at ${path}`, { path, key });
        }
        if (seen.has(key)) {
          fail('IMPORT_DUPLICATE_KEY', `Duplicate JSON key "${key}" at ${path}`, { path, key });
        }
        seen.add(key);
        whitespace();
        if (source[index++] !== ':') fail('IMPORT_JSON_INVALID', `Expected ":" after ${_jsonPath(path, key)}`);
        result[key] = value(depth + 1, _jsonPath(path, key));
        whitespace();
        const separator = source[index++];
        if (separator === '}') return result;
        if (separator !== ',') fail('IMPORT_JSON_INVALID', `Expected "," or "}" at ${path}`);
        whitespace();
      }
      fail('IMPORT_JSON_INVALID', `Unterminated object at ${path}`);
    }
    if (ch === '[') {
      index++;
      const result = [];
      whitespace();
      if (source[index] === ']') { index++; return result; }
      let itemIndex = 0;
      while (index < source.length) {
        result.push(value(depth + 1, _jsonPath(path, itemIndex), true));
        itemIndex++;
        whitespace();
        const separator = source[index++];
        if (separator === ']') return result;
        if (separator !== ',') fail('IMPORT_JSON_INVALID', `Expected "," or "]" at ${path}`);
        whitespace();
      }
      fail('IMPORT_JSON_INVALID', `Unterminated array at ${path}`);
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return parsed;
      }
    }
    numberPattern.lastIndex = index;
    const match = numberPattern.exec(source);
    if (match) {
      index = numberPattern.lastIndex;
      const parsed = Number(match[0]);
      if (!Number.isFinite(parsed)) fail('IMPORT_JSON_INVALID', `Number at ${path} is outside the finite range`);
      return parsed;
    }
    fail('IMPORT_JSON_INVALID', `Unexpected token at ${path}`);
  };

  whitespace();
  const parsed = value(0, '$');
  whitespace();
  if (index !== source.length) fail('IMPORT_JSON_INVALID', 'Trailing content after the JSON value');
  return { value: parsed, stats: { bytes: bytes.byteLength, nodes, records } };
}

function normalizeCollectionRef(raw, label = 'collection reference') {
  if (!isPlainObject(raw)) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', `${label} must be an object`);
  }
  const allowed = raw.scope === 'core'
    ? new Set(['scope', 'collection'])
    : new Set(['scope', 'addonId', 'collection']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ImportError('IMPORT_PROVIDER_INVALID', `${label} has unknown field "${key}"`);
    }
  }
  if (raw.scope !== 'core' && raw.scope !== 'addon') {
    throw new ImportError('IMPORT_PROVIDER_INVALID', `${label}.scope must be "core" or "addon"`);
  }
  if (typeof raw.collection !== 'string' || !COLLECTION_RE.test(raw.collection)) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', `${label}.collection is invalid`);
  }
  if (raw.scope === 'core') return { scope: 'core', collection: raw.collection };
  if (typeof raw.addonId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}$/.test(raw.addonId)) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', `${label}.addonId is invalid`);
  }
  return { scope: 'addon', addonId: raw.addonId, collection: raw.collection };
}

function collectionRefKey(ref) {
  return ref.scope === 'core'
    ? `core:${ref.collection}`
    : `addon:${ref.addonId}:${ref.collection}`;
}

function _normalizeRefList(raw, label) {
  if (!Array.isArray(raw)) throw new ImportError('IMPORT_PROVIDER_INVALID', `${label} must be an array`);
  if (raw.length > 16) throw new ImportError('IMPORT_PROVIDER_INVALID', `${label} may contain at most 16 collections`);
  const seen = new Set();
  return raw.map((entry, index) => {
    const ref = normalizeCollectionRef(entry, `${label}[${index}]`);
    const key = collectionRefKey(ref);
    if (seen.has(key)) throw new ImportError('IMPORT_PROVIDER_INVALID', `${label} contains duplicate "${key}"`);
    seen.add(key);
    return ref;
  });
}

function normalizeProviderDescriptor(addon, raw, policy = {}) {
  if (!isPlainObject(raw)) throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider descriptor must be an object');
  const allowed = new Set([
    'id', 'apiVersion', 'schemaVersion', 'formats', 'reads', 'writes',
    'targetTypes', 'limits', 'capabilities', 'preview',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ImportError('IMPORT_PROVIDER_INVALID', `Provider has unknown field "${key}"`);
  }
  if (!addon || typeof addon.id !== 'string') throw new ImportError('IMPORT_PROVIDER_INVALID', 'Addon metadata is missing');
  if (addon.apiVersion !== 2) throw new ImportError('IMPORT_CAPABILITY_REQUIRED', 'Import providers require addon API v2');
  const addonCapabilities = [
    ...(addon.capabilities?.required || []),
    ...(addon.capabilities?.optional || []),
  ];
  if (!addonCapabilities.includes('imports.providers')) {
    throw new ImportError('IMPORT_CAPABILITY_REQUIRED', 'Addon did not negotiate imports.providers');
  }
  const grants = Array.isArray(addon.grantedPermissions) ? addon.grantedPermissions : [];
  if (!grants.includes('data:import-provider')) {
    throw new ImportError('IMPORT_PERMISSION', 'Addon lacks permission data:import-provider', 403);
  }
  if (typeof raw.id !== 'string' || !PROVIDER_ID_RE.test(raw.id)) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider id is invalid');
  }
  if (raw.apiVersion !== PROVIDER_API_VERSION) {
    throw new ImportError(
      'IMPORT_PROVIDER_UNSUPPORTED',
      `Provider API version ${raw.apiVersion} is unsupported`,
    );
  }
  if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1 || raw.schemaVersion > 1_000_000) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider schemaVersion must be a positive integer');
  }
  if (!Array.isArray(raw.formats) || !raw.formats.length) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider formats must be a non-empty array');
  }
  const formats = [];
  for (const format of raw.formats) {
    if (!INPUT_FORMATS.has(format)) {
      throw new ImportError('IMPORT_PROVIDER_UNSUPPORTED', `Input format "${format}" is unsupported`);
    }
    if (formats.includes(format)) {
      throw new ImportError('IMPORT_PROVIDER_INVALID', `Duplicate input format "${format}"`);
    }
    formats.push(format);
  }
  const reads = _normalizeRefList(raw.reads || [], 'reads');
  const writes = _normalizeRefList(raw.writes, 'writes');
  if (!writes.length) throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider writes must not be empty');

  const declarations = new Map((addon.collections || []).map(entry => [entry.name, entry]));
  const coreCollections = policy.coreCollections || new Set();
  const resolveType = (ref) => {
    if (ref.scope === 'core') {
      if (!coreCollections.has(ref.collection)) {
        throw new ImportError('IMPORT_PROVIDER_UNDECLARED', 'Provider references an unavailable core collection');
      }
      if (!grants.includes(`data:read:${ref.collection}`)) {
        throw new ImportError('IMPORT_PERMISSION', `Core read requires data:read:${ref.collection}`, 403);
      }
      return 'core';
    }
    if (ref.addonId !== addon.id) {
      throw new ImportError(
        'IMPORT_PROVIDER_FOREIGN',
        'Cross-addon collection access is unsupported by provider API v1',
      );
    }
    const declaration = declarations.get(ref.collection);
    if (!declaration) {
      throw new ImportError('IMPORT_PROVIDER_UNDECLARED', 'Provider references an undeclared addon collection');
    }
    if (!grants.includes('data:own')) {
      throw new ImportError('IMPORT_PERMISSION', 'Addon collection access requires data:own', 403);
    }
    return declaration.keyed ? 'addon-keyed' : 'addon-list';
  };
  reads.forEach(resolveType);
  for (const ref of writes) {
    if (ref.scope === 'core') {
      throw new ImportError(
        'IMPORT_PROVIDER_FOREIGN',
        'Core collection writes are unsupported by provider API v1',
      );
    }
    resolveType(ref);
  }

  if (!addonCapabilities.includes('collections.transactions')) {
    throw new ImportError('IMPORT_CAPABILITY_REQUIRED', 'Import writes require collections.transactions');
  }
  if (!Array.isArray(raw.targetTypes) || !raw.targetTypes.length) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', 'targetTypes must be a non-empty array');
  }
  const targetTypes = [];
  for (const type of raw.targetTypes) {
    if (!TARGET_TYPES.has(type)) throw new ImportError('IMPORT_PROVIDER_UNSUPPORTED', `Target type "${type}" is unsupported`);
    if (targetTypes.includes(type)) throw new ImportError('IMPORT_PROVIDER_INVALID', `Duplicate target type "${type}"`);
    targetTypes.push(type);
  }
  for (const ref of writes) {
    const actual = resolveType(ref);
    if (!targetTypes.includes(actual)) {
      throw new ImportError('IMPORT_PROVIDER_INVALID', `Write target "${collectionRefKey(ref)}" has undeclared type "${actual}"`);
    }
  }

  if (!Array.isArray(raw.capabilities)) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider capabilities must be an array');
  }
  const capabilities = [];
  for (const capability of raw.capabilities) {
    if (!PROVIDER_CAPABILITIES.has(capability)) {
      throw new ImportError('IMPORT_PROVIDER_UNSUPPORTED', `Provider capability "${capability}" is unsupported`);
    }
    if (capabilities.includes(capability)) {
      throw new ImportError('IMPORT_PROVIDER_INVALID', `Duplicate provider capability "${capability}"`);
    }
    capabilities.push(capability);
  }
  if (!capabilities.includes('abort-signal')) {
    throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider must declare abort-signal capability');
  }
  if (typeof raw.preview !== 'function') {
    throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider preview must be a function');
  }

  const limitKeys = new Set([
    'maxInputBytes', 'maxDepth', 'maxRecords', 'maxStringChars',
    'maxOperations', 'timeoutMs',
  ]);
  const requested = raw.limits === undefined ? {} : raw.limits;
  if (!isPlainObject(requested)) throw new ImportError('IMPORT_PROVIDER_INVALID', 'Provider limits must be an object');
  for (const key of Object.keys(requested)) {
    if (!limitKeys.has(key)) throw new ImportError('IMPORT_PROVIDER_INVALID', `Provider limits has unknown field "${key}"`);
  }
  const limits = {};
  for (const key of limitKeys) {
    const maximum = key === 'timeoutMs' ? LIMITS.maxTimeoutMs : LIMITS[key];
    const fallback = key === 'timeoutMs' ? LIMITS.timeoutMs : maximum;
    const candidate = requested[key] === undefined ? fallback : requested[key];
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > maximum) {
      throw new ImportError('IMPORT_PROVIDER_INVALID', `Provider limit ${key} must be an integer from 1 to ${maximum}`);
    }
    limits[key] = candidate;
  }

  return Object.freeze({
    addonId: addon.id,
    id: raw.id,
    key: `${addon.id}:${raw.id}`,
    apiVersion: raw.apiVersion,
    schemaVersion: raw.schemaVersion,
    formats: Object.freeze(formats),
    reads: Object.freeze(reads),
    writes: Object.freeze(writes),
    targetTypes: Object.freeze(targetTypes),
    limits: Object.freeze(limits),
    capabilities: Object.freeze(capabilities),
    packageRevision: String(addon.packageRevision || ''),
    preview: raw.preview,
  });
}

function normalizeDiagnostics(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ImportError('IMPORT_PLAN_INVALID', 'Plan diagnostics must be an array');
  if (raw.length > LIMITS.maxDiagnostics) {
    throw new ImportError('IMPORT_PLAN_INVALID', `Plan diagnostics exceed ${LIMITS.maxDiagnostics}`);
  }
  return raw.map((diagnostic, index) => {
    if (!isPlainObject(diagnostic)) {
      throw new ImportError('IMPORT_PLAN_INVALID', `diagnostics[${index}] must be an object`);
    }
    const allowed = new Set(['severity', 'code', 'message', 'path']);
    for (const key of Object.keys(diagnostic)) {
      if (!allowed.has(key)) throw new ImportError('IMPORT_PLAN_INVALID', `diagnostics[${index}] has unknown field "${key}"`);
    }
    if (!['info', 'warning', 'error'].includes(diagnostic.severity)) {
      throw new ImportError('IMPORT_PLAN_INVALID', `diagnostics[${index}].severity is invalid`);
    }
    if (typeof diagnostic.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(diagnostic.code)) {
      throw new ImportError('IMPORT_PLAN_INVALID', `diagnostics[${index}].code is invalid`);
    }
    if (typeof diagnostic.message !== 'string' || diagnostic.message.length > LIMITS.maxDiagnosticChars) {
      throw new ImportError('IMPORT_PLAN_INVALID', `diagnostics[${index}].message is invalid`);
    }
    let path;
    if (diagnostic.path !== undefined) {
      if (!Array.isArray(diagnostic.path) || diagnostic.path.length > LIMITS.maxDepth
          || diagnostic.path.some(part => !(typeof part === 'string' || Number.isInteger(part)))) {
        throw new ImportError('IMPORT_PLAN_INVALID', `diagnostics[${index}].path is invalid`);
      }
      path = diagnostic.path.slice();
    }
    return {
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(path ? { path } : {}),
    };
  });
}

function normalizePlan(provider, raw, targetTypesByKey) {
  if (!isPlainObject(raw)) throw new ImportError('IMPORT_PLAN_INVALID', 'Provider preview must return an object');
  const allowed = new Set(['schemaVersion', 'operations', 'diagnostics']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ImportError('IMPORT_PLAN_INVALID', `Provider plan has unknown field "${key}"`);
  }
  if (raw.schemaVersion !== provider.schemaVersion) {
    throw new ImportError('IMPORT_PLAN_INVALID', 'Provider plan schemaVersion does not match its descriptor');
  }
  if (!Array.isArray(raw.operations)) throw new ImportError('IMPORT_PLAN_INVALID', 'Plan operations must be an array');
  if (raw.operations.length > provider.limits.maxOperations) {
    throw new ImportError('IMPORT_OPERATION_LIMIT', `Plan exceeds ${provider.limits.maxOperations} operations`);
  }
  const writes = new Set(provider.writes.map(collectionRefKey));
  const writeKeys = new Set();
  const operations = raw.operations.map((operation, index) => {
    if (!isPlainObject(operation)) throw new ImportError('IMPORT_PLAN_INVALID', `operations[${index}] must be an object`);
    const allowedKeys = new Set(['target', 'op', 'id', 'value']);
    for (const key of Object.keys(operation)) {
      if (!allowedKeys.has(key)) throw new ImportError('IMPORT_PLAN_INVALID', `operations[${index}] has unknown field "${key}"`);
    }
    const target = normalizeCollectionRef(operation.target, `operations[${index}].target`);
    const targetKey = collectionRefKey(target);
    if (!writes.has(targetKey)) {
      throw new ImportError('IMPORT_PROVIDER_UNDECLARED', `operations[${index}] targets an undeclared write collection`);
    }
    const targetType = targetTypesByKey.get(targetKey);
    if (!provider.targetTypes.includes(targetType)) {
      throw new ImportError('IMPORT_PLAN_INVALID', `operations[${index}] targets unsupported type "${targetType}"`);
    }
    if (operation.op !== 'put') {
      throw new ImportError('IMPORT_PLAN_INVALID', `operations[${index}].op must be "put"`);
    }
    if (typeof operation.id !== 'string' || !operation.id || operation.id.length > 200
        || FORBIDDEN_KEYS.has(operation.id)) {
      throw new ImportError('IMPORT_PLAN_INVALID', `operations[${index}].id is invalid`);
    }
    const writeKey = `${targetKey}\0${operation.id}`;
    if (writeKeys.has(writeKey)) {
      throw new ImportError('IMPORT_PLAN_INVALID', `Record "${targetKey}/${operation.id}" is written more than once`);
    }
    writeKeys.add(writeKey);
    if (!isPlainObject(operation.value)) {
      throw new ImportError('IMPORT_PLAN_INVALID', `operations[${index}].value must be an object`);
    }
    assertSafeJson(operation.value, `operations[${index}].value`);
    for (const field of PROTECTED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(operation.value, field)) {
        throw new ImportError(
          'IMPORT_PROTECTED_FIELD',
          `operations[${index}].value attempts to set protected field "${field}"`,
          400,
          { operation: index, field },
        );
      }
    }
    if (byteLength(operation.value) > 256 * 1024) {
      throw new ImportError('IMPORT_OPERATION_LIMIT', `operations[${index}].value exceeds 262144 bytes`);
    }
    return { target, op: 'put', id: operation.id, value: clone(operation.value) };
  });
  if (byteLength(operations) > 2 * 1024 * 1024) {
    throw new ImportError('IMPORT_OPERATION_LIMIT', 'Plan operations exceed 2097152 bytes');
  }
  return { operations, diagnostics: normalizeDiagnostics(raw.diagnostics) };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function digestPlan(plan) {
  return crypto.createHash('sha256').update(stableStringify(plan)).digest('hex');
}

module.exports = {
  ImportError,
  LIMITS,
  PLAN_VERSION,
  PROVIDER_API_VERSION,
  PROTECTED_FIELDS,
  assertSafeJson,
  byteLength,
  clone,
  collectionRefKey,
  digestPlan,
  isPlainObject,
  normalizeCollectionRef,
  normalizePlan,
  normalizeProviderDescriptor,
  parseJsonStrict,
  stableStringify,
};
