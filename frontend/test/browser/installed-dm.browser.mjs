import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, request as playwrightRequest } from 'playwright';
import { jsonResponse, installReviewedPackage } from './installed-graph-fixture.mjs';
import { installDmPackage } from './installed-dm-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-dm');
let directory, host, browser, admin, csrf, origin, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-graph-fixture-dm', CODEX_PLAYER_PASSWORD: 'local-graph-fixture-player' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-graph-fixture-dm' } }))).csrfToken;
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: 'arrival', expectedRevision: 0, value: { id: 'arrival', name: 'Arrival', short: 'At the northern gate.', sitting: 1, order: 1, visibility: 'public' } },
    { operation: 'put', collection: 'events', key: 'dinner', expectedRevision: 0, value: { id: 'dinner', name: 'Dinner', sitting: 1, order: 2, visibility: 'public' } },
    { operation: 'put', collection: 'events', key: 'secret-event', expectedRevision: 0, value: { id: 'secret-event', name: 'Hidden meeting', sitting: 1, order: 3, visibility: 'dm' } },
  ] } }));
  browser = await chromium.launch({ headless: true });
});

async function disable(id) {
  const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  return jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: snapshot.state.revision } }));
}
async function open(t, role = 'dm', mobile = false) {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  t.after(() => context.close());
  if (role) await jsonResponse(await context.request.post('/api/login', { data: { password: `local-graph-fixture-${role}` } }));
  await context.addInitScript(() => { if (!localStorage.getItem('codex_lang')) localStorage.setItem('codex_lang', 'en'); });
  const page = await context.newPage(); await page.goto('/#/dm'); await page.locator('#dm-page-title').waitFor(); return page;
}
function slotRoot(page, mode) {
  const root = page.locator('[data-dm-dashboard-slot]');
  return mode === 'isolated' ? root.frameLocator('iframe') : root;
}

