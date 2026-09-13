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

export function validateRelease(run: unknown, release: unknown, repository: string, jobs?: unknown): Release {
  // A deployment failure must not make an already verified image unusable.
  const publishedBeforeFailure = isRecord(run) && run.conclusion === 'failure' && isRecord(jobs) &&
    Array.isArray(jobs.jobs) && jobs.jobs.some((job: unknown) => isRecord(job) &&
      job.name === 'Build image' && job.conclusion === 'success' && job.status === 'completed' &&
      job.run_id === run.id && job.head_sha === run.head_sha);
  if (!isRecord(run) || !isRecord(release) || (run.conclusion !== 'success' && !publishedBeforeFailure) || run.status !== 'completed' ||
      run.head_branch !== 'main' || typeof run.event !== 'string' || !['push', 'workflow_dispatch'].includes(run.event) ||
      typeof run.path !== 'string' || run.path.split('@')[0] !== '.github/workflows/build-and-dispatch.yml' ||
      !isRecord(run.repository) || run.repository.full_name !== repository ||
      release.repository !== repository || release.sha !== run.head_sha ||
      String(release.run_id) !== String(run.id)) {
    throw new Error('Release must belong to a verified main-branch image build in this repository');
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

export function resolveTargets(target: string, configured: string): string[] {
  const targets = target === 'configured' ? configured.split(/[,\s]+/).filter(Boolean) : [target];
  if (!targets.length || targets.some(value => !['asurai', 'tiamat'].includes(value))) {
    throw new Error('INFRA_SERVICE must contain asurai and/or tiamat (for both sites, set it to "asurai tiamat").');
  }
  return [...new Set(targets)].sort();
}

export async function checkInfrastructureAccess(api: GitHubApi, infra: string) {
  if (!/^[a-zA-Z0-9][\w.-]*\/[\w.-]+$/.test(infra)) throw new Error('INFRA_REPO must be owner/repository.');
  const workflow = await api(`/repos/${infra}/actions/workflows/deploy.yml`);
  if (!isRecord(workflow) || workflow.state !== 'active') {
    throw new Error(`Enable the Deploy workflow in https://github.com/${infra}/actions before deploying.`);
  }
}

export async function isCurrentRelease(api: GitHubApi, repository: string, sha: string): Promise<boolean> {
  const head = await api(`/repos/${repository}/commits/main`);
  if (!isRecord(head) || typeof head.sha !== 'string' || !/^[a-f0-9]{40}$/.test(head.sha)) {
    throw new Error('Cannot verify the current main revision; publication is blocked.');
  }
  return head.sha === sha;
}

export function createGitHubApi(token: string, { request = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: {
  request?: typeof fetch; sleep?: Sleep;
} = {}): GitHubApi {
  return async (path, options = {}) => {
    if (!path.startsWith('/repos/') || path.includes('\n')) throw new Error('Invalid GitHub API path.');
    const readOnly = !options.method || options.method === 'GET';
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await request(`https://api.github.com${path}`, {
          ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
        });
      } catch {
        if (readOnly && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
        throw new Error(`GitHub request outcome is unknown for ${path}. Inspect Actions before retrying a deployment.`);
      }
      if (readOnly && (response.status === 429 || response.status >= 500) && attempt < 2) {
        await sleep(1000 * 2 ** attempt); continue;
      }
      if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}; check token repository access, expiry and permissions (infrastructure deployment requires Contents: read and Actions: write). Inspect Actions before retrying a deployment.`);
      return response.status === 204 ? null : response.json();
    }
  };
}

export async function dispatchAndWait({ api, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), infra, target, sha, image, requestId, attempts = 120, report = console.log }: {
  api: GitHubApi; sleep?: Sleep; infra: string; target: string; sha: string; image: string;
  requestId: string; attempts?: number; report?: (message: string) => void;
}) {
  if (!/^[a-zA-Z0-9][\w.-]*\/[\w.-]+$/.test(infra ?? '') ||
      !['asurai', 'tiamat'].includes(target) || !/^[a-zA-Z0-9-]+$/.test(requestId)) {
    throw new Error('Invalid infrastructure repository, campaign target, or request identity');
  }
  await checkInfrastructureAccess(api, infra);
  const receipt = await api(`/repos/${infra}/actions/workflows/deploy.yml/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref: 'main',
      inputs: { service: target, sha, image_ref: image, request_id: requestId } }),
  });
  if (!isRecord(receipt) || typeof receipt.workflow_run_id !== 'number' ||
      !Number.isSafeInteger(receipt.workflow_run_id) || receipt.workflow_run_id <= 0) {
    throw new Error('Dispatch returned no run ID; inspect infrastructure Actions before retrying.');
  }
  const id = receipt.workflow_run_id;
  const path = `/repos/${infra}/actions/runs/${id}`;
  const url = `https://github.com/${infra}/actions/runs/${id}`;
  if (receipt.run_url !== `https://api.github.com${path}` || receipt.html_url !== url) {
    throw new Error('Invalid dispatch receipt; inspect infrastructure Actions before retrying.');
  }
  report(`Infrastructure deployment: ${url}`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(15_000);
    const value = await api(path);
    const run = deploymentRun(value);
    if (!isRecord(value) || run.id !== id || value.event !== 'workflow_dispatch' || value.head_branch !== 'main' ||
        typeof value.path !== 'string' || value.path.split('@')[0] !== '.github/workflows/deploy.yml' ||
        run.html_url !== url) {
      throw new Error('Invalid infrastructure run identity.');
    }
    // GitHub can return the workflow name before expanding a queued run-name.
    if (run.display_title !== `Deploy ${target} ${requestId}`) {
      if (run.display_title === 'Deploy' && run.status === 'queued' && attempt < 4) continue;
      throw new Error('Invalid infrastructure run title.');
    }
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Deployment ${run.conclusion}: ${url}`);
      return run;
    }
  }
  throw new Error(`Deployment result is still unknown; inspect ${url}. Do not blindly redispatch.`);
}

async function main() {
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const api = createGitHubApi(env('GH_TOKEN'));
  const repository = env('GITHUB_REPOSITORY');
  if (process.argv[2] === 'prepare') {
    const targets = resolveTargets(env('DEPLOY_TARGET'), process.env.INFRA_SERVICE ?? '');
    await checkInfrastructureAccess(api, env('INFRA_REPO'));
    appendFileSync(env('GITHUB_OUTPUT'), `services=${JSON.stringify(targets)}\n`);
    console.log(`Deployment access verified; targets: ${targets.join(', ')}`);
    return;
  }
  if (process.argv[2] === 'current') {
    const current = await isCurrentRelease(api, repository, env('DEPLOY_SHA'));
    appendFileSync(env('GITHUB_OUTPUT'), `current=${current}\n`);
    if (!current) {
      const message = 'This push was superseded by a newer main revision. Tests and image startup checks still run; publication and deployment are skipped. Use the latest main run.';
      console.log(`::notice::${message}`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    }
    return;
  }
  if (process.argv[2] === 'verify') {
    const runId = process.env.SOURCE_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Expected a numeric successful source run ID');
    const run = await api(`/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`);
    const jobs = isRecord(run) && run.conclusion === 'failure'
      ? await api(`/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`) : undefined;
    const release = validateRelease(run, JSON.parse(readFileSync('release/release.json', 'utf8')), repository, jobs);
    appendFileSync(env('GITHUB_OUTPUT'), `image_ref=${release.image_ref}\nsha=${release.sha}\n`);
    return;
  }
  validateImage(process.env.DEPLOY_IMAGE, process.env.DEPLOY_SHA, repository);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Requested deployment: **${env('DEPLOY_TARGET')}**\n\nSource: \`${env('DEPLOY_SHA')}\`\n\nImage: \`${env('DEPLOY_IMAGE')}\`\n\n`);
  const run = await dispatchAndWait({ api, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    infra: env('INFRA_REPO'), target: env('DEPLOY_TARGET'),
    sha: env('DEPLOY_SHA'), image: env('DEPLOY_IMAGE'),
    requestId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.env.DEPLOY_TARGET}`,
    report: message => {
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
    } });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Deployment succeeded: [${process.env.DEPLOY_TARGET}](${run.html_url})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Deployment blocked or failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
