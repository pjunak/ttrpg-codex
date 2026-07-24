'use strict';

const { HOST_CAPABILITIES } = require('./addon-compat.cjs');
const { collectionRefKey } = require('./import-contract.cjs');
const { ImportJobManager } = require('./import-jobs.cjs');
const { revisionOf } = require('./collection-transactions.cjs');

function createMockImportHost(meta = {}, opts = {}) {
  meta = {
    id: 'mock-addon',
    apiVersion: 2,
    capabilities: {
      required: ['collections.dm', 'collections.transactions', 'imports.providers'],
    },
    permissions: ['server:code', 'data:own', 'data:import-provider'],
    collections: [{ name: 'items', keyed: false, access: 'dm' }],
    contentRevision: 'mock-package',
    ...meta,
  };
  const store = new Map();
  for (const declaration of meta.collections || []) {
    const seeded = opts.collections?.[declaration.name];
    store.set(
      collectionRefKey({ scope: 'addon', addonId: meta.id, collection: declaration.name }),
      structuredClone(seeded ?? (declaration.keyed ? {} : [])),
    );
  }
  for (const [name, value] of Object.entries(opts.coreCollections || {})) {
    store.set(collectionRefKey({ scope: 'core', collection: name }), structuredClone(value));
  }

  const inputs = new Map();
  let inputSequence = 0;
  let events = 0;
  const targetType = ref => {
    if (ref.scope === 'core') return 'core';
    const declaration = (meta.collections || []).find(entry => entry.name === ref.collection);
    return declaration?.keyed ? 'addon-keyed' : 'addon-list';
  };
  const snapshot = refs => {
    const values = {};
    const revisions = {};
    const targetTypes = new Map();
    for (const ref of refs) {
      const key = collectionRefKey(ref);
      const value = structuredClone(
        store.get(key) ?? (targetType(ref) === 'addon-keyed' ? {} : []),
      );
      values[key] = value;
      revisions[key] = revisionOf(value);
      targetTypes.set(key, targetType(ref));
    }
    return { values, revisions, targetTypes };
  };

  const manager = new ImportJobManager({
    coreCollections: new Set(Object.keys(opts.coreCollections || {})),
    now: opts.now || (() => Date.now()),
    randomBytes: opts.randomBytes,
    readFile: async path => {
      if (!inputs.has(path)) {
        const error = new Error('Input not found');
        error.code = 'ENOENT';
        throw error;
      }
      return inputs.get(path);
    },
    unlinkFile: async path => {
      inputs.delete(path);
    },
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    limits: opts.limits,
    snapshotCollections: async ({ refs }) => snapshot(refs),
    commitOperations: async ({ plan, clientAborted }) => {
      if (clientAborted()) {
        const error = new Error('Client disconnected');
        error.code = 'TX_EXPIRED';
        error.status = 409;
        throw error;
      }
      const refs = [...new Map([...plan.readSet, ...plan.writeSet]
        .map(ref => [collectionRefKey(ref), ref])).values()];
      const current = snapshot(refs);
      for (const ref of refs) {
        const key = collectionRefKey(ref);
        if (current.revisions[key] !== plan.baseRevisions[key]) {
          const error = new Error('Transaction snapshot is stale');
          error.code = 'TX_CONFLICT';
          error.status = 409;
          error.details = { collection: key };
          throw error;
        }
      }

      const staged = new Map(
        [...store].map(([key, value]) => [key, structuredClone(value)]),
      );
      for (const operation of plan.operations) {
        const key = collectionRefKey(operation.target);
        const container = staged.get(key);
        if (targetType(operation.target) === 'addon-keyed') {
          container[operation.id] = structuredClone(operation.value);
        } else {
          const value = { ...structuredClone(operation.value), id: operation.id };
          const index = container.findIndex(entry => entry?.id === operation.id);
          if (index >= 0) container[index] = value;
          else container.push(value);
        }
      }
      if (opts.failCommit) throw new Error('Injected import commit failure');

      const changed = [];
      for (const ref of plan.writeSet) {
        const key = collectionRefKey(ref);
        if (revisionOf(staged.get(key)) === revisionOf(store.get(key))) continue;
        store.set(key, staged.get(key));
        changed.push(ref.collection);
      }
      if (changed.length) events++;
      const revisions = Object.fromEntries(plan.writeSet.map(ref => {
        const key = collectionRefKey(ref);
        return [ref.collection, revisionOf(store.get(key))];
      }));
      return {
        ok: true,
        commitId: changed.length ? `mock-import-${events}` : null,
        changed,
        revisions,
      };
    },
  });

  const registrations = [];
  const addon = {
    id: meta.id,
    apiVersion: meta.apiVersion,
    capabilities: meta.capabilities,
    collections: meta.collections,
    grantedPermissions: meta.permissions,
    packageRevision: meta.contentRevision,
  };
  const host = {
    id: meta.id,
    apiVersion: meta.apiVersion,
    capabilities: Object.freeze({
      has: capability => HOST_CAPABILITIES.has(capability),
      supported: Object.freeze([...HOST_CAPABILITIES]),
    }),
    registerImportProvider(descriptor) {
      const registration = manager.registerProvider(addon, descriptor);
      registrations.push(registration.dispose);
      return registration.dispose;
    },
  };

  return {
    host,
    manager,
    providers: () => manager.listProviders(),
    events: () => events,
    collection(name) {
      return structuredClone(store.get(collectionRefKey({
        scope: 'addon',
        addonId: meta.id,
        collection: name,
      })));
    },
    setCollection(ref, value) {
      store.set(collectionRefKey(ref), structuredClone(value));
    },
    createJob(providerId, input, jobOpts = {}) {
      const path = `memory:import-${++inputSequence}`;
      const bytes = Buffer.from(
        typeof input === 'string' ? input : JSON.stringify(input),
        'utf8',
      );
      inputs.set(path, bytes);
      return manager.createJob({
        addonId: meta.id,
        providerId,
        owner: jobOpts.owner || 'mock-session',
        format: jobOpts.format || 'json',
        input: {
          path,
          size: bytes.byteLength,
          originalName: jobOpts.originalName || 'input.json',
          mimeType: jobOpts.mimeType || 'application/json',
        },
      });
    },
    async dispose() {
      while (registrations.length) registrations.pop()();
      await manager.dispose();
    },
  };
}

module.exports = { createMockImportHost };
