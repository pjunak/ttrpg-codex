import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Sleep = (milliseconds: number) => Promise<void>;
type GitHubApi = (path: string, options?: RequestInit) => Promise<unknown>;
interface Release { repository: string; sha: string; image_ref: string; run_id: string | number }
interface DeploymentRun { id: number; status: string; conclusion: string | null; display_title: string; html_url: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deploymentRun(value: unknown): DeploymentRun {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.status !== 'string' ||
      typeof value.display_title !== 'string' || typeof value.html_url !== 'string' ||
      (value.conclusion !== null && typeof value.conclusion !== 'string')) {
    throw new Error('Invalid infrastructure workflow response; inspect Actions before retrying a deployment.');
  }
  return value as unknown as DeploymentRun;
}

export function validateRelease(run: unknown, release: unknown, repository: string): Release {
  if (!isRecord(run) || !isRecord(release) || run.conclusion !== 'success' || run.status !== 'completed' ||
      run.head_branch !== 'main' || typeof run.event !== 'string' || !['push', 'workflow_dispatch'].includes(run.event) ||
      typeof run.path !== 'string' || run.path.split('@')[0] !== '.github/workflows/build-and-dispatch.yml' ||
      !isRecord(run.repository) || run.repository.full_name !== repository ||
      release.repository !== repository || release.sha !== run.head_sha ||
      String(release.run_id) !== String(run.id)) {
    throw new Error('Release must belong to a successful main-branch build in this repository');
  }
  validateImage(release.image_ref, release.sha, repository);
  return release as unknown as Release;
}

export function validateImage(image: unknown, sha: unknown, repository: string) {
  const prefix = `ghcr.io/${repository.toLowerCase()}@sha256:`;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || typeof image !== 'string' || !image.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(image.slice(prefix.length))) {
    throw new Error('Release image must be an immutable digest from this repository with a full source SHA');
  }
}

export function createGitHubApi(token: string, { request = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: {
  request?: typeof fetch; sleep?: Sleep;
} = {}): GitHubApi {
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

export async function dispatchAndWait({ api, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), infra, target, sha, image, requestId, attempts = 120, report = console.log }: {
  api: GitHubApi; sleep?: Sleep; infra: string; target: string; sha: string; image: string;
  requestId: string; attempts?: number; report?: (message: string) => void;
}) {
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
  let run: DeploymentRun | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(15_000);
    if (!run) {
      const result = await api(`${endpoint}?event=repository_dispatch&per_page=100&created=${encodeURIComponent(`>=${started}`)}`);
      if (!isRecord(result) || !Array.isArray(result.workflow_runs)) throw new Error('Invalid infrastructure workflow listing');
      const candidate: unknown = result.workflow_runs.find((candidate: unknown) => isRecord(candidate) && candidate.display_title === `Deploy ${target} ${requestId}`);
      if (candidate !== undefined) run = deploymentRun(candidate);
      if (run) report(`Infrastructure deployment: ${run.html_url}`);
    } else {
      run = deploymentRun(await api(`/repos/${infra}/actions/runs/${run.id}`));
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Deployment ${run.conclusion}: ${run.html_url}`);
      return run;
    }
  }
  throw new Error(`Deployment result is still unknown; inspect ${run?.html_url ?? `https://github.com/${infra}/actions`}. Do not blindly redispatch.`);
}

async function main() {
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const api = createGitHubApi(env('GH_TOKEN'));
  const repository = env('GITHUB_REPOSITORY');
  if (process.argv[2] === 'verify') {
    const runId = process.env.SOURCE_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Expected a numeric successful source run ID');
    const run = await api(`/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`);
    const release = validateRelease(run, JSON.parse(readFileSync('release/release.json', 'utf8')), repository);
    appendFileSync(env('GITHUB_OUTPUT'), `image_ref=${release.image_ref}\nsha=${release.sha}\n`);
    return;
  }
  validateImage(process.env.DEPLOY_IMAGE, process.env.DEPLOY_SHA, repository);
  const run = await dispatchAndWait({ api, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    infra: env('INFRA_REPO'), target: env('DEPLOY_TARGET'),
    sha: env('DEPLOY_SHA'), image: env('DEPLOY_IMAGE'),
    requestId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.env.DEPLOY_TARGET}` });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Deployment succeeded: [${process.env.DEPLOY_TARGET}](${run.html_url})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
