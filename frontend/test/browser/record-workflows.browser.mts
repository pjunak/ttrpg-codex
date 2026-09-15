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
const output = resolve(root, 'frontend/test-results/record-workflows');
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, browser: Browser, admin: APIRequestContext, csrf: string, origin: string, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-record-workflows-dm', CODEX_PLAYER_PASSWORD: 'local-record-workflows-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-record-workflows-dm' } }))).csrfToken;
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
  const auth = role ? await jsonResponse(await context.request.post('/api/login', { data: { password: `local-record-workflows-${role}` } })) : undefined;
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto('/#/'); await page.locator('.session-section').waitFor();
  return { page, client: context.request, token: auth?.csrfToken };
}
async function put(client: APIRequestContext, token: string, key: string, value: Record<string, unknown>, revision = 0, collection = 'locations') {
  return jsonResponse(await client.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': token }, data: {
    contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection, key, expectedRevision: revision, value: { id: key, ...value } }],
  } }));
}
async function record(key: string, name = 'locations') {
  const data = await jsonResponse(await admin.get('/api/campaign'));
  return data.collections.find((collection: FixtureCollection) => collection.name === name).records.find((record: FixtureRecord) => record.key === key);
}

test('DM location notes round-trip privately through the real editor and public API', async t => {
  const secret = '# Hidden arrangement\n\nKeep this apart from public prose.';
  await put(admin, csrf, 'private-notes-town', {name:'Private notes town', description:'Public overview', mapNotes:'Public map notes', notes:secret});
  const dm = await open(t,'dm'), player = await open(t,'player');
  await dm.page.goto('/#/locations/private-notes-town');
  await dm.page.getByRole('heading',{name:'DM notes',exact:true}).waitFor();
  await dm.page.getByRole('heading',{name:'Hidden arrangement',exact:true}).waitFor();
  await dm.page.getByRole('button',{name:'Edit',exact:true}).click();
  const writer = dm.page.locator('codex-markdown-editor').filter({has:dm.page.getByText('DM notes',{exact:true})});
  await writer.getByRole('combobox',{name:'Editor view',exact:true}).selectOption('markdown');
  await writer.locator('.writer-source').fill(secret+'\n\nEdited by DM.');
  await dm.page.getByRole('button',{name:'Save entry',exact:true}).last().click();
  await dm.page.getByRole('heading',{name:'DM notes',exact:true}).waitFor();
  await dm.page.reload(); await dm.page.getByRole('heading',{name:'Hidden arrangement',exact:true}).waitFor();
  assert.equal((await record('private-notes-town')).value.notes, secret+'\n\nEdited by DM.');
  await player.page.goto('/#/locations/private-notes-town');
  await player.page.getByRole('heading',{name:'Private notes town',exact:true}).waitFor();
  assert.equal(await player.page.getByRole('heading',{name:'DM notes',exact:true}).count(),0);
  const dataset = await jsonResponse(await player.client.get('/api/campaign'));
  assert.ok(!JSON.stringify(dataset).includes('Hidden arrangement'));
  await player.page.getByRole('button',{name:'Edit',exact:true}).click();
  assert.equal(await player.page.locator('[name="notes"]').count(),0);
  await player.page.getByLabel('Name',{exact:true}).fill('Player renamed town');
  await player.page.getByRole('button',{name:'Save entry',exact:true}).last().click();
  await player.page.getByRole('heading',{name:'Player renamed town',exact:true}).waitFor();
  const saved = await record('private-notes-town');
  assert.equal(saved.value.notes,secret+'\n\nEdited by DM.');
  assert.equal(saved.value.description,'Public overview'); assert.equal(saved.value.mapNotes,'Public map notes');
});
test('DM twins create, navigate, unlink and link without losing exact record routes', async t => {
  await put(admin, csrf, 'twin-town', {name:'Twin town', description:'Public town'},0);
  const dm = await open(t,'dm'), player = await open(t,'player');
  await dm.page.goto('/#/locations/twin-town');
  await dm.page.getByRole('button',{name:'Manage versions',exact:true}).click();
  await dm.page.getByRole('button',{name:'Create DM version',exact:true}).click();
  const dmLink = dm.page.getByRole('link',{name:'Open DM version',exact:true}); await dmLink.waitFor();
  const publicRecord = await record('twin-town'), privateKey = publicRecord.value.linkedTwinId as string;
  assert.ok(privateKey); assert.equal((await record(privateKey)).value.linkedTwinId,'twin-town');
  await dm.page.reload(); await dmLink.waitFor();
  await dmLink.click(); await dm.page.getByRole('link',{name:'Open player version',exact:true}).waitFor();
  assert.equal(new URL(dm.page.url()).hash,'#/locations/'+encodeURIComponent(privateKey));
  await dm.page.getByRole('link',{name:'Open player version',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Twin town',exact:true}).waitFor();
  await dm.page.goto('/#/locations');
  assert.equal(await dm.page.locator('a.record-row').filter({hasText:'Twin town'}).count(),1);
  await player.page.goto('/#/locations/twin-town');
  await player.page.getByRole('heading',{name:'Twin town',exact:true}).waitFor();
  assert.equal(await player.page.locator('codex-record-twins').count(),0);
  assert.ok(!JSON.stringify(await jsonResponse(await player.client.get('/api/campaign'))).includes(privateKey));
  await dm.page.goto('/#/locations/twin-town');
  await dm.page.getByRole('button',{name:'Manage versions',exact:true}).click();
  await dm.page.getByRole('button',{name:'Unlink versions',exact:true}).click();
  await dm.page.getByText('Versions updated.',{exact:true}).waitFor();
  assert.equal((await record('twin-town')).value.linkedTwinId,undefined);
  assert.equal((await record(privateKey)).value.description,'Public town');
  await dm.page.getByRole('button',{name:'Manage versions',exact:true}).click();
  await dm.page.getByLabel('Or link an existing opposite version',{exact:true}).selectOption(privateKey);
  await dm.page.getByRole('button',{name:'Link versions',exact:true}).click();
  await dmLink.waitFor();
  assert.equal((await record('twin-town')).value.linkedTwinId,privateKey);
});

test('stale twin review rejects without losing a draft or repeating an uncertain write', async t => {
  await put(admin, csrf, 'stale-twin', {name:'Stale twin'},0);
  const dm = await open(t,'dm'); await dm.page.goto('/#/locations/stale-twin');
  await dm.page.getByRole('button',{name:'Manage versions',exact:true}).click();
  const initial = await record('stale-twin');
  await put(admin,csrf,'stale-twin',{...initial.value,name:'Changed elsewhere'},initial.revision);
  await dm.page.getByRole('button',{name:'Create DM version',exact:true}).click();
  await dm.page.getByRole('alert').filter({hasText:'The records changed.'}).waitFor();
  assert.equal((await record('stale-twin')).value.linkedTwinId,undefined);
  assert.equal(await dm.page.getByRole('button',{name:'Create DM version',exact:true}).isDisabled(),true);
  await dm.page.getByRole('button',{name:'Review current records',exact:true}).click();
  await dm.page.getByRole('button',{name:'Create DM version',exact:true}).click();
  await dm.page.getByRole('link',{name:'Open DM version',exact:true}).waitFor();
  assert.equal((await record('stale-twin')).value.name,'Changed elsewhere');
});

test('an uncertain twin response is refreshed without replaying the write', async t => {
  await put(admin,csrf,'uncertain-twin',{name:'Uncertain twin'});
  const dm = await open(t,'dm'); await dm.page.goto('/#/locations/uncertain-twin');
  let writes = 0;
  await dm.page.route('**/api/campaign/twins',async route => { writes++; await route.fetch(); await route.abort('failed'); });
  await dm.page.getByRole('button',{name:'Manage versions',exact:true}).click();
  await dm.page.getByRole('button',{name:'Create DM version',exact:true}).click();
  await dm.page.getByRole('alert').filter({hasText:'Could not confirm the change.'}).waitFor();
  assert.equal(writes,1);
  const current = await record('uncertain-twin'); assert.ok(current.value.linkedTwinId);
  await dm.page.getByRole('link',{name:'Open DM version',exact:true}).waitFor();
  assert.equal(await dm.page.getByRole('button',{name:'Create DM version',exact:true}).isDisabled(),true);
  await dm.page.unroute('**/api/campaign/twins');
  await dm.page.getByRole('button',{name:'Review current records',exact:true}).click();
  await dm.page.getByRole('button',{name:'Unlink versions',exact:true}).waitFor();
  assert.equal(await dm.page.getByRole('button',{name:'Create DM version',exact:true}).count(),0);
});
