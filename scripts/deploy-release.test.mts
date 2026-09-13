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

const receipt = { workflow_run_id: 8, run_url: 'https://api.github.com/repos/example/infra/actions/runs/8',
  html_url: 'https://github.com/example/infra/actions/runs/8' };
const infraRun = { id: 8, event: 'workflow_dispatch', head_branch: 'main', path: '.github/workflows/deploy.yml',
  status: 'completed', conclusion: 'success', display_title: 'Deploy asurai 1-1-asurai', html_url: receipt.html_url };

test('dispatch uses main and polls only the returned run ID', async () => {
  const calls: { path: string; options?: RequestInit }[] = [];
  let polls = 0;
  const result = await dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', sleep: async () => {}, report: () => {},
    api: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith('/workflows/deploy.yml')) return { state: 'active' };
      if (options?.method === 'POST') {
        assert.equal(path, '/repos/example/infra/actions/workflows/deploy.yml/dispatches');
        return receipt;
      }
      assert.equal(path, '/repos/example/infra/actions/runs/8');
      return ++polls === 1 ? { ...infraRun, status: 'queued', conclusion: null } : infraRun;
    } });
  assert.equal(result.conclusion, 'success');
  assert.equal(polls, 2);
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
  const body = JSON.parse(calls[1]!.options!.body as string);
  assert.equal(body.ref, 'main');
  assert.equal(body.inputs.image_ref, image);
});

test('queued workflow placeholder waits for the expanded request title', async () => {
  let polls = 0;
  const result = await dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', sleep: async () => {}, report: () => {},
    api: async (path, options) => {
      if (options?.method === 'POST') return receipt;
      if (path.endsWith('/workflows/deploy.yml')) return { state: 'active' };
      return ++polls === 1 ? { ...infraRun, display_title: 'Deploy', status: 'queued', conclusion: null } : infraRun;
    } });
  assert.equal(result.conclusion, 'success');
  assert.equal(polls, 2);
});

test('placeholder cannot report success or wait without bound', async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    let polls = 0;
    await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
      requestId: '1-1-asurai', attempts: 6, sleep: async () => {}, report: () => {},
      api: async (path, options) => {
        if (options?.method === 'POST') return receipt;
        if (path.endsWith('/workflows/deploy.yml')) return { state: 'active' };
        polls++;
        return { ...infraRun, display_title: 'Deploy', status };
      } }), /run title/);
    assert.equal(polls, status === 'queued' ? 5 : 1);
  }
});

test('failed or mismatched run identity cannot report deployment success', async () => {
  for (const change of [{ conclusion: 'failure' }, { conclusion: 'skipped' }, { id: 9 }, { event: 'push' },
    { head_branch: 'feature' }, { path: '.github/workflows/other.yml' }, { html_url: 'https://elsewhere.invalid' },
    { display_title: 'Deploy tiamat other' }]) {
    await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
      requestId: '1-1-asurai', sleep: async () => {}, report: () => {},
      api: async (path, options) => options?.method === 'POST' ? receipt :
        path.endsWith('/workflows/deploy.yml') ? { state: 'active' } : { ...infraRun, ...change } }));
  }
});

test('bad dispatch receipts fail without polling or repeating the request', async () => {
  for (const value of [null, {}, { ...receipt, workflow_run_id: -1 }, { ...receipt, run_url: 'other' }]) {
    let calls = 0;
    await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
      requestId: '1-1-asurai', report: () => {}, api: async (_path, options) => {
        calls++;
        return options?.method === 'POST' ? value : { state: 'active' };
      } }), /receipt|run ID/);
    assert.equal(calls, 2);
  }
});

test('timeout reports its exact run without redispatching', async () => {
  let posts = 0;
  await assert.rejects(dispatchAndWait({ infra: 'example/infra', target: 'asurai', sha, image,
    requestId: '1-1-asurai', attempts: 2, sleep: async () => {}, report: () => {},
    api: async (path, options) => {
      if (options?.method === 'POST') { posts++; return receipt; }
      return path.endsWith('/workflows/deploy.yml') ? { state: 'active' } : { ...infraRun, status: 'in_progress', conclusion: null };
    } }), /still unknown.*runs\/8/);
  assert.equal(posts, 1);
});

test('transient reads retry, uncertain dispatch does not, and redirects are forbidden', async () => {
  let requests = 0;
  const api = createGitHubApi('test', { sleep: async () => {}, request: async (_url, options) => {
    requests++;
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>)['X-GitHub-Api-Version'], '2026-03-10');
    return requests < 3 ? new Response(null, { status: 503 }) : Response.json({ ok: true });
  } });
  assert.deepEqual(await api('/repos/example/app'), { ok: true });
  assert.equal(requests, 3);
  requests = 0;
  const uncertain = createGitHubApi('test', { request: async () => { requests++; throw new Error('connection lost'); } });
  await assert.rejects(uncertain('/repos/example/infra/actions/workflows/deploy.yml/dispatches', { method: 'POST' }), /outcome is unknown/);
  assert.equal(requests, 1);
});

test('malformed source run or metadata cannot be reused', () => {
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
