import { required, fixtureCollection, fixtureRecord } from './fixture-types.mts';
import type { Browser, Page } from 'playwright';
import type { TestContext } from 'node:test';
import type { PreviewServer } from 'vite';
import type { AddressInfo } from 'node:net';
import type { FixtureCampaign, FixtureMutation, FixtureTransaction } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { visualCampaign, visualFixturePlugin } from './visual-fixture.mts';

let server: PreviewServer, browser: Browser, origin: string, campaign: FixtureCampaign, sequence = 0;
const streams = new Set<import("node:http").ServerResponse>(), output = fileURLToPath(new URL('../../test-results/chrome-settings/', import.meta.url));
const collection = (name: string) => fixtureCollection(campaign, name);
interface SidebarLayout { sections: { id: string; label: string; pages: string[]; extension?: unknown }[]; hidden: string[]; extension?: unknown }
const setting = <K extends string,>(key: K) => fixtureRecord<K extends 'sidebarLayout' ? SidebarLayout : Record<string, unknown>>(collection('settings'), key);
const logoId = `b_${'2'.repeat(32)}`, logoUrl = `/api/media/${logoId}`;
const logoSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="35" fill="#99ccff"/></svg>';
const originalLayout = { extension: { keep: true }, sections: [
  { id: 'prehled', label: 'Our archive', icon: '', collapsible: false, defaultOpen: true, role: '', pages: ['/', '/mapa/svet'] },
  { id: 'svet', label: 'World notes', icon: '🦉', collapsible: true, defaultOpen: false, role: '', pages: ['/postavy', '/mista'], extension: { keep: true } },
  { id: 'private', label: 'Private plans', icon: '', collapsible: false, defaultOpen: true, role: 'dm', pages: ['/mysteries', '/dm', '/future/page'] },
], hidden: ['/frakce'] };
before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) { streams.add(response); response.on('close', () => streams.delete(response)); } })],
    preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t: TestContext, { mobile = false, role = 'dm', locale = 'en', reject = false, failUpload = false, addon = false, malformed = false } = {}) {
  campaign = structuredClone(visualCampaign);
  collection('settings').records = [
    { key: 'branding', revision: 3, value: malformed ? [] : { title: 'Asurai', subtitle: 'World atlas', logoUrl: '', extension: { keep: true } } },
    { key: 'sidebarLayout', revision: 4, value: malformed ? [] : structuredClone(originalLayout) },
  ];
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, locale,
    reducedMotion: 'reduce', extraHTTPHeaders: { 'x-fixture-role': role, 'x-fixture-addon': String(addon) } });
  t.after(() => context.close());
  await context.addInitScript(locale => localStorage.setItem('codex_lang', locale), locale);
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const writes: FixtureMutation[][] = [], uploads: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.route(`**${logoUrl}`, route => route.fulfill({ contentType: 'image/svg+xml', body: logoSVG }));
  await page.route('**/api/media/branding-logo/main', async route => {
    assert.equal(route.request().headers()['x-codex-csrf'], 'x'.repeat(32));
    uploads.push(required(route.request().postData()));
    if (failUpload && uploads.length === 1) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    await route.fulfill({ json: { contractVersion: 'media-blob.v1', id: logoId, url: logoUrl, kind: 'branding-logo', target: 'main', mediaType: 'image/svg+xml', bytes: logoSVG.length, revision: 1, createdAt: '2026-09-05T12:00:00Z' } });
  });
  await page.route('**/api/campaign/transactions', async route => {
    const body: FixtureTransaction = route.request().postDataJSON();
    assert.equal(route.request().headers()['x-codex-csrf'], 'x'.repeat(32)); assert.equal(body.contractVersion, 'campaign-mutation.v1');
    writes.push(body.mutations);
    if (reject || body.mutations.some(item => item.expectedRevision !== (collection('settings').records.find(record => record.key === item.key)?.revision ?? 0))) return route.fulfill({ status: 409, json: { error: 'conflict' } });
    const results = [];
    for (const mutation of body.mutations) {
      assert.equal(mutation.operation, 'put'); assert.equal(mutation.collection, 'settings');
      const next = { key: mutation.key, revision: mutation.expectedRevision + 1, value: mutation.value };
      const index = collection('settings').records.findIndex(item => item.key === mutation.key);
      if (index < 0) collection('settings').records.push(next); else collection('settings').records[index] = next;
      results.push({ collection: 'settings', key: mutation.key, beforeRevision: mutation.expectedRevision, afterRevision: next.revision, deleted: false });
    }
    collection('settings').revision++;
    await route.fulfill({ json: { contractVersion: 'campaign-commit.v1', commitId: writes.length, occurredAt: '2026-09-05T12:00:00Z', results, collectionRevisions: { settings: collection('settings').revision } } });
  });
  await page.goto(`${origin}/#/settings`); await page.locator('.settings-page').waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.live-connected'));
  return { page, writes, uploads };
}
async function openCategory(page: Page, category: string) { await page.locator(`[data-category="${category}"]`).click(); }
async function saved(page: Page, key: string, revision: number) {
  await page.waitForFunction(({ key, revision }) => document.querySelector('codex-settings')?.campaign.collections.find(item => item.name === 'settings')!.records.find(item => item.key === key)?.revision === revision, { key, revision });
  await page.waitForFunction(() => document.querySelector('codex-settings')?.saving === false);
}
async function publish(page: Page, change: () => void) {
  change(); const revision = ++collection('settings').revision;
  const payload = { sequence: ++sequence, topic: 'campaign-data-changed', resourceId: 'settings', revision: String(revision), occurredAt: '2026-09-05T12:00:00Z', metadata: { commitId: sequence, records: 1 } };
  for (const response of streams) response.write(`id: ${sequence}\nevent: campaign-data-changed\ndata: ${JSON.stringify(payload)}\n\n`);
  await page.waitForFunction(revision => document.querySelector('codex-settings')?.campaign.collections.find(item => item.name === 'settings')!.revision === revision, revision);
}
async function showMenu(page: Page, mobile: boolean) { if (mobile) await page.locator('[data-menu-toggle]').click(); }

