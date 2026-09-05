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
const node = (page, key) => page.locator(`.cm-node[data-key=${JSON.stringify(key)}]`);
const typedKey = (kind, key) => JSON.stringify([kind, key]);
const typedNode = (page, kind, key) => node(page, typedKey(kind, key));
const savedPositions = { ryn: { x: -300, y: -160 }, mira: { x: 120, y: -160 }, kael: { x: -100, y: 170 }, talia: { x: 340, y: 190 } };
before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) { streams.add(response); response.on('close', () => streams.delete(response)); } })],
    preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(t, { mobile = false, role = 'player', locale = 'en', blockedStorage = false, malformedStorage = false, mixed = false, reducedMotion = 'reduce' } = {}) {
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
  if (mixed) {
    for (const record of collection('characters').records) {
      if (['ryn', 'mira'].includes(record.key)) { record.value.faction = 'watch'; record.value.location = 'gate'; }
      if (record.key === 'mira') record.value.locationRoles = [{ locationId: 'outpost' }, { locationId: 'gate' }];
      if (record.key === 'talia') { record.value.faction = 'guild'; record.value.location = 'gate'; }
    }
    collection('factions').records.push({ key: 'guild', revision: 1, value: { name: 'Explorers Guild', color: '#336688', badge: '⚑' } });
    collection('locations').records.push({ key: 'outpost', revision: 1, value: { name: 'Mountain Outpost' } });
    collection('mysteries').records = [
      { key: 'gate', revision: 1, value: { name: 'The Open Gate', characters: ['ryn', 'talia', 'secret'], priority: 'kritická', questions: [{ text: 'Who opened the northern gate?', answer: 'An answer is not a preview' }] } },
      { key: 'veil', revision: 1, value: { name: 'The Mountain Veil', characters: ['ryn', 'mira'], questions: ['What waits beyond the mist?'] } },
      { key: 'unresolved', revision: 1, value: { name: 'An Unresolved Question', characters: [] } },
    ];
  }
  const context = await browser.newContext({ reducedMotion, hasTouch: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    extraHTTPHeaders: { 'x-fixture-role': role } });
  t.after(() => context.close());
  await context.addInitScript(({ savedPositions, locale, blockedStorage, malformedStorage }) => {
    if (!localStorage.getItem('graph-test-seeded')) {
      localStorage.setItem('cm_pos_vztahy', malformedStorage ? '{broken' : JSON.stringify(savedPositions));
      localStorage.setItem('cm_pos_frakce', JSON.stringify({ hub_watch: { x: -330, y: -250 }, hub_guild: { x: 330, y: -250 },
        ryn: { x: -330, y: 0 }, mira: { x: 0, y: 0 }, kael: { x: 330, y: 250 }, talia: { x: 330, y: 0 }, gate: { x: 0, y: -250 }, outpost: { x: -330, y: 250 } }));
      localStorage.setItem('cm_pos_tajemstvi', JSON.stringify({ gate: { x: -300, y: -200 }, veil: { x: 300, y: -200 },
        unresolved: { x: 0, y: 260 }, ryn: { x: -300, y: 70 }, mira: { x: 0, y: 70 }, talia: { x: 300, y: 70 } }));
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
  await page.waitForFunction(revision => document.querySelector('codex-campaign-graph')?.campaign.collections.find(item => item.name === 'characters').revision === revision, revision);
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
  assert.deepEqual(await page.locator('codex-campaign-graph').evaluate(graph => graph.positions.get('ryn')), { x: -195, y: -85 });
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
  await page.mouse.wheel(0, 2000); await page.waitForFunction(() => document.querySelector('codex-campaign-graph').zoom === .9);
  await page.mouse.wheel(0, -2000); await page.waitForFunction(() => document.querySelector('codex-campaign-graph').zoom === 1);
  const before = await page.locator('codex-campaign-graph').evaluate(graph => graph.pan);
  await canvas.focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('codex-campaign-graph').evaluate(graph => graph.pan.x), before.x + 30);
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
  const before = await page.locator('codex-campaign-graph').evaluate(graph => graph.positions.get('ryn'));
  await node(page, 'ryn').focus(); await page.keyboard.press('ArrowRight'); await page.locator('.cm-message[role="alert"]').waitFor();
  assert.equal(await page.locator('codex-campaign-graph').evaluate(graph => graph.positions.get('ryn').x), before.x + 5);
  await page.evaluate(() => { window.graphStorageBlocked = false; }); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.cm-message[role="alert"]').waitFor({ state: 'detached' }); assert.equal((await positions(page)).ryn.x, before.x + 5);
});

test('another tab interrupts an active drag without overwriting its saved arrangement', async t => {
  const { page, context } = await fixture(t); const second = await context.newPage(); await second.goto(`${origin}/#/graph/relationships`); await node(second, 'ryn').waitFor();
  const rect = await node(page, 'ryn').boundingBox(); await page.mouse.move(rect.x + 20, rect.y + 20); await page.mouse.down(); await page.mouse.move(rect.x + 100, rect.y + 80, { steps: 3 });
  await second.evaluate(() => localStorage.setItem('cm_pos_vztahy', JSON.stringify({ ryn: { x: 10, y: 20 }, mira: { x: 120, y: -160 } })));
  await page.locator('.cm-message').filter({ hasText: 'Another tab changed' }).waitFor(); await page.mouse.up();
  assert.deepEqual((await positions(page)).ryn, { x: 10, y: 20 });
  assert.deepEqual(await page.locator('codex-campaign-graph').evaluate(graph => graph.positions.get('ryn')), { x: 10, y: 20 });
});

test('anonymous Czech readers can arrange the read-only graph and use the preserved route', async t => {
  const { page } = await fixture(t, { role: '', locale: 'cs' });
  await page.goto(`${origin}/#/mapa/vztahy`); await node(page, 'ryn').waitFor();
  await page.getByRole('heading', { name: /Myšlenkový palác/ }).waitFor();
  await node(page, 'ryn').focus(); await page.keyboard.press('ArrowRight'); assert.equal((await positions(page)).ryn.x, savedPositions.ryn.x + 5);
  await publish(page, () => { collection('characters').records = []; }); await page.getByText('Žádné postavy k zobrazení', { exact: true }).waitFor();
});

async function switchMode(page, mode) {
  await page.locator(`.map-mode-btn[href="#/graph/${mode}"]`).click();
  await page.waitForFunction(mode => document.querySelector('codex-campaign-graph')?.mode === mode, mode);
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
}
async function typedPosition(page, kind, key) {
  return page.locator('codex-campaign-graph').evaluate((graph, id) => graph.positions.get(id), typedKey(kind, key));
}

for (const mode of ['factions', 'mysteries']) for (const mobile of [false, true]) test(`${mode} restores original cards, links and navigation (${mobile ? 'phone' : 'desktop'})`, async t => {
  const { page } = await fixture(t, { mixed: true, mobile, role: 'dm' });
  await switchMode(page, mode);
  assert.equal(await page.locator('.map-mode-btn').count(), 3);
  assert.equal(await page.locator('.map-mode-btn[aria-current="page"]').getAttribute('href'), `#/graph/${mode}`);
  assert.equal(await page.locator('.cm-node').count(), mode === 'factions' ? 8 : 6);
  if (mode === 'factions') {
    const hub = typedNode(page, 'faction', 'watch');
    assert.equal(await hub.locator('.cm-fact').textContent(), '2 characters');
    const style = await hub.evaluate(element => ({ width: element.offsetWidth, radius: getComputedStyle(element.querySelector('.cm-cloud')).borderRadius,
      font: getComputedStyle(element.querySelector('.cm-name')).fontSize }));
    assert.deepEqual(style, { width: 210, radius: '999px', font: '15px' });
    assert.equal(await typedNode(page, 'location', 'gate').getAttribute('href'), '#/locations/gate');
    assert.match(await typedNode(page, 'character', 'mira').textContent(), /Under command: Ryn/);
    assert.equal(await page.locator('[data-edge-type="member"]').count(), 2);
    assert.equal(await page.locator('[data-edge-type="located_at"]').count(), 3);
    assert.equal(await page.locator('.cm-glow').count(), 5);
  } else {
    assert.equal(await page.locator('[data-edge-type="mysteryLink"]').count(), 4);
    assert.equal(await typedNode(page, 'mystery', 'gate').getAttribute('href'), '#/mysteries/gate');
    assert.match(await typedNode(page, 'character', 'ryn').textContent(), /2 mysteries/);
    assert.equal(await typedNode(page, 'mystery', 'gate').locator('.cm-hint').textContent(), 'Who opened the northern gate?');
    assert.doesNotMatch(await page.locator('.cm-shell').textContent(), /secret|An answer is not a preview|\[object Object\]/);
    const color = await typedNode(page, 'mystery', 'gate').locator('.cm-cloud').evaluate(element => getComputedStyle(element).backgroundImage);
    assert.match(color, /28, 10, 42/);
  }
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForFunction(() => {
    const graph = document.querySelector('codex-campaign-graph'), viewport = document.querySelector('.cm-viewport').getBoundingClientRect();
    return [...graph.querySelectorAll('.cm-node')].every(node => { const box = node.getBoundingClientRect(); return box.left >= viewport.left - 1 && box.right <= viewport.right + 1 && box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1; });
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}${mode}-${mobile ? 'phone' : 'desktop'}.png`, animations: 'disabled' });
  if (!mobile) {
    const target = mode === 'factions' ? typedNode(page, 'faction', 'watch') : typedNode(page, 'mystery', 'gate');
    await target.focus(); await page.keyboard.press('Enter'); await page.waitForURL(mode === 'factions' ? /#\/factions\/watch$/ : /#\/mysteries\/gate$/);
  }
});

test('mode changes isolate filters and migrated positions while preserving the original browser values', async t => {
  const { page } = await fixture(t, { mixed: true }); const before = structuredClone(campaign);
  const legacy = await page.evaluate(() => localStorage.getItem('cm_pos_frakce'));
  await switchMode(page, 'factions');
  assert.deepEqual(await typedPosition(page, 'character', 'ryn'), { x: -330, y: 0 });
  await typedNode(page, 'character', 'ryn').focus(); await page.keyboard.press('ArrowRight');
  const query = page.getByRole('textbox', { name: 'Filter graph', exact: true }); await query.fill('ryn'); await query.press('Enter');
  await switchMode(page, 'mysteries');
  assert.deepEqual(await typedPosition(page, 'character', 'ryn'), { x: -300, y: 70 });
  assert.equal(await page.getByRole('button', { name: 'Remove filter ryn', exact: true }).count(), 0);
  await typedNode(page, 'character', 'ryn').focus(); await page.keyboard.press('Shift+ArrowDown');
  await switchMode(page, 'factions');
  assert.deepEqual(await typedPosition(page, 'character', 'ryn'), { x: -325, y: 0 });
  await page.getByRole('button', { name: 'Remove filter ryn', exact: true }).waitFor();
  await page.reload(); await typedNode(page, 'character', 'ryn').waitFor();
  assert.deepEqual(await typedPosition(page, 'character', 'ryn'), { x: -325, y: 0 });
  assert.equal(await page.evaluate(() => localStorage.getItem('cm_pos_frakce')), legacy);
  await switchMode(page, 'relationships'); assert.deepEqual((await positions(page)).ryn, savedPositions.ryn);
  await switchMode(page, 'mysteries'); assert.deepEqual(await typedPosition(page, 'character', 'ryn'), { x: -300, y: 90 });
  assert.deepEqual(campaign, before);
});

test('shared places and mysteries follow faction visibility and return with exact detail routes', async t => {
  const { page } = await fixture(t, { mixed: true }); await switchMode(page, 'factions');
  await page.getByText('Legend & filters', { exact: true }).click();
  await page.getByRole('checkbox', { name: /The Watch/ }).uncheck();
  await typedNode(page, 'location', 'outpost').waitFor({ state: 'detached' }); await typedNode(page, 'location', 'gate').waitFor();
  await page.getByRole('checkbox', { name: /Explorers Guild/ }).uncheck(); await typedNode(page, 'location', 'gate').waitFor({ state: 'detached' });
  await switchMode(page, 'mysteries');
  // The same component retains the open legend while loading this mode's filters.
  await page.getByRole('checkbox', { name: /The Watch/ }).uncheck(); await typedNode(page, 'mystery', 'veil').waitFor({ state: 'detached' });
  await typedNode(page, 'mystery', 'gate').waitFor();
  await page.getByRole('checkbox', { name: /Explorers Guild/ }).uncheck(); await typedNode(page, 'mystery', 'gate').waitFor({ state: 'detached' });
  await typedNode(page, 'mystery', 'unresolved').waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await typedNode(page, 'mystery', 'gate').focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: '↗ Open detail', exact: true }).click(); await page.waitForURL(/#\/mysteries\/gate$/);
});

test('same IDs in different collections keep separate cards, links and saved positions', async t => {
  const { page } = await fixture(t, { mixed: true });
  await publish(page, () => {
    collection('characters').records.push({ key: 'gate', revision: 1, value: { name: 'Gatekeeper', knowledge: 4, faction: 'watch' } });
    collection('mysteries').records[0].value.characters.push('gate');
  });
  await switchMode(page, 'mysteries');
  const mystery = typedNode(page, 'mystery', 'gate'), character = typedNode(page, 'character', 'gate');
  const mysteryBefore = await typedPosition(page, 'mystery', 'gate'), characterBefore = await typedPosition(page, 'character', 'gate');
  assert.notDeepEqual(mysteryBefore, characterBefore);
  await character.focus(); await page.keyboard.press('ArrowRight');
  assert.deepEqual(await typedPosition(page, 'mystery', 'gate'), mysteryBefore);
  await page.reload(); await mystery.waitFor();
  assert.deepEqual(await typedPosition(page, 'character', 'gate'), { x: characterBefore.x + 5, y: characterBefore.y });
  await character.focus(); await page.keyboard.press('Enter'); await page.waitForURL(/#\/characters\/gate$/);
});

test('route changes and live removal cancel a mixed graph drag without saving it into another mode', async t => {
  const { page } = await fixture(t, { mixed: true }); await switchMode(page, 'factions');
  const rect = await typedNode(page, 'character', 'ryn').boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 20); await page.mouse.down(); await page.mouse.move(rect.x + 80, rect.y + 80, { steps: 4 });
  await page.evaluate(() => { location.hash = '#/graph/mysteries'; }); await typedNode(page, 'mystery', 'gate').waitFor(); await page.mouse.up();
  assert.deepEqual(await typedPosition(page, 'character', 'ryn'), { x: -300, y: 70 });
  assert.equal(await page.evaluate(() => localStorage.getItem('cm_pos_v2_frakce')), null);
  await publish(page, () => { collection('characters').records = collection('characters').records.filter(record => record.key !== 'ryn'); });
  await typedNode(page, 'character', 'ryn').waitFor({ state: 'detached' }); assert.equal(await page.locator('[data-edge-key]').count(), 2);
  await publish(page, () => { collection('mysteries').records = []; }); await page.getByText('No cards to display', { exact: true }).waitFor();
});

for (const reducedMotion of ['reduce', 'no-preference']) test(`touch input arranges a faction card without navigating or mutating content (${reducedMotion})`, async t => {
  const { page, context } = await fixture(t, { mixed: true, mobile: true, reducedMotion }); await switchMode(page, 'factions');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const card = typedNode(page, 'character', 'mira'); await card.waitFor();
  const before = await typedPosition(page, 'character', 'mira'), rect = await card.boundingBox();
  const zoom = await page.locator('codex-campaign-graph').evaluate(graph => graph.zoom);
  const client = await context.newCDPSession(page), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 25, y: y + 30 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => localStorage.getItem('cm_pos_v2_frakce') !== null);
  const after = await typedPosition(page, 'character', 'mira');
  assert.ok(Math.abs(after.x - before.x - 25 / zoom) < 1); assert.ok(Math.abs(after.y - before.y - 30 / zoom) < 1);
  assert.match(page.url(), /#\/graph\/factions$/);
});

test('anonymous Czech readers can use every preserved Mind Palace URL', async t => {
  const { page } = await fixture(t, { mixed: true, role: '', locale: 'cs' });
  for (const [hash, mode] of [['palac', 'factions'], ['frakce', 'factions'], ['tajemstvi', 'mysteries']]) {
    await page.goto(`${origin}/#/mapa/${hash}`); await page.waitForFunction(mode => document.querySelector('codex-campaign-graph')?.mode === mode, mode);
    await page.getByRole('heading', { name: /Myšlenkový palác/ }).waitFor();
    await page.getByRole('region', { name: mode === 'factions' ? 'Graf frakcí' : 'Graf záhad', exact: true }).waitFor();
    assert.equal(await page.locator('.map-mode-btn[aria-current="page"]').textContent(), mode === 'factions' ? 'Frakce' : 'Záhady');
  }
});

async function holdDrag(page, key, dx, dy) {
  const rect = await node(page, key).boundingBox();
  const x = rect.x + 20, y = rect.y + 20;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy);
}
async function waitForRest(page) { await page.locator('.cm-viewport[data-motion="idle"]').waitFor(); }

