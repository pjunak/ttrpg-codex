import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type API = (path: string, method?: string, body?: unknown) => Promise<unknown>;
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid GitHub response');
  return v as Record<string, unknown>;
};
const id = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new Error('Invalid GitHub ID');
  return v;
};
export function packageFile(directory: string): { name: string; bytes: Uint8Array; digest: string } {
  const files = readdirSync(directory);
  if (files.length !== 1 || !/^[a-z0-9][a-z0-9._-]*\.zip$/i.test(files[0]!)) throw new Error('Expected exactly one inspected package ZIP');
  const file = join(directory, files[0]!); const stat = lstatSync(file);
  if (!stat.isFile() || stat.size < 4 || stat.size > 128 * 1024 * 1024) throw new Error('Invalid package file');
  const bytes = new Uint8Array(readFileSync(file));
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Package is not a ZIP');
  return { name: files[0]!, bytes, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}

export async function publish({ api, upload, repo, sha, runId, package: pkg }: {
  api: API; upload: (releaseId: number, name: string, bytes: Uint8Array) => Promise<unknown>;
  repo: string; sha: string; runId: string; package: ReturnType<typeof packageFile>;
}): Promise<string> {
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo) || !/^[a-f0-9]{40}$/.test(sha) || !/^[1-9][0-9]*$/.test(runId)) throw new Error('Invalid release identity');
  const base = `/repos/${repo}`, tag = `build-${sha}`;
  const lineage = record(await api(`${base}/compare/${sha}...main`));
  if (!['identical', 'ahead'].includes(String(lineage.status))) throw new Error('Commit is not on main');
  const ref = await api(`${base}/git/ref/tags/${tag}`);
  if (ref !== null && record(record(ref).object).sha !== sha) throw new Error('Release tag points to another commit');
  const existing = await api(`${base}/releases/tags/${tag}`);
  let release = existing === null ? record(await api(`${base}/releases`, 'POST', {
    tag_name: tag, target_commitish: sha, name: `Tested commit ${sha.slice(0, 12)}`,
    body: `Package built and inspected in https://github.com/${repo}/actions/runs/${runId}.\n\nSource commit: ${sha}\nPackage: ${pkg.name}\nSHA-256: ${pkg.digest}\n\nInstall or update through your website, review the package, then activate it when ready. Publishing does not update any installation.`,
    draft: true, prerelease: false, make_latest: 'false',
  })) : record(existing);
  const releaseId = id(release.id);
  if (release.tag_name !== tag || release.target_commitish !== sha || release.prerelease !== false || typeof release.draft !== 'boolean' || !Array.isArray(release.assets)) throw new Error('Release identity differs from the tested commit');
  if (release.assets.length > 1) throw new Error('Commit release contains unexpected assets');
  const asset = release.assets.length ? record(release.assets[0]) : null;
  if (asset && (asset.name !== pkg.name || asset.digest !== pkg.digest || asset.state !== 'uploaded')) throw new Error('Published package differs; existing assets will not be overwritten');
  if (!asset) {
    if (!release.draft) throw new Error('Published release has no package; inspect it before retrying');
    const saved = record(await upload(releaseId, pkg.name, pkg.bytes));
    if (saved.name !== pkg.name || saved.digest !== pkg.digest || saved.state !== 'uploaded') throw new Error('Uploaded package verification failed');
  }
  if (release.draft) {
    const latest = await api(`${base}/releases/latest`);
    let makeLatest = true;
    if (latest !== null) {
      const previous = record(latest).tag_name;
      if (typeof previous !== 'string' || !previous) throw new Error('Invalid latest release');
      const comparison = record(await api(`${base}/compare/${encodeURIComponent(previous)}...${sha}`));
      if (!['ahead', 'behind', 'identical', 'diverged'].includes(String(comparison.status))) throw new Error('Cannot order releases');
      makeLatest = ['ahead', 'diverged'].includes(String(comparison.status));
    }
    release = record(await api(`${base}/releases/${releaseId}`, 'PATCH', { draft: false, make_latest: String(makeLatest) }));
    if (release.draft !== false || release.tag_name !== tag) throw new Error('Release publication not confirmed');
  }
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

export function github(token: string, request: typeof fetch = fetch) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  async function send(url: string, method: string, body?: BodyInit, contentType = 'application/json'): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': contentType, 'X-GitHub-Api-Version': '2026-03-10' },
        ...(body === undefined ? {} : { body }) });
      if (method === 'GET' && response.status === 404) return null;
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      if (!response.ok) throw new Error(`GitHub ${method} returned HTTP ${response.status}; inspect the commit release before retrying`);
      return response.json();
    }
    throw new Error('GitHub read failed');
  }
  return {
    api: (path: string, method = 'GET', body?: unknown) => send('https://api.github.com' + path, method, body === undefined ? undefined : JSON.stringify(body)),
    upload: (repo: string) => (releaseId: number, name: string, bytes: Uint8Array) => send(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, 'POST', new Blob([new Uint8Array(bytes)]), 'application/zip'),
  };
}

async function main() {
  const env = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`Missing ${name}`); return v; };
  if (env('GITHUB_REF') !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env('GITHUB_EVENT_NAME'))) throw new Error('Only tested main builds may publish');
  const repo = env('GITHUB_REPOSITORY'), client = github(env('GH_TOKEN'));
  const url = await publish({ api: client.api, upload: client.upload(repo), repo, sha: env('GITHUB_SHA'), runId: env('GITHUB_RUN_ID'), package: packageFile(env('PACKAGE_DIRECTORY')) });
  console.log('Tested add-on release: ' + url);
  if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `Available for owner-selected installation: ${url}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Release publication failed'); process.exitCode = 1; });
