import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { visualCampaign, visualFixturePlugin } from './visual-fixture.mjs';

let server, browser, origin, campaign, sequence = 0;
const streams = new Set();
const artifacts = fileURLToPath(new URL('../../test-results/maps/', import.meta.url));
const imageURL = `/api/media/b_${'1'.repeat(32)}`;
const uploadedURL = `/api/media/b_${'2'.repeat(32)}`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#988363"/><path d="M0 550 Q300 180 640 500 T1280 260" fill="none" stroke="#648894" stroke-width="60"/><path d="M70 300 L230 40 L400 300 M750 190 L870 40 L1000 190" fill="#615945"/><text x="460" y="200" fill="#302615" font-size="46">Synthetic map</text></svg>';
const collection = name => campaign.collections.find(item => item.name === name);
const record = key => collection('locations').records.find(item => item.key === key);
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) { streams.add(response); response.on('close', () => streams.delete(response)); } })],
    preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, { role = 'dm', mobile = false } = {}) {
  campaign = structuredClone(visualCampaign); sequence = 0;
  collection('locations').records = [
    { key: 'gate', revision: 3, value: { id: 'gate', name: 'Northern Gate', x: .25, y: .4, pinType: 'fortress', localMap: imageURL, extension: { keep: true }, visibility: 'public' } },
    { key: 'inn', revision: 1, value: { id: 'inn', name: 'Old Inn', x: .7, y: .6, pinType: 'tavern', visibility: 'public' } },
    { key: 'room', revision: 1, value: { id: 'room', name: 'Upper Room', parentId: 'gate', x: .5, y: .5, visibility: 'public' } },
    { key: 'unplaced', revision: 1, value: { id: 'unplaced', name: 'Unplaced town', visibility: 'public' } },
  ];
  collection('settings').records.push({ key: 'mapViews', revision: 4, value: [
    { id: 'gate-view', label: 'Gate interior', parentId: 'gate', icon: '📍', bounds: { x1: 0, y1: 0, x2: .8, y2: .8 }, extension: true },
  ] });
  collection('events').records = [
    { key: 'travel', revision: 1, value: { id: 'travel', name: 'Road to the inn', sitting: 2, locations: ['gate', 'inn', 'missing', 'room'] } },
    { key: 'arrival', revision: 1, value: { id: 'arrival', name: 'Camp by the river', sitting: 1, mapX: .48, mapY: .35, locations: ['gate'] } },
    { key: 'past', revision: 1, value: { id: 'past', name: 'The old gate', locations: ['gate'] } },
    { key: 'local-event', revision: 1, value: { id: 'local-event', name: 'Inside the gate', sitting: 3, mapParentId: 'gate', mapX: .25, mapY: .25, locations: ['room'] } },
  ];
  const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, extraHTTPHeaders: { 'x-fixture-role': role } });
  t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const errors = [], writes = [], uploads = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser errors'));
  let latest = imageURL;
  await page.route('**/api/media/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') {
      assert.equal(request.headers()['x-codex-csrf'], 'x'.repeat(32));
      uploads.push(url.pathname);
      latest = uploadedURL;
      const [, , , kind, target] = url.pathname.split('/');
      return route.fulfill({ json: blob(latest, kind, target) });
    }
    if (url.pathname.startsWith('/api/media/latest/')) return route.fulfill({ json: blob(latest, 'world-map', 'main') });
    return route.fulfill({ contentType: 'image/svg+xml', body: svg });
  });
  await page.route('**/api/campaign/transactions', async route => {
    const request = route.request(), body = request.postDataJSON();
    assert.equal(request.headers()['x-codex-csrf'], 'x'.repeat(32));
    assert.equal(body.contractVersion, 'campaign-mutation.v1');
    writes.push(body.mutations);
    const results = [], revisions = {};
    for (const mutation of body.mutations) {
      const target = collection(mutation.collection), index = target.records.findIndex(item => item.key === mutation.key);
      assert.equal(mutation.expectedRevision, index < 0 ? 0 : target.records[index].revision);
      const updated = { key: mutation.key, revision: mutation.expectedRevision + 1, value: mutation.value };
      if (index < 0) target.records.push(updated); else target.records[index] = updated;
      revisions[target.name] = ++target.revision;
      results.push({ collection: target.name, key: updated.key, beforeRevision: mutation.expectedRevision, afterRevision: updated.revision, deleted: false });
    }
    await route.fulfill({ json: { contractVersion: 'campaign-commit.v1', commitId: writes.length,
      occurredAt: '2026-09-05T12:00:00Z', results, collectionRevisions: revisions } });
  });
  await page.goto(`${origin}/#/map/world`);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).waitFor();
  return { page, writes, uploads };
}
function blob(url, kind, target) { return { contractVersion: 'media-blob.v1', id: url.split('/').at(-1), url, kind, target,
  mediaType: 'image/svg+xml', bytes: svg.length, revision: 1, createdAt: '2026-09-05T12:00:00Z' }; }
