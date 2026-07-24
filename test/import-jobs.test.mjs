import test from 'node:test';
import assert from 'node:assert/strict';

import ImportHarness from '../server/addon-import-harness.cjs';

const { createMockImportHost } = ImportHarness;

const target = { scope: 'addon', addonId: 'mock-addon', collection: 'items' };

function provider(preview, overrides = {}) {
  return {
    id: 'fixture-json',
    apiVersion: 1,
    schemaVersion: 1,
    formats: ['json'],
    reads: [target],
    writes: [target],
    targetTypes: ['addon-list'],
    limits: {
      maxInputBytes: 4096,
      maxDepth: 12,
      maxRecords: 50,
      maxStringChars: 4096,
      maxOperations: 20,
      timeoutMs: 1000,
    },
    capabilities: ['abort-signal', 'structured-diagnostics'],
    preview,
    ...overrides,
  };
}

function onePut(input) {
  return {
    schemaVersion: 1,
    operations: [{
      target,
      op: 'put',
      id: input.data.id,
      value: { name: input.data.name },
    }],
    diagnostics: [],
  };
}

test('preview performs no writes/events and commit applies the exact server-held plan once', async () => {
  const harness = createMockImportHost({}, { collections: { items: [] } });
  harness.host.registerImportProvider(provider(onePut));
  const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
  const previewed = await harness.manager.preview(job.id, 'mock-session');

  assert.deepEqual(harness.collection('items'), []);
  assert.equal(harness.events(), 0);
  assert.equal(previewed.plan.operations[0].value.name, 'Alpha');
  assert.equal(previewed.plan.version, 1);
  assert.ok(previewed.plan.baseRevisions['addon:mock-addon:items']);

  const committed = await harness.manager.commit(
    job.id,
    'mock-session',
    previewed.previewToken,
  );
  assert.equal(committed.operationCount, 1);
  assert.deepEqual(harness.collection('items'), [{ id: 'alpha', name: 'Alpha' }]);
  assert.equal(harness.events(), 1);

  await assert.rejects(
    harness.manager.commit(job.id, 'mock-session', previewed.previewToken),
    error => error.code === 'IMPORT_TOKEN_USED',
  );
  await harness.dispose();
});

test('forged tokens and wrong import sessions cannot access or commit a job', async () => {
  const harness = createMockImportHost();
  harness.host.registerImportProvider(provider(onePut));
  const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
  const previewed = await harness.manager.preview(job.id, 'mock-session');
  await assert.rejects(
    harness.manager.commit(job.id, 'other-session', previewed.previewToken),
    error => error.code === 'IMPORT_NOT_FOUND' && error.status === 404,
  );
  await assert.rejects(
    harness.manager.commit(job.id, 'mock-session', '0'.repeat(64)),
    error => error.code === 'IMPORT_TOKEN_INVALID',
  );
  assert.deepEqual(harness.collection('items'), []);
  await harness.dispose();
});

test('a collection revision conflict invalidates the single-use preview without writes', async () => {
  const harness = createMockImportHost({}, { collections: { items: [] } });
  harness.host.registerImportProvider(provider(onePut));
  const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
  const previewed = await harness.manager.preview(job.id, 'mock-session');
  harness.setCollection(target, [{ id: 'other', name: 'Concurrent edit' }]);

  await assert.rejects(
    harness.manager.commit(job.id, 'mock-session', previewed.previewToken),
    error => error.code === 'IMPORT_REVISION_CONFLICT',
  );
  assert.deepEqual(harness.collection('items'), [{ id: 'other', name: 'Concurrent edit' }]);
  assert.equal(harness.events(), 0);
  await assert.rejects(
    harness.manager.commit(job.id, 'mock-session', previewed.previewToken),
    error => error.code === 'IMPORT_TOKEN_USED',
  );
  await harness.dispose();
});