test('elastic lines bend during pointer movement, save only after settling and sleep at rest', async t => {
  const { page } = await fixture(t, { reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.graphAnimationFrames = 0; const original = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => original.call(window, time => { window.graphAnimationFrames++; callback(time); });
  });
  await holdDrag(page, 'ryn', 40, 150);
  const path = page.locator('[data-edge-key="edge-one"] > path');
  const during = await path.getAttribute('d');
  assert.deepEqual(await positions(page), savedPositions);
  assert.equal(await page.locator('.cm-viewport').getAttribute('data-motion'), 'dragging');
  await page.screenshot({ path: `${output}elastic-drag.png`, animations: 'allow' });
  await page.mouse.up(); await waitForRest(page);
  assert.notEqual(await path.getAttribute('d'), during);
  assert.deepEqual((await positions(page)).ryn, { x: -260, y: -10 });
  assert.deepEqual((await positions(page)).mira, savedPositions.mira);
  assert.deepEqual((await positions(page)).talia, savedPositions.talia);
  const frames = await page.evaluate(() => window.graphAnimationFrames);
  await page.waitForTimeout(100); assert.equal(await page.evaluate(() => window.graphAnimationFrames), frames, 'settled graphs must stop requesting frames');
  await page.reload(); await node(page, 'ryn').waitFor(); await waitForRest(page);
  assert.deepEqual((await positions(page)).ryn, { x: -260, y: -10 });
});

