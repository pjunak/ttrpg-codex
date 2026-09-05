import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { visualCampaign, visualFixturePlugin } from './visual-fixture.mjs';

let server, browser, origin, campaign, sequence = 0;
const streams = new Set(), output = fileURLToPath(new URL('../../test-results/relationship-graph/', import.meta.url));
const collection = name => campaign.collections.find(item => item.name === name);
const node = (page, key) => page.locator(`.cm-node[data-key="${key}"]`);
const savedPositions = { ryn: { x: -300, y: -160 }, mira: { x: 120, y: -160 }, kael: { x: -100, y: 170 }, talia: { x: 340, y: 190 } };
before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) { streams.add(response); response.on('close', () => streams.delete(response)); } })],
    preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(t, { mobile = false, role = 'player', locale = 'en', blockedStorage = false, malformedStorage = false } = {}) {
  campaign = structuredClone(visualCampaign); sequence = 0;
  collection('relationships').records = [
    { key: 'edge-one', revision: 1, value: { source: 'ryn', target: 'mira', type: 'ally', label: 'Trusted ally' } },
    { key: 'edge-two', revision: 1, value: { source: 'ryn', target: 'mira', type: 'commands' } },
    { key: 'edge-three', revision: 1, value: { source: 'mira', target: 'kael', type: 'enemy' } },
    { key: 'missing-target', revision: 1, value: { source: 'ryn', target: 'secret-character', type: 'enemy' } },
  ];
  collection('characters').records.find(record => record.key === 'talia').value.faction = 'watch';
  collection('factions').records.push({ key: 'watch', revision: 1, value: { name: 'The Watch', color: '#886633', badge: '♜' } });
  collection('settings').records.push(
    { key: 'characterStatuses', revision: 1, value: [{ id: 'alive', label: 'Alive', color: '#558844', icon: '●' }] },
    { key: 'relationshipTypes', revision: 1, value: [{ id: 'ally', label: 'Ally', color: '#448844', style: 'dashed' },
      { id: 'commands', label: 'Commands', color: '#C49A35', style: 'solid' }, { id: 'enemy', label: 'Enemy', color: '#A84444', style: 'dotted' }] },
  );
  const context = await browser.newContext({ reducedMotion: 'reduce', hasTouch: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    extraHTTPHeaders: { 'x-fixture-role': role } });
  t.after(() => context.close());
  await context.addInitScript(({ savedPositions, locale, blockedStorage, malformedStorage }) => {
    if (!localStorage.getItem('graph-test-seeded')) {
      localStorage.setItem('cm_pos_vztahy', malformedStorage ? '{broken' : JSON.stringify(savedPositions));
      localStorage.setItem('codex_lang', locale); localStorage.setItem('graph-test-seeded', 'true');
    }
    window.graphStorageBlocked = blockedStorage;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('cm_') && window.graphStorageBlocked) throw new DOMException('Storage is full', 'QuotaExceededError'); return original.call(this, key, value); };
  }, { savedPositions, locale, blockedStorage, malformedStorage });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url()); });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(writes, [], 'graph gestures must never mutate campaign content'); });
  await page.goto(`${origin}/#/graph/relationships`); await node(page, 'ryn').waitFor();
  await page.waitForFunction(() => document.querySelector('.live-connected'));
  await page.getByRole('button', { name: locale === 'cs' ? 'Obnovit přiblížení na 100 %' : 'Reset zoom to 100%', exact: true }).click();
  return { page, context };
}
async function positions(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('cm_pos_vztahy'))); }
async function publish(page, change) {
  change(); const revision = ++collection('characters').revision;
  const payload = { sequence: ++sequence, topic: 'campaign-data-changed', resourceId: 'characters', revision: String(revision), occurredAt: '2026-09-05T12:00:00Z', metadata: { commitId: sequence, records: 1 } };
  for (const response of streams) response.write(`id: ${sequence}\nevent: campaign-data-changed\ndata: ${JSON.stringify(payload)}\n\n`);
  await page.waitForFunction(revision => document.querySelector('codex-relationship-graph')?.campaign.collections.find(item => item.name === 'characters').revision === revision, revision);
}
async function drag(page, key, dx, dy) {
  const rect = await node(page, key).boundingBox(); const x = rect.x + rect.width / 2, y = rect.y + 20;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up();
}

