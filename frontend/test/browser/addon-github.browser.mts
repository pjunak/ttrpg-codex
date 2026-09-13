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
  let heldDiscovery: Promise<void> | undefined, finishDiscovery: (() => void) | undefined;
  t.after(() => finishDiscovery?.());
  const tokens = new Map<string, string>();
  const generations: { addonId: string; generationId: string; version: string; installedAt: string }[] = [];
  const status = () => ({ contractVersion: 'addon-github.v1', sources: links, credentials: { defaultSource: tokens.has('') ? 'stored' : 'none', environmentConfigured: false, repositories: [...tokens.keys()].filter(Boolean) } });
  const review = (state = 'prepared') => ({ reviewId: 'review-1', addonId: 'example', generationId: reviewed, proposalSha256: 'e'.repeat(64), status: state,
    proposal: { addonId: 'example', generationId: reviewed, targetManifest: { id: 'example', name: 'GitHub test', version: generations.find(g => g.generationId === reviewed)!.version, permissions: [] },
      ...(active ? { currentManifest: { version: generations.find(g => g.generationId === active)!.version } } : {}), changes: { runtimeChanged: false }, requiredPermissionIds: [], restartedAddonIds: [], blockers: [] } });
  await page.route('**/api/admin/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname, body = req.headers()['content-type']?.includes('application/json') && req.postData() ? req.postDataJSON() as Record<string, unknown> : {};
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
      checks++; if (heldDiscovery) { const held = heldDiscovery; heldDiscovery = undefined; await held; }
      if (failDiscovery) { await route.fulfill({ status: 502, json: { error: { kind: 'GITHUB_UNAVAILABLE' } } }); return; }
      value = { source, candidates: [{ id: target, name: 'reviewed-package', version: target, digest: '', active: target === active }] };
    } else if (path.endsWith('/addon-github/stage')) {
      downloads++; assert.equal(body.candidateId, target);
      const generation = { addonId: 'example', generationId: target, version: '1.0.0', installedAt: '2026-09-10T10:00:00Z' };
      if (!generations.some(g => g.generationId === target)) generations.push(generation);
      if (!links.length) links = [{ addonId: 'example', revision: 1, source }]; value = generation;
    } else if (path === '/api/admin/addons/generations') {
      const generation = { addonId: 'example', generationId: 'c'.repeat(64), version: '2.0.0', installedAt: '2026-09-12T10:00:00Z' };
      generations.push(generation); value = generation;
    }
    else if (path === '/api/admin/addons') value = { contractVersion: 'addon-inventory.v1', addonIds: generations.length ? ['example'] : [] };
    else if (path === '/api/admin/addons/example') value = { state: { addonId: 'example', revision, ...(active ? { activeGenerationId: active } : {}) }, generations, events: [] };
    else if (path === '/api/admin/addons/example/activation-reviews') { reviewed = String(body.generationId); value = review(); }
    else if (path.endsWith('/approval')) value = review('approved');
    else if (path.endsWith('/activation')) { active = reviewed; revision++; value = { state: { addonId: 'example', activeGenerationId: active } }; }
    else { await route.fulfill({ status: 404, json: { error: { kind: 'NOT_FOUND' } } }); return; }
    await route.fulfill({ json: value });
  });
  await page.goto(`${origin}/#/settings`); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), add = manager.getByRole('button', { name: 'Add add-on', exact: true });
  const check = manager.getByRole('button', { name: 'Check for updates', exact: true });
  const dialog = manager.getByRole('dialog'), sourceRow = manager.locator('[data-github-addon="example"]');
  await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  for (const button of [add, check]) assert.equal(await button.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'toolbar labels fit their buttons');
  assert.equal(await manager.locator('input[type="file"]:visible, input[name="repo"]:visible').count(), 0);
  await check.click(); await manager.getByText('No GitHub repositories are linked yet.', { exact: false }).waitFor();
  await add.click(); await dialog.getByRole('heading', { name: 'Choose a source' }).waitFor();
  const githubChoice = dialog.getByRole('button', { name: 'GitHub Install from a repository', exact: false });
  await githubChoice.focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await githubChoice.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await add.evaluate(el => el === document.activeElement), true);
  await add.click(); await githubChoice.click();
  const connect = dialog.locator('form.addon-install-form');
  await connect.locator('input[name="repo"]').fill('owner/private');
  assert.equal(await connect.getByLabel('Package source').inputValue(), 'release', 'new sources default to durable releases');
  assert.equal(await connect.locator('input[name="token"]').count(), 0);
  await connect.getByLabel('Private repository').check();
  await dialog.getByRole('link', { name: 'Create a fine-grained token on GitHub.' }).waitFor();
  await connect.getByRole('button', { name: 'Find package', exact: true }).click();
  assert.equal(checks, 0, 'a private source requires access before discovery');
  await connect.getByLabel('Package source').selectOption('actions');
  await connect.locator('input[name="token"]').fill('synthetic-private-token');
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await dialog.screenshot({ path: `${output}/${mobile ? 'phone' : 'desktop'}-private-wizard.png` });
  heldDiscovery = new Promise<void>(resolve => { finishDiscovery = resolve; });
  await connect.getByRole('button', { name: 'Find package', exact: true }).click();
  await connect.getByRole('button', { name: 'Checking repository…', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true);
  finishDiscovery!();
  await dialog.getByRole('button', { name: 'Download and review' }).waitFor();
  assert.equal(tokenWrites, 1); assert.equal(tokens.get('owner/private'), 'synthetic-private-token');
  assert.equal(await connect.locator('input[name="token"]').inputValue(), '');
  assert.equal(await manager.textContent().then(text => text?.includes('synthetic-private-token')), false);
  // Editing the source invalidates the displayed selection before it can be downloaded.
  await connect.locator('input[name="repo"]').fill('owner/changed');
  await dialog.getByRole('button', { name: 'Download and review' }).waitFor({ state: 'detached' });
  await connect.locator('input[name="repo"]').fill('owner/private');
  await connect.getByRole('button', { name: 'Find package', exact: true }).click();
  await dialog.getByRole('button', { name: 'Download and review' }).waitFor();
  assert.equal(downloads, 0); await dialog.getByRole('button', { name: 'Download and review' }).click();
  const reviewPanel = dialog.locator('.addon-review');
  await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor();
  assert.equal(await page.locator('#addon-review-title').evaluate(el => el === document.activeElement), true);
  assert.equal(active, ''); await reviewPanel.getByRole('button', { name: 'Approve and activate' }).click();
  await dialog.waitFor({ state: 'detached' }); await manager.getByText('Add-on state updated.', { exact: true }).waitFor();
  await check.click(); await sourceRow.getByText('Up to date', { exact: true }).waitFor();
  // A new commit remains an update even when the package version is unchanged.
  target = 'b'.repeat(64); await check.click();
  await sourceRow.getByRole('button', { name: 'Download and review' }).click();
  await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor(); assert.equal(active, 'a'.repeat(64));
  await reviewPanel.getByRole('button', { name: 'Cancel review' }).click(); assert.equal(active, 'a'.repeat(64));
  await check.click(); await sourceRow.getByRole('button', { name: 'Download and review' }).click();
  await reviewPanel.getByRole('button', { name: 'Approve and activate' }).click();
  await dialog.waitFor({ state: 'detached' }); await manager.getByText('Add-on state updated.', { exact: true }).waitFor(); assert.equal(active, target);
  failDiscovery = true; await check.click(); await sourceRow.getByRole('alert').filter({ hasText: 'GitHub could not be reached' }).waitFor();
  failDiscovery = false; await check.click(); await sourceRow.getByText('Up to date', { exact: true }).waitFor();
  // Source editing and token replacement stay attached to the installed add-on.
  await sourceRow.locator('summary').click(); await sourceRow.getByRole('button', { name: 'Edit GitHub source' }).click();
  await connect.locator('input[name="repo"]').waitFor(); assert.equal(await connect.locator('input[name="repo"]').inputValue(), 'owner/private');
  assert.equal(await connect.getByLabel('Package source').inputValue(), 'actions', 'existing linked sources keep their selected channel');
  lostTokenResponse = true; await connect.locator('input[name="token"]').fill('replacement-private-token');
  await connect.getByRole('button', { name: 'Check and save source' }).click();
  await dialog.getByRole('alert').waitFor(); await dialog.locator('.addon-install-step[aria-busy="false"]').waitFor();
  assert.equal(await connect.locator('input[name="token"]').inputValue(), ''); assert.equal(tokenWrites, 2);
  await connect.getByRole('button', { name: 'Check and save source' }).click();
  await dialog.waitFor({ state: 'detached' }); await sourceRow.getByText('Up to date', { exact: true }).waitFor();
  assert.equal(tokenWrites, 2, 'retry reads saved access without replaying the token write');
  // ZIPs enter the same review and do not replace the active version on cancellation.
  await add.click(); await dialog.getByRole('button', { name: 'ZIP file Upload', exact: false }).click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'example.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic package') });
  await dialog.getByRole('button', { name: 'Inspect ZIP', exact: true }).click();
  await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor(); assert.equal(active, target);
  await reviewPanel.getByRole('button', { name: 'Cancel review' }).click(); assert.equal(active, target);
  await page.reload(); await page.locator('[data-category="addons"]').click(); await sourceRow.waitFor();
  const tokensPanel = manager.locator('.github-tokens'); await tokensPanel.locator(':scope > summary').click();
  await tokensPanel.getByRole('button', { name: 'Remove token', exact: true }).click();
  await manager.getByText('GitHub token settings saved.', { exact: true }).waitFor(); assert.equal(tokens.size, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.ok(checks >= 5);
  await tokensPanel.locator(':scope > summary').click();
  await manager.screenshot({ path: `${output}/${mobile ? 'phone' : 'desktop'}.png` });
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('[data-category="addons"]').click();
  await manager.getByRole('button', { name: 'Zkontrolovat aktualizace', exact: true }).waitFor();
  await sourceRow.locator('summary').click(); await sourceRow.getByRole('button', { name: 'Odpojit repozitář', exact: true }).click();
  await sourceRow.getByRole('button', { name: 'Připojit GitHub', exact: true }).waitFor(); assert.equal(active, target);
  assert.equal(await manager.locator('[data-addon-id="example"]').count(), 1, 'unlinking preserves the installed row');
});