for (const reducedMotion of ['reduce', 'no-preference']) test(`collision movement keeps the dropped point exact and saves displaced cards (${reducedMotion})`, async t => {
  const { page } = await fixture(t, { reducedMotion });
  const before = await node(page, 'mira').boundingBox();
  await holdDrag(page, 'ryn', 330, 0);
  await page.waitForFunction(before => document.querySelector('.cm-node[data-key="mira"]').getBoundingClientRect().x > before.x + 5, before);
  assert.deepEqual(await positions(page), savedPositions);
  await page.mouse.up(); await waitForRest(page);
  const saved = await positions(page);
  assert.deepEqual(saved.ryn, { x: 30, y: -160 });
  assert.ok(saved.mira.x - saved.ryn.x >= 196); assert.deepEqual(saved.talia, savedPositions.talia);
  await page.reload(); await node(page, 'mira').waitFor(); assert.deepEqual(await positions(page), saved);
});

test('Escape restores the complete pre-drag arrangement after other cards have been displaced', async t => {
  const { page } = await fixture(t, { reducedMotion: 'no-preference' });
  const before = await node(page, 'mira').boundingBox();
  await holdDrag(page, 'ryn', 330, 0);
  await page.waitForFunction(before => document.querySelector('.cm-node[data-key="mira"]').getBoundingClientRect().x > before.x + 5, before);
  await page.keyboard.press('Escape'); await page.mouse.up(); await waitForRest(page);
  assert.deepEqual(await positions(page), savedPositions);
  const restored = await node(page, 'mira').boundingBox(); assert.equal(restored.x, before.x); assert.equal(restored.y, before.y);
  await holdDrag(page, 'ryn', 330, 0); await page.mouse.up();
  await page.keyboard.press('Escape'); await waitForRest(page);
  assert.deepEqual(await positions(page), savedPositions, 'Escape also cancels the settling draft');
});

