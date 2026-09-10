import type { APIRequestContext, Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
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
const output = resolve(root, 'frontend/test-results/host-map');
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, browser: Browser, admin: APIRequestContext, origin: string, imageURL: string, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-map-dm', CODEX_PLAYER_PASSWORD: 'local-map-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  const csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-map-dm' } }))).csrfToken;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 800;
    const context = canvas.getContext('2d')!; context.fillStyle = '#988363'; context.fillRect(0, 0, 1280, 800);
    context.fillStyle = '#648894'; context.fillRect(0, 550, 1280, 60);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  }), 'base64');
  await page.close();
  // A valid EXIF directory without orientation reproduces exported campaign maps.
  const app1 = Buffer.alloc(24); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(22, 2);
  app1.write('Exif\0\0II', 4, 'ascii'); app1.writeUInt16LE(42, 12); app1.writeUInt32LE(8, 14);
  imageURL = (await jsonResponse(await admin.post('/api/media/world-map/main', {
    headers: { 'X-Codex-CSRF': csrf, 'Content-Type': 'image/jpeg', 'X-Codex-Filename': 'map-with-metadata.jpg' },
    data: Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]),
  }))).url;
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: {
    contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection: 'locations', key: 'town', expectedRevision: 0,
      value: { id: 'town', name: 'River town', x: .5, y: .5, pinType: 'town', visibility: 'public', knowledge: 4 } }],
  } }));
});
after(async () => {
  await browser?.close(); await admin?.dispose();
  if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; }
  if (directory) {
    const child = relative(output, directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const mobile of [false, true]) test(`Go host serves visible markers and EXIF map tiles on ${mobile ? 'phone' : 'desktop'}`, async t => {
  const context = await browser.newContext({ baseURL: origin, locale: 'en-US', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  t.after(() => context.close());
  await jsonResponse(await context.request.post('/api/login', { data: { password: 'local-map-player' } }));
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const reads: string[] = [], errors: string[] = []; page.on('request', request => reads.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(error.message));
  const manifestResponse = page.waitForResponse(response => response.url().endsWith('/tiles/v1/manifest'));
  await page.goto('/#/map/world');
  const manifest = await jsonResponse(await manifestResponse);
  assert.equal(manifest.width, 1280); assert.equal(manifest.height, 800); assert.equal(manifest.depth, 3);
  await page.waitForFunction(() => {
    const markers = [...document.querySelectorAll('.sc-marker img')], tiles = [...document.querySelectorAll('.leaflet-tile')];
    return markers.length > 0 && tiles.length > 0 && [...markers, ...tiles].every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
      && tiles.every(image => getComputedStyle(image).opacity === '1');
  });
  const marker = page.locator('.sc-marker[title="River town"]'); await marker.waitFor();
  assert.equal(await marker.locator('img').first().getAttribute('src'), '/icons-defaults/town.svg');
  assert.ok(reads.some(path => /\/tiles\/v1\/\d+\/\d+\/\d+$/.test(path)));
  assert.ok(!reads.includes(imageURL), 'The browser must not download the original JPEG when tiles are supported');
  await page.locator('.leaflet-container').screenshot({ path: resolve(output, `${mobile ? 'phone' : 'desktop'}.png`) });
  await marker.click(); await page.getByRole('complementary', { name: 'Map location', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
