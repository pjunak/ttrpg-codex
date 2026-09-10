import { required } from './fixture-types.mts';
import type { APIRequestContext, Browser, Page } from 'playwright';
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
const output = resolve(root, 'frontend/test-results/portraits');
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, browser: Browser, admin: APIRequestContext, csrf: string, origin: string, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-portrait-dm', CODEX_PLAYER_PASSWORD: 'local-portrait-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-portrait-dm' } }))).csrfToken;
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

async function record(key: string) {
  const data = await jsonResponse(await admin.get('/api/campaign'));
  return data.collections.find((c: FixtureCollection) => c.name === 'characters')!.records.find((r: FixtureRecord) => r.key === key);
}
async function put(key: string, value: Record<string, unknown>, revision = 0) {
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: {
    contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection: 'characters', key, expectedRevision: revision, value: { id: key, ...value } }],
  } }));
}
async function open(t: TestContext, key: string, mobile = false, role: string | null = 'player') {
  const context = await browser.newContext({ baseURL: origin, locale: 'en-US', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  t.after(() => context.close());
  if (role) await jsonResponse(await context.request.post('/api/login', { data: { password: `local-portrait-${role}` } }));
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(`/#/characters/${key}`); await page.locator('#record-title').waitFor();
  return { page, context };
}
async function picture(page: Page, color = 'green') {
  const buffer = Buffer.from(await page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 96, 96);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color), 'base64');
  return { name: 'portrait.png', mimeType: 'image/png', buffer };
}
async function edit(page: Page) { await page.getByLabel('More actions', { exact: true }).click(); await page.getByRole('button', { name: 'Edit all fields', exact: true }).click(); }
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await page.locator('#record-title').waitFor();
}
test('direct fields and the wiki commit independently through the authenticated host', async t => {
  const key = 'direct-edit';
  await put(key, { name: 'Before', title: 'Scout', description: 'Saved wiki', visibility: 'public', extension: { keep: true } });
  const { page } = await open(t, key);
  await page.getByRole('button', { name: 'Edit wiki', exact: true }).click();
  await page.getByRole('combobox', { name: 'Editor view', exact: true }).selectOption('markdown');
  const source = page.getByRole('textbox', { name: 'Overview Markdown', exact: true });
  await source.fill('## Wiki draft\n\n<span data-md-color="info">Blue ink</span>');
  await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('After');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Edit Name', exact: true }).filter({ hasText: 'After' }).waitFor();
  const renamed = await record(key);
  assert.equal(renamed.value.description, 'Saved wiki'); assert.equal(renamed.revision, 2);
  assert.deepEqual(renamed.value.extension, { keep: true });
  assert.match(await source.inputValue(), /Wiki draft/);
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Wiki saved' }).waitFor();
  assert.match((await record(key)).value.description, /data-md-color="info"/);
  await page.reload();
  await page.locator('.character-wiki .md-color-info').filter({ hasText: 'Blue ink' }).waitFor();
  assert.equal(await page.locator('.character-wiki .md-color-info').evaluate(element => getComputedStyle(element).color), 'rgb(144, 202, 249)');
  await page.getByLabel('More actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Portrait', exact: true }).click();
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles(await picture(page));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.record-portrait')?.naturalWidth === 96);
  assert.equal((await record(key)).value.name, 'After');
});
for (const mobile of [false, true]) test(`portrait draft uploads, replaces and removes through the real host on ${mobile ? 'phone' : 'desktop'}`, async t => {
  const key = mobile ? 'phone' : 'desktop';
  await put(key, { name: 'Portrait hero', visibility: 'public', extension: { keep: true } });
  const { page, context } = await open(t, key, mobile);
  const uploads: string[] = []; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/api/media/character-portrait/')) uploads.push(r.url()); });
  await edit(page);
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles(await picture(page));
  await page.getByRole('img', { name: 'Portrait preview' }).waitFor();
  assert.equal(uploads.length, 0, 'selection must not upload');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await record(key)).value.portrait, undefined);
  await edit(page); await page.getByLabel('Choose portrait', { exact: true }).setInputFiles(await picture(page));
  await page.getByLabel('Name', { exact: true }).fill('Portrait hero updated');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, `${key}-editor.png`), fullPage: true });
  await save(page);
  const first = await record(key); assert.match(first.value.portrait, /^\/api\/media\/b_/);
  assert.equal(first.value.name, 'Portrait hero updated'); assert.deepEqual(first.value.extension, { keep: true });
  await page.reload(); await page.locator('.record-portrait').waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.record-portrait')?.naturalWidth === 96);
  await edit(page); await page.getByLabel('Choose portrait', { exact: true }).setInputFiles(await picture(page, 'blue'));
  await save(page); const second = await record(key); assert.notEqual(second.value.portrait, first.value.portrait);
  assert.equal((await context.request.get(first.value.portrait)).status(), 200, 'replacement preserves recovery media');
  await edit(page); await page.getByRole('button', { name: 'Remove portrait', exact: true }).click();
  await page.getByRole('button', { name: 'Undo portrait change', exact: true }).click();
  assert.equal(await page.getByRole('img', { name: 'Portrait preview' }).getAttribute('src'), second.value.portrait);
  await page.getByRole('button', { name: 'Remove portrait', exact: true }).click(); await save(page);
  assert.equal((await record(key)).value.portrait, undefined);
  assert.equal((await context.request.get(second.value.portrait)).status(), 200);
  await page.reload(); await page.locator('#record-title').waitFor(); assert.equal(await page.locator('img.record-portrait').count(), 0);
});

