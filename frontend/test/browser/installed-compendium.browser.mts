import { required } from './fixture-types.mts';
import type { APIRequestContext, Browser, Page } from 'playwright';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
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
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { chromium, request as playwrightRequest } from 'playwright';
import { jsonResponse, installReviewedPackage, zip } from './installed-graph-fixture.mts';

const archivePath = process.env.CODEX_COMPENDIUM_ZIP;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-compendium');
const id = 'dnd-2024-compendium', route = `#/addons/${id}/compendium`;
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, browser: Browser, admin: APIRequestContext, csrf: string, origin: string, archive: Buffer, hostOutput = '';
before(async () => {
  if (!archivePath) return;
  archive = await readFile(resolve(archivePath));
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-compendium-dm', CODEX_PLAYER_PASSWORD: 'local-compendium-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-compendium-dm' } }))).csrfToken;
  await installReviewedPackage(admin, csrf, id, archive, []);
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
async function open(t: TestContext, role = 'dm', mobile = false, locale = 'en', navigate = true) {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  t.after(() => context.close());
  await jsonResponse(await context.request.post('/api/login', { data: { password: `local-compendium-${role}` } }));
  await context.addInitScript(locale => localStorage.setItem('codex_lang', locale), locale);
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  if (navigate) { await page.goto(`/${route}`); await page.locator('.comp-reading-pane h1').waitFor(); }
  return page;
}
async function fits(page: Page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
async function go(page: Page, query: string) { await page.goto(`/${route}${query}`); await page.locator('.comp-reading-pane h1').waitFor(); }

for (const mobile of [false, true]) for (const role of ['dm', 'player']) test(`installed compendium restores browsing and reading for ${role} on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath }, async t => {
  const page = await open(t, role, mobile), pane = page.locator('.comp-reading-pane');
  assert.equal(await pane.locator('.codex-link-tile').count(), 17);
  assert.equal(await pane.locator('.codex-auto-grid-tiles').evaluate(node => getComputedStyle(node).display), 'grid');
  assert.equal(await pane.locator('.codex-link-tile').first().evaluate(node => getComputedStyle(node).display), 'flex');
  const style = await pane.locator('h1').evaluate(node => ({ color: getComputedStyle(node).color, font: getComputedStyle(node).fontFamily, size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight }));
  assert.equal(style.size, mobile ? '24px' : '32px'); assert.equal(style.weight, '600');
  assert.equal(style.color, 'rgb(245, 237, 216)'); assert.match(style.font, /Cinzel/u); await fits(page);
  await page.screenshot({ path: resolve(output, `library-${role}-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  await pane.getByRole('link', { name: /Spells/ }).click(); await pane.locator('[data-filter="level"]').selectOption('3');
  await pane.locator('[data-filter="school"]').selectOption('Evocation'); await pane.locator('[data-compendium-search]').fill('fireball');
  await pane.locator('.codex-link-row').filter({ hasText: 'Fireball' }).click();
  await pane.getByRole('heading', { name: /Fireball/ }).waitFor();
  assert.ok(await pane.locator('strong').filter({ hasText: '8d6 Fire damage' }).count());
  await page.reload(); await pane.getByRole('heading', { name: /Fireball/ }).waitFor();
  await page.goBack(); await pane.locator('[data-filter="level"]').waitFor();
  assert.equal(await pane.locator('[data-filter="level"]').inputValue(), '3');
  assert.equal(await pane.locator('[data-filter="school"]').inputValue(), 'Evocation');
  assert.equal(await pane.locator('[data-compendium-search]').inputValue(), 'fireball');
  await pane.getByRole('button', { name: 'Clear', exact: true }).click();
  await pane.getByRole('button', { name: /Show all/ }).click();
  const expandedCount = await pane.locator('.codex-link-row').count(); assert.ok(expandedCount > 100);
  await pane.locator('.codex-link-row').first().click(); await pane.locator('article').waitFor();
  await page.goBack(); await page.waitForFunction(expected => document.querySelectorAll('.comp-reading-pane .codex-link-row').length === expected, expandedCount);
  await pane.locator('[data-sort]').selectOption('name'); await pane.locator('[data-compendium-search]').fill('shield');
  const instance = await page.locator('.dnd-compendium').evaluate(node => {
    node.dataset.fixtureRetained = 'yes'; node.dataset.fixtureRefreshes = '0';
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'codexContribution')!.set!;
    Object.defineProperty(node, 'codexContribution', { set(value) { node.dataset.fixtureRefreshes = String(Number(node.dataset.fixtureRefreshes) + 1); setter.call(node, value); } });
    return node.localName;
  });
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: `compendium-${role}-${mobile}`, expectedRevision: 0, value: { id: `compendium-${role}-${mobile}`, name: 'Unrelated refresh', visibility: 'public' } },
  ] } }));
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>('.dnd-compendium')?.dataset.fixtureRefreshes) > 0);
  assert.equal(await page.locator('.dnd-compendium').getAttribute('data-fixture-retained'), 'yes');
  assert.equal(await page.locator('.dnd-compendium').evaluate(node => node.localName), instance);
  assert.equal(await pane.locator('[data-compendium-search]').inputValue(), 'shield');
  await go(page, '?kind=class&id=wizard'); await pane.getByRole('heading', { name: 'Features', exact: true }).waitFor();
  assert.ok(await pane.locator('table').count());
  await pane.locator('h3 a').filter({ hasText: 'Arcane Recovery' }).first().click(); await pane.getByRole('heading', { name: /Arcane Recovery/ }).waitFor();
  await go(page, '?kind=monster&id=aboleth'); assert.equal(await pane.locator('.codex-tile-compact').count(), 6);
  assert.match(await pane.locator('.codex-fact-grid').textContent().then(required), /Saving Throws/); await fits(page);
  await page.screenshot({ path: resolve(output, `monster-${role}-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  await go(page, '?kind=spell&id=shield'); const spellURL = page.url(); assert.match(await pane.locator('.codex-fact-grid').textContent().then(required), /Casting Time/);
  await go(page, '?kind=armor&id=shield'); assert.notEqual(page.url(), spellURL); assert.match(await pane.locator('.codex-fact-grid').textContent().then(required), /Armor Class/);
  await go(page, '?kind=spell&id=missing'); await pane.getByRole('heading', { name: 'Not found' }).waitFor();
  await go(page, ''); if (mobile) await page.locator('.comp-tree-drawer > summary').click();
  await page.getByRole('button', { name: 'By source', exact: true }).click();
  await page.locator('.comp-tree a').filter({ hasText: 'Player' }).first().click();
  await pane.getByRole('heading', { name: /Player/ }).waitFor();
  await pane.getByRole('link', { name: /Spells/ }).click(); assert.equal(await pane.locator('[data-filter="book"]').inputValue(), 'phb');
  await fits(page);
});

test('installed compendium uses Czech controls and supports direct bestiary links', { skip: !archivePath }, async t => {
  const page = await open(t, 'player', true, 'cs'), pane = page.locator('.comp-reading-pane');
  await pane.getByRole('heading', { name: /Kompendium/ }).waitFor();
  await pane.getByRole('link', { name: /Kouzla/ }).click(); await pane.getByLabel('Příručka').waitFor();
  await pane.getByLabel('Hledat…', { exact: true }).fill('Fireball');
  await pane.locator('.codex-link-row').first().click(); await pane.getByRole('heading', { name: /Fireball/ }).waitFor();
  await page.goto(`/#/addons/${id}/bestiary?kind=spell&id=aboleth`); await pane.getByRole('heading', { name: /Aboleth/ }).waitFor();
  assert.equal(await pane.locator('.codex-tile-compact').count(), 6); await fits(page);
});

test('failed content stays stable until Retry and keeps the requested record', { skip: !archivePath }, async t => {
  const page = await open(t, 'player', false, 'en', false); let attempts = 0;
  await page.route('**/content/query?*', route => { attempts++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"kind":"UNAVAILABLE","message":"fixture unavailable"}}' }); });
  await page.goto(`/${route}?kind=spell&id=fireball`);
  await page.locator('.dnd-compendium [role="alert"]').waitFor(); assert.equal(attempts, 1);
  await page.goto(`/${route}?kind=spell&id=shield`);
  await page.locator('.dnd-compendium [role="alert"]').waitFor(); assert.equal(attempts, 1);
  await page.unroute('**/content/query?*'); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.comp-reading-pane').getByRole('heading', { name: /Shield/ }).waitFor();
});

function replacement(archive: Buffer) {
  const end = archive.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])), files: Record<string, string | Buffer> = Object.create(null); assert.ok(end >= 0);
  const count = archive.readUInt16LE(end + 10); assert.ok(count < 10000); let cursor = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10), compressed = archive.readUInt32LE(cursor + 20), nameSize = archive.readUInt16LE(cursor + 28);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameSize).toString(), local = archive.readUInt32LE(cursor + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28), body = archive.subarray(start, start + compressed);
    assert.ok(method === 0 || method === 8); if (!name.endsWith('/')) files[name] = method === 8 ? inflateRawSync(body, { maxOutputLength: 32 * 1024 * 1024 }) : body;
    cursor += 46 + nameSize + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  const manifest = JSON.parse(files['addon.json'].toString()); manifest.version = '3.0.1'; files['addon.json'] = JSON.stringify(manifest);
  delete files['checksums.json']; files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files);
}