test('commit failure is atomic and emits no event', async () => {
  const harness = createMockImportHost({}, {
    collections: { items: [{ id: 'existing', name: 'Existing' }] },
    failCommit: true,
  });
  harness.host.registerImportProvider(provider(onePut));
  const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
  const previewed = await harness.manager.preview(job.id, 'mock-session');
  await assert.rejects(
    harness.manager.commit(job.id, 'mock-session', previewed.previewToken),
    error => error.code === 'IMPORT_COMMIT_FAILED',
  );
  assert.deepEqual(harness.collection('items'), [{ id: 'existing', name: 'Existing' }]);
  assert.equal(harness.events(), 0);
  await harness.dispose();
});

test('client disconnect before commit consumes the preview without writing', async () => {
  const harness = createMockImportHost();
  harness.host.registerImportProvider(provider(onePut));
  const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
  const previewed = await harness.manager.preview(job.id, 'mock-session');

  await assert.rejects(
    harness.manager.commit(
      job.id,
      'mock-session',
      previewed.previewToken,
      { clientAborted: () => true },
    ),
    error => error.code === 'IMPORT_CANCELLED',
  );
  assert.deepEqual(harness.collection('items'), []);
  assert.equal(harness.events(), 0);
  await assert.rejects(
    harness.manager.commit(job.id, 'mock-session', previewed.previewToken),
    error => error.code === 'IMPORT_TOKEN_USED',
  );
  await harness.dispose();
});

test('provider output validation rejects undeclared reads, protected fields, and malformed plans', async () => {
  const cases = [
    {
      preview: (_input, context) => {
        context.read({ scope: 'core', collection: 'characters' });
        return { schemaVersion: 1, operations: [] };
      },
      code: 'IMPORT_PROVIDER_UNDECLARED',
    },
    {
      preview: input => ({
        ...onePut(input),
        operations: [{ ...onePut(input).operations[0], value: { id: 'forged' } }],
      }),
      code: 'IMPORT_PROTECTED_FIELD',
    },
    {
      preview: () => ({ schemaVersion: 2, operations: [] }),
      code: 'IMPORT_PLAN_INVALID',
    },
  ];
  for (const entry of cases) {
    const harness = createMockImportHost();
    harness.host.registerImportProvider(provider(entry.preview));
    const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
    await assert.rejects(
      harness.manager.preview(job.id, 'mock-session'),
      error => error.code === entry.code,
    );
    assert.deepEqual(harness.collection('items'), []);
    await harness.dispose();
  }
});

test('provider registration is shared with the harness and fails on duplicates/foreign declarations', async () => {
  const harness = createMockImportHost();
  harness.host.registerImportProvider(provider(onePut));
  assert.equal(harness.providers().length, 1);
  assert.throws(
    () => harness.host.registerImportProvider(provider(onePut)),
    error => error.code === 'IMPORT_PROVIDER_DUPLICATE',
  );
  const foreignHarness = createMockImportHost();
  assert.throws(
    () => foreignHarness.host.registerImportProvider(provider(onePut, {
      writes: [{ scope: 'addon', addonId: 'foreign-addon', collection: 'items' }],
    })),
    error => error.code === 'IMPORT_PROVIDER_FOREIGN',
  );
  await harness.dispose();
  await foreignHarness.dispose();
});

test('one provider failure does not affect another registered provider', async () => {
  const harness = createMockImportHost();
  harness.host.registerImportProvider(provider(() => {
    throw new Error('fixture failure');
  }, { id: 'broken-json' }));
  harness.host.registerImportProvider(provider(onePut, { id: 'healthy-json' }));

  const broken = harness.createJob('broken-json', { id: 'bad', name: 'Bad' });
  await assert.rejects(
    harness.manager.preview(broken.id, 'mock-session'),
    error => error.code === 'IMPORT_PROVIDER_FAILED',
  );
  const healthy = harness.createJob('healthy-json', { id: 'good', name: 'Good' });
  const ready = await harness.manager.preview(healthy.id, 'mock-session');
  await harness.manager.commit(healthy.id, 'mock-session', ready.previewToken);

  assert.deepEqual(harness.collection('items'), [{ id: 'good', name: 'Good' }]);
  await harness.dispose();
});

