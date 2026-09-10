import { required } from './fixture-types.mts';
import type { Browser, Page } from 'playwright';
import type { TestContext } from 'node:test';
import type { PreviewServer, ViteDevServer } from 'vite';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import { visualFixturePlugin } from './visual-fixture.mts';

let server: PreviewServer, referenceServer: ViteDevServer, browser: Browser, origin: string, referenceOrigin: string;
const artifacts = fileURLToPath(new URL('../../test-results/visual/', import.meta.url));
before(async () => {
  await mkdir(artifacts, { recursive: true });
  const root = fileURLToPath(new URL('../../', import.meta.url));
  server = await preview({ root, configFile: false, plugins: [visualFixturePlugin()], logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  referenceServer = await createServer({ root, configFile: false,
    cacheDir: fileURLToPath(new URL('../../node_modules/.vite-visual-reference', import.meta.url)),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await referenceServer.listen();
  referenceOrigin = `http://127.0.0.1:${(referenceServer.httpServer!.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); await referenceServer?.close(); });

async function fixture(t: TestContext, viewport: { width: number; height: number }, role = '', addon = false) {
  const context = await browser.newContext({ viewport, locale: 'en-US', reducedMotion: 'reduce',
    ...(role ? { extraHTTPHeaders: { 'x-fixture-role': role, 'x-fixture-addon': String(addon) } } : {}) });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser errors'));
  const external: string[] = [];
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  t.after(() => assert.deepEqual(external, [], 'fonts and branding must load locally'));
  await page.goto(origin);
  await page.locator('#campaign-title').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => ['Cinzel Variable','Lora Variable','Inter Variable'].every(font => document.fonts.check(`16px "${font}"`))), 'the deployed font files must actually load');
  assert.equal(await page.locator('.application-alert').count(), 0);
  return page;
}

async function style(page: Page, selector: string, properties: string[]) {
  return page.locator(selector).first().evaluate((element, properties) => {
    const css = getComputedStyle(element);
    return Object.fromEntries(properties.map(property => [property, css.getPropertyValue(property)]));
  }, properties);
}
async function compare(page: Page, reference: Page, actual: string, original: string, properties: string[]) {
  assert.deepEqual(await style(page, actual, properties), await style(reference, original, properties), `${actual} must retain v1 appearance`);
}
async function fits(page: Page) {
  const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(size.content <= size.viewport, `horizontal overflow: ${JSON.stringify(size)}`);
}

for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
  test(`classic ${name} matches preserved v1 typography, surfaces and card geometry`, async t => {
    const page = await fixture(t, viewport);
    const reference = await page.context().newPage();
    await reference.goto(`${referenceOrigin}/test/browser/reference/classic.html`);
    await reference.evaluate(() => document.fonts.ready);
    await compare(page, reference, 'body', 'body', ['background-color','color','font-family','font-size','line-height']);
    await compare(page, reference, '.campaign-content', '.main-content', ['margin-left','padding-top','padding-left','padding-right']);
    await compare(page, reference, '.campaign-sidebar', '.sidebar', ['width','background-color','border-right-color']);
    await compare(page, reference, '#campaign-title', '.dash-hero-name', ['font-family','font-size','font-weight','line-height','letter-spacing','color']);
    await compare(page, reference, '.campaign-title-page', '.dash-hero', ['padding','margin-bottom','text-align']);
    await compare(page, reference, '.campaign-identity-pen', '.dash-hero-pen', ['width','height','border-radius','font-size','color','opacity','border-top-color']);
    await compare(page, reference, '.party-add', '.dash-section-add', ['padding','font-family','font-size','color','background-color','border-radius','border-top-color']);
    await compare(page, reference, '.section-heading h2', '.dash-section-head h2', ['font-family','font-size','line-height','letter-spacing','color']);
    await compare(page, reference, '.party-member', '.dash-party-card', ['width','padding','gap','border-radius','background-color','border-top-color']);
    await compare(page, reference, '.party-portrait', '.dash-party-portrait', ['width','height','border-radius']);
    await compare(page, reference, '.party-member-copy strong', '.dash-party-name', ['font-family','font-size','color']);
    await compare(page, reference, '.party-member-copy > span', '.dash-party-title', ['font-family','font-size','color']);
    const sections = await page.locator('.chronicle-section').evaluateAll(nodes => nodes.map(node => { const r=node.getBoundingClientRect(); return {x:r.x, y:r.y, bottom:r.bottom}; }));
    assert.ok(sections[1].y >= sections[0].bottom && sections[2].y >= sections[1].bottom, 'dashboard sections remain vertically stacked');
    assert.equal(sections[0].x, sections[1].x);
    await fits(page);
    await page.screenshot({ animations: "disabled", path: `${artifacts}${name}-dashboard.png`, fullPage: true });
    await reference.screenshot({ animations: "disabled", path: `${artifacts}${name}-reference.png`, fullPage: true });

    await page.goto(`${origin}/#/characters`);
    await page.locator('.record-row').first().waitFor();
    await compare(page, reference, '.record-row', '.char-card', ['background-color','border-radius','border-top-color']);
    await compare(page, reference, '.record-row-copy strong', '.char-card-name', ['font-family','font-size','color']);
    const card = await page.locator('.record-row-mark').first().boundingBox().then(required);
    assert.ok(Math.abs(card.width / card.height - .75) < .01, 'character portraits keep the original 3:4 card proportions');
    await fits(page);
    await page.screenshot({ animations: "disabled", path: `${artifacts}${name}-characters.png`, fullPage: true });
    await page.locator('.record-row').first().click();
    await page.locator('#record-title').waitFor();
    assert.equal((await style(page, '.record-masthead', ['background-color']))['background-color'], 'rgb(36, 28, 13)');
    const rail = await page.locator('.record-side').boundingBox().then(required);
    const reading = await page.locator('.record-reading').boundingBox().then(required);
    assert.ok(name === 'desktop' ? reading.x > rail.x + rail.width : reading.y >= rail.y + rail.height, 'article rail stacks at the original breakpoint');
    await fits(page);
    await page.screenshot({ animations: "disabled", path: `${artifacts}${name}-article.png`, fullPage: true });
  });
}

test('mobile drawer stays accessible and preserves dirty record edits', async t => {
  const page = await fixture(t, { width: 390, height: 844 }, 'dm');
  await page.locator('[data-menu-toggle]').click();
  assert.equal(await page.locator('[data-menu-toggle]').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('main').evaluate(element => (element as HTMLElement).inert), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-menu-toggle]').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.campaign-sidebar').evaluate(element => (element as HTMLElement).inert), true);
  assert.equal(await page.locator('[data-menu-toggle]').evaluate(element => element === document.activeElement), true);
  await page.locator('[data-menu-toggle]').click();
  await page.locator('.core-navigation a[href="#/characters"]').click();
  await page.locator('.record-row').first().waitFor();
  assert.equal(await page.locator('[data-menu-toggle]').getAttribute('aria-expanded'), 'false');
  await page.locator('.record-row[href="#/characters/ryn"]').click();
  await page.getByLabel('More actions', { exact: true }).click(); await page.getByRole('button', { name: 'Edit all fields', exact: true }).click();
  await page.locator('[name="name"]').fill('Keep this draft');
  await page.locator('[data-menu-toggle]').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.core-navigation a[href="#/"]').click();
  await page.waitForURL(/#\/characters\/ryn$/);
  assert.match(page.url(), /#\/characters\/ryn$/);
  assert.equal(await page.locator('[name="name"]').inputValue(), 'Keep this draft');
  await page.keyboard.press('Escape');
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Control+k');
  await page.waitForURL(/#\/characters\/ryn$/);
  assert.match(page.url(), /#\/characters\/ryn$/);
  assert.equal(await page.locator('[name="name"]').inputValue(), 'Keep this draft');
  await fits(page);
  await page.screenshot({ animations: "disabled", path: `${artifacts}mobile-editor.png`, fullPage: true });
});

test('desktop sidebar, phone menu and settings remain usable across resize', async t => {
  const page = await fixture(t, { width: 820, height: 900 }, 'dm');
  assert.equal(await page.locator('.campaign-sidebar').evaluate(element => (element as HTMLElement).inert), false);
  assert.equal(await page.locator('[data-menu-toggle]').isVisible(), false);
  await page.setViewportSize({ width: 320, height: 780 });
  await page.locator('[data-menu-toggle]').click();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.campaign-sidebar')!.getBoundingClientRect().x === 0);
  await page.screenshot({ animations: "disabled", path: `${artifacts}mobile-menu.png` });
  await page.locator('.sidebar-footer a[href="#/settings"]').click();
  await page.locator('.settings-page').waitFor();
  await fits(page);
  await page.screenshot({ animations: "disabled", path: `${artifacts}mobile-settings.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  assert.equal((await style(page, '.theme-sample-classic .settings-theme-sample', ['background-color']))['background-color'], 'rgb(20, 16, 8)');
  await fits(page);
  await page.screenshot({ animations: "disabled", path: `${artifacts}desktop-settings.png`, fullPage: true });
  assert.equal(await page.locator('.application-alert').count(), 0);
});


test('one add-on navigation outlet survives desktop and mobile transitions', async t => {
  const page = await fixture(t, { width: 1440, height: 1000 }, 'dm', true);
  const link = page.getByRole('link', { name: 'Fixture tools', exact: true });
  await link.waitFor().catch(async error => {
    t.diagnostic(await page.locator('.account-panel small').getAttribute('title').then(required));
    throw error;
  });
  assert.equal(await link.count(), 1);
  await link.click();
  await page.locator('visual-fixture-addon').waitFor();
  assert.equal(await page.locator('visual-fixture-addon').textContent().then(required), 'Synthetic add-on page');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-menu-toggle]').click();
  assert.equal(await link.count(), 1);
  assert.equal(await link.isVisible(), true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator('visual-fixture-addon').count(), 1);
  assert.equal(await page.locator('.application-alert').count(), 0);
});

test('skip link moves focus into the campaign without changing its route', async t => {
  const page = await fixture(t, { width: 1440, height: 1000 });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#campaign-content').evaluate(element => element === document.activeElement), true);
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.locator('#campaign-title').textContent().then(required), 'Asurai');
});
