import assert from 'node:assert/strict';
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
import { jsonResponse } from './installed-graph-fixture.mjs';
import { installTimelinePackage } from './installed-timeline-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-timeline');
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
  await jsonResponse(await context.request.post('/api/login', { data: { password: `local-graph-fixture-${role}` } }));
  await context.addInitScript(() => localStorage.setItem('codex_lang', 'en'));
  const page = await context.newPage(); await page.goto('/#/timeline'); await page.locator('.tl-card[data-key="arrival"]').waitFor(); return page;
}
function widget(page, id, mode, slot, eventKey) {
  const root = eventKey ? page.locator(`.tl-card[data-key="${eventKey}"]`) : page.locator('.tl-shell');
  const container = root.locator(`codex-timeline-slot[data-timeline-slot="${slot}"] .addon-contribution[data-addon-id="${id}"]`).first();
  return mode === 'isolated' ? container.frameLocator('iframe') : container;
}
async function details(widget) { return JSON.parse(await widget.locator('output').textContent()); }
async function refreshArrival() {
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  const event = campaign.collections.find(collection => collection.name === 'events').records.find(record => record.key === 'arrival');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: event.key, expectedRevision: event.revision, value: { ...event.value, short: `Updated ${event.revision}` } },
  ] } }));
  return event.revision + 1;
}

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} timeline slots retain widget state, role filtering and the original board`, async t => {
  const id = `timeline-${mode}`; await installTimelinePackage(admin, csrf, { id, mode }); t.after(() => disable(id));
  const page = await open(t, 'dm', mode === 'isolated');
  const extra = widget(page, id, mode, 'timeline:card:extra', 'arrival'); await extra.getByLabel('Widget draft').waitFor();
  const initial = await details(extra);
  assert.equal(initial.slot, 'timeline:card:extra'); assert.equal(initial.sitting, 1); assert.equal(initial.connections, 1);
  assert.deepEqual(initial.events.map(event => event.key), ['arrival']); assert.equal(JSON.stringify(initial).includes('northern gate'), false);
  await extra.getByLabel('Widget draft').fill('Keep this unsaved widget text');
  const revision = await refreshArrival();
  await extra.locator('output').filter({ hasText: `"revision":${revision}` }).waitFor();
  assert.equal(await extra.getByLabel('Widget draft').inputValue(), 'Keep this unsaved widget text'); assert.equal((await details(extra)).connections, 1);
  await extra.getByRole('button', { name: 'Widget action' }).click(); assert.equal(await extra.getByLabel('Widget draft').inputValue(), 'Action ran');
  assert.equal(new URL(page.url()).hash, '#/timeline');
  const header = widget(page, id, mode, 'timeline:column:header'); await header.locator('output').waitFor();
  assert.ok((await details(header)).events.some(event => event.key === 'secret-event'));
  await widget(page, id, mode, 'timeline:column:footer').locator('output').waitFor();
  await page.screenshot({ path: resolve(output, `${mode}.png`) });
  const player = await open(t, 'player'); const playerHeader = widget(player, id, mode, 'timeline:column:header'); await playerHeader.locator('output').waitFor();
  assert.deepEqual((await details(playerHeader)).events.map(event => event.key), ['arrival', 'dinner']);
  assert.equal(await player.locator('[data-timeline-slot="timeline:column:footer"]').count(), 0);
  await player.goto('/#/'); assert.equal(await player.locator(`[data-addon-slot] [data-addon-id="${id}"]`).count(), 0);
  await disable(id); await page.waitForFunction(() => document.querySelectorAll('codex-timeline-slot').length === 0);
  assert.equal(await page.locator('.tl-card[data-key="arrival"]').count(), 1);
});

test('timeline slot replacement and refresh preserve unsaved core ordering and enforce read grants', async t => {
  const id = 'timeline-no-read'; await installTimelinePackage(admin, csrf, { id, mode: 'isolated', read: false }); t.after(() => disable(id));
  const page = await open(t), extra = widget(page, id, 'isolated', 'timeline:card:extra', 'arrival'); await extra.locator('output').waitFor();
  assert.deepEqual((await details(extra)).events, []);
  await page.getByRole('button', { name: /Edit timeline/ }).click();
  await page.getByRole('button', { name: 'Move Arrival down' }).click();
  assert.deepEqual(await page.locator('.tl-col[data-sitting="1"] .tl-card').evaluateAll(cards => cards.map(card => card.dataset.key)), ['dinner', 'arrival', 'secret-event']);
  await installTimelinePackage(admin, csrf, { id, mode: 'isolated', read: false, version: '1.0.1' });
  await extra.locator('output').filter({ hasText: '1.0.1' }).waitFor();
  assert.equal((await details(extra)).editing, true);
  await refreshArrival();
  assert.deepEqual(await page.locator('.tl-col[data-sitting="1"] .tl-card').evaluateAll(cards => cards.map(card => card.dataset.key)), ['dinner', 'arrival', 'secret-event']);
  const addonInput = page.locator('.tl-toolbar codex-timeline-slot');
  assert.ok(await addonInput.count());
  page.on('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('a retained timeline draft does not share newly hidden event references with add-ons', async t => {
  const id = 'timeline-projection'; await installTimelinePackage(admin, csrf, { id, mode: 'isolated' }); t.after(() => disable(id));
  const page = await open(t, 'player'), header = widget(page, id, 'isolated', 'timeline:column:header'); await header.locator('output').waitFor();
  await page.getByRole('button', { name: /Edit timeline/ }).click(); await page.getByRole('button', { name: 'Move Arrival down' }).click();
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  const dinner = campaign.collections.find(collection => collection.name === 'events').records.find(record => record.key === 'dinner');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: 'dinner', expectedRevision: dinner.revision, value: { ...dinner.value, visibility: 'dm' } },
  ] } }));
  await header.locator('output').filter({ hasNotText: 'dinner' }).waitFor();
  assert.equal(await page.locator('.tl-card[data-key="dinner"]').count(), 1);
  assert.deepEqual((await details(header)).events.map(event => event.key), ['arrival']);
  page.on('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.tl-card[data-key="dinner"]').waitFor({ state: 'detached' });
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
