import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../web/js/api-client.js';

test('API client serializes JSON and returns parsed response data', async () => {
  let captured;
  const client = ApiClient.create({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    onAuthFailure: null,
  });
  const result = await client.requestJson('/api/example', {
    method: 'POST',
    json: { value: 3 },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, '/api/example');
  assert.equal(captured.options.credentials, 'same-origin');
  assert.equal(captured.options.headers.get('Accept'), 'application/json');
  assert.equal(captured.options.headers.get('Content-Type'), 'application/json');
  assert.equal(captured.options.body, '{"value":3}');
});

test('API client exposes structured response errors and auth failure', async () => {
  const authFailures = [];
  const client = ApiClient.create({
    fetchImpl: async () => new Response(JSON.stringify({
      error: 'DM required',
      code: 'DM_REQUIRED',
      details: { role: 'player' },
    }), { status: 403 }),
    onAuthFailure: status => authFailures.push(status),
  });
  await assert.rejects(
    () => client.requestJson('/api/private'),
    error => {
      assert.ok(error instanceof ApiClient.ApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'DM_REQUIRED');
      assert.equal(error.message, 'DM required');
      assert.deepEqual(error.details, { role: 'player' });
      return true;
    },
  );
  assert.deepEqual(authFailures, [403]);
});

test('API client distinguishes invalid JSON, network errors, and cancellation', async () => {
  const invalid = ApiClient.create({
    fetchImpl: async () => new Response('<html>', { status: 200 }),
    onAuthFailure: null,
  });
  await assert.rejects(
    () => invalid.requestJson('/api/example'),
    error => error instanceof ApiClient.ApiError && error.code === 'API_RESPONSE_INVALID',
  );

  const network = ApiClient.create({
    fetchImpl: async () => { throw new Error('offline'); },
    onAuthFailure: null,
  });
  await assert.rejects(
    () => network.requestJson('/api/example'),
    error => error instanceof ApiClient.ApiError
      && error.code === 'API_NETWORK'
      && error.cause?.message === 'offline',
  );

  const abort = new DOMException('cancelled', 'AbortError');
  const cancelled = ApiClient.create({
    fetchImpl: async () => { throw abort; },
    onAuthFailure: null,
  });
  await assert.rejects(() => cancelled.requestJson('/api/example'), error => error === abort);
});

test('API client upload keeps the caller FormData body and omits JSON content type', async () => {
  const form = new FormData();
  form.append('value', 'one');
  let captured;
  const client = ApiClient.create({
    fetchImpl: async (_url, options) => {
      captured = options;
      return new Response(null, { status: 204 });
    },
    onAuthFailure: null,
  });
  assert.equal(await client.uploadJson('/api/upload', form, { method: 'POST' }), null);
  assert.equal(captured.body, form);
  assert.equal(captured.headers.has('Content-Type'), false);
});
