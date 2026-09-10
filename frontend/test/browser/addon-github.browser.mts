import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { visualFixturePlugin } from './visual-fixture.mts';
interface GitHubSource { repo: string; channel: 'actions' | 'release'; branch: string; artifact: string }
interface GitHubLink { addonId: string; revision: number; source: GitHubSource }

let server: PreviewServer, browser: Browser, origin: string;
const output = fileURLToPath(new URL('../../test-results/addon-github/', import.meta.url));
before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error', plugins: [visualFixturePlugin()], preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const mobile of [false, true]) test(`GitHub installation, token management and reviewed updates (${mobile ? 'phone' : 'desktop'})`, async t => {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 }, extraHTTPHeaders: { 'X-Fixture-Role': 'dm' } });
  t.after(() => context.close()); const page = await context.newPage(); page.setDefaultTimeout(7000);
  await page.addInitScript(() => { if (!localStorage.getItem('codex_lang')) localStorage.setItem('codex_lang', 'en'); });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const source: GitHubSource = { repo: 'owner/private', channel: 'actions', branch: '', artifact: 'reviewed-package' };
  let links: GitHubLink[] = [], active = '', target = 'a'.repeat(64), revision = 0, downloads = 0, checks = 0, tokenWrites = 0, lostTokenResponse = false, failDiscovery = false;
  let reviewed = '';
  const tokens = new Map<string, string>();
  const generations: { addonId: string; generationId: string; version: string; installedAt: string }[] = [];
  const status = () => ({ contractVersion: 'addon-github.v1', sources: links, credentials: { defaultSource: tokens.has('') ? 'stored' : 'none', environmentConfigured: false, repositories: [...tokens.keys()].filter(Boolean) } });
  const review = (state = 'prepared') => ({ reviewId: 'review-1', addonId: 'example', generationId: reviewed, proposalSha256: 'e'.repeat(64), status: state,
    proposal: { addonId: 'example', generationId: reviewed, targetManifest: { id: 'example', name: 'GitHub test', version: generations.find(g => g.generationId === reviewed)!.version, permissions: [] },
      ...(active ? { currentManifest: { version: generations.find(g => g.generationId === active)!.version } } : {}), changes: { runtimeChanged: false }, requiredPermissionIds: [], restartedAddonIds: [], blockers: [] } });
  await page.route('**/api/admin/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname, body = req.postData() ? req.postDataJSON() as Record<string, unknown> : {};
    if (req.method() === 'POST') assert.equal(req.headers()['x-codex-csrf'], 'x'.repeat(32));
    let value: unknown;
    if (path === '/api/admin/addon-github') value = status();
    else if (path.endsWith('/addon-github/token')) {
      tokenWrites++; const repo = String(body.repo).toLowerCase(), token = String(body.token);
      if (token) tokens.set(repo, token); else tokens.delete(repo);
      if (lostTokenResponse) { lostTokenResponse = false; await route.abort('failed'); return; } value = status();
    } else if (path.endsWith('/addon-github/source')) {
      if (body.remove) links = []; else links = [{ addonId: String(body.addonId), revision: Number(body.revision)+1, source: body.source as GitHubSource }]; value = status();
    } else if (path.endsWith('/addon-github/discover')) {
      checks++; if (failDiscovery) { await route.fulfill({ status: 502, json: { error: { kind: 'GITHUB_UNAVAILABLE' } } }); return; }
      value = { source, candidates: [{ id: target, name: 'reviewed-package', version: target, digest: '', active: target === active }] };
    } else if (path.endsWith('/addon-github/stage')) {
      downloads++; assert.equal(body.candidateId, target);
      const generation = { addonId: 'example', generationId: target, version: target.startsWith('a') ? '1.0.0' : '1.1.0', installedAt: '2026-09-10T10:00:00Z' };
      if (!generations.some(g => g.generationId === target)) generations.push(generation);
      if (!links.length) links = [{ addonId: 'example', revision: 1, source }]; value = generation;
    } else if (path === '/api/admin/addons') value = { contractVersion: 'addon-inventory.v1', addonIds: generations.length ? ['example'] : [] };
    else if (path === '/api/admin/addons/example') value = { state: { addonId: 'example', revision, ...(active ? { activeGenerationId: active } : {}) }, generations, events: [] };
    else if (path === '/api/admin/addons/example/activation-reviews') { reviewed = String(body.generationId); value = review(); }
    else if (path.endsWith('/approval')) value = review('approved');
    else if (path.endsWith('/activation')) { active = reviewed; revision++; value = { state: { addonId: 'example', activeGenerationId: active } }; }
    else { await route.fulfill({ status: 404, json: { error: { kind: 'NOT_FOUND' } } }); return; }
    await route.fulfill({ json: value });
  });
  await page.goto(`${origin}/#/settings`); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), github = manager.locator('codex-addon-github'), tokenForm = github.locator('.github-tokens form');
  await github.getByRole('button', { name: 'Save or replace token', exact: true }).waitFor();
  await tokenForm.locator('input[name="repo"]').fill('owner/private'); await tokenForm.locator('input[name="token"]').fill('synthetic-private-token');
  await tokenForm.getByRole('button').click(); await github.getByText('GitHub token settings saved.', { exact: true }).waitFor();
  assert.equal(await tokenForm.locator('input[name="token"]').inputValue(), ''); assert.equal(await github.textContent().then(text => text?.includes('synthetic-private-token')), false);
  const connect = github.locator('form').first(); await connect.locator('input[name="repo"]').fill('owner/private');
  await connect.getByRole('button', { name: 'Find package' }).click(); await github.getByRole('button', { name: 'Download and review' }).waitFor();
  assert.equal(downloads, 0); await github.getByRole('button', { name: 'Download and review' }).click();
  const reviewPanel = manager.locator('.addon-review'); await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor();
  assert.equal(await page.locator('#addon-review-title').evaluate(el => el === document.activeElement), true);
  assert.equal(active, ''); await reviewPanel.getByRole('button', { name: 'Approve and activate' }).click(); await manager.getByText('Add-on state updated.', { exact: true }).waitFor();
  const sourceRow = github.locator('[data-github-addon="example"]'); await sourceRow.getByRole('button', { name: 'Check for updates', exact: true }).click(); await sourceRow.getByText('Up to date', { exact: true }).waitFor();
  target = 'b'.repeat(64); await sourceRow.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await sourceRow.getByRole('button', { name: 'Download and review' }).click(); await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor(); assert.equal(active, 'a'.repeat(64));
  await reviewPanel.getByRole('button', { name: 'Cancel review' }).click(); assert.equal(active, 'a'.repeat(64));
  await sourceRow.getByRole('button', { name: 'Check for updates', exact: true }).click(); await sourceRow.getByRole('button', { name: 'Download and review' }).click();
  await reviewPanel.getByRole('button', { name: 'Approve and activate' }).click(); await manager.getByText('Add-on state updated.', { exact: true }).waitFor(); assert.equal(active, target);
  failDiscovery = true; await github.getByRole('button', { name: 'Check all for updates' }).click(); await sourceRow.getByRole('alert').filter({ hasText: 'GitHub could not be reached' }).waitFor();
  failDiscovery = false;
  lostTokenResponse = true; await tokenForm.locator('input[name="token"]').fill('replacement-private-token'); await tokenForm.getByRole('button').click();
  await github.getByRole('alert').waitFor(); assert.equal(await tokenForm.locator('input[name="token"]').inputValue(), '');
  await github.getByRole('button', { name: 'Refresh list', exact: true }).click(); await github.locator('.addon-github[aria-busy="false"]').waitFor(); assert.equal(tokenWrites, 2);
  await page.reload(); await page.locator('[data-category="addons"]').click(); await sourceRow.waitFor();
  await github.getByRole('button', { name: 'Remove token', exact: true }).click(); await github.getByText('GitHub token settings saved.', { exact: true }).waitFor(); assert.equal(tokens.size, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.ok(checks >= 5);
  await github.screenshot({ path: `${output}/${mobile ? 'phone' : 'desktop'}.png` });
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('[data-category="addons"]').click();
  await github.getByRole('button', { name: 'Zkontrolovat aktualizace všech', exact: true }).waitFor();
  await sourceRow.getByRole('button', { name: 'Odpojit repozitář', exact: true }).click(); await sourceRow.waitFor({ state: 'detached' }); assert.equal(active, target);
});
