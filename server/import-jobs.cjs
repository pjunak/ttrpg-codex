'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs').promises;

const {
  ImportError,
  LIMITS,
  PLAN_VERSION,
  PROTECTED_FIELDS,
  clone,
  collectionRefKey,
  digestPlan,
  normalizeCollectionRef,
  normalizePlan,
  normalizeProviderDescriptor,
  parseJsonStrict,
} = require('./import-contract.cjs');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'expired']);

function _tokenDigest(token, planDigest) {
  return crypto.createHash('sha256').update(`${token}\0${planDigest}`).digest();
}

function _safeTokenEqual(token, expected, planDigest) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || !Buffer.isBuffer(expected)) return false;
  const actual = _tokenDigest(token, planDigest);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function _providerPublic(provider) {
  return {
    addonId: provider.addonId,
    id: provider.id,
    apiVersion: provider.apiVersion,
    schemaVersion: provider.schemaVersion,
    formats: [...provider.formats],
    reads: clone(provider.reads),
    writes: clone(provider.writes),
    targetTypes: [...provider.targetTypes],
    limits: { ...provider.limits },
    capabilities: [...provider.capabilities],
    packageRevision: provider.packageRevision,
  };
}

function _jobPublic(job) {
  return {
    id: job.id,
    state: job.state,
    provider: {
      addonId: job.provider.addonId,
      id: job.provider.id,
      packageRevision: job.provider.packageRevision,
    },
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    ...(job.error ? { error: { ...job.error } } : {}),
  };
}

class ImportJobManager {
  constructor({
    coreCollections = new Set(),
    snapshotCollections,
    commitOperations,
    now = () => Date.now(),
    randomBytes = size => crypto.randomBytes(size),
    readFile = file => fsp.readFile(file),
    unlinkFile = file => fsp.unlink(file),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = timer => clearTimeout(timer),
    limits = {},
  } = {}) {
    if (typeof snapshotCollections !== 'function') {
      throw new TypeError('snapshotCollections is required');
    }
    if (typeof commitOperations !== 'function') {
      throw new TypeError('commitOperations is required');
    }
    this.coreCollections = coreCollections;
    this.snapshotCollections = snapshotCollections;
    this.commitOperations = commitOperations;
    this.now = now;
    this.randomBytes = randomBytes;
    this.readFile = readFile;
    this.unlinkFile = unlinkFile;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.limits = { ...LIMITS, ...limits };
    this.providers = new Map();
    this.jobs = new Map();
    this.activity = new Map();
    this.addonActivity = new Map();
  }

  registerProvider(addon, descriptor) {
    const provider = normalizeProviderDescriptor(addon, descriptor, {
      coreCollections: this.coreCollections,
    });
    if (this.providers.has(provider.key)) {
      throw new ImportError(
        'IMPORT_PROVIDER_DUPLICATE',
        `Provider "${provider.key}" is already registered`,
        409,
      );
    }
    this.providers.set(provider.key, provider);
    this.activity.set(provider.key, {
      active: 0,
      tokens: this.limits.rateBurst,
      refilledAt: this.now(),
    });
    if (!this.addonActivity.has(provider.addonId)) {
      this.addonActivity.set(provider.addonId, {
        active: 0,
        tokens: this.limits.addonRateBurst,
        refilledAt: this.now(),
      });
    }
    return {
      provider: _providerPublic(provider),
      dispose: () => this.unregisterProvider(provider.addonId, provider.id, 'provider-disposed'),
    };
  }

  unregisterProvider(addonId, providerId, reason = 'provider-unloaded') {
    const key = `${addonId}:${providerId}`;
    const removed = this.providers.delete(key);
    this.activity.delete(key);
    for (const job of this.jobs.values()) {
      if (job.provider.key === key && !TERMINAL_STATES.has(job.state)) {
        this.#terminate(job, 'cancelled', 'IMPORT_PROVIDER_UNAVAILABLE', reason);
      }
    }
    if (![...this.providers.values()].some(provider => provider.addonId === addonId)) {
      this.addonActivity.delete(addonId);
    }
    return removed;
  }

  unregisterAddon(addonId, reason = 'provider-unloaded') {
    let removed = 0;
    for (const provider of [...this.providers.values()]) {
      if (provider.addonId !== addonId) continue;
      if (this.unregisterProvider(addonId, provider.id, reason)) removed++;
    }
    return removed;
  }

