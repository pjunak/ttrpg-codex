import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubApi, dispatchAndWait, validateRelease, validateImage, resolveTargets, checkInfrastructureAccess, isCurrentRelease } from './deploy-release.mts';

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
  const calls: { path: string; options?: RequestInit }[] = [];
  const infraRun = { id: 8, status: 'in_progress', conclusion: null, display_title: 'Deploy asurai 1-1-asurai', html_url: 'https://github.com/example/infra/actions/runs/8' };
  const result = await dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', sleep: async () => {}, report: () => {},
    api: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith('/workflows/deploy.yml')) return { state: 'active' };
      if (path.endsWith('/runs/8')) return { ...infraRun, status: 'completed', conclusion: 'success' };
      return { workflow_runs: [{ display_title: 'other', status: 'completed', conclusion: 'success' }, infraRun] };
    } });
  assert.equal(result.conclusion, 'success');
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
  const body = calls[1].options?.body;
  assert.equal(typeof body, 'string');
  assert.equal(JSON.parse(body as string).client_payload.image_ref, image);
});

test('infra failure propagates and permission failure never dispatches', async () => {
  await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', sleep: async () => {}, report: () => {},
    api: async path => path.endsWith('/workflows/deploy.yml') ? { state: 'active' } : ({ workflow_runs: [{ id: 8, display_title: 'Deploy asurai 1-1-asurai',
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
    api: async (path, options) => { if (options?.method === 'POST') posts++; return path.endsWith('/workflows/deploy.yml') ? { state: 'active' } : { workflow_runs: [] }; } }), /still unknown/);
  assert.equal(posts, 1);
});

test('transient reads retry, but an uncertain dispatch is never repeated', async () => {
  let requests = 0;
  const api = createGitHubApi('test', { sleep: async () => {}, request: async () => {
    requests++;
    return requests < 3 ? new Response(null, { status: 503 }) : Response.json({ ok: true });
  } });
  assert.deepEqual(await api('/read'), { ok: true });
  assert.equal(requests, 3);
  requests = 0;
  const uncertain = createGitHubApi('test', { request: async () => { requests++; throw new Error('connection lost'); } });
  await assert.rejects(uncertain('/dispatches', { method: 'POST' }), /outcome is unknown/);
  assert.equal(requests, 1);
});

test('malformed workflow responses fail without redispatching', async () => {
  let posts = 0;
  await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', sleep: async () => {},
    api: async (path, options) => {
      if (path.endsWith('/workflows/deploy.yml')) return { state: 'active' };
      if (options?.method === 'POST') posts++;
      return { workflow_runs: [{ display_title: 'Deploy asurai 1-1-asurai', status: 'completed', conclusion: 'success' }] };
    } }), /Invalid infrastructure workflow response/);
  assert.equal(posts, 1);
  assert.throws(() => validateRelease(null, release, repository), /Release must belong/);
  assert.throws(() => validateRelease(run, null, repository), /Release must belong/);
});


test('configured targets deploy both sites once and reject empty or unknown targets', () => {
  assert.deepEqual(resolveTargets('configured', 'tiamat, asurai tiamat\nasurai'), ['asurai', 'tiamat']);
  assert.deepEqual(resolveTargets('asurai', 'tiamat'), ['asurai']);
  assert.deepEqual(resolveTargets('tiamat', ''), ['tiamat']);
  for (const value of ['', ' , ', 'music', 'asurai unknown']) {
    assert.throws(() => resolveTargets('configured', value), /INFRA_SERVICE/);
  }
  assert.throws(() => resolveTargets('none', 'asurai tiamat'), /INFRA_SERVICE/);
});

test('preflight requires an active infrastructure workflow and never writes', async () => {
  const paths: string[] = [];
  await checkInfrastructureAccess(async (path, options) => {
    assert.equal(options?.method, undefined);
    paths.push(path);
    return { state: 'active' };
  }, 'example/infra');
  assert.deepEqual(paths, ['/repos/example/infra/actions/workflows/deploy.yml']);
  for (const value of [null, {}, { state: 'disabled_manually' }]) {
    await assert.rejects(checkInfrastructureAccess(async () => value, 'example/infra'), /Enable the Deploy workflow/);
  }
  let calls = 0;
  await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', api: async () => { calls++; return { state: 'disabled_manually' }; } }), /Enable/);
  assert.equal(calls, 1);
  await assert.rejects(checkInfrastructureAccess(async () => { throw new Error('unexpected request'); }, '../bad'), /INFRA_REPO/);
});

test('only the current main revision may publish automatically, including older reruns', async () => {
  assert.equal(await isCurrentRelease(async () => ({ sha }), repository, sha), true);
  assert.equal(await isCurrentRelease(async () => ({ sha: 'c'.repeat(40) }), repository, sha), false);
  for (const value of [null, {}, { sha: 'short' }]) {
    await assert.rejects(isCurrentRelease(async () => value, repository, sha), /publication is blocked/);
  }
});

test('failed deployments can reuse a proven image, but failed or unrelated builds cannot', () => {
  const failed = { ...run, conclusion: 'failure' };
  const job = { name: 'Build image', conclusion: 'success', status: 'completed', run_id: run.id, head_sha: sha };
  assert.equal(validateRelease(failed, release, repository, { jobs: [job] }), release);
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' },
    { name: 'Other build' }, { run_id: 41 }, { head_sha: 'c'.repeat(40) }]) {
    assert.throws(() => validateRelease(failed, release, repository, { jobs: [{ ...job, ...change }] }), /Release must belong/);
  }
  assert.throws(() => validateRelease({ ...failed, conclusion: 'cancelled' }, release, repository, { jobs: [job] }));
});
