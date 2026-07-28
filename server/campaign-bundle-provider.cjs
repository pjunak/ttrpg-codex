'use strict';

const {
  MAX_MATERIALIZED_WRITES,
  SCHEMA_VERSION,
  planCampaignBundle,
} = require('./campaign-bundle-contract.cjs');
const {
  clone,
  collectionRefKey,
  isPlainObject,
  normalizePlan,
} = require('./import-contract.cjs');

const PROVIDER_ID = 'campaign-bundle';
const READ_COLLECTIONS = Object.freeze([
  'characters',
  'relationships',
  'locations',
  'events',
  'mysteries',
  'factions',
  'pantheon',
  'artifacts',
  'historicalEvents',
  'settings',
]);
const WRITE_COLLECTIONS = Object.freeze([
  'characters',
  'locations',
  'relationships',
]);
const READS = Object.freeze(READ_COLLECTIONS.map(collection =>
  Object.freeze({ scope: 'core', collection })));
const WRITES = Object.freeze(WRITE_COLLECTIONS.map(collection =>
  Object.freeze({ scope: 'core', collection })));
const CONTRIBUTION_FIELDS = new Set(['addonId', 'contributorId', 'document']);
const LOCAL_REFERENCE_FIELDS = new Set(['$ref']);

function uniqueRefs(refs) {
  return [...new Map(refs.map(ref => [collectionRefKey(ref), ref])).values()];
}

function contributionDiagnostic(severity, code, message, path) {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function resolveContributionRefs(value, references, diagnostics, path = []) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      resolveContributionRefs(entry, references, diagnostics, [...path, index]));
  }
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && LOCAL_REFERENCE_FIELDS.has(keys[0])) {
    if (typeof value.$ref !== 'string' || !references.has(value.$ref)) {
      diagnostics.push(contributionDiagnostic(
        'error',
        'BUNDLE_CONTRIBUTION_REFERENCE_MISSING',
        `Unknown campaign bundle reference "${String(value.$ref || '')}".`,
        path,
      ));
      return '';
    }
    return references.get(value.$ref);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    resolveContributionRefs(entry, references, diagnostics, [...path, key]),
  ]));
}

function recordFromSnapshot(container, targetType, id) {
  if (targetType === 'addon-keyed') {
    const value = isPlainObject(container?.[id]) ? container[id] : null;
    return value ? { id, ...clone(value) } : null;
  }
  if (!Array.isArray(container)) return null;
  const value = container.find(record => record?.id === id);
  return value ? clone(value) : null;
}

function contributorContext(provider, context) {
  const reads = new Set(provider.reads.map(collectionRefKey));
  const assertRead = ref => {
    const key = collectionRefKey(ref);
    if (!reads.has(key)) throw new Error('Bundle contributor attempted an undeclared read');
    return ref;
  };
  return Object.freeze({
    signal: context.signal,
    read: ref => context.read(assertRead(ref)),
    revision: ref => context.revision(assertRead(ref)),
  });
}