  reconcilePackages(entries) {
    const current = new Map((entries || [])
      .filter(entry => entry && entry.enabled)
      .map(entry => [entry.id, String(entry.packageRevision || '')]));
    for (const provider of [...this.providers.values()]) {
      if (current.get(provider.addonId) !== provider.packageRevision) {
        this.unregisterProvider(provider.addonId, provider.id, 'provider-package-changed');
      }
    }
  }

  invalidateJobs(reason = 'import-state-changed') {
    for (const job of this.jobs.values()) {
      if (!TERMINAL_STATES.has(job.state)) {
        this.#terminate(job, 'cancelled', 'IMPORT_CANCELLED', reason);
      }
    }
  }

  listProviders() {
    return [...this.providers.values()]
      .map(_providerPublic)
      .sort((left, right) => left.addonId.localeCompare(right.addonId)
        || left.id.localeCompare(right.id));
  }

  createJob({ addonId, providerId, owner, format, input }) {
    this.sweep();
    if (typeof owner !== 'string' || !owner) {
      throw new ImportError('IMPORT_FORBIDDEN', 'Import session is required', 403);
    }
    const provider = this.providers.get(`${addonId}:${providerId}`);
    if (!provider || !provider.formats.includes(format)) {
      throw new ImportError('IMPORT_PROVIDER_NOT_FOUND', 'Import provider not found', 404);
    }
    if (!input || typeof input.path !== 'string' || !Number.isInteger(input.size) || input.size < 0) {
      throw new ImportError('IMPORT_INPUT_INVALID', 'Import input is missing');
    }
    if (input.size > provider.limits.maxInputBytes) {
      throw new ImportError(
        'IMPORT_INPUT_LIMIT',
        `Input exceeds ${provider.limits.maxInputBytes} bytes`,
        413,
      );
    }
    if (this.jobs.size >= this.limits.maxJobs) {
      throw new ImportError('IMPORT_BUSY', 'Too many import jobs', 503);
    }
    const addonJobs = [...this.jobs.values()]
      .filter(job => job.provider.addonId === provider.addonId
        && !TERMINAL_STATES.has(job.state)).length;
    if (addonJobs >= this.limits.maxJobsPerAddon) {
      throw new ImportError('IMPORT_BUSY', 'Too many jobs for this addon', 429);
    }
    const providerJobs = [...this.jobs.values()]
      .filter(job => job.provider.key === provider.key && !TERMINAL_STATES.has(job.state)).length;
    if (providerJobs >= this.limits.maxJobsPerProvider) {
      throw new ImportError('IMPORT_BUSY', 'Too many jobs for this provider', 429);
    }
    const now = this.now();
    const id = `import-${this.randomBytes(16).toString('hex')}`;
    const job = {
      id,
      owner,
      provider,
      format,
      input: {
        path: input.path,
        size: input.size,
        originalName: typeof input.originalName === 'string' ? input.originalName.slice(0, 255) : '',
        mimeType: typeof input.mimeType === 'string' ? input.mimeType.slice(0, 120) : '',
      },
      state: 'created',
      createdAt: now,
      expiresAt: now + this.limits.jobTtlMs,
      controller: null,
      plan: null,
      planDigest: '',
      tokenDigest: null,
      tokenUsed: false,
      error: null,
    };
    this.jobs.set(id, job);
    return _jobPublic(job);
  }

  getJob(jobId, owner) {
    const job = this.#ownedJob(jobId, owner);
    this.#expireIfNeeded(job);
    return _jobPublic(job);
  }