test('cancellation aborts controlled provider work and provider disposal invalidates previews', async () => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const harness = createMockImportHost();
  const disposeProvider = harness.host.registerImportProvider(provider((_input, context) => {
    started();
    return new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }));
  const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
  const pending = harness.manager.preview(job.id, 'mock-session');
  await startedPromise;
  await harness.manager.cancel(job.id, 'mock-session');
  await assert.rejects(pending, error => error.code === 'IMPORT_CANCELLED');

  harness.host.registerImportProvider(provider(onePut, { id: 'second-json' }));
  const second = harness.createJob('second-json', { id: 'beta', name: 'Beta' });
  const ready = await harness.manager.preview(second.id, 'mock-session');
  disposeProvider();
  assert.equal(harness.providers().some(entry => entry.id === 'fixture-json'), false);
  harness.manager.unregisterProvider('mock-addon', 'second-json');
  await assert.rejects(
    harness.manager.commit(second.id, 'mock-session', ready.previewToken),
    error => error.code === 'IMPORT_TOKEN_USED' || error.code === 'IMPORT_PROVIDER_CHANGED',
  );
  await harness.dispose();
});

test('expiry, timeout, concurrency, and token-bucket limits use deterministic controls', async () => {
  let now = 1000;
  const expiryHarness = createMockImportHost({}, {
    now: () => now,
    limits: { jobTtlMs: 100 },
  });
  expiryHarness.host.registerImportProvider(provider(onePut));
  const expiring = expiryHarness.createJob('fixture-json', { id: 'a', name: 'A' });
  const ready = await expiryHarness.manager.preview(expiring.id, 'mock-session');
  now += 101;
  await assert.rejects(
    expiryHarness.manager.commit(expiring.id, 'mock-session', ready.previewToken),
    error => error.code === 'IMPORT_EXPIRED',
  );
  await expiryHarness.dispose();

  let fireTimeout;
  const timeoutHarness = createMockImportHost({}, {
    setTimer: callback => { fireTimeout = callback; return 1; },
    clearTimer: () => {},
    limits: { maxConcurrentPerProvider: 1, rateBurst: 10 },
  });
  timeoutHarness.host.registerImportProvider(provider(() => new Promise(() => {})));
  const timed = timeoutHarness.createJob('fixture-json', { id: 'a', name: 'A' });
  const timing = timeoutHarness.manager.preview(timed.id, 'mock-session');
  while (!fireTimeout) await Promise.resolve();
  fireTimeout();
  await assert.rejects(timing, error => error.code === 'IMPORT_TIMEOUT');
  const afterTimeout = timeoutHarness.createJob('fixture-json', { id: 'b', name: 'B' });
  await assert.rejects(
    timeoutHarness.manager.preview(afterTimeout.id, 'mock-session'),
    error => error.code === 'IMPORT_BUSY',
  );
  await timeoutHarness.dispose();

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const limited = createMockImportHost({}, {
    now: () => now,
    limits: { maxConcurrentPerProvider: 1, rateBurst: 1, rateRefillMs: 100 },
  });
  limited.host.registerImportProvider(provider(async input => {
    await gate;
    return onePut(input);
  }));
  const first = limited.createJob('fixture-json', { id: 'a', name: 'A' });
  const firstPreview = limited.manager.preview(first.id, 'mock-session');
  await Promise.resolve();
  const second = limited.createJob('fixture-json', { id: 'b', name: 'B' });
  await assert.rejects(
    limited.manager.preview(second.id, 'mock-session'),
    error => ['IMPORT_BUSY', 'IMPORT_RATE_LIMIT'].includes(error.code),
  );
  release();
  await firstPreview;
  const third = limited.createJob('fixture-json', { id: 'c', name: 'C' });
  await assert.rejects(
    limited.manager.preview(third.id, 'mock-session'),
    error => error.code === 'IMPORT_RATE_LIMIT',
  );
  now += 100;
  const fourth = limited.createJob('fixture-json', { id: 'd', name: 'D' });
  await limited.manager.preview(fourth.id, 'mock-session');
  await limited.dispose();
});