test('DM panel preserves the fallback cards and hidden sidebar tool access on desktop and phone', async t => {
  const id = 'dm-fallback'; await installDmPackage(admin, csrf, { id, slot: false }); t.after(() => disable(id));
  for (const mobile of [false, true]) {
    const page = await open(t, 'dm', mobile);
    await page.locator(`[data-addon-health="${id}"]`).waitFor();
    assert.equal(await page.locator('.dm-count-card[data-dm-collection]').count(), 8);
    assert.match(await page.locator('[data-dm-collection="events"]').textContent(), /1\s*\/\s*3/u);
    const tool = page.locator('.dm-panel').getByRole('link', { name: /Fixture planner/ }); await tool.waitFor();
    assert.equal(await page.locator('[data-addon-navigation] a').count(), 0);
    const style = await page.locator('#dm-page-title').evaluate(element => ({ color: getComputedStyle(element).color, font: getComputedStyle(element).fontFamily }));
    assert.equal(style.color, 'rgb(200, 160, 64)'); assert.match(style.font, /Cinzel/u);
    assert.equal(await page.locator('.dm-actions > a').evaluate(element => getComputedStyle(element).color), 'rgb(200, 160, 64)');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, mobile ? 'fallback-phone.png' : 'fallback-desktop.png'), fullPage: true });
    await tool.click(); await page.getByRole('heading', { name: 'Fixture planner page' }).waitFor();
    await page.goto('/#/dm'); await page.locator('[data-dm-collection="events"]').click(); await page.locator('.tl-shell').waitFor();
  }
  const dm = await open(t);
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  const hidden = campaign.collections.find(collection => collection.name === 'events').records.find(record => record.key === 'secret-event');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: hidden.key, expectedRevision: hidden.revision, value: { ...hidden.value, visibility: 'public' } },
  ] } }));
  await dm.locator('[data-dm-collection="events"] .dm-count-numbers strong').filter({ hasText: /^0$/u }).waitFor();
  await dm.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await dm.reload();
  await dm.getByRole('heading', { name: 'Skrytý obsah' }).waitFor();
  await dm.evaluate(() => localStorage.setItem('codex_lang', 'en')); await dm.reload();
  await dm.locator('.account-menu summary').click();
  await dm.getByRole('button', { name: 'View as player' }).click();
  await dm.getByText('This page is available only in DM view.').waitFor();
  assert.equal(await dm.locator('.dm-count-card').count(), 0);
  assert.equal(await dm.locator('.sidebar-footer > a[href="#/dm"]').count(), 0);
  for (const role of ['player', '']) {
    const page = await open(t, role); await page.getByText('This page is available only in DM view.').waitFor();
    assert.equal(await page.locator('[data-dm-dashboard-slot], .dm-count-card, [data-addon-health]').count(), 0);
  }
});

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} DM dashboard mounts only in the DM route and cleans up on replacement and disable`, async t => {
  const id = `dm-${mode}`; await installDmPackage(admin, csrf, { id, mode }); t.after(() => disable(id));
  const page = await open(t, 'dm', mode === 'isolated'), slot = slotRoot(page, mode);
  await slot.getByRole('heading', { name: 'Fixture DM workspace 1.0.0' }).waitFor();
  assert.equal(await page.locator('codex-dm-dashboard').evaluate(element => element.degraded), false,
    JSON.stringify(await page.locator('codex-app').evaluate(element => element.addonState)));
  await page.locator('[data-dm-collection="events"]').waitFor({ state: 'detached' });
  await slot.getByLabel('Fixture notes').fill('Keep these notes');
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  const event = campaign.collections.find(collection => collection.name === 'events').records.find(record => record.key === 'arrival');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: event.key, expectedRevision: event.revision, value: { ...event.value, short: `Changed ${event.revision}` } },
  ] } }));
  await page.waitForFunction(revision => document.querySelector('codex-dm-dashboard').campaign.collections.find(collection => collection.name === 'events').records.find(record => record.key === 'arrival').revision > revision, event.revision);
  assert.equal(await slot.getByLabel('Fixture notes').inputValue(), 'Keep these notes');
  const player = await open(t, 'player'); assert.equal(await player.locator('[data-dm-dashboard-slot]').count(), 0);
  await page.goto('/#/'); assert.equal(await page.locator(`[data-addon-slot] [data-addon-id="${id}"]`).count(), 0);
  await page.goto('/#/dm'); await slotRoot(page, mode).getByRole('heading', { name: 'Fixture DM workspace 1.0.0' }).waitFor();
  await installDmPackage(admin, csrf, { id, mode, version: '1.0.1' });
  await slotRoot(page, mode).getByRole('heading', { name: 'Fixture DM workspace 1.0.1' }).waitFor();
  await disable(id); await page.locator('[data-dm-collection="events"]').waitFor();
  assert.equal(await page.locator(`[data-dm-dashboard-slot] [data-addon-id="${id}"]`).count(), 0);
});

test('failed dashboard rendering and activation retain useful DM fallback and retry', async t => {
  const id = 'dm-failed'; await installDmPackage(admin, csrf, { id, failure: 'mount' }); t.after(() => disable(id));
  const page = await open(t); await page.locator('.dm-panel [role="alert"]').waitFor();
  await page.locator('.dm-panel').getByRole('link', { name: /Fixture planner/ }).waitFor();
  assert.equal(await page.locator('.dm-panel').textContent().then(text => text.includes('Private fixture')), false);
  await page.getByRole('button', { name: 'Reload add-on tools' }).click();
  await page.locator('.dm-panel [role="alert"]').waitFor();
  await installDmPackage(admin, csrf, { id, version: '1.0.1', failure: 'activation' });
  await page.locator(`[data-addon-health="${id}"] .failed`).waitFor();
  assert.equal(await page.locator('.dm-panel').getByRole('link', { name: /Fixture planner/ }).count(), 0);
  await page.locator('[data-dm-collection="events"]').waitFor();
  await installDmPackage(admin, csrf, { id: 'dm-healthy' }); t.after(() => disable('dm-healthy'));
  await slotRoot(page, 'integrated').getByRole('heading', { name: 'Fixture DM workspace 1.0.0' }).waitFor();
  await page.locator(`[data-addon-health="${id}"] .failed`).waitFor();
  await installDmPackage(admin, csrf, { id, version: '1.0.2' });
  await slotRoot(page, 'integrated').getByRole('heading', { name: 'Fixture DM workspace 1.0.2' }).waitFor();
  await page.locator('[data-dm-collection="events"]').waitFor({ state: 'detached' });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('reviewed DM Tools package opens its planner and Import Center from the DM fallback', async t => {
  const archive = await readFile(resolve(process.env.CODEX_DM_TOOLS_ZIP));
  await installReviewedPackage(admin, csrf, 'dm-tools', archive, []); t.after(() => disable('dm-tools'));
  const page = await open(t); const panel = page.locator('.dm-panel');
  await panel.getByRole('link', { name: /Story Planner/ }).click();
  await page.getByRole('heading', { name: 'Story Planner', exact: true }).waitFor();
  await page.goto('/#/dm'); await panel.getByRole('link', { name: /Import Center/ }).click();
  await page.getByRole('heading', { name: 'Import Center', exact: true }).waitFor();
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