async function planContributions(source, context, contributions, corePlan, input) {
  const diagnostics = [];
  const operations = [];
  const changes = [];
  const summaries = [];
  if (source?.addonImports !== undefined && !Array.isArray(source.addonImports)) {
    diagnostics.push(contributionDiagnostic(
      'error',
      'BUNDLE_ADDON_IMPORT_INVALID',
      'addonImports must be an array.',
      ['addonImports'],
    ));
  }
  const values = Array.isArray(source?.addonImports) ? source.addonImports : [];
  const byKey = new Map(contributions.map(contribution => [
    `${contribution.addonId}:${contribution.id}`,
    contribution,
  ]));
  const seen = new Set();
  const references = new Map(
    (corePlan.review?.references || []).map(entry => [entry.ref, entry.id]),
  );

  if (values.length > 8) {
    diagnostics.push(contributionDiagnostic(
      'error',
      'BUNDLE_CONTRIBUTION_LIMIT',
      'Campaign bundle schema version 1 supports at most 8 addon contributions.',
      ['addonImports'],
    ));
  }
  for (let index = 0; index < Math.min(values.length, 8); index++) {
    const raw = values[index];
    const path = ['addonImports', index];
    if (!isPlainObject(raw)) {
      diagnostics.push(contributionDiagnostic(
        'error',
        'BUNDLE_CONTRIBUTION_INVALID',
        'Addon contribution must be an object.',
        path,
      ));
      continue;
    }
    for (const field of Object.keys(raw)) {
      if (!CONTRIBUTION_FIELDS.has(field)) {
        diagnostics.push(contributionDiagnostic(
          'error',
          'BUNDLE_CONTRIBUTION_UNKNOWN_FIELD',
          `Unknown addon contribution field "${field}".`,
          [...path, field],
        ));
      }
    }
    const key = `${raw.addonId}:${raw.contributorId}`;
    const contribution = byKey.get(key);
    if (!contribution) {
      diagnostics.push(contributionDiagnostic(
        'error',
        'BUNDLE_CONTRIBUTOR_UNAVAILABLE',
        `Bundle contributor "${key}" is not available.`,
        path,
      ));
      continue;
    }
    if (seen.has(key)) {
      diagnostics.push(contributionDiagnostic(
        'error',
        'BUNDLE_CONTRIBUTOR_DUPLICATE',
        `Bundle contributor "${key}" appears more than once.`,
        path,
      ));
      continue;
    }
    seen.add(key);
    if (!isPlainObject(raw.document)) {
      diagnostics.push(contributionDiagnostic(
        'error',
        'BUNDLE_CONTRIBUTION_DOCUMENT_INVALID',
        'Addon contribution document must be an object.',
        [...path, 'document'],
      ));
      continue;
    }
    const resolvedDocument = resolveContributionRefs(
      raw.document,
      references,
      diagnostics,
      [...path, 'document'],
    );
    const rawPlan = await contribution.provider.preview(
      Object.freeze({
        format: 'json',
        data: clone(resolvedDocument),
        metadata: Object.freeze({
          ...input.metadata,
          originalName: `${input.metadata.originalName || 'campaign-bundle.json'}#${key}`,
        }),
        stats: input.stats,
      }),
      contributorContext(contribution.provider, context),
    );
    const normalized = normalizePlan(
      contribution.provider,
      rawPlan,
      contribution.targetTypesByKey,
    );
    const contributionChanges = [];
    for (const operation of normalized.operations) {
      const targetKey = collectionRefKey(operation.target);
      const targetType = contribution.targetTypesByKey.get(targetKey);
      const before = recordFromSnapshot(context.read(operation.target), targetType, operation.id);
      const after = { id: operation.id, ...clone(operation.value) };
      operations.push({
        ...operation,
        meta: {
          status: before ? 'update' : 'create',
          derived: false,
          contributor: {
            addonId: contribution.addonId,
            id: contribution.id,
          },
        },
      });
      contributionChanges.push({
        collection: `${operation.target.addonId}:${operation.target.collection}`,
        id: operation.id,
        status: before ? 'update' : 'create',
        derived: false,
        contributor: {
          addonId: contribution.addonId,
          id: contribution.id,
        },
        before,
        after,
      });
    }
    changes.push(...contributionChanges);
    diagnostics.push(...normalized.diagnostics.map(entry => ({
      ...entry,
      path: [...path, 'document', ...(entry.path || [])],
    })));
    summaries.push({
      addonId: contribution.addonId,
      contributorId: contribution.id,
      providerId: contribution.provider.id,
      materializedWriteCount: contributionChanges.length,
    });
  }
  return { diagnostics, operations, changes, summaries };
}

function descriptor({ createId, contributions = [] } = {}) {
  if (typeof createId !== 'function') {
    throw new TypeError('Campaign bundle provider requires createId');
  }
  const reads = Object.freeze(uniqueRefs([
    ...READS,
    ...contributions.flatMap(contribution => [
      ...contribution.provider.reads,
      ...contribution.provider.writes,
    ]),
  ]));
  const writes = Object.freeze(uniqueRefs([
    ...WRITES,
    ...contributions.flatMap(contribution => contribution.provider.writes),
  ]));
  const targetTypes = Object.freeze([...new Set([
    'core',
    ...contributions.flatMap(contribution => contribution.provider.targetTypes),
  ])]);
  return {
    id: PROVIDER_ID,
    apiVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    formats: ['json'],
    reads,
    writes,
    targetTypes,
    limits: {
      maxInputBytes: 2 * 1024 * 1024,
      maxDepth: 32,
      maxRecords: 10_000,
      maxStringChars: 256 * 1024,
      maxOperations: MAX_MATERIALIZED_WRITES,
      timeoutMs: 5_000,
    },
    capabilities: ['abort-signal', 'structured-diagnostics'],
    schema: {
      id: 'campaign-bundle-v1',
      version: SCHEMA_VERSION,
      url: '/api/content-import/schemas/campaign-bundle-v1',
    },
    async preview(input, context) {
      const snapshot = Object.fromEntries(READS.map(ref => [
        collectionRefKey(ref),
        context.read(ref),
      ]));
      const coreSource = isPlainObject(input.data)
        ? { ...clone(input.data), addonImports: [] }
        : input.data;
      const plan = planCampaignBundle(coreSource, { snapshot, createId });
      const contributed = await planContributions(
        input.data,
        context,
        contributions,
        plan,
        input,
      );
      const available = Math.max(0, MAX_MATERIALIZED_WRITES - plan.operations.length);
      if (contributed.operations.length > available) {
        plan.diagnostics.push(contributionDiagnostic(
          'error',
          'BUNDLE_OPERATION_LIMIT',
          `Expanded bundle exceeds ${MAX_MATERIALIZED_WRITES} materialized writes.`,
          ['addonImports'],
        ));
      } else {
        plan.operations.push(...contributed.operations);
        plan.review.changes.push(...contributed.changes);
      }
      plan.diagnostics.push(...contributed.diagnostics);
      plan.review.materializedWriteCount = plan.operations.length;
      plan.review.contributions = contributed.summaries;
      return plan;
    },
  };
}

module.exports = {
  PROVIDER_ID,
  READS,
  WRITES,
  descriptor,
};
