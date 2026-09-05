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
import { installGraphPackage, jsonResponse } from './installed-graph-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-graphs');
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
const card = (page, id, contribution = 'notes') => page.locator(`.cm-node[data-key=${JSON.stringify(JSON.stringify(['addon', id, contribution, 'node', 'note']))}]`);
async function open(t, role = 'dm', mobile = false) {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  t.after(() => context.close());
  await jsonResponse(await context.request.post('/api/login', { data: { password: `local-graph-fixture-${role}` } }));
  await context.addInitScript(() => localStorage.setItem('codex_lang', 'en'));
  const page = await context.newPage(); await page.goto('/#/graph/relationships');
  await page.locator('.cm-node[data-key="captain"]').waitFor(); return page;
}
async function disable(id) {
  const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  return jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: snapshot.state.revision } }));
}

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} graphs preserve core cards, detail navigation and local movement`, async t => {
  const id = `graph-${mode}`; await installGraphPackage(admin, csrf, { id, mode }); t.after(() => disable(id));
  const page = await open(t, 'dm', mode === 'isolated'), note = card(page, id);
  await note.waitFor(); assert.equal(await note.locator('.cm-name').textContent(), 'Trail note');
  assert.equal(await note.locator('.cm-hint').textContent(), 'Follow the northern road.');
  assert.equal(await page.locator('.cm-node[data-key="captain"] .cm-name').textContent(), 'Captain');
  await page.getByRole('link', { name: 'Trail board', exact: true }).click();
  const board = card(page, id, 'board'); await board.waitFor();
  assert.equal(await page.locator('.cm-node[data-key="captain"]').count(), 0);
  const before = await board.boundingBox(); await board.focus(); await page.keyboard.press('ArrowRight');
  const storage = await page.evaluate(view => JSON.parse(localStorage.getItem(`cm_pos_v3_addon:${view}:board`)), id);
  assert.equal(storage[JSON.stringify(['addon', id, 'board', 'node', 'note'])].x, 305);
  await page.screenshot({ path: resolve(output, `${mode}.png`) });
  await page.reload(); await card(page, id, 'board').waitFor();
  assert.ok(before.width > 0);
  assert.equal(await page.evaluate(view => JSON.parse(localStorage.getItem(`cm_pos_v3_addon:${view}:board`))[JSON.stringify(['addon', view, 'board', 'node', 'note'])].x, id), 305);
  await card(page, id, 'board').click();
  await (mode === 'isolated' ? page.frameLocator('[data-addon-route-outlet] iframe').getByText('Reviewed package detail') : page.getByText('Reviewed package detail')).waitFor();
  const player = await open(t, 'player'); await card(player, id).waitFor();
  assert.equal(await player.getByRole('link', { name: 'Trail board', exact: true }).count(), 0);
  assert.equal(await player.locator('.cm-node[data-key="secret"]').count(), 0);
  await player.goto(`/#/graph/addons/${id}/board`);
  await player.getByText('This add-on view is currently unavailable for your role.').waitFor();
  assert.equal(await card(player, id, 'board').count(), 0);
});

test('invalid and replaced installed graph models cannot leave stale cards behind', async t => {
  const id = 'graph-replace'; await installGraphPackage(admin, csrf, { id, mode: 'integrated', invalid: true }); t.after(() => disable(id));
  const page = await open(t); await page.getByRole('alert').filter({ hasText: 'Could not load graph content' }).waitFor();
  assert.equal(await card(page, id).count(), 0);
  await installGraphPackage(admin, csrf, { id, mode: 'integrated', version: '1.0.1', delay: 1000, label: 'Late old card' });
  await page.getByText('Loading add-on cards…').waitFor();
  await page.goto('/#/graph/mysteries'); await sleep(1100);
  assert.equal(await card(page, id).count(), 0);
  await page.goto('/#/graph/relationships'); await page.getByText('Loading add-on cards…').waitFor();
  await installGraphPackage(admin, csrf, { id, mode: 'integrated', version: '1.0.2', label: 'Current card' });
  await card(page, id).waitFor(); await sleep(1100);
  assert.ok((await card(page, id).innerText()).includes('Current card'));
  await disable(id); await card(page, id).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.cm-node[data-key="captain"]').count(), 1);
});

test('late installed models and live refresh preserve explicit zoom and saved positions', async t => {
  const id = 'graph-zoom'; await installGraphPackage(admin, csrf, { id, mode: 'isolated', delay: 500 }); t.after(() => disable(id));
  const page = await open(t); await page.getByRole('link', { name: 'Trail board', exact: true }).click();
  await page.getByText('Loading add-on cards…').waitFor();
  await page.locator('.cm-zoom-level').click(); await card(page, id, 'board').waitFor();
  assert.equal(await page.locator('.cm-zoom-level').innerText(), '100%');
  await card(page, id, 'board').focus(); await page.keyboard.press('ArrowRight');
  const snapshot = await jsonResponse(await admin.get('/api/campaign'));
  const captain = snapshot.collections.find(collection => collection.name === 'characters').records.find(record => record.key === 'captain');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'characters', key: 'captain', expectedRevision: captain.revision, value: { ...captain.value, name: 'Captain refreshed' } },
  ] } }));
  await page.getByText('Loading add-on cards…').waitFor(); await card(page, id, 'board').waitFor();
  assert.equal(await page.locator('.cm-zoom-level').innerText(), '100%');
  assert.equal(await page.evaluate(view => JSON.parse(localStorage.getItem(`cm_pos_v3_addon:${view}:board`))[JSON.stringify(['addon', view, 'board', 'node', 'note'])].x, id), 305);
});
