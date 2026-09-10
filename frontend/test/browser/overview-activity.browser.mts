import { required } from './fixture-types.mts';
import type { APIRequestContext, Browser } from 'playwright';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { FixtureCollection, FixtureRecord } from './fixture-types.mts';
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
import { jsonResponse } from './installed-graph-fixture.mts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/overview-activity');
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, browser: Browser, admin: APIRequestContext, csrf: string, origin: string, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-activity-dm', CODEX_PLAYER_PASSWORD: 'local-activity-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-activity-dm' } }))).csrfToken;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close(); await admin?.dispose();
  if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; }
  if (directory) {
    const child = relative(output, directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function open(t: TestContext, role: string | undefined = undefined, mobile = false) {
  const context = await browser.newContext({ baseURL: origin, locale: 'en-US', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const auth = role ? await jsonResponse(await context.request.post('/api/login', { data: { password: `local-activity-${role}` } })) : undefined;
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto('/#/'); await page.locator('.session-section').waitFor();
  return { page, client: context.request, token: auth?.csrfToken };
}
async function put(client: APIRequestContext, token: string, key: string, value: Record<string, unknown>, revision = 0) {
  return jsonResponse(await client.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': token }, data: {
    contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection: 'locations', key, expectedRevision: revision, value: { id: key, ...value } }],
  } }));
}
async function record(key: string) {
  const data = await jsonResponse(await admin.get('/api/campaign'));
  return data.collections.find((collection: FixtureCollection) => collection.name === 'locations').records.find((record: FixtureRecord) => record.key === key);
}

test('empty recent history is explained to signed-in users without requiring an add-on', async t => {
  const player = await open(t, 'player'), anonymous = await open(t);
  await player.page.getByRole('heading', { name: 'Recent changes', exact: false }).waitFor();
  assert.equal(await player.page.locator('.recent-section .empty-state').textContent().then(required), 'No changes yet. Newly created and edited entries will appear here.');
  assert.equal(await anonymous.page.locator('.recent-section').count(), 0);
  await player.page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await player.page.reload();
  await player.page.getByText('Zatím žádné změny. Nově vytvořené a upravené záznamy se zobrazí zde.', { exact: true }).waitFor();
});

for (const mobile of [false, true]) test(`overview activity follows player creations and edits with role filtering on ${mobile ? 'phone' : 'desktop'}`, async t => {
  const key = mobile ? 'phone-town' : 'desktop-town', hiddenKey = `${key}-secret`;
  const player = await open(t, 'player', mobile), dm = await open(t, 'dm', mobile), anonymous = await open(t, undefined, mobile);
  const started = Date.now();
  await put(player.client, player.token, key, { name: 'Player-created town', description: 'New campaign content.', updatedAt: '2000-01-01T00:00:00Z' });
  const link = `.recent-ledger a[href="#/locations/${key}"]`;
  for (const { page } of [player, dm, anonymous]) await page.locator(link).waitFor();
  const created = await record(key); assert.equal(typeof created.value.updatedAt, 'number');
  assert.ok(created.value.updatedAt >= started && created.value.updatedAt <= Date.now());
  assert.equal(await player.page.locator(`${link} time`).getAttribute('datetime'), new Date(created.value.updatedAt).toISOString());
  await put(admin, csrf, hiddenKey, { name: 'Private planning secret', visibility: 'dm' });
  await dm.page.locator(`.recent-ledger a[href="#/locations/${hiddenKey}"]`).waitFor();
  await put(player.client, player.token, key, { ...created.value, name: 'Edited by a player' }, created.revision);
  for (const { page } of [player, dm, anonymous]) {
    await page.locator(link).filter({ hasText: 'Edited by a player' }).waitFor();
    assert.equal(await page.locator('.recent-ledger a').first().getAttribute('href'), `#/locations/${key}`);
  }
  assert.ok((await record(key)).value.updatedAt > created.value.updatedAt);
  for (const { page } of [player, anonymous]) assert.equal(await page.locator(`.recent-ledger a[href="#/locations/${hiddenKey}"]`).count(), 0);
  const session = await player.page.locator('.session-section').boundingBox().then(required), recent = await player.page.locator('.recent-section').boundingBox().then(required);
  assert.ok(recent.y >= session.y + session.height, 'Recent changes remain below the last session');
  assert.equal(await player.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await player.page.screenshot({ path: resolve(output, `${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  await player.page.locator(link).click(); await player.page.locator('#record-title').filter({ hasText: 'Edited by a player' }).waitFor();
  // Making a formerly public record private must remove it from open overview feeds.
  const current = await record(key); await put(admin, csrf, key, { ...current.value, visibility: 'dm' }, current.revision);
  await anonymous.page.waitForFunction(key => !document.querySelector(`.recent-ledger a[href="#/locations/${key}"]`), key);
  await player.page.goto('/#/'); await player.page.locator('.session-section').waitFor();
  assert.equal(await player.page.locator(link).count(), 0);
});