for (const mobile of [false, true]) test(`campaign references and old Compendium bookmarks work on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath }, async t => {
  const key = `library-notes-${mobile}`;
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'characters', key, expectedRevision: 0, value: { id: key, name: 'Library notes', knowledge: 4, visibility: 'public', description:
      '[[Fireball|spell]] and [[Ward|spell:shield]] and [[Equipment|armor:shield]]. Ambiguous: [[Shield]]. [Old monster](#/bestiary/monster:aboleth).' } },
  ] } }));
  const page = await open(t, 'dm', mobile, 'en', false);
  await page.goto(`/#/characters/${key}`);
  await page.locator('a.wiki-link').filter({ hasText: 'Ward' }).waitFor();
  assert.equal(await page.locator('a.wiki-link').filter({ hasText: 'Ward' }).getAttribute('href'), `${route}?kind=spell&id=shield`);
  assert.equal(await page.locator('a.wiki-link').filter({ hasText: 'Equipment' }).getAttribute('href'), `${route}?kind=armor&id=shield`);
  assert.equal(await page.locator('.wiki-link-missing').filter({ hasText: 'Shield' }).count(), 1);
  await page.screenshot({ path: resolve(output, `article-links-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  await page.locator('a.wiki-link').filter({ hasText: 'Fireball' }).click(); await page.locator('.comp-reading-pane h1').filter({ hasText: 'Fireball' }).waitFor();
  await page.goBack(); await page.getByRole('button', { name: 'Edit wiki', exact: true }).click();
  await page.getByRole('combobox', { name: 'Editor view', exact: true }).selectOption('preview');
  await page.locator('.writer-preview a.wiki-link').filter({ hasText: 'Ward' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('link', { name: 'Old monster', exact: true }).click();
  await page.locator('.comp-reading-pane h1').filter({ hasText: 'Aboleth' }).waitFor(); assert.match(page.url(), /\/bestiary\?kind=monster&id=aboleth$/u);
  await page.goto('/#/compendium/spell:shield'); await page.locator('.comp-reading-pane h1').filter({ hasText: 'Shield' }).waitFor();
  assert.ok(page.url().endsWith(`${route}?kind=spell&id=shield`));
  await page.goto('/#/compendium/spell'); await page.locator('[data-filter="level"]').waitFor();
  await page.goto('/#/compendium'); await page.locator('.comp-reading-pane .codex-link-tile').first().waitFor();
  await page.goto('/#/search'); await page.locator('.campaign-search-field input').fill('shield');
  const results = page.locator('.search-group[aria-label="Compendium"]'); await results.locator('a').first().waitFor();
  assert.equal(await results.locator('a[href$="kind=armor&id=shield"]').count(), 1);
  await page.screenshot({ path: resolve(output, `library-search-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  await results.locator('a[href$="kind=spell&id=shield"]').click(); await page.locator('.comp-reading-pane h1').filter({ hasText: 'Shield' }).waitFor(); await fits(page);
});

test('campaign reference failures offer Retry without making broken links clickable', { skip: !archivePath }, async t => {
  const page = await open(t, 'player', false, 'en', false);
  let attempts = 0;
  await page.route('**/content/query?*', route => { attempts++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"kind":"UNAVAILABLE","message":"fixture unavailable"}}' }); });
  await page.goto('/#/characters/library-notes-false');
  await page.getByRole('button', { name: 'Retry references' }).waitFor(); assert.equal(await page.locator('a.wiki-link').count(), 0); assert.equal(attempts, 1);
  await page.unroute('**/content/query?*'); await page.getByRole('button', { name: 'Retry references' }).click();
  await page.locator('a.wiki-link').filter({ hasText: 'Fireball' }).waitFor();
});
test('installed compendium replaces constructors and can reactivate the same generation', { skip: !archivePath }, async t => {
  const page = await open(t); await go(page, '?kind=spell&id=fireball');
  const first = await page.locator('.dnd-compendium').evaluate(node => node.localName);
  await installReviewedPackage(admin, csrf, id, replacement(archive), []);
  await page.waitForFunction(first => { const node = document.querySelector<HTMLElement>('.dnd-compendium'); return node && node.localName !== first && node.textContent.includes('Fireball'); }, first);
  const second = await page.locator('.dnd-compendium').evaluate(node => node.localName); assert.notEqual(second, first);
  const state = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: state.state.revision } }));
  await page.locator('.dnd-compendium').waitFor({ state: 'detached' });
  await installReviewedPackage(admin, csrf, id, archive, []);
  await page.locator('.comp-reading-pane').getByRole('heading', { name: /Fireball/ }).waitFor();
  assert.equal(await page.locator('.dnd-compendium').evaluate(node => node.localName), first);
});
