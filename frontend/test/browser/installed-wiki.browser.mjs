import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, after, test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, request as playwrightRequest } from 'playwright';
import { installReviewedPackage, zip, jsonResponse } from './installed-graph-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-wiki');
let directory, host, browser, admin, csrf, origin, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-wiki-fixture-dm', CODEX_PLAYER_PASSWORD: 'local-wiki-fixture-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Host startup. */ }
    if (host.exitCode !== null) break;
    await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-wiki-fixture-dm' } }))).csrfToken;
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'characters', key: 'captain', expectedRevision: 0, value: { id: 'captain', name: 'Captain', knowledge: 4, faction: 'party', visibility: 'public' } },
    { operation: 'put', collection: 'characters', key: 'secret', expectedRevision: 0, value: { id: 'secret', name: 'Hidden witness', knowledge: 4, visibility: 'dm' } },
  ] } }));
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close(); await admin?.dispose();
  if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; }
  if (directory) {
    const child = relative(output, directory);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function open(t, role = 'dm', mobile = false) {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  t.after(() => context.close());
  await jsonResponse(await context.request.post('/api/login', { data: { password: `local-wiki-fixture-${role}` } }));
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex_lang', 'en'); });
  const page = await context.newPage(); await page.goto('/#/graph/relationships');
  await page.locator('.cm-node[data-key="captain"]').waitFor(); return page;
}
async function disable(id) {
  const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  return jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: snapshot.state.revision } }));
}

function wikiPackage(id, mode, { version = '1.0.0', roles = ['dm', 'player'] } = {}) {
  const manifest = { packageFormat: 1, id, name: 'Reference fixture', version, compatibility: { host: '>=2.0.0 <3.0.0', addonApi: '^3.0.0' },
    capabilities: { required: ['ui.contributions'], optional: [] }, runtime: { ui: { mode, entry: 'web/index.js' } }, permissions: [], contributions: [
      { id: 'links', surface: 'wiki-kind', label: 'Fixture library', roles, config: { contractVersion: 1, kinds: ['spell'], legacyRoots: ['old-library'], search: true } },
      { id: 'detail', surface: 'route', label: 'Library detail', roles, config: { path: 'library' } },
    ] };
  const entry = `export function activate(context) {
    const tag = 'fixture-wiki-' + context.addon.generation;
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement { connectedCallback() { this.textContent = 'Reference detail'; } });
    if (context.ui.declarations().some(item => item.id === 'detail')) context.ui.bind('detail', { kind: 'element', tag });
    if (context.ui.declarations().some(item => item.id === 'links')) context.ui.bind('links', { kind: 'model-provider', provide(request) {
      if (Object.keys(request).some(key => !['contractVersion','operation','references','query','limit'].includes(key))) throw Error('Unexpected article context');
      const target = { route: 'detail', query: [['id', 'shield']] };
      return { contractVersion: 'wiki-links.v1', matches: request.operation === 'search' ? [{index:0,label:'Shield reference',target}] : request.references.flatMap((reference,index) => {
        if (reference.label === 'Captain') throw Error('Core references should take priority');
        return reference.path || reference.hint === 'spell:shield' ? [{index,target}] : [];
      }) };
    } });
  }`;
  const files = { 'addon.json': JSON.stringify(manifest), 'web/index.js': entry };
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files);
}

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} reference providers resolve articles, search and old URLs across replacement`, async t => {
  const id = `wiki-${mode}`, archive = wikiPackage(id, mode);
  await installReviewedPackage(admin, csrf, id, archive, []);
  t.after(() => disable(id));
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'characters', key: id, expectedRevision: 0, value: { id, name: 'Reference notes', knowledge: 4, visibility: 'public', description: '[[Captain]] and [[Ward|spell:shield]].' } },
  ] } }));
  const page = await open(t, 'player', mode === 'isolated');
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(`/#/characters/${id}`);
  const ward = page.locator('a.wiki-link').filter({ hasText: 'Ward' }); await ward.waitFor();
  assert.equal(await page.locator('a.wiki-link').filter({ hasText: 'Captain' }).getAttribute('href'), '#/characters/captain');
  assert.equal(await ward.getAttribute('href'), `#/addons/${id}/library?id=shield`);
  await installReviewedPackage(admin, csrf, id, wikiPackage(id, mode, { version: '1.0.1' }), []);
  await ward.waitFor();
  await disable(id); await ward.waitFor({ state: 'detached' });
  await installReviewedPackage(admin, csrf, id, archive, []); await ward.waitFor();
  await page.goto('/#/search'); await page.locator('.campaign-search-field input').fill('shield');
  await page.getByRole('link', { name: 'Shield reference' }).waitFor();
  await page.goto('/#/old-library/spell:shield');
  await (mode === 'isolated' ? page.frameLocator('[data-addon-route-outlet] iframe').getByText('Reference detail') : page.getByText('Reference detail')).waitFor();
  assert.ok(page.url().endsWith(`#/addons/${id}/library?id=shield`));
  await page.reload();
  await (mode === 'isolated' ? page.frameLocator('[data-addon-route-outlet] iframe').getByText('Reference detail') : page.getByText('Reference detail')).waitFor();
  await installReviewedPackage(admin, csrf, id, wikiPackage(id, mode, { version: '1.0.2', roles: ['dm'] }), []);
  await page.goto(`/#/characters/${id}`);
  // Loading and missing references share a CSS class; wait for resolution.
  await page.getByTitle('No unique visible entry matches this link. Check its kind or record ID.').filter({ hasText: 'Ward' }).waitFor();
  assert.equal(await ward.count(), 0);
  await page.goto('/#/old-library/spell:shield'); await page.getByRole('heading', { name: 'This page is not in the index.' }).waitFor();
});