for (const mobile of [false, true]) test(`branding text, logo and reset reach the shell (${mobile ? 'phone' : 'desktop'})`, async t => {
  const { page, writes, uploads } = await fixture(t, { mobile }); await openCategory(page, 'appearance');
  const panel = page.locator('codex-branding-settings');
  await panel.getByLabel('Site name', { exact: true }).fill('Tiamat');
  await panel.getByLabel('Subtitle', { exact: true }).fill('Friends and adventures');
  await panel.getByLabel('Upload logo', { exact: true }).setInputFiles({ name: 'emblem.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(logoSVG) });
  assert.equal(uploads.length, 0, 'the selected file is saved with the reviewed form');
  assert.equal(await page.locator('.settings-theme-form input[value="moonlit"]').isDisabled(), true);
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'branding', 4);
  assert.equal(uploads.length, 1); assert.equal(writes[0][0].expectedRevision, 3);
  assert.deepEqual(setting('branding').value, { title: 'Tiamat', subtitle: 'Friends and adventures', logoUrl, extension: { keep: true } });
  assert.equal(await page.title(), 'Tiamat'); assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), logoUrl);
  assert.equal(await page.locator('.campaign-brand strong').textContent().then(required), 'Tiamat'); assert.equal(await page.locator('.campaign-sigil').getAttribute('src'), logoUrl);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await panel.locator('.settings-branding-preview img').evaluate(image => image.getBoundingClientRect().width), 84, 'original branding preview size');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}/branding-${mobile ? 'phone' : 'desktop'}.png`, fullPage: true });
  await panel.getByRole('button', { name: 'Use default logo', exact: true }).click();
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'branding', 5);
  assert.equal(setting('branding').value.logoUrl, ''); assert.match(await page.locator('.campaign-sigil').getAttribute('src').then(required), /logo-default/);
  assert.equal(uploads.length, 1);
});

test('failed logo uploads retain the file for retry and do not publish partial branding', async t => {
  const { page, writes, uploads } = await fixture(t, { failUpload: true }); await openCategory(page, 'appearance');
  const panel = page.locator('codex-branding-settings');
  await panel.getByLabel('Upload logo', { exact: true }).setInputFiles({ name: 'retry.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(logoSVG) });
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'selected file are kept' }).waitFor();
  assert.equal(writes.length, 0); assert.equal(setting('branding').value.logoUrl, '');
  assert.equal(await panel.getByText('retry.svg', { exact: true }).count(), 1);
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'branding', 4);
  assert.equal(uploads.length, 2); assert.equal(writes.length, 1);
});

test('branding drafts survive live refresh and category navigation, and theme drafts cannot be discarded by another save', async t => {
  const { page, writes } = await fixture(t); await openCategory(page, 'appearance');
  const panel = page.locator('codex-branding-settings'), name = panel.getByLabel('Site name', { exact: true });
  await name.fill('Kept draft');
  await publish(page, () => { setting('branding').revision++; setting('branding').value.title = 'Remote'; });
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Branding changed' }).waitFor();
  assert.equal(await name.inputValue(), 'Kept draft'); assert.equal(writes.length, 0);
  page.once('dialog', dialog => dialog.dismiss()); await openCategory(page, 'sidebar'); assert.equal(await name.inputValue(), 'Kept draft');
  page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await name.inputValue(), 'Remote');
  await page.locator('.settings-theme-form input[value="moonlit"]').check();
  assert.equal(await name.isDisabled(), true); assert.equal(await panel.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
});

for (const mobile of [false, true]) test(`saved sidebar layout, role filtering and collapsed state (${mobile ? 'phone' : 'desktop'})`, async t => {
  const { page } = await fixture(t, { mobile, role: 'player' }); await showMenu(page, mobile);
  const nav = page.locator('.core-navigation');
  assert.equal(await nav.locator('[data-navigation-section="private"]').count(), 0);
  assert.equal(await nav.locator('a[href="#/factions"]').count(), 0);
  assert.equal(await nav.locator('a[href="#/map/world"]').isVisible(), true);
  const toggle = nav.getByRole('button', { name: /World notes/ });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await nav.locator('a[href="#/characters"]').isVisible(), false);
  await toggle.click(); assert.equal(await nav.locator('a[href="#/characters"]').isVisible(), true);
  await page.reload(); await page.locator('.settings-page').waitFor(); await showMenu(page, mobile);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('sidebar editing preserves original route names and extensions through moves, hiding and section deletion', async t => {
  const { page, writes } = await fixture(t); await openCategory(page, 'sidebar'); const panel = page.locator('codex-sidebar-settings');
  await panel.locator('[data-section="svet"]').getByLabel('Section name', { exact: true }).fill('Shared notes');
  await panel.getByLabel('Move Characters to', { exact: true }).selectOption('prehled');
  await panel.getByRole('button', { name: 'Move Characters up', exact: true }).click();
  await panel.getByLabel('Move World map to', { exact: true }).selectOption('__hidden__');
  await panel.getByRole('button', { name: 'Delete section Private plans', exact: true }).click();
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'sidebarLayout', 5);
  assert.equal(writes.length, 1); assert.equal(writes[0][0].expectedRevision, 4);
  assert.deepEqual(setting('sidebarLayout').value.sections[0].pages, ['/', '/postavy']);
  assert.deepEqual(setting('sidebarLayout').value.extension, { keep: true });
  assert.deepEqual(setting('sidebarLayout').value.sections[1].extension, { keep: true });
  assert.ok(setting('sidebarLayout').value.hidden.includes('/future/page'));
  assert.equal(await page.locator('.core-navigation a[href="#/characters"]').isVisible(), true);
  assert.equal(await page.locator('.core-navigation a[href="#/map/world"]').count(), 0);
  assert.equal(await page.locator('.core-navigation a[href="#/future/page"]').count(), 0);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}/sidebar-desktop.png`, fullPage: true });
  const world = panel.locator('[data-section="svet"]');
  await panel.locator('[data-page="/postavy"] .sb-grip').dragTo(world.locator('.sb-pages'));
  assert.equal(await world.locator('[data-page="/postavy"]').count(), 1);
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'sidebarLayout', 6);
  assert.ok(setting('sidebarLayout').value.sections[1].pages.includes('/postavy'));
});

