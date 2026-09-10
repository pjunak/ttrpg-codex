import { required, fixtureCollection, fixtureRecord } from './fixture-types.mts';
import type { Browser, Page } from 'playwright';
import type { TestContext } from 'node:test';
import type { PreviewServer } from 'vite';
import type { AddressInfo } from 'node:net';
import type { FixtureCampaign, FixtureMutation } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { visualCampaign, visualFixturePlugin } from './visual-fixture.mts';

let server: PreviewServer, browser: Browser, origin: string, campaign: FixtureCampaign, sequence = 0;
const streams = new Set<import("node:http").ServerResponse>();
const artifacts = fileURLToPath(new URL('../../test-results/maps/', import.meta.url));
const imageURL = `/api/media/b_${'1'.repeat(32)}`;
const uploadedURL = `/api/media/b_${'2'.repeat(32)}`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#988363"/><path d="M0 550 Q300 180 640 500 T1280 260" fill="none" stroke="#648894" stroke-width="60"/><path d="M70 300 L230 40 L400 300 M750 190 L870 40 L1000 190" fill="#615945"/><text x="460" y="200" fill="#302615" font-size="46">Synthetic map</text></svg>';
const collection = (name: string) => fixtureCollection(campaign, name);
const record = (key: string) => fixtureRecord(collection('locations'), key);
const eventRecord = (key: string) => fixtureRecord(collection('events'), key);
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) { streams.add(response); response.on('close', () => streams.delete(response)); } })],
    preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t: TestContext, { role = 'dm', mobile = false, tiled = false, tileFailure = false } = {}) {
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
  collection('settings').records.push({ key: 'mapConfigs', revision: 3, value: {
    world: { zoomScaleRatio: 0, extension: true }, 'local-gate': { zoomScaleRatio: .5, extra: { keep: true } },
  } });
  collection('events').records = [
    { key: 'travel', revision: 1, value: { id: 'travel', name: 'Road to the inn', sitting: 2, locations: ['gate', 'inn', 'missing', 'room'] } },
    { key: 'arrival', revision: 1, value: { id: 'arrival', name: 'Camp by the river', sitting: 1, mapX: .48, mapY: .35, locations: ['gate'] } },
    { key: 'past', revision: 1, value: { id: 'past', name: 'The old gate', locations: ['gate'], extension: { keep: true } } },
    { key: 'local-event', revision: 1, value: { id: 'local-event', name: 'Inside the gate', sitting: 3, mapParentId: 'gate', mapX: .25, mapY: .25, locations: ['room'] } },
  ];
  const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, extraHTTPHeaders: { 'x-fixture-role': role } });
  t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const errors: string[] = [], writes: FixtureMutation[][] = [], uploads: string[] = [], mediaReads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser errors'));
  let latest = imageURL;
  await page.route('**/api/media/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'GET') mediaReads.push(url.pathname);
    if (url.pathname.endsWith('/tiles/v1/manifest')) return tiled
      ? route.fulfill({ json: { contractVersion: 'map-tiles.v1', id: url.pathname.split('/')[3], width: 1280, height: 800, tileSize: 256, depth: 3 } })
      : route.fulfill({ status: 415, json: { error: 'Use original image' } });
    const tile = /\/tiles\/v1\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (tile) {
      if (tileFailure) return route.fulfill({ status: 503, json: { error: 'Tile unavailable' } });
      const [, level, x, y] = tile.map(Number), scale = 2 ** (3 - level);
      const body = svg.replace('width="1280" height="800"', `width="257" height="257" viewBox="${x*256*scale} ${y*256*scale} ${257*scale} ${257*scale}"`)
        .replace('><rect', '><defs><clipPath id="source-bounds"><rect width="1280" height="800"/></clipPath></defs><g clip-path="url(#source-bounds)"><rect')
        .replace('</svg>', '</g></svg>');
      return route.fulfill({ contentType: 'image/svg+xml', body });
    }
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
    const results = [], revisions: Record<string, number> = {};
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
  return { page, writes, uploads, mediaReads };
}
function blob(url: string, kind: string, target: string) { return { contractVersion: 'media-blob.v1', id: url.split('/').at(-1), url, kind, target,
  mediaType: 'image/svg+xml', bytes: svg.length, revision: 1, createdAt: '2026-09-05T12:00:00Z' }; }