test('failed uploads and rejected record saves keep the portrait draft and original record', async t => {
  const key = 'failure'; await put(key, { name: 'Original', visibility: 'public' });
  const { page } = await open(t, key); await edit(page);
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await page.getByRole('alert').filter({ hasText: 'Choose a supported image' }).waitFor();
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles(await picture(page));
  await page.getByLabel('Name', { exact: true }).fill('Draft name');
  await page.route('**/api/media/character-portrait/*', r => r.fulfill({ status: 500, body: 'failed' }));
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await page.getByText('The entry could not be saved:', { exact: false }).waitFor();
  assert.equal((await record(key)).value.name, 'Original');
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Draft name');
  assert.match(await page.getByRole('img', { name: 'Portrait preview' }).getAttribute('src').then(required), /^blob:/);
  await page.unroute('**/api/media/character-portrait/*');
  await page.route('**/api/campaign/transactions', r => r.fulfill({ status: 409, body: 'conflict' }));
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await page.getByText('The entry changed while saving.', { exact: false }).waitFor();
  assert.equal((await record(key)).value.portrait, undefined);
  assert.match(await page.getByRole('img', { name: 'Portrait preview' }).getAttribute('src').then(required), /^blob:/);
  await page.unroute('**/api/campaign/transactions'); await save(page);
  assert.equal((await record(key)).value.name, 'Draft name'); assert.match((await record(key)).value.portrait, /^\/api\/media\/b_/);
});

test('portrait controls localize, explain creation and obey signed-in visibility', async t => {
  await put('access', { name: 'Access hero', visibility: 'public' });
  const { page } = await open(t, 'access', false, 'dm'); await edit(page);
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles(await picture(page));
  await page.locator('[name="visibility"]').selectOption('dm');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await page.getByText('Save visibility changes first, then replace the portrait. Your draft is kept.', { exact: true }).waitFor();
  assert.equal((await record('access')).revision, 1);
  await page.locator('[name="visibility"]').selectOption('public'); await save(page);
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload();
  await page.getByLabel('Další akce', { exact: true }).click(); await page.getByRole('button', { name: 'Upravit všechna pole', exact: true }).click();
  await page.getByLabel('Vybrat portrét', { exact: true }).waitFor();
  const anonymous = await open(t, 'access', false, null);
  assert.equal(await anonymous.page.locator('codex-portrait-editor').count(), 0);
  assert.equal(await anonymous.page.getByRole('button', { name: 'Edit', exact: true }).count(), 0);
  await page.goto('/#/party/new');
  await page.getByText('Nejprve postavu uložte. Poté ji upravte a přidejte portrét.', { exact: true }).waitFor();
  assert.equal(await page.locator('codex-portrait-editor input[type="file"]').count(), 0);
});
