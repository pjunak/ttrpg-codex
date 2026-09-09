import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubApi, dispatchAndWait, validateRelease, validateImage } from './deploy-release.mjs';

const repository = 'example/app';
const sha = 'a'.repeat(40);
const image = `ghcr.io/${repository}@sha256:${'b'.repeat(64)}`;
const run = { id: 42, conclusion: 'success', status: 'completed', head_branch: 'main',
  event: 'push', path: '.github/workflows/build-and-dispatch.yml', head_sha: sha,
  repository: { full_name: repository } };
const release = { repository, sha, image_ref: image, run_id: 42 };

test('release reuse requires matching successful main build and immutable image', () => {
  assert.equal(validateRelease(run, release, repository), release);
  for (const change of [{ conclusion: 'failure' }, { head_branch: 'feature' },
    { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { head_sha: 'c'.repeat(40) }]) {
    assert.throws(() => validateRelease({ ...run, ...change }, release, repository));
  }
  assert.throws(() => validateRelease(run, { ...release, run_id: 41 }, repository));
  assert.throws(() => validateImage('ghcr.io/example/app:latest', sha, repository));
  assert.throws(() => validateImage(image, sha, 'other/app'));
});

test('dispatch waits for the correlated infrastructure result, ignoring unrelated runs', async () => {
  const calls = [];
  const infraRun = { id: 8, status: 'in_progress', display_title: 'Deploy asurai 1-1-asurai', html_url: 'https://github.com/example/infra/actions/runs/8' };
  const result = await dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', sleep: async () => {}, report: () => {},
    api: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith('/runs/8')) return { ...infraRun, status: 'completed', conclusion: 'success' };
      return { workflow_runs: [{ display_title: 'other', status: 'completed', conclusion: 'success' }, infraRun] };
    } });
  assert.equal(result.conclusion, 'success');
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
  assert.equal(JSON.parse(calls[1].options.body).client_payload.image_ref, image);
});

test('infra failure propagates and permission failure never dispatches', async () => {
  await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', sleep: async () => {}, report: () => {},
    api: async () => ({ workflow_runs: [{ display_title: 'Deploy asurai 1-1-asurai',
      status: 'completed', conclusion: 'failure', html_url: 'failure-url' }] }) }), /Deployment failure/);
  let calls = 0;
  await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', api: async () => { calls++; throw new Error('permission'); } }), /permission/);
  assert.equal(calls, 1);
});

test('timeout reports an unknown outcome without redispatching', async () => {
  let posts = 0;
  await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'tiamat', sha, image,
    requestId: '1-1-tiamat', attempts: 2, sleep: async () => {},
    api: async (_path, options) => { if (options?.method === 'POST') posts++; return { workflow_runs: [] }; } }), /still unknown/);
  assert.equal(posts, 1);
});

test('transient reads retry, but an uncertain dispatch is never repeated', async () => {
  let requests = 0;
  const api = createGitHubApi('test', { sleep: async () => {}, request: async () => {
    requests++;
    return requests < 3 ? { status: 503, ok: false } : { status: 200, ok: true, json: async () => ({ ok: true }) };
  } });
  assert.deepEqual(await api('/read'), { ok: true });
  assert.equal(requests, 3);
  requests = 0;
  const uncertain = createGitHubApi('test', { request: async () => { requests++; throw new Error('connection lost'); } });
  await assert.rejects(uncertain('/dispatches', { method: 'POST' }), /outcome is unknown/);
  assert.equal(requests, 1);
});