async function changed(page: Page, resource = 'locations') {
  const refresh = page.waitForResponse(response => response.url() === `${origin}/api/campaign`);
  const payload = { sequence: ++sequence, topic: 'campaign-data-changed', resourceId: resource, revision: String(++collection(resource).revision),
    occurredAt: '2026-09-05T12:00:00Z', metadata: { commitId: sequence, records: 1 } };
  for (const stream of streams) stream.write(`id: ${sequence}\nevent: campaign-data-changed\ndata: ${JSON.stringify(payload)}\n\n`);
  await refresh;
}
const marker = (page: Page, name: string) => page.locator(`.sc-marker[title="${name}"]`);
const eventMarker = (page: Page, name: string) => page.locator(`.sc-event-pin[title="${name}"]`);
async function chooseEventPoint(page: Page, mobile = false) {
  const box = await page.locator('.sc-map').boundingBox().then(required);
  await page.locator('.sc-map').click({ position: { x: mobile ? 85 : 400, y: box.height * .65 } });
  await page.getByLabel('Horizontal position (%)').waitFor();
}
async function setScale(page: Page, value: number) {
  const slider = page.getByRole('slider', { name: 'Marker scaling with zoom', exact: true });
  await slider.fill(String(value));
}

for (const mobile of [false, true]) {
  test(`location fields and article links share map placement and local image editing (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes, uploads } = await fixture(t, { role: 'player', mobile });
    record('inn').value.localMap = imageURL;
    collection('settings').records.push({ key: 'pinTypes', revision: 1, value: [{ id: 'town', label: 'Town', size: 28 }] });
    await changed(page, 'settings');
    await page.goto(`${origin}/#/locations/gate`);
    const show = page.getByRole('link', { name: 'Show on map', exact: true });
    assert.match(await show.getAttribute('href').then(required), /#\/map\/world\/location\/gate\/show$/);
    await show.click();
    await page.getByRole('complementary', { name: 'Map location', exact: true }).waitFor();
    assert.equal(writes.length, 0);
    await page.goto(`${origin}/#/locations/gate`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.locator('.record-editor');
    await form.locator('[name="pinType"]').selectOption('town');
    await form.locator('[name="size"]').fill('42');
    await form.locator('[name="parentId"]').selectOption('inn');
    page.once('dialog', dialog => dialog.dismiss());
    await form.getByRole('link', { name: 'Local map', exact: true }).click();
    assert.equal(await form.locator('[name="size"]').inputValue(), '42', 'refusing navigation retains the form');
    assert.equal(await form.locator('.location-map-preview').getAttribute('src'), imageURL);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-location-fields.png`, fullPage: true, animations: 'disabled' });
    await form.getByRole('button', { name: 'Save entry', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    assert.equal(writes.length, 1);
    assert.equal(record('gate').value.pinType, 'town'); assert.equal(record('gate').value.size, 42);
    assert.equal(record('gate').value.parentId, 'inn');
    assert.equal(record('gate').value.x, undefined); assert.equal(record('gate').value.y, undefined);
    assert.equal(record('gate').value.localMap, imageURL); assert.deepEqual(record('gate').value.extension, { keep: true });
    const place = page.getByRole('link', { name: 'Place location pin', exact: true });
    assert.match(await place.getAttribute('href').then(required), /#\/map\/local\/inn\/location\/gate\/place$/);
    await place.click();
    await page.getByRole('complementary', { name: 'Map location', exact: true }).waitFor();
    await chooseEventPoint(page, mobile);
    await page.getByLabel('Horizontal position (%)').fill('31.25');
    await page.getByLabel('Vertical position (%)').fill('62.5');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByLabel('Horizontal position (%)').waitFor({ state: 'detached' });
    assert.equal(writes[1][0].expectedRevision, 4);
    assert.equal(record('gate').value.x, .3125); assert.equal(record('gate').value.y, .625);
    const pin = marker(page, 'Northern Gate'); await pin.waitFor();
    assert.equal(await pin.evaluate(node => node.style.width), '42px');
    await page.goto(`${origin}/#/locations/gate`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.record-editor').getByRole('link', { name: 'Local map', exact: true }).click();
    await page.waitForURL(/#\/map\/local\/gate$/);
    await page.getByRole('button', { name: 'Edit map', exact: false }).click();
    await page.getByLabel('Upload map image').setInputFiles({ name: 'interior.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.sc-map .leaflet-image-layer')?.getAttribute('src')?.includes('b_2222'));
    assert.equal(uploads.length, 1); assert.equal(record('gate').value.localMap, uploadedURL);
    assert.equal(record('gate').value.x, .3125); assert.equal(record('gate').value.size, 42);
  });
  test(`tiled maps preserve image coordinates and original controls (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes, mediaReads } = await fixture(t, { mobile, tiled: true });
    await page.waitForFunction(() => {
      const tiles = [...document.querySelectorAll('.leaflet-tile')];
      return tiles.length > 0 && tiles.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0 && Number(getComputedStyle(image).opacity) === 1);
    });
    assert.equal(await page.locator('.leaflet-image-layer').count(), 0);
    assert.equal(mediaReads.includes(imageURL), false, 'a tiled map must not download the full original');
    const rendered = page.locator('.leaflet-tile[src$="/0/0"]').first();
    const originTile = await rendered.boundingBox().then(required);
    assert.equal(await rendered.evaluate(node => getComputedStyle(node).mixBlendMode), 'normal');
    const level = Number((await rendered.getAttribute('src').then(required)).match(/v1\/(\d+)/)![1]);
    const pixelScale = originTile.width / 257 / 2 ** (3 - level);
    const pin = await marker(page, 'Northern Gate').boundingBox().then(required);
    assert.ok(Math.abs(pin.x + pin.width / 2 - originTile.x - 1280 * .25 * pixelScale) < 2);
    assert.ok(Math.abs(pin.y + pin.height / 2 - originTile.y - 800 * .4 * pixelScale) < 2);
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-tiled-map.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Actual image size', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.equal(await page.getByRole('slider', { name: 'Map zoom', exact: true }).inputValue(), '0.5');
    assert.ok((await page.locator('.leaflet-tile').evaluateAll(nodes => nodes.map(node => Number((node as HTMLImageElement).src.match(/v1\/(\d+)/)![1])))).every(level => level <= 3));
    await page.goto(`${origin}/#/map/local/gate`);
    await marker(page, 'Upper Room').waitFor();
    assert.equal(await page.locator('.leaflet-image-layer').count(), 0);
    record('gate').value.localMap = uploadedURL; record('gate').revision++;
    await changed(page, 'locations');
    await page.locator(`.leaflet-tile[src^="${uploadedURL}/tiles/"]`).first().waitFor();
    assert.equal(await page.locator(`.leaflet-tile[src^="${imageURL}/tiles/"]`).count(), 0, 'replacement must never mix old and new tile generations');
    assert.equal(mediaReads.includes(uploadedURL), false);
    assert.equal(writes.length, 0);
  });
  test(`attitude glows keep the original diagonal marker bands (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { mobile, role: 'player' });
    collection('settings').records.push({ key: 'attitudes', revision: 1, value: [
      { id: 'ally', label: 'Ally', labelColor: '#40d080', strength: .7 },
      { id: 'danger', label: 'Danger', labelColor: '#ed4264', strength: 1 },
      { id: 'muted', label: 'Muted', labelColor: '#0000ff', strength: 0 },
    ] }, { key: 'playerParty', revision: 1, value: { color: '#f4b942' } },
    { key: 'pinTypes', revision: 1, value: [{ id: 'gem', icon: '💎', size: 48 }] });
    record('gate').value.attitudes = [{ id: 'ally', strength: 0 }, { id: 'muted' }, { id: 'unknown' }, { id: 'danger' }];
    record('inn').value.pinType = 'gem';
    record('inn').value.attitudes = [{ id: 'ally' }, { id: 'danger' }, { id: 'party' }];
    record('room').value.attitudes = [{ id: 'ally' }];
    await changed(page, 'settings');
    await marker(page, 'Northern Gate').locator('.sc-pin-icon-segment').nth(1).waitFor();
    await marker(page, 'Old Inn').locator('.sc-pin-emoji-segment').nth(2).waitFor();
    const layers = await marker(page, 'Northern Gate').locator('.sc-pin-icon-segment').evaluateAll(nodes => nodes.map(node => ({
      filter: getComputedStyle(node).filter, clip: getComputedStyle(node).clipPath,
      pointer: getComputedStyle(node).pointerEvents, draggable: (node as HTMLElement).draggable,
    })));
    assert.match(layers[0].filter, /rgba\(64, 208, 128, 0.7\) 0px 0px 8px/);
    assert.doesNotMatch(layers[0].filter, /237, 66, 100/);
    assert.match(layers[1].filter, /rgb\(237, 66, 100\) 0px 0px 8px/);
    assert.deepEqual(layers.map(layer => layer.clip), [
      'polygon(-100% -100%, 147.5% -100%, -47.5% 200%, -100% 200%)',
      'polygon(147.5% -100%, 200% -100%, 200% 200%, -47.5% 200%)',
    ]);
    assert.ok(layers.every(layer => layer.pointer === 'none' && layer.draggable === false));
    assert.equal(await marker(page, 'Northern Gate').locator('.sc-pin').evaluate(node => getComputedStyle(node).filter), 'none');
    assert.equal(await marker(page, 'Old Inn').locator('.sc-pin-emoji-segment').first().evaluate(node => getComputedStyle(node).fontSize), '41px');
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-attitude-glows.png`, animations: 'disabled' });
    await marker(page, 'Northern Gate').focus(); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Northern Gate', exact: true }).waitFor();
    await page.goto(`${origin}/#/map/local/gate`);
    const local = marker(page, 'Upper Room');
    await local.locator('.sc-pin-icon').waitFor();
    assert.equal(await local.locator('[class$="-segment"]').count(), 0);
    assert.match(await local.locator('.sc-pin-icon').evaluate(node => getComputedStyle(node).filter), /64, 208, 128/);
    await page.getByRole('button', { name: 'Actual image size', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(() => Math.abs(Number(document.querySelector<HTMLElement>('.sc-pin')!.style.getPropertyValue('--sc-pin-base-scale')) - 2 ** .25) < .001);
    const definitions = fixtureRecord<{ strength: number; [key: string]: unknown }[]>(collection('settings'), 'attitudes');
    definitions.value[0].strength = 0; definitions.revision++;
    await changed(page, 'settings');
    await page.waitForFunction(() => !getComputedStyle(document.querySelector<HTMLElement>('.sc-pin-icon')!).filter.includes('64, 208, 128'));
    assert.equal(await local.locator('.sc-pin-icon').evaluate(node => (getComputedStyle(node).filter.match(/drop-shadow/g) ?? []).length), 2, 'an unknown or zero-strength stance keeps only the original dark outline');
    assert.equal(writes.length, 0);
  });
  test(`map preferences preserve map scope and apply marker scaling (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { mobile });
    await page.getByRole('button', { name: 'Edit map', exact: false }).click();
    await page.getByRole('link', { name: 'Maps', exact: false }).click();
    await page.waitForURL(/#\/settings\/maps$/);
    await page.getByAltText('Map image preview', { exact: true }).waitFor();
    await setScale(page, 1);
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-map-settings.png`, animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-map-config button[type="submit"]')!.disabled);
    assert.equal(writes.length, 1);
    const config = fixtureRecord<Record<string, { zoomScaleRatio: number; [key: string]: unknown }>>(collection('settings'), 'mapConfigs');
    assert.deepEqual(config.value.world, { zoomScaleRatio: 1, extension: true });
    assert.deepEqual(config.value['local-gate'], { zoomScaleRatio: .5, extra: { keep: true } });
    await page.getByRole('link', { name: 'Open map', exact: true }).click();
    await marker(page, 'Northern Gate').waitFor();
    const zoomSlider = page.getByRole('slider', { name: 'Map zoom', exact: true });
    await page.getByRole('button', { name: 'Actual image size', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.equal(Number(await zoomSlider.inputValue()), .5);
    await page.waitForFunction(() => Math.abs(Number(document.querySelector<HTMLElement>('.sc-pin')!.style.getPropertyValue('--sc-pin-base-scale')) - Math.sqrt(2)) < .001);
    await page.getByRole('button', { name: 'Whole map', exact: false }).click();
    const min = Number(await zoomSlider.getAttribute('min'));
    assert.equal(Number(await zoomSlider.inputValue()), min);
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    assert.equal(Number(await zoomSlider.inputValue()), min, 'zoom-out is bounded by the image fit');
    await page.goto(`${origin}/#/map/local/gate`);
    await marker(page, 'Upper Room').waitFor();
    await page.getByRole('button', { name: 'Actual image size', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(() => Math.abs(Number(document.querySelector<HTMLElement>('.sc-pin')!.style.getPropertyValue('--sc-pin-base-scale')) - 2 ** .25) < .001);
    await page.getByRole('button', { name: 'Edit map', exact: false }).click();
    await page.getByRole('link', { name: 'Maps', exact: false }).click();
    await page.waitForURL(/#\/settings\/maps\/local\/gate$/);
    assert.equal(await page.getByRole('slider', { name: 'Marker scaling with zoom' }).inputValue(), '0.5');
    await page.getByText('📍 Gate interior', { exact: true }).waitFor();
  });
  test(`event articles place, edit and remove pins without losing event data (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { role: 'player', mobile });
    await page.goto(`${origin}/#/events/past`);
    await page.getByRole('link', { name: 'Place event pin', exact: true }).click();
    await page.waitForURL(/#\/map\/world\/event\/past\/place$/);
    await page.getByRole('complementary', { name: 'Event map position', exact: true }).waitFor();
    assert.equal(writes.length, 0);
    await chooseEventPoint(page, mobile);
    await page.getByLabel('Horizontal position (%)').fill('41.25');
    await page.getByLabel('Vertical position (%)').fill('62.5');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-event-editor.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('complementary', { name: 'Event map position', exact: true }).waitFor({ state: 'detached' });
    assert.equal(writes.length, 1);
    assert.equal(eventRecord('past').value.mapX, .4125);
    assert.equal(eventRecord('past').value.mapY, .625);
    assert.equal(eventRecord('past').value.mapParentId, null);
    assert.deepEqual(eventRecord('past').value.locations, ['gate']);
    assert.deepEqual(eventRecord('past').value.extension, { keep: true });
    await page.goto(`${origin}/#/events/past`);
    await page.getByRole('link', { name: 'Show on map', exact: true }).click();
    const pin = eventMarker(page, 'The old gate');
    await pin.waitFor();
    assert.equal(await page.getByRole('complementary', { name: 'Event map position', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Edit map', exact: false }).click();
    await pin.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.getByLabel('Horizontal position (%)').inputValue(), '41.25');
    await page.getByLabel('Horizontal position (%)').fill('45');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('complementary', { name: 'Event map position', exact: true }).waitFor({ state: 'detached' });
    assert.equal(eventRecord('past').value.mapX, .45);
    await pin.focus(); await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Remove event pin', exact: true }).click();
    await page.getByRole('complementary', { name: 'Event map position', exact: true }).waitFor({ state: 'detached' });
    assert.equal(writes.length, 3);
    assert.equal(eventRecord('past').value.mapX, undefined);
    assert.equal(eventRecord('past').value.mapY, undefined);
    assert.equal(eventRecord('past').value.mapParentId, undefined);
    assert.deepEqual(eventRecord('past').value.locations, ['gate']);
    assert.deepEqual(eventRecord('past').value.extension, { keep: true });
    await pin.waitFor();
    assert.equal(await pin.count(), 1, 'removing an explicit pin restores its linked-location marker');
  });
  test(`world/local map navigation and original controls (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page } = await fixture(t, { role: '', mobile });
    assert.equal(await page.locator('.sc-marker').count(), 2);
    const image = await page.locator('.leaflet-image-layer').boundingBox().then(required), pin = await marker(page, 'Northern Gate').boundingBox().then(required);
    assert.ok(Math.abs(pin.x + pin.width / 2 - image.x - image.width * .25) < 2);
    assert.ok(Math.abs(pin.y + pin.height / 2 - image.y - image.height * .4) < 2);
    const zoom = Number(await page.getByRole('slider', { name: 'Map zoom' }).inputValue());
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(previous => Number(document.querySelector<HTMLInputElement>('.sc-zoom-slider-vertical')!.value) > previous, zoom);
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
      assert.equal(await page.locator('main').evaluate(node => (node as HTMLElement).inert), true);
      await page.keyboard.press('Escape');
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${artifacts}${mobile ? 'mobile' : 'desktop'}-local.png`, animations: 'disabled' });
  });
}

for (const change of ['edit', 'move', 'delete']) {
  test(`location placement retains the opening revision before a remote ${change}`, async t => {
    const { page, writes } = await fixture(t, { role: 'player' });
    await page.goto(`${origin}/#/map/world/location/unplaced/place`);
    await page.getByRole('complementary', { name: 'Map location', exact: true }).waitFor();
    if (change === 'delete') collection('locations').records = collection('locations').records.filter(item => item.key !== 'unplaced');
    else { record('unplaced').revision++; if (change === 'move') record('unplaced').value.parentId = 'gate'; }
    await changed(page);
    await chooseEventPoint(page);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.sc-message').filter({ hasText: 'Your draft is kept' }).waitFor();
    assert.equal(writes.length, 0);
    assert.notEqual(await page.getByLabel('Horizontal position (%)').inputValue(), '');
  });
}

test('location map actions respect scope and anonymous access', async t => {
  const { page, writes } = await fixture(t, { role: '' });
  await page.goto(`${origin}/#/locations/gate`);
  await page.getByRole('link', { name: 'Show on map', exact: true }).click();
  await page.getByRole('complementary', { name: 'Map location', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Move location pin', exact: true }).count(), 0);
  await page.goto(`${origin}/#/map/world/location/gate/place`);
  await marker(page, 'Northern Gate').waitFor();
  assert.equal(await page.getByRole('button', { name: /Edit map/ }).count(), 0);
  assert.equal(await page.getByLabel('Horizontal position (%)').count(), 0);
  for (const target of ['room', 'missing', 'unplaced']) {
    await page.goto(`${origin}/#/map/world/location/${target}/show`);
    await page.locator('.sc-message').filter({ hasText: 'This location or its pin is unavailable' }).waitFor();
  }
  assert.equal(writes.length, 0);
});

test('a tile failure falls back to the original image without losing the map', async t => {
  const { page, writes, mediaReads } = await fixture(t, { tiled: true, tileFailure: true });
  await page.locator('.leaflet-image-layer').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.leaflet-tile').length === 0);
  await marker(page, 'Northern Gate').waitFor();
  assert.equal(mediaReads.filter(url => url === imageURL).length, 1);
  assert.equal(writes.length, 0);
});

test('card and article glows surround portraits and follow icon silhouettes', async t => {
  const { page, writes } = await fixture(t);
  collection('settings').records.push({ key: 'attitudes', revision: 1, value: [
    { id: 'ally', label: 'Ally', labelColor: '#40d080', strength: .7 },
    { id: 'danger', label: 'Danger', labelColor: '#ed4264', strength: 1 },
  ] });
  const ryn = fixtureRecord<Record<string, unknown>>(collection('characters'), 'ryn');
  ryn.value.attitudes = [{ id: 'ally' }, { id: 'danger' }];
  record('gate').value.attitudes = [{ id: 'ally' }, { id: 'danger' }];
  await changed(page, 'settings');
  await marker(page, 'Northern Gate').locator('.sc-pin-icon-segment').nth(1).waitFor();
  await page.goto(`${origin}/#/characters`);
  const card = page.locator('.record-row[href="#/characters/ryn"] .record-row-mark');
  await card.waitFor();
  const ring = await card.evaluate(node => getComputedStyle(node).boxShadow);
  assert.match(ring, /rgba\(64, 208, 128, 0.7\) 0px 0px 10px 1px/);
  assert.match(ring, /rgb\(237, 66, 100\) 0px 0px 4px 1px/);
  assert.equal(await card.locator('.record-visual-glyph').evaluate(node => getComputedStyle(node).filter), 'none');
  await page.goto(`${origin}/#/characters/ryn`);
  await page.locator('.record-portrait').waitFor();
  assert.equal(await page.locator('.record-portrait').evaluate(node => getComputedStyle(node).boxShadow), ring);
  ryn.value.portrait = imageURL; ryn.revision++;
  await changed(page, 'characters');
  await page.locator('img.record-portrait').waitFor();
  assert.equal(await page.locator('.record-portrait').evaluate(node => getComputedStyle(node).boxShadow), ring);
  assert.equal(await page.locator('.record-portrait').evaluate(node => getComputedStyle(node).filter), 'none');
  await page.goto(`${origin}/#/locations`);
  const location = page.locator('.record-row[href="#/locations/gate"] .record-row-mark');
  await location.waitFor();
  assert.equal(await location.evaluate(node => getComputedStyle(node).filter), 'none', 'the card background must not cast the icon glow');
  const iconGlow = await location.locator('.record-visual-glyph').evaluate(node => getComputedStyle(node).filter);
  assert.match(iconGlow, /rgba\(64, 208, 128, 0.7\) 0px 0px 10px/);
  assert.match(iconGlow, /rgb\(237, 66, 100\) 0px 0px 4px/);
  await page.goto(`${origin}/#/locations/gate`);
  await page.locator('.record-portrait-placeholder').waitFor();
  assert.equal(await page.locator('.record-portrait-placeholder .record-visual-glyph').evaluate(node => getComputedStyle(node).filter), iconGlow);
  await page.screenshot({ path: `${artifacts}article-attitude-glows.png`, animations: 'disabled' });
  assert.equal(writes.length, 0);
});

test('event dragging keeps its opening revision during live refresh and remote deletion', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: 'Event paths', exact: false }).click();
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  const pin = await eventMarker(page, 'Camp by the river').boundingBox().then(required);
  await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2);
  await page.mouse.down();
  await page.mouse.move(pin.x + pin.width / 2 + 50, pin.y + pin.height / 2 + 35, { steps: 12 });
  await page.mouse.up();
  await page.getByLabel('Horizontal position (%)').waitFor();
  const draftX = await page.getByLabel('Horizontal position (%)').inputValue();
  assert.ok(Number(draftX) > 48);
  assert.equal(writes.length, 0);
  eventRecord('arrival').revision++; eventRecord('arrival').value.mapX = .3;
  await changed(page, 'events');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.sc-message').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await page.getByLabel('Horizontal position (%)').inputValue(), draftX);
  await page.getByRole('button', { name: 'Remove event pin', exact: true }).click();
  assert.equal(writes.length, 0);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: 'Open event article', exact: true }).click();
  await page.waitForURL(/#\/map\/world$/);
  collection('events').records = collection('events').records.filter(record => record.key !== 'arrival');
  await changed(page, 'events');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal(await page.getByLabel('Horizontal position (%)').inputValue(), draftX);
  assert.equal(writes.length, 0);
});

