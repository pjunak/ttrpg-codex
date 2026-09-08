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
import { attemptHash, unloadBlocked } from './installed-planner-navigation-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/credentials');
let directory, binary, host, browser, admin, origin, address, csrf, hostOutput = '';
let dmPassword = 'local-credentials-dm';
async function start(environment = {}) {
  host = spawn(binary, ['-listen', address, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-credentials-dm', CODEX_PLAYER_PASSWORD: 'local-credentials-player', ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) return; } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.fail(hostOutput);
}
async function stop() { if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; } }
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); address = `127.0.0.1:${probe.address().port}`; await new Promise(resolve => probe.close(resolve)); origin = `http://${address}`;
  admin = await request.newContext({ baseURL: origin }); await start();
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: dmPassword } }))).csrfToken;
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection: 'characters', key: 'keeper', expectedRevision: 0, value: { id: 'keeper', name: 'Keeper', notes: 'Retain this campaign.' } }] } }));
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close(); await admin?.dispose(); await stop();
  if (directory) { const child = relative(output, directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

async function open(t, mobile = false, password = dmPassword) {
  const context = await browser.newContext({ baseURL: origin, locale: mobile ? 'cs-CZ' : 'en-US', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, isMobile: mobile, hasTouch: mobile });
  t.after(() => context.close());
  if (password) await jsonResponse(await context.request.post('/api/login', { data: { password } }));
  const page = await context.newPage(); page.setDefaultTimeout(12_000); await page.goto('/#/settings'); await page.locator('.settings-page').waitFor();
  if (mobile) await page.locator('.settings-preference-field select').selectOption('cs');
  return { page, context };
}
const form = (page, role) => page.locator(`.settings-password-card[data-role="${role}"]`);
async function fill(page, role, current, next, confirmation = next) {
  const inputs = form(page, role).locator('input[type=password]');
  await inputs.nth(0).fill(current); await inputs.nth(1).fill(next); await inputs.nth(2).fill(confirmation);
}
async function submit(page, role) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/passwords') && response.request().method() === 'POST');
  await form(page, role).getByRole('button').click(); return response;
}

for (const mobile of [false, true]) test(`password settings preserve the original cards and manage player access (${mobile ? 'Czech phone' : 'English desktop'})`, async t => {
  const { page, context } = await open(t, mobile); await page.locator('[data-category=account]').click(); await form(page, 'player').waitFor();
  await fill(page, 'player', dmPassword, `player-${mobile}`, 'mismatch');
  await form(page, 'player').getByRole('button').click(); await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), mobile ? /neshodují/ : /do not match/);
  assert.equal(await unloadBlocked(page), true);
  if (!mobile) { await attemptHash(page, '#/dashboard'); assert.equal(await form(page, 'player').locator('input').nth(1).inputValue(), `player-${mobile}`); }
  await fill(page, 'player', 'wrong-current', `player-${mobile}`); assert.equal((await submit(page, 'player')).status(), 401);
  await fill(page, 'player', dmPassword, `player-${mobile}`); await jsonResponse(await submit(page, 'player'));
  await page.getByRole('status').filter({ hasText: mobile ? 'uloženo' : 'saved' }).waitFor(); assert.equal(await unloadBlocked(page), false);
  const player = await request.newContext({ baseURL: origin }); t.after(() => player.dispose());
  await jsonResponse(await player.post('/api/login', { data: { password: `player-${mobile}` } }));
  assert.equal((await player.get('/api/passwords')).status(), 403);
  await form(page, 'player').locator('input[type=password]').first().fill(dmPassword); await form(page, 'player').getByRole('checkbox').check();
  await jsonResponse(await submit(page, 'player')); await page.getByRole('status').filter({ hasText: mobile ? 'uloženo' : 'saved' }).waitFor();
  assert.equal((await jsonResponse(await player.get('/api/auth'))).role, null);
  assert.equal((await player.post('/api/login', { data: { password: `player-${mobile}` } })).status(), 401);
  assert.equal((await jsonResponse(await context.request.get('/api/auth'))).role, 'dm');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('codex-credential-settings').screenshot({ path: resolve(output, `passwords-${mobile ? 'phone' : 'desktop'}.png`) });
});

test('password writes block navigation and uncertain outcomes retain the reviewing DM session', async t => {
  const { page, context } = await open(t); await page.locator('[data-category=account]').click(); await form(page, 'dm').waitFor();
  let release; const blocked = new Promise(resolve => { release = resolve; }); let entered; const waiting = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/passwords', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    entered(); await blocked; await route.fetch(); await route.abort('failed');
  });
  await fill(page, 'dm', dmPassword, 'rotated-local-dm'); await form(page, 'dm').getByRole('button').click(); await waiting;
  assert.equal(await page.locator('[data-category=language]').isDisabled(), true);
  await page.evaluate(() => { location.hash = '#/dashboard'; }); await page.waitForURL('**/#/settings');
  release(); await page.getByRole('alert').filter({ hasText: 'Could not confirm' }).waitFor();
  dmPassword = 'rotated-local-dm'; await page.unroute('**/api/passwords');
  assert.equal(await form(page, 'dm').locator('input').nth(1).inputValue(), dmPassword);
  assert.equal((await jsonResponse(await context.request.get('/api/auth'))).role, 'dm');
  assert.equal((await jsonResponse(await admin.get('/api/auth'))).role, null);
  assert.equal(await form(page, 'dm').getByRole('button').isDisabled(), true);
  await page.getByRole('button', { name: 'Refresh password status', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('codex-credential-settings').loading);
  await fill(page, 'dm', dmPassword, dmPassword); await jsonResponse(await submit(page, 'dm'));
  await page.getByRole('status').filter({ hasText: 'saved' }).waitFor();
  assert.equal(await form(page, 'dm').locator('input').nth(1).inputValue(), '');
});

test('password settings stay private and saved credentials survive restart and offline reset', async t => {
  const { page } = await open(t, false, null); assert.equal(await page.locator('[data-category=account]').count(), 0);
  await assert.rejects(promisify(execFile)(binary, ['-data-dir', resolve(directory, 'data'), '-reset-passwords'], {
    windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'must-not-replace-live', CODEX_PLAYER_PASSWORD: '' }, timeout: 30_000,
  }), /acquire data directory/);
  await stop(); await start({ CODEX_DM_PASSWORD: '', CODEX_PLAYER_PASSWORD: 'ignored-environment-player' });
  assert.equal((await admin.post('/api/login', { data: { password: 'local-credentials-dm' } })).status(), 401);
  await jsonResponse(await admin.post('/api/login', { data: { password: dmPassword } }));
  assert.equal((await jsonResponse(await admin.get('/api/passwords'))).playerEnabled, false);
  await stop();
  await promisify(execFile)(binary, ['-data-dir', resolve(directory, 'data'), '-reset-passwords'], { windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'offline-recovery-dm', CODEX_PLAYER_PASSWORD: '' }, timeout: 30_000 });
  await start({ CODEX_DM_PASSWORD: '', CODEX_PLAYER_PASSWORD: '' }); dmPassword = 'offline-recovery-dm';
  await jsonResponse(await admin.post('/api/login', { data: { password: dmPassword } }));
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  assert.equal(campaign.collections.find(value => value.name === 'characters').records.find(value => value.key === 'keeper').value.notes, 'Retain this campaign.');
});
