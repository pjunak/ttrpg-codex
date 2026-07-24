import test from 'node:test';
import assert from 'node:assert/strict';

import { createAddonImportClient } from '../web/js/addon-imports.js';
import { createMockHost, disposeMockHost } from '../web/js/addon-test-harness.mjs';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('scoped import client filters providers and only exposes jobs it created', async () => {
  const requests = [];
  const client = createAddonImportClient({
    addonId: 'dm-tools',
    enabled: true,
    isDM: () => true,
    fetchImpl: async (url, opts = {}) => {
      requests.push({ url, opts });
      if (url.endsWith('/providers')) {
        return response(200, {
          version: 1,
          providers: [
            { addonId: 'dm-tools', id: 'scenario-json' },
            { addonId: 'other-addon', id: 'secret' },
          ],
          limits: { maxInputBytes: 1024 },
        });
      }
      if (url.endsWith('/jobs')) return response(201, { job: { id: 'import-owned', state: 'created' } });
      return response(200, { job: { id: 'import-owned', state: 'preview-ready' } });
    },
  });

  const listed = await client.listProviders();
  assert.deepEqual(listed.providers.map(provider => provider.id), ['scenario-json']);
  await assert.rejects(
    client.getJob('import-foreign'),
    error => error.code === 'IMPORT_JOB_NOT_FOUND',
  );

  const file = new Blob(['{}'], { type: 'application/json' });
  file.name = 'scenarios.json';
  const job = await client.createJob({ providerId: 'scenario-json', file });
  assert.equal(job.id, 'import-owned');
  assert.equal((await client.getJob(job.id)).state, 'preview-ready');
  assert.equal(requests.at(-1).url, '/api/content-import/jobs/import-owned');
  await client.dispose();
});

test('client preserves structured API errors and denies effective players', async () => {
  let isDM = true;
  const client = createAddonImportClient({
    addonId: 'dm-tools',
    enabled: true,
    isDM: () => isDM,
    fetchImpl: async () => response(409, {
      code: 'IMPORT_REVISION_CONFLICT',
      error: 'stale',
      details: { collection: 'addon:dm-tools:scenarios' },
    }),
  });
  await assert.rejects(
    client.listProviders(),
    error => error.code === 'IMPORT_REVISION_CONFLICT'
      && error.status === 409
      && error.details.collection === 'addon:dm-tools:scenarios',
  );
  isDM = false;
  await assert.rejects(
    client.listProviders(),
    error => error.code === 'IMPORT_FORBIDDEN' && error.status === 403,
  );
  await client.dispose();
});

test('disposing aborts active requests and prevents later access', async () => {
  let aborted = false;
  const client = createAddonImportClient({
    addonId: 'dm-tools',
    enabled: true,
    isDM: () => true,
    fetchImpl: (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const pending = client.listProviders();
  await client.dispose();
  await assert.rejects(pending, error => error.code === 'IMPORT_CANCELLED');
  assert.equal(aborted, true);
  await assert.rejects(
    client.listProviders(),
    error => error.code === 'IMPORT_CLIENT_DISPOSED',
  );
});

test('published harness exposes the same capability and permission-scoped facade', async () => {
  const meta = {
    id: 'dm-tools',
    apiVersion: 2,
    capabilities: { required: ['imports.providers'] },
    permissions: ['data:import-provider'],
  };
  const { host, rec } = createMockHost(meta, {
    isDM: true,
    fetch: async () => response(200, {
      version: 1,
      providers: [
        { addonId: 'dm-tools', id: 'scenario-json' },
        { addonId: 'foreign', id: 'hidden' },
      ],
    }),
  });
  assert.deepEqual(
    (await host.imports.listProviders()).providers.map(provider => provider.id),
    ['scenario-json'],
  );
  await disposeMockHost(rec);
  await assert.rejects(
    host.imports.listProviders(),
    error => error.code === 'IMPORT_CLIENT_DISPOSED',
  );
});