test('addon-wide concurrency and rate limits span multiple providers', async () => {
  let now = 1000;
  let started;
  let release;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createMockImportHost({}, {
    now: () => now,
    limits: {
      maxConcurrentPerAddon: 1,
      maxConcurrentPerProvider: 2,
      addonRateBurst: 1,
      addonRateRefillMs: 100,
      rateBurst: 5,
    },
  });
  harness.host.registerImportProvider(provider(async input => {
    started();
    await gate;
    return onePut(input);
  }, { id: 'first-json' }));
  harness.host.registerImportProvider(provider(onePut, { id: 'second-json' }));

  const first = harness.createJob('first-json', { id: 'a', name: 'A' });
  const pending = harness.manager.preview(first.id, 'mock-session');
  await startedPromise;
  const concurrent = harness.createJob('second-json', { id: 'b', name: 'B' });
  await assert.rejects(
    harness.manager.preview(concurrent.id, 'mock-session'),
    error => error.code === 'IMPORT_BUSY',
  );
  release();
  await pending;

  const rateLimited = harness.createJob('second-json', { id: 'c', name: 'C' });
  await assert.rejects(
    harness.manager.preview(rateLimited.id, 'mock-session'),
    error => error.code === 'IMPORT_RATE_LIMIT',
  );
  now += 100;
  const refilled = harness.createJob('second-json', { id: 'd', name: 'D' });
  await harness.manager.preview(refilled.id, 'mock-session');
  await harness.dispose();
});

test('global and addon outstanding-job limits reject excess work', async () => {
  const global = createMockImportHost({}, {
    limits: { maxJobs: 1, maxJobsPerAddon: 10, maxJobsPerProvider: 10 },
  });
  global.host.registerImportProvider(provider(onePut));
  global.createJob('fixture-json', { id: 'a', name: 'A' });
  assert.throws(
    () => global.createJob('fixture-json', { id: 'b', name: 'B' }),
    error => error.code === 'IMPORT_BUSY' && error.status === 503,
  );
  await global.dispose();

  const addonLimited = createMockImportHost({}, {
    limits: { maxJobs: 10, maxJobsPerAddon: 1, maxJobsPerProvider: 10 },
  });
  addonLimited.host.registerImportProvider(provider(onePut, { id: 'first-json' }));
  addonLimited.host.registerImportProvider(provider(onePut, { id: 'second-json' }));
  addonLimited.createJob('first-json', { id: 'a', name: 'A' });
  assert.throws(
    () => addonLimited.createJob('second-json', { id: 'b', name: 'B' }),
    error => error.code === 'IMPORT_BUSY' && error.status === 429,
  );
  await addonLimited.dispose();
});

test('package revision reconciliation invalidates outstanding jobs', async () => {
  const harness = createMockImportHost();
  harness.host.registerImportProvider(provider(onePut));
  const job = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });
  const previewed = await harness.manager.preview(job.id, 'mock-session');
  harness.manager.reconcilePackages([{
    id: 'mock-addon',
    enabled: true,
    packageRevision: 'replacement-package',
  }]);
  await assert.rejects(
    harness.manager.commit(job.id, 'mock-session', previewed.previewToken),
    error => error.code === 'IMPORT_TOKEN_USED' || error.code === 'IMPORT_PROVIDER_CHANGED',
  );
  assert.deepEqual(harness.collection('items'), []);
  await harness.dispose();
});

test('restore invalidation cancels jobs without unregistering providers', async () => {
  const harness = createMockImportHost();
  harness.host.registerImportProvider(provider(onePut));
  const created = harness.createJob('fixture-json', { id: 'alpha', name: 'Alpha' });

  harness.manager.invalidateJobs('campaign-restored');

  assert.equal(harness.providers().length, 1);
  await assert.rejects(
    harness.manager.preview(created.id, 'mock-session'),
    error => error.code === 'IMPORT_STATE',
  );
  const replacement = harness.createJob('fixture-json', { id: 'beta', name: 'Beta' });
  await harness.manager.preview(replacement.id, 'mock-session');
  await harness.dispose();
});