test('phone sidebar conflicts keep the draft and cancel reloads the current layout', async t => {
  const { page, writes } = await fixture(t, { mobile: true }); await openCategory(page, 'sidebar');
  const panel = page.locator('codex-sidebar-settings'), name = panel.locator('[data-section="svet"]').getByLabel('Section name', { exact: true });
  await name.fill('My layout');
  await publish(page, () => { setting('sidebarLayout').revision++; setting('sidebarLayout').value.sections[1].label = 'Remote layout'; });
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'sidebar changed' }).waitFor();
  assert.equal(await name.inputValue(), 'My layout'); assert.equal(writes.length, 0);
  page.once('dialog', dialog => dialog.dismiss()); await openCategory(page, 'language'); assert.equal(await name.inputValue(), 'My layout');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}/sidebar-phone.png`, fullPage: true });
  page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await name.inputValue(), 'Remote layout');
});

test('add-on sidebar pages remain opt-in and hide without disabling their route', async t => {
  const { page, writes } = await fixture(t, { addon: true }); await openCategory(page, 'sidebar');
  const panel = page.locator('codex-sidebar-settings'), mode = panel.getByLabel('Visibility of Fixture tools', { exact: true });
  await mode.waitFor(); assert.equal(await mode.inputValue(), 'hidden');
  assert.equal(await page.locator('.addon-navigation-link').count(), 0);
  await mode.selectOption('dm'); await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'addonSidebarVisibility', 1);
  await page.locator('.addon-navigation-link').waitFor();
  assert.equal(writes[0].length, 2, 'layout and visibility are one transaction');
  await mode.selectOption('hidden'); await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'addonSidebarVisibility', 2);
  assert.equal(await page.locator('.addon-navigation-link').count(), 0);
  await page.goto(`${origin}/#/addons/visual-fixture/tools`); await page.locator('visual-fixture-addon').waitFor();
});

