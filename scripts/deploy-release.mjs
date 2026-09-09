import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateRelease(run, release, repository) {
  if (run.conclusion !== 'success' || run.status !== 'completed' ||
      run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event) ||
      run.path?.split('@')[0] !== '.github/workflows/build-and-dispatch.yml' ||
      run.repository?.full_name !== repository ||
      release.repository !== repository || release.sha !== run.head_sha ||
      String(release.run_id) !== String(run.id)) {
    throw new Error('Release must belong to a successful main-branch build in this repository');
  }
  validateImage(release.image_ref, release.sha, repository);
  return release;
}

export function validateImage(image, sha, repository) {
  const prefix = `ghcr.io/${repository.toLowerCase()}@sha256:`;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !image?.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(image.slice(prefix.length))) {
    throw new Error('Release image must be an immutable digest from this repository with a full source SHA');
  }
}

export function createGitHubApi(token, { request = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return async (path, options = {}) => {
    const readOnly = !options.method || options.method === 'GET';
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await request(`https://api.github.com${path}`, {
          ...options, signal: AbortSignal.timeout(30_000),
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
        });
      } catch {
        if (readOnly && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
        throw new Error(`GitHub request outcome is unknown for ${path}. Inspect Actions before retrying a deployment.`);
      }
      if (readOnly && (response.status === 429 || response.status >= 500) && attempt < 2) {
        await sleep(1000 * 2 ** attempt); continue;
      }
      if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}; check repository access and Actions-read permission. Inspect Actions before retrying a deployment.`);
      return response.status === 204 ? null : response.json();
    }
  };
}

export async function dispatchAndWait({ api, sleep, infra, target, sha, image, requestId, attempts = 120, report = console.log }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(infra ?? '') ||
      !['asurai', 'tiamat'].includes(target) || !/^[a-zA-Z0-9-]+$/.test(requestId)) {
    throw new Error('Invalid infrastructure repository, campaign target, or request identity');
  }
  const endpoint = `/repos/${infra}/actions/workflows/deploy.yml/runs`;
  // Check Actions-read permission before sending an irreversible deployment request.
  await api(`${endpoint}?per_page=1`);
  const started = new Date(Date.now() - 60_000).toISOString();
  await api(`/repos/${infra}/dispatches`, {
    method: 'POST', body: JSON.stringify({ event_type: 'deploy',
      client_payload: { service: target, sha, image_ref: image, request_id: requestId } }),
  });
  let run;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(15_000);
    if (!run) {
      const result = await api(`${endpoint}?event=repository_dispatch&per_page=100&created=${encodeURIComponent(`>=${started}`)}`);
      run = result.workflow_runs.find(candidate => candidate.display_title === `Deploy ${target} ${requestId}`);
      if (run) report(`Infrastructure deployment: ${run.html_url}`);
    } else {
      run = await api(`/repos/${infra}/actions/runs/${run.id}`);
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Deployment ${run.conclusion}: ${run.html_url}`);
      return run;
    }
  }
  throw new Error(`Deployment result is still unknown; inspect ${run?.html_url ?? `https://github.com/${infra}/actions`}. Do not blindly redispatch.`);
}

async function main() {
  const api = createGitHubApi(process.env.GH_TOKEN);
  if (process.argv[2] === 'verify') {
    const runId = process.env.SOURCE_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Expected a numeric successful source run ID');
    const run = await api(`/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`);
    const release = validateRelease(run, JSON.parse(readFileSync('release/release.json', 'utf8')), process.env.GITHUB_REPOSITORY);
    appendFileSync(process.env.GITHUB_OUTPUT, `image_ref=${release.image_ref}\nsha=${release.sha}\n`);
    return;
  }
  validateImage(process.env.DEPLOY_IMAGE, process.env.DEPLOY_SHA, process.env.GITHUB_REPOSITORY);
  const run = await dispatchAndWait({ api, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    infra: process.env.INFRA_REPO, target: process.env.DEPLOY_TARGET,
    sha: process.env.DEPLOY_SHA, image: process.env.DEPLOY_IMAGE,
    requestId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.env.DEPLOY_TARGET}` });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Deployment succeeded: [${process.env.DEPLOY_TARGET}](${run.html_url})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