for (const mobile of [false, true]) test(`relationship graph preserves card styling and zoom geometry (${mobile ? 'phone' : 'desktop'})`, async t => {
  const { page } = await fixture(t, { mobile });
  assert.equal(await page.locator('.cm-node').count(), 4); assert.equal(await page.locator('[data-edge-key]').count(), 3);
  const native = await node(page, 'ryn').evaluate(element => ({ width: element.offsetWidth, font: getComputedStyle(element.querySelector('.cm-name')).fontSize,
    family: getComputedStyle(element.querySelector('.cm-name')).fontFamily, transform: getComputedStyle(element).transform }));
  assert.equal(native.width, 168); assert.equal(native.font, '13px'); assert.match(native.family, /Cinzel/); assert.equal(native.transform, 'none');
  const shell = await page.locator('.cm-shell').boundingBox(); assert.equal(Math.round(shell.x), mobile ? 0 : 240); assert.equal(Math.round(shell.height), mobile ? 784 : 1000);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (mobile) await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.screenshot({ path: `${output}${mobile ? 'phone' : 'desktop'}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  const zoomed = await node(page, 'ryn').evaluate(element => ({ width: element.offsetWidth, font: getComputedStyle(element.querySelector('.cm-name')).fontSize,
    detail: getComputedStyle(element.querySelector('.cm-fact')).visibility }));
  assert.equal(zoomed.width, 151); assert.equal(zoomed.font, '13px'); assert.equal(zoomed.detail, 'hidden');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).textContent(), '100%');
});

test('pointer and keyboard moves persist legacy centers and never modify campaign records', async t => {
  const { page } = await fixture(t); const before = structuredClone(campaign);
  await drag(page, 'ryn', 100, 55); await page.waitForFunction(() => JSON.parse(localStorage.getItem('cm_pos_vztahy')).ryn.x === -200);
  assert.deepEqual((await positions(page)).ryn, { x: -200, y: -105 }); assert.match(page.url(), /#\/graph\/relationships$/);
  await node(page, 'ryn').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  assert.deepEqual((await positions(page)).ryn, { x: -195, y: -85 }); assert.deepEqual(campaign, before);
  await page.reload(); await node(page, 'ryn').waitFor();
  assert.deepEqual(await page.locator('codex-relationship-graph').evaluate(graph => graph.positions.get('ryn')), { x: -195, y: -85 });
});

test('click, keyboard and context actions navigate to exact character details', async t => {
  const { page } = await fixture(t);
  await node(page, 'ryn').focus(); await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); assert.match(page.url(), /#\/graph\/relationships$/);
  assert.match(await node(page, 'talia').locator('.cm-cloud').getAttribute('class'), /cm-vfilter-dim/);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await node(page, 'ryn').focus(); await page.keyboard.press('Enter'); await page.waitForURL(/#\/characters\/ryn$/);
  await page.goBack(); await node(page, 'mira').waitFor(); await node(page, 'mira').click(); await page.waitForURL(/#\/characters\/mira$/);
});

test('chip filters, relationship toggles, focus depth and faction hiding survive reload', async t => {
  const { page } = await fixture(t);
  const search = page.getByRole('textbox', { name: 'Filter graph', exact: true }); await search.fill('ryn'); await search.press('Enter');
  assert.match(await node(page, 'mira').locator('.cm-cloud').getAttribute('class'), /cm-vfilter-dim/);
  await page.getByRole('button', { name: 'Remove filter ryn', exact: true }).click();
  await page.getByRole('button', { name: 'Ally', exact: true }).click(); assert.equal(await page.locator('[data-edge-key="edge-one"]').getAttribute('opacity'), '0.1');
  await page.getByRole('button', { name: 'Focus', exact: false }).click(); await page.getByRole('slider', { name: 'Neighborhood depth' }).fill('1'); await node(page, 'ryn').click();
  assert.match(await node(page, 'kael').locator('.cm-cloud').getAttribute('class'), /cm-vfilter-dim/);
  await page.getByRole('slider', { name: 'Neighborhood depth' }).fill('2'); assert.doesNotMatch(await node(page, 'kael').locator('.cm-cloud').getAttribute('class'), /cm-vfilter-dim/);
  await page.getByText('Legend & filters', { exact: true }).click(); await page.getByRole('checkbox', { name: /The Watch/ }).uncheck();
  await node(page, 'talia').waitFor({ state: 'detached' }); await page.reload(); await node(page, 'ryn').waitFor();
  assert.equal(await node(page, 'talia').count(), 0); assert.equal(await page.getByRole('button', { name: 'Ally', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await node(page, 'talia').waitFor();
});

test('cancelled drags and live changes preserve stored positions and remove unavailable endpoints', async t => {
  const { page } = await fixture(t); const rect = await node(page, 'ryn').boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 20); await page.mouse.down(); await page.mouse.move(rect.x + 80, rect.y + 60, { steps: 4 });
  await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual((await positions(page)).ryn, savedPositions.ryn);
  await publish(page, () => { collection('characters').records = collection('characters').records.filter(record => record.key !== 'mira'); });
  await node(page, 'mira').waitFor({ state: 'detached' }); assert.equal(await page.locator('[data-edge-key]').count(), 0);
  assert.deepEqual((await positions(page)).ryn, savedPositions.ryn);
});

test('wheel zoom uses fixed steps and canvas panning does not change saved centers', async t => {
  const { page } = await fixture(t); const canvas = page.getByRole('region', { name: 'Relationship graph', exact: true });
  const rect = await canvas.boundingBox(); await page.mouse.move(rect.x + 20, rect.y + 20);
  await page.mouse.wheel(0, 2000); await page.waitForFunction(() => document.querySelector('codex-relationship-graph').zoom === .9);
  await page.mouse.wheel(0, -2000); await page.waitForFunction(() => document.querySelector('codex-relationship-graph').zoom === 1);
  const before = await page.locator('codex-relationship-graph').evaluate(graph => graph.pan);
  await canvas.focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('codex-relationship-graph').evaluate(graph => graph.pan.x), before.x + 30);
  assert.deepEqual(await positions(page), savedPositions);
});

test('long authored edge labels wrap completely along the connection', async t => {
  const { page } = await fixture(t);
  const label = 'The old agreement between the northern scouts and the guardians of the mountain gate';
  collection('relationships').records[2].value.label = label;
  await publish(page, () => { collection('characters').records[0].revision++; });
  const text = page.locator('[data-edge-key="edge-three"] .cm-edge-text'); await text.waitFor();
  assert.equal((await text.locator('tspan').allTextContents()).join(' '), label);
  assert.ok(await text.locator('tspan').count() > 1); assert.doesNotMatch(await text.getAttribute('transform'), /rotate\(0 /);
});

test('storage failures keep the local arrangement for retry and malformed preferences remain usable', async t => {
  const { page } = await fixture(t, { blockedStorage: true, malformedStorage: true });
  const before = await page.locator('codex-relationship-graph').evaluate(graph => graph.positions.get('ryn'));
  await node(page, 'ryn').focus(); await page.keyboard.press('ArrowRight'); await page.locator('.cm-message[role="alert"]').waitFor();
  assert.equal(await page.locator('codex-relationship-graph').evaluate(graph => graph.positions.get('ryn').x), before.x + 5);
  await page.evaluate(() => { window.graphStorageBlocked = false; }); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.cm-message[role="alert"]').waitFor({ state: 'detached' }); assert.equal((await positions(page)).ryn.x, before.x + 5);
});

test('another tab interrupts an active drag without overwriting its saved arrangement', async t => {
  const { page, context } = await fixture(t); const second = await context.newPage(); await second.goto(`${origin}/#/graph/relationships`); await node(second, 'ryn').waitFor();
  const rect = await node(page, 'ryn').boundingBox(); await page.mouse.move(rect.x + 20, rect.y + 20); await page.mouse.down(); await page.mouse.move(rect.x + 100, rect.y + 80, { steps: 3 });
  await second.evaluate(() => localStorage.setItem('cm_pos_vztahy', JSON.stringify({ ryn: { x: 10, y: 20 }, mira: { x: 120, y: -160 } })));
  await page.locator('.cm-message').filter({ hasText: 'Another tab changed' }).waitFor(); await page.mouse.up();
  assert.deepEqual((await positions(page)).ryn, { x: 10, y: 20 });
  assert.deepEqual(await page.locator('codex-relationship-graph').evaluate(graph => graph.positions.get('ryn')), { x: 10, y: 20 });
});

test('anonymous Czech readers can arrange the read-only graph and use the preserved route', async t => {
  const { page } = await fixture(t, { role: '', locale: 'cs' });
  await page.goto(`${origin}/#/mapa/vztahy`); await node(page, 'ryn').waitFor();
  await page.getByRole('heading', { name: /Myšlenkový palác/ }).waitFor();
  await node(page, 'ryn').focus(); await page.keyboard.press('ArrowRight'); assert.equal((await positions(page)).ryn.x, savedPositions.ryn.x + 5);
  await publish(page, () => { collection('characters').records = []; }); await page.getByText('Žádné postavy k zobrazení', { exact: true }).waitFor();
});