test('a completed drop survives an immediate mode change without writing into the destination layout', async t => {
  const { page } = await fixture(t, { mixed: true, reducedMotion: 'no-preference' }); await switchMode(page, 'factions');
  await holdDrag(page, typedKey('character', 'ryn'), 70, 50); await page.mouse.up();
  await page.evaluate(() => { location.hash = '#/graph/mysteries'; }); await typedNode(page, 'mystery', 'gate').waitFor(); await waitForRest(page);
  assert.deepEqual(await typedPosition(page, 'character', 'ryn'), { x: -300, y: 70 });
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem('cm_pos_v2_frakce'))[key], typedKey('character', 'ryn'));
  assert.deepEqual(saved, { x: -260, y: 50 });
  assert.equal(await page.evaluate(() => localStorage.getItem('cm_pos_v2_tajemstvi')), null);
  await switchMode(page, 'factions'); assert.deepEqual(await typedPosition(page, 'character', 'ryn'), saved);
});

test('live projection changes discard an active motion draft and remove its stale edge controls', async t => {
  const { page } = await fixture(t, { reducedMotion: 'no-preference' }); await holdDrag(page, 'ryn', 330, 0);
  await publish(page, () => { collection('characters').records = collection('characters').records.filter(record => record.key !== 'mira'); });
  await node(page, 'mira').waitFor({ state: 'detached' }); await page.mouse.up(); await waitForRest(page);
  assert.equal(await page.locator('[data-edge-key]').count(), 0); assert.deepEqual(await positions(page), savedPositions);
});

