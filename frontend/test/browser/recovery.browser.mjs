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
import { chromium, request } from 'playwright';
import { jsonResponse } from './installed-graph-fixture.mjs';
import { unloadBlocked } from './installed-planner-navigation-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/recovery');
let directory, host, browser, admin, origin, csrf, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const address = `127.0.0.1:${probe.address().port}`; await new Promise(resolve => probe.close(resolve)); origin = `http://${address}`;
  host = spawn(binary, ['-listen', address, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], { cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-recovery-dm', CODEX_PLAYER_PASSWORD: 'local-recovery-player' }, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await request.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-recovery-dm' } }))).csrfToken;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close(); await admin?.dispose();
  if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; }
  if (directory) { const child = relative(output, directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
async function open(t, mobile = false, role = 'dm') {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, isMobile: mobile, hasTouch: mobile });
  t.after(() => context.close());
  if (role) await jsonResponse(await context.request.post('/api/login', { data: { password: `local-recovery-${role}` } }));
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto('/#/settings'); await page.locator('.settings-page').waitFor();
  if (mobile) await page.locator('.settings-preference-field select').selectOption('cs');
  if (role === 'dm') { await page.locator('[data-category=backup]').click(); await page.waitForFunction(() => !!document.querySelector('codex-recovery-settings')?.listing); }
  return { page, context };
}
async function put(key, name, expectedRevision = 0) {
  return jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection: 'characters', key, expectedRevision, value: { id: key, name, notes: 'Keep the archive.', future: { kept: true } } }] } }));
}
async function mutation(page, action, path) { const response = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST'); await action(); return response; }
const panel = page => page.locator('codex-recovery-settings');
async function refresh(page, mobile = false) { await panel(page).getByRole('button', { name: mobile ? '↻ Obnovit seznam' : '↻ Refresh', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('codex-recovery-settings').busy); }

for (const mobile of [false, true]) test(`recovery points restore the campaign and original Settings layout (${mobile ? 'Czech phone' : 'English desktop'})`, async t => {
  const key = `recovery-${mobile}`; await put(key, 'Before recovery');
  const { page, context } = await open(t, mobile);
  const result = await jsonResponse(await mutation(page, () => panel(page).getByRole('button', { name: mobile ? '＋ Vytvořit bod obnovy' : '＋ Create recovery point', exact: true }).click(), '/api/recovery'));
  const id = result.points[0].id; assert.equal(result.points[0].reason, 'manual');
  await put(key, 'Changed campaign', 1);
  await page.locator(`[data-point-id="${id}"] .settings-btn-edit`).click();
  assert.equal(await page.locator('#recovery-review-title').evaluate(node => document.activeElement === node), true);
  const confirm = () => page.locator('.settings-recovery-review').getByRole('button', { name: mobile ? 'Obnovit' : 'Restore', exact: true }).click();
  assert.equal((await mutation(page, confirm, '/api/recovery/restore')).status(), 409);
  await panel(page).getByRole('alert').waitFor(); await refresh(page, mobile);
  const observer = await context.newPage(); await observer.goto(`/#/characters/${key}`); await observer.getByRole('heading', { name: 'Changed campaign', exact: true }).waitFor();
  await page.locator(`[data-point-id="${id}"] .settings-btn-edit`).click();
  const restored = await jsonResponse(await mutation(page, confirm, '/api/recovery/restore'));
  assert.equal(restored.points[0].reason, 'pre-restore');
  await observer.getByRole('heading', { name: 'Before recovery', exact: true }).waitFor();
  await panel(page).getByRole('status').filter({ hasText: mobile ? 'obnovena' : 'restored' }).waitFor();
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  const record = campaign.collections.find(collection => collection.name === 'characters').records.find(record => record.key === key);
  assert.equal(record.revision, 3); assert.deepEqual(record.value.future, { kept: true });
  assert.equal(await unloadBlocked(page), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.settings-page').screenshot({ path: resolve(output, `backup-${mobile ? 'phone-cs' : 'desktop-en'}.png`) });
  await page.locator(`[data-point-id="${id}"] .settings-btn-del`).click();
  await page.locator('.settings-recovery-review').getByRole('button', { name: mobile ? 'Zrušit' : 'Cancel', exact: true }).click();
  assert.equal(await page.locator(`[data-point-id="${id}"]`).count(), 1);
  await page.locator(`[data-point-id="${id}"] .settings-btn-del`).click();
  await jsonResponse(await mutation(page, () => page.locator('.settings-recovery-review').getByRole('button', { name: mobile ? 'Smazat' : 'Delete', exact: true }).click(), '/api/recovery/delete'));
  await page.locator(`[data-point-id="${id}"]`).waitFor({ state: 'detached' });
});

test('recovery retains uncertain results, guards pending writes and keeps backup private', async t => {
  const { page } = await open(t);
  const created = await jsonResponse(await admin.post('/api/recovery', { headers: { 'X-Codex-CSRF': csrf }, data: {} }));
  await refresh(page); const id = created.points[0].id;
  await page.route('**/api/recovery/restore', async route => { await route.fetch(); await route.abort('failed'); });
  await page.locator(`[data-point-id="${id}"] .settings-btn-edit`).click();
  await page.locator('.settings-recovery-review').getByRole('button', { name: 'Restore', exact: true }).click();
  await panel(page).getByRole('alert').waitFor(); assert.equal(await page.locator('.settings-btn-edit').first().isDisabled(), true);
  await page.unroute('**/api/recovery/restore'); await refresh(page);
  assert.match(await page.locator('.settings-snapshot-row').first().textContent(), /Before restore/);
  let release, received; const blocked = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { received = resolve; });
  await page.route('**/api/recovery', async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); received(); await blocked; await route.fulfill({ response }); });
  await panel(page).getByRole('button', { name: '＋ Create recovery point', exact: true }).click(); await started;
  assert.equal(await unloadBlocked(page), true); assert.equal(await page.locator('[data-category=account]').isDisabled(), true);
  release(); await page.waitForFunction(() => !document.querySelector('codex-recovery-settings').busy); assert.equal(await unloadBlocked(page), false);
  const zip = await admin.get('/api/backup'); assert.equal(zip.status(), 200); assert.equal((await zip.body()).subarray(0, 2).toString(), 'PK');
  for (const role of [null, 'player']) { const { page, context } = await open(t, false, role); assert.equal(await page.locator('[data-category=backup]').count(), 0); assert.equal((await context.request.get('/api/recovery')).status(), 403); assert.equal((await context.request.get('/api/backup')).status(), 403); }
});

test('revert selects a reviewed automatic edit group', async t => {
  const { page } = await open(t);
  const before = await jsonResponse(await admin.get('/api/recovery'));
  const target = before.points.find(point => point.reason === 'save'); assert.ok(target);
  await panel(page).locator('input[name=count]').fill('1');
  await panel(page).getByRole('button', { name: '↶ Undo', exact: true }).click();
  await page.locator('#recovery-review-title').waitFor();
  await jsonResponse(await mutation(page, () => page.locator('.settings-recovery-review').getByRole('button', { name: 'Restore', exact: true }).click(), '/api/recovery/restore'));
  const restored = await jsonResponse(await admin.get('/api/campaign'));
  assert.equal(restored.collections.reduce((total, collection) => total + collection.records.length, 0), target.records);
});