test('malformed branding and sidebar records show errors without offering destructive default saves', async t => {
  const { page, writes } = await fixture(t, { malformed: true }); await openCategory(page, 'appearance');
  await page.locator('codex-branding-settings').getByRole('alert').waitFor();
  assert.equal(await page.locator('codex-branding-settings button').count(), 0);
  await openCategory(page, 'sidebar'); await page.locator('codex-sidebar-settings').getByRole('alert').waitFor();
  assert.equal(await page.locator('codex-sidebar-settings button').count(), 0); assert.equal(writes.length, 0);
});

test('server conflicts keep uploaded branding and sidebar drafts without changing accepted values', async t => {
  const { page, writes } = await fixture(t, { reject: true }); await openCategory(page, 'appearance');
  const brand = page.locator('codex-branding-settings');
  await brand.getByLabel('Site name', { exact: true }).fill('Unaccepted');
  await brand.getByLabel('Upload logo', { exact: true }).setInputFiles({ name: 'conflict.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(logoSVG) });
  await brand.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Branding changed' }).waitFor();
  assert.equal(await brand.getByLabel('Site name', { exact: true }).inputValue(), 'Unaccepted');
  assert.equal(await brand.getByText('conflict.svg', { exact: true }).count(), 1); assert.equal(setting('branding').value.logoUrl, '');
  assert.equal(await page.locator('.campaign-brand strong').textContent().then(required), 'Asurai');
  page.once('dialog', dialog => dialog.accept()); await openCategory(page, 'sidebar');
  const sidebar = page.locator('codex-sidebar-settings');
  await sidebar.locator('[data-section="svet"]').getByLabel('Section name', { exact: true }).fill('Unaccepted section');
  await sidebar.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'sidebar changed' }).waitFor();
  assert.equal(writes.length, 2); assert.equal(setting('sidebarLayout').value.sections[1].label, 'World notes');
  assert.equal(await sidebar.locator('[data-section="svet"]').getByLabel('Section name', { exact: true }).inputValue(), 'Unaccepted section');
});

test('section drag, addition and reset preserve unavailable saved routes', async t => {
  const { page } = await fixture(t); await openCategory(page, 'sidebar'); const panel = page.locator('codex-sidebar-settings');
  await panel.locator('[data-section="private"] .sb-sec-head > .sb-grip').dragTo(panel.locator('[data-section="prehled"] .sb-sec-head'));
  assert.equal(await panel.locator('[data-section]').first().getAttribute('data-section'), 'private');
  await panel.getByRole('button', { name: '＋ Add section', exact: true }).click();
  assert.equal(await panel.locator('[data-section]').count(), 4);
  page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '↺ Reset layout', exact: true }).click();
  assert.equal(await panel.locator('.sb-hidden [data-page="/future/page"]').count(), 1);
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page, 'sidebarLayout', 5);
  assert.equal(setting('sidebarLayout').value.sections[0].id, 'overview');
  assert.deepEqual(setting('sidebarLayout').value.extension, { keep: true });
});