  async preview(jobId, owner) {
    const job = this.#ownedJob(jobId, owner);
    this.#expireIfNeeded(job);
    if (job.state !== 'created') {
      throw new ImportError('IMPORT_STATE', 'Import job is not ready for preview', 409);
    }
    const live = this.providers.get(job.provider.key);
    if (live !== job.provider) {
      this.#terminate(job, 'cancelled', 'IMPORT_PROVIDER_UNAVAILABLE', 'Provider changed before preview');
      throw new ImportError('IMPORT_PROVIDER_UNAVAILABLE', 'Import provider is unavailable', 409);
    }
    const activity = this.activity.get(job.provider.key);
    const addonActivity = this.addonActivity.get(job.provider.addonId);
    if (!activity || !addonActivity
        || activity.active >= this.limits.maxConcurrentPerProvider
        || addonActivity.active >= this.limits.maxConcurrentPerAddon) {
      throw new ImportError('IMPORT_BUSY', 'Provider concurrency limit reached', 429);
    }
    this.#consumeRate(job.provider.key, job.provider.addonId);

    activity.active++;
    addonActivity.active++;
    job.state = 'validating';
    job.controller = new AbortController();
    let timer;
    let providerSettled = false;
    let releaseWhenSettled = false;
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activity.active = Math.max(0, activity.active - 1);
      addonActivity.active = Math.max(0, addonActivity.active - 1);
    };
    try {
      const bytes = await this.readFile(job.input.path);
      if (job.controller.signal.aborted) throw new ImportError('IMPORT_CANCELLED', 'Import preview was cancelled', 409);
      const parsed = parseJsonStrict(bytes, job.provider.limits);
      const refs = this.#participatingRefs(job.provider);
      const snapshot = await this.snapshotCollections({
        provider: job.provider,
        refs: clone(refs),
      });
      this.#validateSnapshot(snapshot, refs);
      const readKeys = new Set(job.provider.reads.map(collectionRefKey));
      const context = Object.freeze({
        signal: job.controller.signal,
        read: ref => {
          const key = collectionRefKey(normalizeCollectionRef(ref, 'provider read'));
          if (!readKeys.has(key)) {
            throw new ImportError('IMPORT_PROVIDER_UNDECLARED', 'Provider attempted an undeclared collection read');
          }
          return clone(snapshot.values[key]);
        },
        revision: ref => {
          const key = collectionRefKey(normalizeCollectionRef(ref, 'provider revision read'));
          if (!readKeys.has(key)) {
            throw new ImportError('IMPORT_PROVIDER_UNDECLARED', 'Provider attempted an undeclared revision read');
          }
          return snapshot.revisions[key];
        },
      });
      const timeoutMs = job.provider.limits.timeoutMs;
      const timed = new Promise((_, reject) => {
        timer = this.setTimer(() => {
          reject(new ImportError('IMPORT_TIMEOUT', 'Import preview timed out', 408));
          job.controller.abort(new Error('timeout'));
        }, timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      });
      const aborted = new Promise((_, reject) => {
        job.controller.signal.addEventListener('abort', () => {
          reject(new ImportError('IMPORT_CANCELLED', 'Import preview was cancelled', 409));
        }, { once: true });
      });
      const providerWork = Promise.resolve().then(() => job.provider.preview(
        Object.freeze({
          format: job.format,
          data: clone(parsed.value),
          metadata: Object.freeze({
            size: job.input.size,
            originalName: job.input.originalName,
            mimeType: job.input.mimeType,
          }),
          stats: Object.freeze({ ...parsed.stats }),
        }),
        context,
      ));
      providerWork.then(
        () => {
          providerSettled = true;
          if (releaseWhenSettled) releaseSlot();
        },
        () => {
          providerSettled = true;
          if (releaseWhenSettled) releaseSlot();
        },
      );
      const rawPlan = await Promise.race([providerWork, timed, aborted]);
      if (job.state !== 'validating' || job.controller.signal.aborted) {
        throw new ImportError('IMPORT_CANCELLED', 'Import preview was cancelled', 409);
      }
      const normalized = normalizePlan(job.provider, rawPlan, snapshot.targetTypes);
      const plan = {
        version: PLAN_VERSION,
        provider: {
          addonId: job.provider.addonId,
          id: job.provider.id,
          apiVersion: job.provider.apiVersion,
          schemaVersion: job.provider.schemaVersion,
          packageRevision: job.provider.packageRevision,
        },
        operations: normalized.operations,
        targetCollections: [...new Map(normalized.operations
          .map(operation => [collectionRefKey(operation.target), operation.target])).values()],
        diagnostics: normalized.diagnostics,
        readSet: clone(job.provider.reads),
        writeSet: clone(job.provider.writes),
        baseRevisions: { ...snapshot.revisions },
        protectedFields: job.provider.targetTypes.map(targetType => ({
          targetType,
          identity: 'operation.id',
          decision: 'reject-in-value',
          fields: [...PROTECTED_FIELDS],
        })),
      };
      job.plan = plan;
      job.planDigest = digestPlan(plan);
      const token = this.randomBytes(32).toString('hex');
      job.tokenDigest = _tokenDigest(token, job.planDigest);
      job.state = 'preview-ready';
      job.expiresAt = this.now() + this.limits.jobTtlMs;
      await this.#cleanupInput(job);
      return {
        ..._jobPublic(job),
        previewToken: token,
        plan: clone(plan),
        committable: !plan.diagnostics.some(entry => entry.severity === 'error'),
      };
    } catch (error) {
      if (!TERMINAL_STATES.has(job.state)) {
        const importError = this.#asImportError(error, 'IMPORT_PROVIDER_FAILED', 'Import provider failed during preview');
        job.state = importError.code === 'IMPORT_CANCELLED' ? 'cancelled' : 'failed';
        job.error = { code: importError.code, message: importError.message };
      }
      await this.#cleanupInput(job);
      throw this.#asImportError(error, 'IMPORT_PROVIDER_FAILED', 'Import provider failed during preview');
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
      job.controller = null;
      if (providerSettled) releaseSlot();
      else releaseWhenSettled = true;
    }
  }