test('another tab wins over post-release settling without a delayed overwrite', async t => {
  const { page, context } = await fixture(t, { reducedMotion: 'no-preference' });
  const second = await context.newPage(); await second.goto(`${origin}/#/graph/relationships`); await node(second, 'ryn').waitFor();
  await holdDrag(page, 'ryn', 330, 0); await page.mouse.up();
  const replacement = { ...savedPositions, ryn: { x: -250, y: 10 } };
  await second.evaluate(value => localStorage.setItem('cm_pos_vztahy', JSON.stringify(value)), replacement);
  await page.locator('.cm-message').filter({ hasText: 'Another tab changed' }).waitFor(); await waitForRest(page);
  await page.waitForTimeout(100);
  assert.deepEqual(await positions(page), replacement);
  assert.deepEqual(await page.locator('codex-campaign-graph').evaluate(graph => Object.fromEntries(graph.positions)), replacement);
});

test('reduced-motion changes and blur finish a released drop but cancel a held one', async t => {
  const { page } = await fixture(t, { reducedMotion: 'no-preference' });
  await holdDrag(page, 'ryn', 330, 0); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.mouse.up(); await waitForRest(page);
  assert.deepEqual((await positions(page)).ryn, { x: 30, y: -160 });
  const saved = await positions(page); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await holdDrag(page, 'ryn', 30, 50); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up(); await waitForRest(page);
  assert.deepEqual(await positions(page), saved);
  await holdDrag(page, 'ryn', -40, -30); await page.mouse.up(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await waitForRest(page);
  assert.deepEqual((await positions(page)).ryn, { x: -10, y: -190 });
});

test('a failed settled save keeps the final arrangement available for retry', async t => {
  const { page } = await fixture(t, { blockedStorage: true, reducedMotion: 'no-preference' });
  await holdDrag(page, 'ryn', 330, 0); await page.mouse.up(); await waitForRest(page);
  await page.locator('.cm-message[role="alert"]').waitFor();
  const settled = await page.locator('codex-campaign-graph').evaluate(graph => Object.fromEntries(graph.positions));
  assert.deepEqual(settled.ryn, { x: 30, y: -160 }); assert.ok(settled.mira.x >= 226);
  assert.deepEqual(await positions(page), savedPositions);
  await page.evaluate(() => { window.graphStorageBlocked = false; }); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.cm-message[role="alert"]').waitFor({ state: 'detached' }); assert.deepEqual(await positions(page), settled);
});

test('hidden faction cards do not collide with the dragged card or change their saved positions', async t => {
  const { page } = await fixture(t, { reducedMotion: 'no-preference' });
  await page.getByText('Legend & filters', { exact: true }).click(); await page.getByRole('checkbox', { name: /The Watch/ }).uncheck();
  await node(page, 'talia').waitFor({ state: 'detached' });
  await holdDrag(page, 'ryn', 640, 350); await page.mouse.up(); await waitForRest(page);
  assert.deepEqual((await positions(page)).ryn, savedPositions.talia);
  assert.deepEqual((await positions(page)).talia, savedPositions.talia);
  assert.deepEqual((await positions(page)).mira, savedPositions.mira);
});

test('leaving during settling saves the drop and does not recreate observers on the detached graph', async t => {
  const { page } = await fixture(t, { reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.detachedGraphObservations = 0; window.departedGraph = document.querySelector('codex-campaign-graph');
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      observe(element, options) {
        if (element.classList.contains('cm-viewport') && !element.isConnected) window.detachedGraphObservations++;
        return super.observe(element, options);
      }
    };
  });
  await holdDrag(page, 'ryn', 330, 0); await page.mouse.up();
  await page.evaluate(() => { location.hash = '#/characters/mira'; }); await page.locator('.record-article').waitFor();
  await page.evaluate(() => window.departedGraph.updateComplete);
  assert.equal(await page.evaluate(() => window.departedGraph.isConnected), false);
  assert.equal(await page.evaluate(() => window.detachedGraphObservations), 0);
  assert.deepEqual((await positions(page)).ryn, { x: 30, y: -160 });
  assert.ok((await positions(page)).mira.x >= 226);
});