test('local event placement captures its revision before the map click and protects other map scopes', async t => {
  const { page, writes } = await fixture(t, { role: 'player' });
  await page.goto(`${origin}/#/map/local/gate`);
  await marker(page, 'Upper Room').waitFor();
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  const picker = page.getByLabel('Place an event', { exact: true });
  assert.equal(await picker.locator('option[value="arrival"]').count(), 0, 'a world pin must be removed before moving it to another map');
  await picker.selectOption('past');
  eventRecord('past').revision++;
  await changed(page, 'events');
  await chooseEventPoint(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.sc-message').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(writes.length, 0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await picker.selectOption('past');
  await chooseEventPoint(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('complementary', { name: 'Event map position', exact: true }).waitFor({ state: 'detached' });
  assert.equal(writes[0][0].expectedRevision, 2);
  assert.equal(eventRecord('past').value.mapParentId, 'gate');
  await page.goto(`${origin}/#/events/past`);
  assert.match(await page.getByRole('link', { name: 'Show on map', exact: true }).getAttribute('href').then(required), /#\/map\/local\/gate\/event\/past\/show$/);
  await page.getByRole('link', { name: 'Move event pin', exact: true }).click();
  await page.getByRole('complementary', { name: 'Event map position', exact: true }).waitFor();
  assert.equal(writes.length, 1, 'article navigation must not write');
});

test('anonymous and missing-event map links cannot start edits', async t => {
  const { page, writes } = await fixture(t, { role: '' });
  await page.goto(`${origin}/#/events/arrival`);
  assert.equal(await page.getByRole('link', { name: 'Move event pin', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Show on map', exact: true }).click();
  await eventMarker(page, 'Camp by the river').waitFor();
  await page.goto(`${origin}/#/map/world/event/arrival/place`);
  await eventMarker(page, 'Camp by the river').waitFor();
  assert.equal(await page.getByRole('complementary', { name: 'Event map position', exact: true }).count(), 0);
  await page.goto(`${origin}/#/map/world/event/missing/place`);
  await page.locator('.sc-message').filter({ hasText: 'unavailable on this map' }).waitFor();
  assert.equal(writes.length, 0);
});

test('map setting drafts survive live updates and protect category and map changes', async t => {
  const { page, writes } = await fixture(t);
  await page.goto(`${origin}/#/settings/maps`);
  await setScale(page, .6);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-category="appearance"]').click();
  assert.equal(await page.locator('[data-category="maps"]').getAttribute('aria-current'), 'page');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('navigation', { name: 'Select a map' }).getByRole('button', { name: 'Northern Gate', exact: false }).click();
  assert.equal(await page.locator('.settings-maps-detail-title').innerText(), 'World map');
  const config = fixtureRecord<Record<string, { zoomScaleRatio: number; [key: string]: unknown }>>(collection('settings'), 'mapConfigs');
  config.revision++; config.value.world.zoomScaleRatio = .2;
  await changed(page, 'settings');
  assert.equal(await page.getByRole('slider', { name: 'Marker scaling with zoom' }).inputValue(), '0.6');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(writes.length, 0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: 'Marker scaling with zoom' }).inputValue(), '0.2');
  await setScale(page, .4);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-map-config button[type="submit"]')!.disabled);
  assert.equal(writes[0][0].expectedRevision, 4);
  assert.equal(fixtureRecord<Record<string, { zoomScaleRatio: number; [key: string]: unknown }>>(collection('settings'), 'mapConfigs').value.world.zoomScaleRatio, .4);
  const updated = fixtureRecord<Record<string, { zoomScaleRatio: number; [key: string]: unknown }>>(collection('settings'), 'mapConfigs');
  updated.revision++; updated.value.world.zoomScaleRatio = .8;
  await changed(page, 'settings');
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#map-marker-zoom')!.value === '0.8');
});

test('map settings handle world/local image uploads and malformed configuration without data loss', async t => {
  const { page, writes, uploads } = await fixture(t);
  await page.goto(`${origin}/#/settings/maps`);
  await setScale(page, .4);
  assert.equal(await page.getByLabel('Upload map image').isDisabled(), true);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const file = { name: 'map.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) };
  await page.getByLabel('Upload map image').setInputFiles(file);
  await page.locator(`.settings-worldmap-preview img[src="${uploadedURL}"]`).waitFor();
  assert.equal(writes.length, 0);
  await page.getByRole('navigation', { name: 'Select a map' }).getByRole('button', { name: 'Unplaced town', exact: false }).click();
  await page.getByLabel('Upload map image').setInputFiles(file);
  await page.locator(`.settings-worldmap-preview img[src="${uploadedURL}"]`).waitFor();
  assert.deepEqual(uploads, ['/api/media/world-map/main', '/api/media/location-map/unplaced']);
  assert.equal(record('unplaced').value.localMap, uploadedURL);
  assert.equal(record('unplaced').value.name, 'Unplaced town');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.settings-map-config button[type="submit"]')!.disabled);
  const config = fixtureRecord<Record<string, { zoomScaleRatio: number; [key: string]: unknown }>>(collection('settings'), 'mapConfigs');
  fixtureRecord<unknown>(collection('settings'), 'mapConfigs').value = []; config.revision++;
  await changed(page, 'settings');
  await page.getByRole('alert').filter({ hasText: 'invalid stored shape' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.equal(writes.length, 1);
});

test('zoom fit bounds adapt both ways to viewport changes and live scale updates', async t => {
  const { page } = await fixture(t);
  await page.getByRole('button', { name: 'Actual image size', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.equal(await marker(page, 'Northern Gate').locator('.sc-pin').evaluate(node => node.style.getPropertyValue('--sc-pin-base-scale')), '1');
  const config = fixtureRecord<Record<string, { zoomScaleRatio: number; [key: string]: unknown }>>(collection('settings'), 'mapConfigs');
  config.value.world.zoomScaleRatio = 1; config.revision++;
  await changed(page, 'settings');
  await page.waitForFunction(() => Math.abs(Number(document.querySelector<HTMLElement>('.sc-pin')!.style.getPropertyValue('--sc-pin-base-scale')) - Math.sqrt(2)) < .001);
  const zoomSlider = page.getByRole('slider', { name: 'Map zoom', exact: true });
  const desktopMin = Number(await zoomSlider.getAttribute('min'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(previous => Number(document.querySelector<HTMLInputElement>('.sc-zoom-slider-vertical')!.min) < previous, desktopMin);
  await page.getByRole('button', { name: 'Whole map', exact: false }).click();
  const phoneMin = Number(await zoomSlider.getAttribute('min'));
  assert.equal(Number(await zoomSlider.inputValue()), phoneMin);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(previous => Number(document.querySelector<HTMLInputElement>('.sc-zoom-slider-vertical')!.min) === previous, desktopMin);
  assert.equal(Number(await zoomSlider.inputValue()), desktopMin);
});

test('player sessions cannot open shared map configuration', async t => {
  const { page, writes } = await fixture(t, { role: 'player' });
  await page.getByRole('button', { name: 'Edit map', exact: false }).click();
  assert.equal(await page.getByRole('link', { name: 'Maps', exact: false }).count(), 0);
  await page.goto(`${origin}/#/settings/maps/local/gate`);
  await page.locator('[data-category="language"]').waitFor();
  assert.equal(await page.locator('[data-category="maps"]').count(), 0);
  assert.equal(await page.getByRole('slider', { name: 'Marker scaling with zoom' }).count(), 0);
  assert.equal(writes.length, 0);
});

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
  await marker(page, 'Northern Gate').hover();
  const pin = await marker(page, 'Northern Gate').boundingBox().then(required);
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
  const box = await page.locator('.leaflet-image-layer').boundingBox().then(required);
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
  assert.equal((writes[0][0].value as unknown as { extension: boolean }[])[0].extension, true);
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
    assert.deepEqual(await page.locator('.sc-event-pin').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).title)),
      ['The old gate', 'Camp by the river', 'Road to the inn', 'Road to the inn']);
    assert.equal(await page.locator('.sc-event-path').count(), 3);
    const pin = page.locator('.sc-event-pin[title="Camp by the river"]');
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('.leaflet-image-layer')!.getBoundingClientRect();
      const pin = document.querySelector<HTMLElement>('.sc-event-pin[title="Camp by the river"]')!.getBoundingClientRect();
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
    assert.deepEqual(await page.locator('.sc-event-pin').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).title)), ['Road to the inn', 'Inside the gate']);
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
    const views = fixtureRecord<{ id: string; label: string; parentId: string | null; icon: string; bounds: { x1: number; y1: number; x2: number; y2: number }; extension?: unknown }[]>(collection('settings'), 'mapViews');
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
    assert.deepEqual(fixtureRecord<{ id: string; label: string; parentId: string | null; icon: string; bounds: { x1: number; y1: number; x2: number; y2: number }; extension?: unknown }[]>(collection('settings'), 'mapViews').value, [remote]);
  });
}