  async commit(jobId, owner, previewToken, { clientAborted = () => false } = {}) {
    const job = this.#ownedJob(jobId, owner);
    this.#expireIfNeeded(job);
    if (job.state !== 'preview-ready' || !job.plan || job.tokenUsed) {
      throw new ImportError('IMPORT_TOKEN_USED', 'Preview token is expired or already used', 409);
    }
    if (!_safeTokenEqual(previewToken, job.tokenDigest, job.planDigest)) {
      throw new ImportError('IMPORT_TOKEN_INVALID', 'Preview token is invalid', 409);
    }
    const live = this.providers.get(job.provider.key);
    if (live !== job.provider || live.packageRevision !== job.plan.provider.packageRevision) {
      this.#terminate(job, 'cancelled', 'IMPORT_PROVIDER_CHANGED', 'Provider changed after preview');
      throw new ImportError('IMPORT_PROVIDER_CHANGED', 'Provider changed; create a new preview', 409);
    }
    job.tokenUsed = true;
    job.tokenDigest = null;
    job.state = 'committing';
    if (job.plan.diagnostics.some(entry => entry.severity === 'error')) {
      this.#terminate(job, 'failed', 'IMPORT_PLAN_INVALID', 'Preview contains error diagnostics');
      throw new ImportError('IMPORT_PLAN_INVALID', 'Preview contains error diagnostics', 409);
    }
    if (clientAborted()) {
      this.#terminate(job, 'cancelled', 'IMPORT_CANCELLED', 'Client disconnected before commit');
      throw new ImportError('IMPORT_CANCELLED', 'Import commit was cancelled', 409);
    }
    try {
      const result = await this.commitOperations({
        provider: job.provider,
        plan: clone(job.plan),
        planDigest: job.planDigest,
        clientAborted,
      });
      const operationCount = job.plan.operations.length;
      job.state = 'completed';
      job.error = null;
      job.expiresAt = this.now() + this.limits.jobTtlMs;
      job.plan = null;
      job.planDigest = '';
      return {
        ok: true,
        jobId: job.id,
        state: job.state,
        commitId: result.commitId || null,
        changed: Array.isArray(result.changed) ? result.changed.slice() : [],
        operationCount,
        revisions: result.revisions ? { ...result.revisions } : {},
      };
    } catch (error) {
      const importError = this.#asImportError(error, 'IMPORT_COMMIT_FAILED', 'Import commit failed');
      job.state = importError.code === 'IMPORT_CANCELLED' ? 'cancelled' : 'failed';
      job.error = { code: importError.code, message: importError.message };
      job.plan = null;
      job.planDigest = '';
      throw importError;
    }
  }

  async cancel(jobId, owner, reason = 'Cancelled by client') {
    const job = this.#ownedJob(jobId, owner);
    if (!TERMINAL_STATES.has(job.state)) {
      this.#terminate(job, 'cancelled', 'IMPORT_CANCELLED', reason);
    }
    await this.#cleanupInput(job);
    return _jobPublic(job);
  }

  sweep() {
    const now = this.now();
    for (const job of this.jobs.values()) {
      if (!TERMINAL_STATES.has(job.state) && job.expiresAt <= now) {
        this.#terminate(job, 'expired', 'IMPORT_EXPIRED', 'Import job expired');
      }
      if (TERMINAL_STATES.has(job.state) && job.expiresAt <= now) {
        this.#cleanupInput(job).catch(() => {});
        this.jobs.delete(job.id);
      }
    }
  }

