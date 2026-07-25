'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {
  durableCopy,
  durableUnlink,
  durableWrite,
  fsyncDirectory,
} = require('./durable-files.cjs');

const TX_ID_RE = /^tx-[0-9a-f]{32}$/;
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const COLLECTION_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const STATES = new Set(['prepared', 'publishing', 'rolling-back', 'committed', 'rolled-back']);

const LIMITS = Object.freeze({
  maxCollections: 16,
  maxOperations: 256,
  maxPayloadBytes: 2 * 1024 * 1024,
  maxRecordBytes: 256 * 1024,
  minTimeoutMs: 250,
  maxTimeoutMs: 10_000,
  defaultTimeoutMs: 5_000,
  maxLeases: 256,
});

class TransactionError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeJson(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TransactionError('TX_VALIDATION', `${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') {
    throw new TransactionError('TX_VALIDATION', `${label} contains a non-JSON value`);
  }
  if (seen.has(value)) throw new TransactionError('TX_VALIDATION', `${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertSafeJson(value[i], `${label}[${i}]`, seen);
  } else {
    if (!isPlainObject(value)) throw new TransactionError('TX_VALIDATION', `${label} must use plain objects`);
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new TransactionError('TX_VALIDATION', `${label} contains forbidden key "${key}"`);
      assertSafeJson(value[key], `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function revisionOf(value) {
  const raw = JSON.stringify(value);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function normalizeTimeout(value) {
  if (value === undefined) return LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(value) || value < LIMITS.minTimeoutMs || value > LIMITS.maxTimeoutMs) {
    throw new TransactionError(
      'TX_LIMIT',
      `timeoutMs must be an integer from ${LIMITS.minTimeoutMs} to ${LIMITS.maxTimeoutMs}`,
    );
  }
  return value;
}

function normalizeCollections(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    throw new TransactionError('TX_VALIDATION', 'collections must be a non-empty array');
  }
  if (raw.length > LIMITS.maxCollections) {
    throw new TransactionError('TX_LIMIT', `transactions support at most ${LIMITS.maxCollections} collections`);
  }
  const seen = new Set();
  const names = [];
  for (const name of raw) {
    if (typeof name !== 'string' || !COLLECTION_RE.test(name)) {
      throw new TransactionError('TX_NOT_FOUND', 'Collection not found', 404);
    }
    if (seen.has(name)) throw new TransactionError('TX_VALIDATION', `duplicate collection "${name}"`);
    seen.add(name);
    names.push(name);
  }
  return names;
}

function normalizeOperations(raw, allowedNames) {
  if (!Array.isArray(raw)) throw new TransactionError('TX_VALIDATION', 'operations must be an array');
  if (raw.length > LIMITS.maxOperations) {
    throw new TransactionError('TX_LIMIT', `transactions support at most ${LIMITS.maxOperations} operations`);
  }
  let payloadBytes;
  try { payloadBytes = Buffer.byteLength(JSON.stringify(raw)); }
  catch { throw new TransactionError('TX_VALIDATION', 'operations must be JSON-serializable'); }
  if (payloadBytes > LIMITS.maxPayloadBytes) {
    throw new TransactionError('TX_LIMIT', `transaction payload exceeds ${LIMITS.maxPayloadBytes} bytes`);
  }

  const writes = new Set();
  return raw.map((operation, index) => {
    if (!isPlainObject(operation)) throw new TransactionError('TX_VALIDATION', `operations[${index}] must be an object`);
    const allowedKeys = operation.op === 'put'
      ? new Set(['collection', 'op', 'id', 'value'])
      : new Set(['collection', 'op', 'id']);
    for (const key of Object.keys(operation)) {
      if (!allowedKeys.has(key)) throw new TransactionError('TX_VALIDATION', `operations[${index}] has unknown field "${key}"`);
    }
    const { collection, op, id } = operation;
    if (!allowedNames.has(collection)) {
      throw new TransactionError('TX_VALIDATION', `operations[${index}] targets a collection outside the read set`);
    }
    if (op !== 'put' && op !== 'delete') {
      throw new TransactionError('TX_VALIDATION', `operations[${index}].op must be "put" or "delete"`);
    }
    if (typeof id !== 'string' || !id || id.length > 200 || FORBIDDEN_KEYS.has(id)) {
      throw new TransactionError('TX_VALIDATION', `operations[${index}].id is invalid`);
    }
    const writeKey = `${collection}\0${id}`;
    if (writes.has(writeKey)) {
      throw new TransactionError('TX_DUPLICATE_WRITE', `record "${collection}/${id}" is written more than once`);
    }
    writes.add(writeKey);
    if (op === 'put') {
      if (!isPlainObject(operation.value)) {
        throw new TransactionError('TX_VALIDATION', `operations[${index}].value must be an object`);
      }
      assertSafeJson(operation.value, `operations[${index}].value`);
      const recordBytes = Buffer.byteLength(JSON.stringify(operation.value));
      if (recordBytes > LIMITS.maxRecordBytes) {
        throw new TransactionError('TX_LIMIT', `operations[${index}].value exceeds ${LIMITS.maxRecordBytes} bytes`);
      }
      if (operation.value.id !== undefined && operation.value.id !== id) {
        throw new TransactionError('TX_VALIDATION', `operations[${index}].value.id must match id`);
      }
      return { collection, op, id, value: clone(operation.value) };
    }
    return { collection, op, id };
  });
}

function applyOperations(containers, descriptors, operations) {
  const next = new Map();
  for (const [name, value] of containers) next.set(name, clone(value));
  for (const operation of operations) {
    const descriptor = descriptors.get(operation.collection);
    const container = next.get(operation.collection);
    if (descriptor.keyed) {
      if (operation.op === 'put') {
        const value = clone(operation.value);
        delete value.id;
        container[operation.id] = value;
      } else {
        delete container[operation.id];
      }
      continue;
    }
    const index = container.findIndex(record => record && record.id === operation.id);
    if (operation.op === 'put') {
      const value = { ...clone(operation.value), id: operation.id };
      if (index >= 0) container[index] = value;
      else container.push(value);
    } else if (index >= 0) {
      container.splice(index, 1);
    }
  }
  return next;
}

async function cleanupTransactionDir(runtimeDir, txDir, transactionId) {
  const cleanupDir = path.join(
    runtimeDir,
    `.cleanup-${transactionId}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    await fsp.rename(txDir, cleanupDir);
    await fsyncDirectory(runtimeDir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await fsp.rm(cleanupDir, { recursive: true, force: true });
  await fsyncDirectory(runtimeDir);
}

function validateJournal(journal, runtimeDir, addonDataDir) {
  if (!isPlainObject(journal) || journal.version !== 1 || !TX_ID_RE.test(journal.id || '')
      || !ADDON_ID_RE.test(journal.addonId || '') || !STATES.has(journal.state)
      || !Array.isArray(journal.entries) || !journal.entries.length
      || journal.entries.length > LIMITS.maxCollections) {
    throw new TransactionError('TX_JOURNAL_INVALID', 'Invalid transaction journal');
  }
  const txDir = path.join(runtimeDir, journal.id);
  const seen = new Set();
  const entries = journal.entries.map(entry => {
    if (!isPlainObject(entry) || !COLLECTION_RE.test(entry.collection || '')
        || typeof entry.keyed !== 'boolean' || !['public', 'dm'].includes(entry.access)
        || typeof entry.originalExists !== 'boolean') {
      throw new TransactionError('TX_JOURNAL_INVALID', 'Invalid transaction journal entry');
    }
    if (seen.has(entry.collection)) throw new TransactionError('TX_JOURNAL_INVALID', 'Duplicate journal collection');
    seen.add(entry.collection);
    const expectedTarget = path.join(addonDataDir, journal.addonId, `${entry.collection}.json`);
    const original = path.join(txDir, `${entry.collection}.original.json`);
    const next = path.join(txDir, `${entry.collection}.next.json`);
    return { ...entry, target: expectedTarget, original, next };
  });
  return { txDir, entries };
}

class CollectionTransactionManager {
  constructor({
    runtimeDir,
    addonDataDir,
    publicationBarrier,
    resolveCollection,
    onCommit = async () => {},
    onRecoveredCommit = async () => {},
    onFatal = () => {},
    fault = () => {},
    now = () => Date.now(),
  }) {
    this.runtimeDir = runtimeDir;
    this.addonDataDir = addonDataDir;
    this.publicationBarrier = publicationBarrier;
    this.resolveCollection = resolveCollection;
    this.onCommit = onCommit;
    this.onRecoveredCommit = onRecoveredCommit;
    this.onFatal = onFatal;
    this.fault = fault;
    this.now = now;
    this.leases = new Map();
  }

  limits() {
    return LIMITS;
  }

  #pruneLeases() {
    const now = this.now();
    for (const [id, lease] of this.leases) if (lease.deadline <= now) this.leases.delete(id);
  }

  async begin({ addonId, role, collections, timeoutMs }) {
    this.#pruneLeases();
    if (this.leases.size >= LIMITS.maxLeases) {
      throw new TransactionError('TX_BUSY', 'Too many active transactions', 503);
    }
    const names = normalizeCollections(collections);
    const timeout = normalizeTimeout(timeoutMs);
    const descriptors = new Map();
    const snapshot = {};
    const revisions = {};
    for (const name of names) {
      const descriptor = this.resolveCollection(addonId, name, role);
      descriptors.set(name, descriptor);
      const fallback = descriptor.keyed ? {} : [];
      let value;
      try { value = JSON.parse(await fsp.readFile(descriptor.path, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        value = fallback;
      }
      const validShape = descriptor.keyed ? isPlainObject(value) : Array.isArray(value);
      if (!validShape) throw new TransactionError('TX_STORAGE_INVALID', `Collection "${name}" has an invalid stored shape`, 500);
      assertSafeJson(value, `collection.${name}`);
      snapshot[name] = clone(value);
      revisions[name] = revisionOf(value);
    }
    const id = `tx-${crypto.randomBytes(16).toString('hex')}`;
    const deadline = this.now() + timeout;
    this.leases.set(id, { id, addonId, role, names, descriptors, revisions, deadline, committing: false });
    return { transactionId: id, deadline, snapshot, revisions, limits: LIMITS };
  }

  cancel({ addonId, transactionId }) {
    const lease = this.leases.get(transactionId);
    if (lease && lease.addonId === addonId) this.leases.delete(transactionId);
    return { ok: true };
  }

  async commit({ addonId, role, transactionId, operations, clientAborted = () => false }) {
    this.#pruneLeases();
    const lease = this.leases.get(transactionId);
    if (!lease || lease.addonId !== addonId || lease.role !== role || lease.committing) {
      throw new TransactionError('TX_EXPIRED', 'Transaction expired or was already used', 409);
    }
    lease.committing = true;
    const abortIfNeeded = () => {
      if (clientAborted() || this.now() >= lease.deadline) {
        this.leases.delete(transactionId);
        throw new TransactionError('TX_EXPIRED', 'Transaction expired before commit', 409);
      }
    };
    abortIfNeeded();
    let normalized;
    try {
      normalized = normalizeOperations(operations, new Set(lease.names));
    } catch (error) {
      this.leases.delete(transactionId);
      throw error;
    }

    const descriptors = new Map();
    const current = new Map();
    const currentRevisions = {};
    try {
      for (const name of lease.names) {
        const descriptor = this.resolveCollection(addonId, name, role);
        descriptors.set(name, descriptor);
        const fallback = descriptor.keyed ? {} : [];
        let value;
        try { value = JSON.parse(await fsp.readFile(descriptor.path, 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          value = fallback;
        }
        const validShape = descriptor.keyed ? isPlainObject(value) : Array.isArray(value);
        if (!validShape) throw new TransactionError('TX_STORAGE_INVALID', `Collection "${name}" has an invalid stored shape`, 500);
        const revision = revisionOf(value);
        current.set(name, value);
        currentRevisions[name] = revision;
        if (revision !== lease.revisions[name]) {
          throw new TransactionError('TX_CONFLICT', 'Transaction snapshot is stale', 409, {
            collection: name,
            expectedRevision: lease.revisions[name],
            actualRevision: revision,
          });
        }
      }
    } catch (error) {
      this.leases.delete(transactionId);
      throw error;
    }
    abortIfNeeded();

    const next = applyOperations(current, descriptors, normalized);
    const changedNames = lease.names.filter(name => revisionOf(next.get(name)) !== currentRevisions[name]);
    if (!changedNames.length) {
      this.leases.delete(transactionId);
      const collections = Object.fromEntries(lease.names.map(name => [name, clone(current.get(name))]));
      return { ok: true, commitId: null, changed: [], collections, revisions: currentRevisions };
    }

    const commitId = `tx-${crypto.randomBytes(16).toString('hex')}`;
    const txDir = path.join(this.runtimeDir, commitId);
    await fsp.mkdir(txDir, { recursive: true });
    const entries = [];
    try {
      for (let index = 0; index < changedNames.length; index++) {
        const name = changedNames[index];
        const descriptor = descriptors.get(name);
        const originalExists = await fsp.access(descriptor.path).then(() => true, () => false);
        const original = path.join(txDir, `${name}.original.json`);
        const nextFile = path.join(txDir, `${name}.next.json`);
        await this.fault(`stage:${index}:before`);
        await durableWrite(original, JSON.stringify(current.get(name), null, 2));
        await durableWrite(nextFile, JSON.stringify(next.get(name), null, 2));
        await this.fault(`stage:${index}:after`);
        entries.push({
          collection: name,
          keyed: descriptor.keyed,
          access: descriptor.access,
          originalExists,
          beforeRevision: currentRevisions[name],
          afterRevision: revisionOf(next.get(name)),
        });
      }
      abortIfNeeded();
      let journal = {
        version: 1,
        id: commitId,
        addonId,
        state: 'prepared',
        createdAt: new Date(this.now()).toISOString(),
        entries,
      };
      const journalPath = path.join(txDir, 'journal.json');
      await this.fault('journal:prepared:before');
      await durableWrite(journalPath, JSON.stringify(journal, null, 2));
      await this.fault('journal:prepared:after');

      let commitJournalDurable = false;
      await this.publicationBarrier.publish(async () => {
        try {
          journal = { ...journal, state: 'publishing' };
          await this.fault('journal:publishing:before');
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          await this.fault('journal:publishing:after');
          for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            const descriptor = descriptors.get(entry.collection);
            await this.fault(`publish:${index}:before`);
            await durableCopy(path.join(txDir, `${entry.collection}.next.json`), descriptor.path);
            await this.fault(`publish:${index}:after`);
          }
          journal = { ...journal, state: 'committed' };
          await this.fault('journal:committed:before');
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          commitJournalDurable = true;
          await this.fault('journal:committed:after');
        } catch (publicationError) {
          if (commitJournalDurable) throw publicationError;
          try {
            journal = { ...journal, state: 'rolling-back' };
            await durableWrite(journalPath, JSON.stringify(journal, null, 2));
            for (let index = 0; index < entries.length; index++) {
              const entry = entries[index];
              const descriptor = descriptors.get(entry.collection);
              const original = path.join(txDir, `${entry.collection}.original.json`);
              await this.fault(`rollback:${index}:before`);
              if (entry.originalExists) await durableCopy(original, descriptor.path);
              else await durableUnlink(descriptor.path);
              await this.fault(`rollback:${index}:after`);
            }
            journal = { ...journal, state: 'rolled-back' };
            await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          } catch (rollbackError) {
            publicationError.rollbackError = rollbackError;
            const fatalError = new Error(`Transaction ${commitId} rollback failed; startup recovery required`);
            fatalError.cause = rollbackError;
            this.publicationBarrier.poison(fatalError);
            this.onFatal(fatalError);
          }
          throw publicationError;
        }
      });

      this.leases.delete(transactionId);
      const access = entries.every(entry => entry.access === 'dm') ? 'dm' : 'public';
      try {
        await this.onCommit({ commitId, addonId, access, changed: changedNames });
      } catch (effectError) {
        console.error(`[transaction ${commitId}] post-commit effects failed:`, effectError);
      }
      try {
        journal = { ...journal, effectsApplied: true };
        await durableWrite(path.join(txDir, 'journal.json'), JSON.stringify(journal, null, 2));
      } catch (markerError) {
        console.warn(`[transaction ${commitId}] effects marker deferred:`, markerError.message);
      }
      try {
        await this.fault('cleanup:before');
        await cleanupTransactionDir(this.runtimeDir, txDir, commitId);
        await this.fault('cleanup:after');
      } catch (cleanupError) {
        console.warn(`[transaction ${commitId}] committed journal cleanup deferred:`, cleanupError.message);
      }

      const revisions = {};
      const collections = {};
      for (const name of lease.names) {
        collections[name] = clone(next.get(name));
        revisions[name] = revisionOf(next.get(name));
      }
      return { ok: true, commitId, changed: changedNames, collections, revisions };
    } catch (error) {
      this.leases.delete(transactionId);
      const journalPath = path.join(txDir, 'journal.json');
      let journal = null;
      let journalExists = false;
      let journalError = null;
      try {
        const raw = await fsp.readFile(journalPath, 'utf8');
        journalExists = true;
        try { journal = JSON.parse(raw); }
        catch (parseError) { journalError = parseError; }
      } catch (readError) {
        if (readError.code !== 'ENOENT') journalError = readError;
      }
      if (journalError) {
        const fatalError = new Error(`Transaction ${commitId} journal became unreadable; startup recovery required`);
        fatalError.cause = journalError;
        error.rollbackError ||= fatalError;
        this.publicationBarrier.poison(fatalError);
        this.onFatal(fatalError);
      }
      if (error.rollbackError) {
        // Leave every durable artifact in place. The barrier is poisoned and
        // onFatal is terminating the process; startup recovery is the only
        // safe authority for a transaction whose rollback did not complete.
      } else if (journal?.state === 'committed') {
        const access = entries.every(entry => entry.access === 'dm') ? 'dm' : 'public';
        try { await this.onCommit({ commitId, addonId, access, changed: changedNames }); }
        catch (effectError) {
          console.error(`[transaction ${commitId}] post-commit effects failed:`, effectError);
        }
        try {
          journal = { ...journal, effectsApplied: true };
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
        } catch (_) {}
        await cleanupTransactionDir(this.runtimeDir, txDir, commitId).catch(() => {});
        const revisions = {};
        const collections = {};
        for (const name of lease.names) {
          collections[name] = clone(next.get(name));
          revisions[name] = revisionOf(next.get(name));
        }
        return { ok: true, commitId, changed: changedNames, collections, revisions };
      }
      if (journal?.state === 'rolled-back') {
        await cleanupTransactionDir(this.runtimeDir, txDir, commitId).catch(() => {});
      } else if (journal && !error.rollbackError) {
        try {
          journal = { ...journal, state: 'rolling-back' };
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          const validated = validateJournal(journal, this.runtimeDir, this.addonDataDir);
          await this.publicationBarrier.publish(async () => {
            for (const entry of validated.entries) {
              if (entry.originalExists) await durableCopy(entry.original, entry.target);
              else await durableUnlink(entry.target);
            }
          });
          journal = { ...journal, state: 'rolled-back' };
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          await cleanupTransactionDir(this.runtimeDir, txDir, commitId);
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
      } else if (!journalExists) {
        await fsp.rm(txDir, { recursive: true, force: true }).catch(() => {});
      }
      if (error instanceof TransactionError) throw error;
      const wrapped = new TransactionError('TX_COMMIT_FAILED', 'Transaction commit failed', 500);
      wrapped.cause = error;
      if (error.rollbackError) wrapped.rollbackError = error.rollbackError;
      throw wrapped;
    }
  }

  async recover() {
    await fsp.mkdir(this.runtimeDir, { recursive: true });
    const names = await fsp.readdir(this.runtimeDir).catch(() => []);
    const result = { committed: [], rolledBack: [], cleaned: [], invalid: [] };
    for (const name of names) {
      if (/^\.cleanup-tx-[0-9a-f]{32}-[0-9a-f]{12}$/.test(name)) {
        await fsp.rm(path.join(this.runtimeDir, name), { recursive: true, force: true });
        result.cleaned.push(name);
      }
    }
    for (const name of names) {
      if (!TX_ID_RE.test(name)) continue;
      const txDir = path.join(this.runtimeDir, name);
      const journalPath = path.join(txDir, 'journal.json');
      let journal;
      try {
        const raw = await fsp.readFile(journalPath, 'utf8');
        try {
          journal = JSON.parse(raw);
        } catch (parseError) {
          const error = new TransactionError('TX_JOURNAL_INVALID', `Unsafe transaction journal ${name}: invalid JSON`, 500);
          error.cause = parseError;
          result.invalid.push(name);
          throw error;
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          await fsp.rm(txDir, { recursive: true, force: true });
          result.cleaned.push(name);
          continue;
        }
        if (error.code !== 'TX_JOURNAL_INVALID') {
          const wrapped = new TransactionError(
            'TX_JOURNAL_INVALID',
            `Unsafe transaction journal ${name}: ${error.message}`,
            500,
          );
          wrapped.cause = error;
          result.invalid.push(name);
          throw wrapped;
        }
        throw error;
      }
      let validated;
      try {
        validated = validateJournal(journal, this.runtimeDir, this.addonDataDir);
      } catch (error) {
        result.invalid.push(name);
        error.message = `Unsafe transaction journal ${name}: ${error.message}`;
        throw error;
      }
      if (journal.state === 'rolling-back') {
        await this.publicationBarrier.publish(async () => {
          for (const entry of validated.entries) {
            if (entry.originalExists) await durableCopy(entry.original, entry.target);
            else await durableUnlink(entry.target);
          }
        });
        result.rolledBack.push(name);
      } else if (journal.state === 'rolled-back') {
        result.rolledBack.push(name);
      } else {
        if (journal.state !== 'committed') {
          await this.publicationBarrier.publish(async () => {
            for (const entry of validated.entries) await durableCopy(entry.next, entry.target);
            journal = { ...journal, state: 'committed' };
            await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          });
        }
        const access = validated.entries.every(entry => entry.access === 'dm') ? 'dm' : 'public';
        if (journal.effectsApplied !== true) {
          await this.onRecoveredCommit({
            commitId: journal.id,
            addonId: journal.addonId,
            access,
            changed: validated.entries.map(entry => entry.collection),
          });
          journal = { ...journal, effectsApplied: true };
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
        }
        result.committed.push(name);
      }
      await cleanupTransactionDir(this.runtimeDir, txDir, journal.id);
    }
    await fsyncDirectory(this.runtimeDir);
    return result;
  }
}

module.exports = {
  CollectionTransactionManager,
  TransactionError,
  LIMITS,
  applyOperations,
  assertSafeJson,
  normalizeCollections,
  normalizeOperations,
  revisionOf,
  validateJournal,
};
