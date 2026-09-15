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

for (const mobile of [false,true]) test(`knowledge reading and explicit DM inspection work on ${mobile?'phone':'desktop'}`, async t => {
  const key = mobile?'knowledge-phone':'knowledge-desktop';
  await put(admin,csrf,key,{name:'Unrevealed identity',title:'Hidden captain',species:'Hidden species',description:'Hidden biography',knowledge:0},0,'characters');
  const dm=await open(t,'dm',mobile), player=await open(t,'player',mobile);
  await dm.page.goto('/#/characters/'+key);
  await dm.page.getByRole('heading',{name:'Unknown character',exact:true}).waitFor();
  await dm.page.getByText('This character’s identity and details have not been revealed.',{exact:true}).waitFor();
  await dm.page.getByRole('button',{name:'Edit Knowledge',exact:true}).click();
  assert.equal(await dm.page.getByRole('heading',{name:'Unrevealed identity',exact:true}).count(),0);
  await dm.page.getByRole('spinbutton',{name:'Knowledge',exact:true}).press('Escape');
  assert.equal(await dm.page.locator('.character-profile').textContent().then(text=>text?.includes('Hidden biography')),false);
  assert.equal(await dm.page.getByRole('heading',{name:'Unrevealed identity',exact:true}).count(),0);
  await dm.page.getByRole('button',{name:'Inspect as DM',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Unrevealed identity',exact:true}).waitFor();
  await dm.page.getByText('Hidden biography',{exact:true}).waitFor();
  await dm.page.getByRole('button',{name:'Return to reading view',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Unknown character',exact:true}).waitFor();
  await player.page.goto('/#/characters/'+key);
  await player.page.getByRole('heading',{name:'Unknown character',exact:true}).waitFor();
  assert.equal(await player.page.getByRole('button',{name:'Inspect as DM',exact:true}).count(),0);
  for(const knowledge of [1,2,3,4]) {
    const current=await record(key,'characters'); await put(admin,csrf,key,{...current.value,knowledge},current.revision,'characters');
    await player.page.reload(); await player.page.getByRole('heading',{name:'Unrevealed identity',exact:true}).waitFor();
    const text=await player.page.locator('.character-profile').textContent();
    assert.equal(text?.includes('Hidden biography'),knowledge>=2); assert.equal(text?.includes('Hidden captain'),knowledge>=2);
  }
  const stored=await record(key,'characters'); assert.equal(stored.value.description,'Hidden biography');
  await put(admin,csrf,key,{...stored.value,knowledge:0},stored.revision,'characters');
  await dm.page.reload();
  await dm.page.getByRole('heading',{name:'Unknown character',exact:true}).waitFor();
  await dm.page.getByRole('button',{name:'Inspect as DM',exact:true}).click();
  await dm.page.getByRole('button',{name:'Edit wiki',exact:true}).click();
  const writer=dm.page.locator('.character-wiki codex-markdown-editor');
  await writer.getByRole('combobox',{name:'Editor view',exact:true}).selectOption('markdown');
  await writer.locator('.writer-source').fill('Unsubmitted draft');
  assert.equal(await dm.page.getByRole('button',{name:'Return to reading view',exact:true}).isDisabled(),true);
  await dm.page.getByRole('button',{name:'Manage versions',exact:true}).click();
  await dm.page.getByRole('button',{name:'Create DM version',exact:true}).click();
  await dm.page.getByRole('alert').filter({hasText:'Save or cancel your open edits'}).waitFor();
  assert.equal(await writer.locator('.writer-source').inputValue(),'Unsubmitted draft');
  assert.equal((await record(key,'characters')).value.linkedTwinId,undefined);
  dm.page.once('dialog', dialog => dialog.accept());
  await dm.page.locator('.character-wiki').getByRole('button',{name:'Cancel',exact:true}).click();
  await writer.waitFor({state:'detached'});
  assert.equal((await record(key,'characters')).value.description,'Hidden biography');
  await dm.page.locator('.record-twins').getByRole('button',{name:'Cancel',exact:true}).click();
  if(process.env['CODEX_UI_SCREENSHOTS']==='1') {
    await dm.page.screenshot({path:resolve(output,`knowledge-${mobile?'phone':'desktop'}.png`),fullPage:true});
  }
  await dm.page.goto('/#/locations');
  await dm.page.goto('/#/characters/'+key);
  await dm.page.getByRole('heading',{name:'Unknown character',exact:true}).waitFor();
  assert.equal(await dm.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),false);
  if(process.env['CODEX_UI_SCREENSHOTS']==='1') {
    await dm.page.screenshot({path:resolve(output,`knowledge-reading-${mobile?'phone':'desktop'}.png`),fullPage:true});
  }
  await dm.page.evaluate(() => localStorage.setItem('codex_lang','cs')); await dm.page.reload();
  await dm.page.getByRole('heading',{name:'Neznámá postava',exact:true}).waitFor();
  await dm.page.getByRole('button',{name:'Prohlédnout jako PJ',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Unrevealed identity',exact:true}).waitFor();
  await dm.page.getByRole('button',{name:'Zpět na pohled čtenáře',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Neznámá postava',exact:true}).waitFor();
});

test('saved core URLs canonicalize once and retain Back and dirty-edit guards', async t => {
  await put(admin,csrf,'alias/gate%2F',{name:'Alias gate'});
  const dm=await open(t,'dm');
  await dm.page.goto('/#/locations');
  const before=await dm.page.evaluate(()=>history.length);
  await dm.page.goto('/#/misto/alias%2Fgate%252F');
  await dm.page.getByRole('heading',{name:'Alias gate',exact:true}).waitFor();
  assert.equal(new URL(dm.page.url()).hash,'#/locations/alias%2Fgate%252F');
  assert.equal(await dm.page.evaluate(()=>history.length),before+1);
  await dm.page.goBack(); await dm.page.getByRole('heading',{name:'Locations',exact:true}).waitFor();
  await dm.page.goto('/#/misto/alias%2Fgate%252F');
  await dm.page.getByRole('button',{name:'Edit',exact:true}).click();
  const name=dm.page.locator('form.record-editor input[name="name"]'); await name.fill('Unsaved alias edit');
  await dm.page.goto('/#/misto/alias%2Fgate%252F');
  await dm.page.waitForURL('**/#/locations/alias%2Fgate%252F');
  assert.equal(await name.inputValue(),'Unsaved alias edit');
  dm.page.once('dialog',dialog=>dialog.dismiss()); await dm.page.goto('/#/postavy');
  await dm.page.waitForURL('**/#/locations/alias%2Fgate%252F');
  assert.equal(await name.inputValue(),'Unsaved alias edit');
  dm.page.once('dialog',dialog=>dialog.accept()); await dm.page.goto('/#/postavy');
  await dm.page.getByRole('heading',{name:'Characters',exact:true}).waitFor();
  assert.equal(new URL(dm.page.url()).hash,'#/characters');
  await dm.page.goto('/#/misto/%E0%A4%A');
  await dm.page.getByText('This page is not in the index',{exact:false}).waitFor();
});

test('saved creation URLs survive sign-in and cancel without creating records', async t => {
  const visitor=await open(t);
  await visitor.page.goto('/#/misto/new');
  await visitor.page.locator('.editor-article').getByRole('button',{name:'Sign in',exact:true}).click();
  const account=visitor.page.locator('.account-panel');
  await account.locator('input[name="password"]').fill('local-record-workflows-player');
  await account.getByRole('button',{name:'Sign in',exact:true}).click();
  await visitor.page.locator('form.record-editor input[name="name"]').fill('Cancelled alias location');
  assert.equal(new URL(visitor.page.url()).hash,'#/create/locations');
  visitor.page.once('dialog',dialog=>dialog.accept());
  await visitor.page.locator('form.record-editor').getByRole('button',{name:'Cancel',exact:true}).click();
  await visitor.page.getByRole('heading',{name:'Locations',exact:true}).waitFor();
  const data=await jsonResponse(await admin.get('/api/campaign'));
  assert.equal(JSON.stringify(data).includes('Cancelled alias location'),false);
});