  async dispose() {
    for (const job of this.jobs.values()) {
      if (!TERMINAL_STATES.has(job.state)) {
        this.#terminate(job, 'cancelled', 'IMPORT_CANCELLED', 'Import service stopped');
      }
      await this.#cleanupInput(job);
    }
    this.jobs.clear();
    this.providers.clear();
    this.activity.clear();
    this.addonActivity.clear();
  }

  #ownedJob(jobId, owner) {
    const job = this.jobs.get(jobId);
    if (!job || typeof owner !== 'string' || job.owner !== owner) {
      throw new ImportError('IMPORT_NOT_FOUND', 'Import job not found', 404);
    }
    return job;
  }

  #expireIfNeeded(job) {
    if (!TERMINAL_STATES.has(job.state) && job.expiresAt <= this.now()) {
      this.#terminate(job, 'expired', 'IMPORT_EXPIRED', 'Import job expired');
    }
    if (job.state === 'expired') throw new ImportError('IMPORT_EXPIRED', 'Import job expired', 409);
  }

  #terminate(job, state, code, message) {
    job.controller?.abort(new Error(message));
    job.state = state;
    job.error = { code, message };
    job.plan = null;
    job.planDigest = '';
    job.tokenDigest = null;
    job.tokenUsed = true;
    job.expiresAt = this.now() + this.limits.jobTtlMs;
    this.#cleanupInput(job).catch(() => {});
  }

  #consumeRate(providerKey, addonId) {
    const activity = this.activity.get(providerKey);
    const addonActivity = this.addonActivity.get(addonId);
    if (!activity || !addonActivity) {
      throw new ImportError('IMPORT_PROVIDER_UNAVAILABLE', 'Import provider is unavailable', 409);
    }
    const now = this.now();
    const refill = (bucket, burst, refillMs) => {
      const elapsed = Math.max(0, now - bucket.refilledAt);
      if (elapsed < refillMs) return;
      const tokens = Math.floor(elapsed / refillMs);
      bucket.tokens = Math.min(burst, bucket.tokens + tokens);
      bucket.refilledAt += tokens * refillMs;
    };
    refill(activity, this.limits.rateBurst, this.limits.rateRefillMs);
    refill(
      addonActivity,
      this.limits.addonRateBurst,
      this.limits.addonRateRefillMs,
    );
    if (activity.tokens < 1 || addonActivity.tokens < 1) {
      throw new ImportError('IMPORT_RATE_LIMIT', 'Import preview rate limit exceeded', 429);
    }
    activity.tokens--;
    addonActivity.tokens--;
  }

  #participatingRefs(provider) {
    const refs = new Map();
    for (const ref of [...provider.reads, ...provider.writes]) refs.set(collectionRefKey(ref), ref);
    return [...refs.values()];
  }

  #validateSnapshot(snapshot, refs) {
    if (!snapshot || typeof snapshot !== 'object'
        || !snapshot.values || !snapshot.revisions || !(snapshot.targetTypes instanceof Map)) {
      throw new ImportError('IMPORT_INTERNAL', 'Import snapshot contract failed', 500);
    }
    for (const ref of refs) {
      const key = collectionRefKey(ref);
      if (!Object.prototype.hasOwnProperty.call(snapshot.values, key)
          || typeof snapshot.revisions[key] !== 'string') {
        throw new ImportError('IMPORT_INTERNAL', 'Import snapshot is incomplete', 500);
      }
    }
  }

  async #cleanupInput(job) {
    const inputPath = job.input?.path;
    if (!inputPath) return;
    job.input.path = '';
    await this.unlinkFile(inputPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  #asImportError(error, fallbackCode, fallbackMessage) {
    if (error instanceof ImportError) return error;
    if (error && typeof error.code === 'string' && error.code.startsWith('TX_')) {
      const code = error.code === 'TX_CONFLICT'
        ? 'IMPORT_REVISION_CONFLICT'
        : error.code === 'TX_EXPIRED'
          ? 'IMPORT_CANCELLED'
          : 'IMPORT_COMMIT_FAILED';
      return new ImportError(code, code === 'IMPORT_REVISION_CONFLICT'
        ? 'Import preview is stale; create a new preview'
        : fallbackMessage, error.status || 409, error.details);
    }
    return new ImportError(fallbackCode, fallbackMessage, 500);
  }
}

module.exports = {
  ImportJobManager,
  TERMINAL_STATES,
};