async function changed(page, resource = 'locations') {
  const refresh = page.waitForResponse(response => response.url() === `${origin}/api/campaign`);
  const payload = { sequence: ++sequence, topic: 'campaign-data-changed', resourceId: resource, revision: String(++collection(resource).revision),
    occurredAt: '2026-09-05T12:00:00Z', metadata: { commitId: sequence, records: 1 } };
  for (const stream of streams) stream.write(`id: ${sequence}\nevent: campaign-data-changed\ndata: ${JSON.stringify(payload)}\n\n`);
  await refresh;
}
const marker = (page, name) => page.locator(`.sc-marker[title="${name}"]`);

for (const mobile of [false, true]) {
  test(`world/local map navigation and original controls (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page } = await fixture(t, { role: '', mobile });
    assert.equal(await page.locator('.sc-marker').count(), 2);
    const image = await page.locator('.leaflet-image-layer').boundingBox(), pin = await marker(page, 'Northern Gate').boundingBox();
    assert.ok(Math.abs(pin.x + pin.width / 2 - image.x - image.width * .25) < 2);
    assert.ok(Math.abs(pin.y + pin.height / 2 - image.y - image.height * .4) < 2);
    const zoom = Number(await page.getByRole('slider', { name: 'Map zoom' }).inputValue());
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(previous => Number(document.querySelector('.sc-zoom-slider-vertical').value) > previous, zoom);
    await page.getByRole('button', { name: 'Whole map', exact: false }).click();
    assert.equal(await page.getByRole('button', { name: 'Edit map', exact: false }).count(), 0);
    const visual = await page.locator('.sc-toolbar').evaluate(node => ({ padding: getComputedStyle(node).padding, background: getComputedStyle(node).backgroundColor }));
    assert.equal(visual.background, 'rgb(20, 16, 8)');
    assert.equal(visual.padding, mobile ? '8px' : '8px 16px');
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-world.png`, animations: 'disabled' });
    await marker(page, 'Northern Gate').focus(); await page.keyboard.press('Enter');
    await page.getByRole('link', { name: 'Local map', exact: true }).click();
    await marker(page, 'Upper Room').waitFor();
    assert.equal(await page.locator('.sc-marker').count(), 1);
    await page.getByRole('button', { name: '📍 Gate interior', exact: true }).waitFor();
    if (mobile) {
      await page.locator('[data-menu-toggle]').click();
      assert.equal(await page.locator('main').evaluate(node => node.inert), true);
      await page.keyboard.press('Escape');
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-local.png`, animations: 'disabled' });
  });
}

test('coordinate drafts survive live refresh and stale saves without changing other fields', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  await marker(page, 'Northern Gate').click();
  await page.getByRole('button', { name: 'Edit position', exact: true }).click();
  await page.getByLabel('Horizontal position (%)').fill('55');
  record('gate').revision++; record('gate').value.x = .3;
  await changed(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.sc-message').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(Number(await page.getByLabel('Horizontal position (%)').inputValue()), 55);
  assert.equal(writes.length, 0);
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Control+k');
  await page.waitForURL(/#\/map\/world$/);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await marker(page, 'Northern Gate').click();
  await page.getByRole('button', { name: 'Edit position', exact: true }).click();
  await page.getByLabel('Horizontal position (%)').fill('60');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.sc-panel form').waitFor({ state: 'detached' });
  assert.equal(writes[0][0].expectedRevision, 4);
  assert.deepEqual(record('gate').value.extension, { keep: true });
  assert.equal(record('gate').value.x, .6);
});

test('marker dragging creates a reviewable draft and unplacing preserves the location', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  const pin = await marker(page, 'Northern Gate').boundingBox();
  await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2);
  await page.mouse.down();
  await page.mouse.move(pin.x + pin.width / 2 + 70, pin.y + pin.height / 2 + 30, { steps: 12 });
  await page.mouse.up();
  await page.getByLabel('Horizontal position (%)').waitFor();
  assert.ok(Number(await page.getByLabel('Horizontal position (%)').inputValue()) > 25);
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.sc-panel form').waitFor({ state: 'detached' });
  assert.equal(writes.length, 1);
  await marker(page, 'Northern Gate').click();
  await page.getByRole('button', { name: 'Edit position', exact: true }).click();
  await page.getByRole('button', { name: 'Remove from map', exact: true }).click();
  await marker(page, 'Northern Gate').waitFor({ state: 'detached' });
  assert.equal(record('gate').value.x, undefined);
  assert.deepEqual(record('gate').value.extension, { keep: true });
});

test('players can create and place locations without shared map administration', async t => {
  const { page, writes } = await fixture(t, { role: 'player' });
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  assert.equal(await page.getByLabel('Upload map image').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save view', exact: false }).count(), 0);
  await page.getByRole('button', { name: 'Add place', exact: false }).click();
  const box = await page.locator('.leaflet-image-layer').boundingBox();
  await page.mouse.click(box.x + box.width * .4, box.y + box.height * .6);
  await page.getByLabel('Name', { exact: true }).fill('New camp');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await marker(page, 'New camp').waitFor();
  assert.equal(writes[0][0].value.parentId, null);
  assert.equal(writes[0][0].value.visibility, 'public');
  await page.getByLabel('Place existing location…').selectOption('unplaced');
  await page.mouse.click(box.x + box.width * .3, box.y + box.height * .3);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await marker(page, 'Unplaced town').waitFor();
  assert.equal(writes[1][0].expectedRevision, 1);
});

test('saved views and local map upload use the existing optimistic records and media API', async t => {
  const { page, writes, uploads } = await fixture(t);
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  await page.getByRole('button', { name: 'Save view', exact: false }).click();
  await page.getByLabel('Name this map view').fill('Northern coast');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: '📍 Northern coast', exact: true }).waitFor();
  assert.equal(writes[0][0].expectedRevision, 4);
  assert.equal(writes[0][0].value[0].extension, true);
  await page.goto(`${origin}/#/map/local/unplaced`);
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  await page.getByLabel('Upload map image').setInputFiles({ name: 'local-map.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).waitFor();
  assert.deepEqual(uploads, ['/api/media/location-map/unplaced']);
  assert.equal(record('unplaced').value.localMap, uploadedURL);
  assert.equal(record('unplaced').value.name, 'Unplaced town');
});

for (const mobile of [false, true]) {
  test(`event paths retain original geometry, style and map scope (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { role: '', mobile });
    const toggle = page.getByRole('button', { name: 'Event paths', exact: false });
    assert.equal(await page.locator('.sc-event-pin').count(), 0);
    await toggle.click();
    await page.locator('.sc-event-pin').first().waitFor();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.locator('.sc-event-pin').evaluateAll(nodes => nodes.map(node => node.title)),
      ['The old gate', 'Camp by the river', 'Road to the inn', 'Road to the inn']);
    assert.equal(await page.locator('.sc-event-path').count(), 3);
    const pin = page.locator('.sc-event-pin[title="Camp by the river"]');
    await page.waitForFunction(() => {
      const image = document.querySelector('.leaflet-image-layer').getBoundingClientRect();
      const pin = document.querySelector('.sc-event-pin[title="Camp by the river"]').getBoundingClientRect();
      return Math.abs(pin.x + pin.width / 2 - image.x - image.width * .48) < 2 &&
        Math.abs(pin.y + pin.height / 2 - image.y - image.height * .35) < 2;
    });
    const style = await pin.locator('.sc-event-marker').evaluate(node => ({ background: getComputedStyle(node).backgroundColor,
      radius: getComputedStyle(node).borderRadius, width: getComputedStyle(node).width, text: node.textContent }));
    assert.deepEqual(style, { background: 'rgb(139, 105, 20)', radius: '50%', width: '28px', text: 'S1' });
    assert.equal(await page.locator('.sc-event-path').first().getAttribute('stroke'), '#C8A040');
    assert.equal(await page.locator('.sc-event-path').first().getAttribute('stroke-dasharray'), '7, 5');
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-events.png`, animations: 'disabled' });
    collection('events').records = collection('events').records.filter(item => item.key !== 'past');
    await changed(page, 'events');
    await page.locator('.sc-event-pin[title="The old gate"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.sc-event-pin').count(), 3);
    await toggle.click();
    await page.locator('.sc-event-pin').first().waitFor({ state: 'detached' });
    assert.equal(await page.locator('.sc-event-path').count(), 0);
    await toggle.click();
    await pin.focus(); await page.keyboard.press('Enter');
    await page.waitForURL(/#\/events\/arrival$/);
    await page.locator('.leaflet-container').waitFor({ state: 'detached' });
    await page.goto(`${origin}/#/map/local/gate`);
    await marker(page, 'Upper Room').waitFor();
    await page.getByRole('button', { name: 'Event paths', exact: false }).click();
    await page.locator('.sc-event-pin').first().waitFor();
    assert.deepEqual(await page.locator('.sc-event-pin').evaluateAll(nodes => nodes.map(node => node.title)), ['Road to the inn', 'Inside the gate']);
    assert.equal(await page.locator('.sc-event-path').count(), 1);
    assert.equal(writes.length, 0);
  });

  test(`saved-view drafts preserve revisions, extension fields and other map scopes (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { mobile });
    await page.goto(`${origin}/#/map/local/gate`);
    await marker(page, 'Upper Room').waitFor();
    await page.getByRole('button', { name: 'Edit map', exact: false }).click();
    await page.getByRole('button', { name: 'Edit view: Gate interior', exact: true }).click();
    await page.getByLabel('Name this map view').fill('Upper floor');
    await page.getByLabel('View icon', { exact: true }).fill('🏰');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Use current map area', exact: true }).click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.keyboard.press('Control+k');
    await page.waitForURL(/#\/map\/local\/gate$/);
    assert.equal(await page.getByLabel('Name this map view').inputValue(), 'Upper floor');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-view-editor.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: '🏰 Upper floor', exact: true }).waitFor();
    const views = collection('settings').records.find(item => item.key === 'mapViews');
    assert.equal(writes.length, 1);
    assert.equal(views.value[0].id, 'gate-view');
    assert.equal(views.value[0].extension, true);
    assert.notDeepEqual(views.value[0].bounds, { x1: 0, y1: 0, x2: .8, y2: .8 });
    await page.getByRole('button', { name: 'Edit view: Upper floor', exact: true }).click();
    await page.getByLabel('Name this map view').fill('Draft name');
    views.revision++;
    const remote = { id: 'world-view', label: 'Remote world view', parentId: null, icon: '📍', bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, extra: true };
    views.value.push(remote);
    await changed(page, 'settings');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.sc-message').filter({ hasText: 'Your draft is kept' }).waitFor();
    assert.equal(await page.getByLabel('Name this map view').inputValue(), 'Draft name');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete view', exact: true }).click();
    assert.equal(writes.length, 1, 'stale deletion must not write');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Edit view: Upper floor', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete view', exact: true }).click();
    await page.getByLabel('Name this map view').waitFor({ state: 'detached' });
    assert.equal(writes.length, 2);
    assert.equal(writes[1][0].expectedRevision, 6);
    assert.deepEqual(collection('settings').records.find(item => item.key === 'mapViews').value, [remote]);
  });
}
