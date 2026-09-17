import type { APIRequestContext, Browser, Page } from 'playwright';
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

async function open(t: TestContext, role: string | undefined = undefined, mobile = false, fallbackFonts = false) {
  const context = await browser.newContext({ baseURL: origin, locale: 'en-US', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const auth = role ? await jsonResponse(await context.request.post('/api/login', { data: { password: `local-record-workflows-${role}` } })) : undefined;
  if (fallbackFonts) await context.route('**/*.woff2', route => route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto('/#/'); await page.locator('.session-section').waitFor();
  return { page, client: context.request, token: auth?.csrfToken };
}
async function assertViewportReflow(page: Page, subject: string, width: number) {
  const layout = await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth)
      .map(element => ({ tag: element.tagName, class: element.className, text: element.textContent?.slice(0, 60) })).slice(-8),
  }));
  assert.equal(layout.viewport, width);
  assert.ok(layout.width <= width, subject+' reflows at '+width+' CSS pixels: '+JSON.stringify(layout));
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

for (const scenario of [
  {role:'dm',mobile:false,stale:false},
  {role:'dm',mobile:true,stale:true},
  {role:'player',mobile:true,stale:false},
]) test(`expired ${scenario.role} sessions recover core drafts without replay (${scenario.mobile?'phone':'desktop'}, stale=${scenario.stale})`,async t=>{
  const key=`session-recovery-${scenario.role}-${scenario.mobile}`;
  const value={name:'Session recovery place',description:'Saved description',visibility:scenario.role==='dm'?'dm':'public'};
  await put(admin,csrf,key,value);
  const editing=await open(t,scenario.role,scenario.mobile);
  await editing.page.goto('/#/locations/'+key);
  await editing.page.getByRole('button',{name:'Edit',exact:true}).click();
  const name=editing.page.getByLabel('Name',{exact:true});
  await name.fill('Unsaved recovery name');
  let writes=0;
  editing.page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/campaign/transactions')writes++});
  await jsonResponse(await editing.client.post('/api/logout'));
  await editing.page.getByRole('button',{name:'Save entry',exact:true}).last().click();
  const recovery=editing.page.locator('.session-recovery'); await recovery.waitFor();
  assert.equal(await name.inputValue(),'Unsaved recovery name');
  assert.equal((await record(key)).value.name,value.name);
  assert.equal(writes,1);
  assert.ok(await editing.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await recovery.screenshot({path:resolve(output,`session-recovery-${scenario.role}-${scenario.mobile}.png`)});
  const password=recovery.getByLabel('DM or player password',{exact:true});
  await password.fill('incorrect-local-password');
  await recovery.getByRole('button',{name:'Resume editing',exact:true}).click();
  await recovery.getByRole('alert').filter({hasText:'Sign-in could not be confirmed'}).waitFor();
  const wrongRole=scenario.role==='dm'?'player':'dm';
  await password.fill('local-record-workflows-'+wrongRole);
  await recovery.getByRole('button',{name:'Resume editing',exact:true}).click();
  await recovery.getByRole('alert').filter({hasText:'same role'}).waitFor();
  assert.equal(await name.inputValue(),'Unsaved recovery name');
  if(scenario.stale)await put(admin,csrf,key,{...value,name:'Changed while signed out'},(await record(key)).revision);
  await password.fill('local-record-workflows-'+scenario.role);
  await recovery.getByRole('button',{name:'Resume editing',exact:true}).click();
  await recovery.waitFor({state:'detached'});
  const save=editing.page.getByRole('button',{name:'Save entry',exact:true}).last();
  await editing.page.getByRole('status').filter({hasText:'Signed in again'}).waitFor();
  await editing.page.waitForFunction(()=>document.activeElement?.id==='campaign-content');
  assert.equal(await name.inputValue(),'Unsaved recovery name'); assert.equal(writes,1,'reauthentication must not replay the failed save');
  await save.click();
  if(scenario.stale){
    await editing.page.getByRole('alert').filter({hasText:'changed'}).waitFor();
    assert.equal(await name.inputValue(),'Unsaved recovery name');
    assert.equal((await record(key)).value.name,'Changed while signed out');
  }else{
    await editing.page.getByRole('heading',{name:'Unsaved recovery name',exact:true}).waitFor();
    assert.equal((await record(key)).value.name,'Unsaved recovery name'); assert.equal(writes,2);
  }
});

test('live session loss preserves a private core draft before any save attempt',async t=>{
  const key='session-live-private';
  await put(admin,csrf,key,{name:'Private session place',visibility:'dm'});
  const editing=await open(t,'dm',true); await editing.page.goto('/#/locations/'+key);
  await editing.page.getByRole('button',{name:'Edit',exact:true}).click();
  const name=editing.page.getByLabel('Name',{exact:true}); await name.fill('Unsaved after live loss');
  await jsonResponse(await editing.client.post('/api/logout'));
  await put(admin,csrf,'session-live-signal',{name:'Public live signal',visibility:'public'});
  await editing.page.locator('.session-recovery').waitFor();
  assert.equal(await name.inputValue(),'Unsaved after live loss');
  assert.equal((await record(key)).value.name,'Private session place');
});

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
  // Same-document navigation resolves before the router renders its new page.
  // Let the character view unmount before testing a fresh reader session.
  await dm.page.getByRole('heading',{name:'Locations',exact:true}).waitFor();
  await dm.page.locator('codex-character-profile').waitFor({state:'detached'});
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

for (const mobile of [false,true]) test(`connected articles support navigation, complete membership and live drafts on ${mobile?'phone':'desktop'}`, async t => {
  const suffix=mobile?'phone':'desktop', key=(name:string)=>'context-'+suffix+'-'+name;
  await put(admin,csrf,key('world'),{name:'Context world'});
  await put(admin,csrf,key('gate'),{name:'Context gate',parentId:key('world'),connections:[key('world')]});
  await put(admin,csrf,key('child'),{name:'Context child',parentId:key('gate')});
  await put(admin,csrf,key('watch'),{name:'Context watch',rankChains:[{id:'command',name:'Command',ranks:['Captain']}]},0,'factions');
  await put(admin,csrf,key('captain'),{name:'Context captain',faction:key('watch'),rankChain:'command',rank:'Captain',location:key('gate'),
    knowledge:4,locationRoles:[{locationId:key('child'),role:'Warden'}]},0,'characters');
  await put(admin,csrf,key('unranked'),{name:'Context unranked',faction:key('watch')},0,'characters');
  await put(admin,csrf,key('secret'),{name:'Private context resident',location:key('gate'),visibility:'dm'},0,'characters');
  await put(admin,csrf,key('event'),{name:'Context arrival',characters:[key('captain')],locations:[key('gate')],sitting:1},0,'events');
  await put(admin,csrf,key('hound'),{name:'Context hound',ownerType:'faction',ownerId:key('watch')},0,'pets');
  await put(admin,csrf,key('raven'),{name:'Context raven',ownerType:'character',ownerId:key('captain')},0,'pets');
  const relationKey='relationship:'+Buffer.from(JSON.stringify([key('captain'),key('unranked'),'friend'])).toString('base64url');
  await put(admin,csrf,relationKey,{source:key('captain'),target:key('unranked'),type:'friend',label:'Trusts'},0,'relationships');
  const dm=await open(t,'dm',mobile), player=await open(t,'player',mobile);
  await player.page.goto('/#/events/'+key('event'));
  await player.page.locator('.record-facts').getByRole('link',{name:'Context captain',exact:true}).click();
  await player.page.getByRole('heading',{name:'Context captain',exact:true}).waitFor();
  await player.page.locator('[data-context="companions"]').getByRole('link',{name:'Context raven',exact:true}).waitFor();
  await player.page.locator('[data-context="events"]').getByRole('link',{name:'Context arrival',exact:true}).waitFor();
  await player.page.locator('.article-relationship-list').getByRole('link',{name:'Context child',exact:true}).waitFor();
  await player.page.locator('.article-relationship-list').getByRole('link',{name:'Context unranked',exact:true}).waitFor();
  await player.page.locator('.record-facts').getByRole('link',{name:'Context watch',exact:true}).click();
  const roster=player.page.locator('[data-context="members"]');
  await roster.getByRole('link',{name:'Context captain',exact:true}).waitFor();
  await roster.getByRole('link',{name:'Context unranked',exact:true}).waitFor();
  await player.page.locator('[data-context="companions"]').getByRole('link',{name:'Context hound',exact:true}).click();
  await player.page.locator('.record-facts').getByRole('link',{name:'Context watch',exact:true}).waitFor();
  await player.page.goto('/#/locations/'+key('gate'));
  await player.page.locator('[data-context="ancestors"]').getByRole('link',{name:'Context world',exact:true}).waitFor();
  await player.page.locator('[data-context="children"]').getByRole('link',{name:'Context child',exact:true}).waitFor();
  await player.page.locator('[data-context="connections"]').getByRole('link',{name:'Context world',exact:true}).waitFor();
  await player.page.locator('[data-context="residents"]').getByRole('link',{name:'Context captain',exact:true}).waitFor();
  assert.equal(await player.page.getByText('Private context resident',{exact:true}).count(),0);
  await dm.page.goto('/#/locations/'+key('gate'));
  await dm.page.locator('[data-context="residents"]').getByRole('link',{name:'Private context resident',exact:true}).waitFor();
  await dm.page.goto('/#/characters/'+key('captain'));
  await dm.page.getByRole('button',{name:'Edit Name',exact:true}).click();
  const draft=dm.page.getByRole('textbox',{name:'Name',exact:true}); await draft.fill('Unsubmitted context name');
  const event=await record(key('event'),'events');
  await put(admin,csrf,key('event'),{...event.value,name:'Refreshed context arrival'},event.revision,'events');
  await dm.page.locator('[data-context="events"]').getByRole('link',{name:'Refreshed context arrival',exact:true}).waitFor();
  assert.equal(await draft.inputValue(),'Unsubmitted context name');
  await draft.press('Escape');
  assert.equal((await record(key('captain'),'characters')).value.name,'Context captain');
  if(process.env['CODEX_UI_SCREENSHOTS']==='1') await player.page.screenshot({path:resolve(output,`context-${suffix}.png`),fullPage:true});
  await player.page.evaluate(()=>localStorage.setItem('codex_lang','cs')); await player.page.reload();
  await player.page.getByRole('heading',{name:'Podřízená místa',exact:true}).waitFor();
  assert.equal(await player.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});

for(const mobile of [false,true]) test(`related creation preserves associations and return pages on ${mobile?'phone':'desktop'}`, async t=>{
  const suffix=mobile?'phone':'desktop', source='creation/'+suffix;
  await put(admin,csrf,source,{name:'Creation source'});
  const dm=await open(t,'dm',mobile);
  for(const [action,name,collection,field] of [
    ['Character here','Created resident','characters','location'],
    ['Event here','Created event','events','locations'],
    ['Sub-location','Created child','locations','parentId'],
  ]) {
    await dm.page.goto('/#/locations/'+encodeURIComponent(source));
    if(process.env['CODEX_UI_SCREENSHOTS']==='1' && action==='Character here') await dm.page.screenshot({path:resolve(output,`creation-actions-${suffix}.png`),fullPage:true});
    await dm.page.getByRole('link',{name:action!,exact:true}).click();
    await dm.page.locator('form.record-editor input[name="name"]').fill(name!+' '+suffix);
    await dm.page.getByRole('link',{name:/Back to Creation source/}).waitFor();
    if(process.env['CODEX_UI_SCREENSHOTS']==='1' && action==='Character here') await dm.page.screenshot({path:resolve(output,`creation-form-${suffix}.png`),fullPage:true});
    assert.equal(await dm.page.locator('select[name="'+field+'"]').inputValue(),source);
    await dm.page.locator('form.record-editor').getByRole('button',{name:'Save entry',exact:true}).click();
    await dm.page.getByRole('heading',{name:'Creation source',exact:true}).waitFor();
    assert.equal(new URL(dm.page.url()).hash,'#/locations/'+encodeURIComponent(source));
    const data=await jsonResponse(await admin.get('/api/campaign'));
    const created=data.collections.find((item:FixtureCollection)=>item.name===collection).records.find((item:FixtureRecord)=>item.value.name===name+' '+suffix);
    assert.ok(created); assert.deepEqual(created.value[field!],field==='locations'?[source]:source);
  }
  await put(admin,csrf,'creation-watch-'+suffix,{name:'Private creation watch',visibility:'dm'},0,'factions');
  await dm.page.goto('/#/factions/creation-watch-'+suffix);
  await dm.page.getByRole('link',{name:'New faction member',exact:true}).click();
  await dm.page.locator('form.record-editor input[name="name"]').fill('Created member '+suffix);
  assert.equal(await dm.page.locator('select[name="faction"]').inputValue(),'creation-watch-'+suffix);
  assert.equal(await dm.page.locator('select[name="visibility"]').inputValue(),'dm');
  await dm.page.locator('form.record-editor').getByRole('button',{name:'Save entry',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Private creation watch',exact:true}).waitFor();
  await dm.page.locator('[data-context="members"]').getByRole('link',{name:'Created member '+suffix,exact:true}).waitFor();
  await dm.page.goto('/#/locations/'+encodeURIComponent(source));
  await dm.page.getByRole('link',{name:'Sub-location',exact:true}).click();
  await dm.page.goBack(); await dm.page.getByRole('heading',{name:'Creation source',exact:true}).waitFor();
  await dm.page.getByRole('link',{name:'Character here',exact:true}).click();
  const name=dm.page.locator('form.record-editor input[name="name"]'); await name.fill('Kept after source deletion');
  const parent=await record(source);
  await jsonResponse(await admin.post('/api/campaign/transactions',{headers:{'X-Codex-CSRF':csrf},data:{contractVersion:'campaign-mutation.v1',
    mutations:[{operation:'delete',collection:'locations',key:source,expectedRevision:parent.revision}]}}));
  await dm.page.locator('.editor-article [role="alert"]').filter({hasText:'The starting entry is no longer available.'}).waitFor();
  await dm.page.locator('form.record-editor').getByRole('button',{name:'Save entry',exact:true}).click();
  assert.equal(await name.inputValue(),'Kept after source deletion');
  assert.equal(JSON.stringify(await jsonResponse(await admin.get('/api/campaign'))).includes('Kept after source deletion'),false);
  dm.page.once('dialog',dialog=>dialog.accept());
  await dm.page.locator('form.record-editor').getByRole('button',{name:'Cancel',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Locations',exact:true}).waitFor();
  await dm.page.evaluate(()=>localStorage.setItem('codex_lang','cs')); await dm.page.reload();
  await dm.page.goto('/#/factions/creation-watch-'+suffix);
  await dm.page.getByRole('link',{name:'Nový člen frakce',exact:true}).waitFor();
});

test('contextual creation retains its source through sign-in',async t=>{
  await put(admin,csrf,'signin-source',{name:'Sign-in source'});
  const visitor=await open(t);
  await visitor.page.goto('/#/locations/signin-source');
  await visitor.page.getByRole('link',{name:'Character here',exact:true}).click();
  await visitor.page.locator('.editor-article').getByRole('button',{name:'Sign in',exact:true}).click();
  const account=visitor.page.locator('.account-panel');
  await account.locator('input[name="password"]').fill('local-record-workflows-player');
  await account.getByRole('button',{name:'Sign in',exact:true}).click();
  await visitor.page.locator('form.record-editor input[name="name"]').waitFor();
  assert.equal(await visitor.page.locator('select[name="location"]').inputValue(),'signin-source');
  await visitor.page.locator('form.record-editor').getByRole('button',{name:'Cancel',exact:true}).click();
  await visitor.page.getByRole('heading',{name:'Sign-in source',exact:true}).waitFor();
  await visitor.page.goto('/#/create/character-here/missing-source');
  await visitor.page.getByRole('heading',{name:'Add character',exact:true}).waitFor();
  assert.equal(await visitor.page.locator('form.record-editor').count(),0);
});

test('direct card editing keeps collection views, party return paths and stale drafts',async t=>{
  await put(admin,csrf,'direct-edit',{name:'Direct editing town'});
  await put(admin,csrf,'direct-party',{name:'Direct party member',faction:'party',knowledge:4},0,'characters');
  const dm=await open(t,'dm');
  const view='#/locations?q=Direct&sort=name';
  await dm.page.goto('/'+view);
  await dm.page.getByRole('link',{name:'Edit Direct editing town',exact:true}).waitFor();
  if(process.env['CODEX_UI_SCREENSHOTS']==='1') {
    await dm.page.setViewportSize({width:390,height:844});
    await dm.page.screenshot({path:resolve(output,'collection-card-edit-phone.png'),fullPage:true});
    assert.equal(await dm.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await dm.page.setViewportSize({width:1440,height:1000});
  }
  const edit=dm.page.getByRole('link',{name:'Edit Direct editing town',exact:true}); await edit.focus(); await edit.press('Enter');
  const name=dm.page.locator('form.record-editor input[name="name"]'); await name.fill('Direct renamed town');
  await dm.page.locator('form.record-editor').getByRole('button',{name:'Save entry',exact:true}).click();
  await dm.page.getByRole('heading',{name:'Locations',exact:true}).waitFor();
  assert.equal(new URL(dm.page.url()).hash,view);
  await dm.page.getByRole('link',{name:'Edit Direct renamed town',exact:true}).click(); await name.fill('Stale direct draft');
  const current=await record('direct-edit');
  await put(admin,csrf,'direct-edit',{...current.value,description:'Changed elsewhere'},current.revision);
  await dm.page.locator('form.record-editor').getByRole('button',{name:'Save entry',exact:true}).click();
  await dm.page.getByText('The entry or its relationships changed.',{exact:false}).waitFor();
  assert.equal(await name.inputValue(),'Stale direct draft');
  dm.page.once('dialog',dialog=>dialog.accept());
  await dm.page.locator('form.record-editor').getByRole('button',{name:'Cancel',exact:true}).click();
  await dm.page.goto('/#/party');
  await dm.page.getByRole('link',{name:'Edit Direct party member',exact:true}).click();
  await dm.page.locator('form.record-editor').getByRole('button',{name:'Cancel',exact:true}).click();
  await dm.page.locator('#party-title').waitFor(); assert.equal(new URL(dm.page.url()).hash,'#/party');
  assert.equal(await dm.page.getByText('The entry or its relationships changed.',{exact:false}).count(),0);
  if(process.env['CODEX_UI_SCREENSHOTS']==='1') await dm.page.screenshot({path:resolve(output,'direct-card-edit.png'),fullPage:true});
});

for (const mobile of [false, true]) test(`investigations share effective status and a role-safe question queue (${mobile ? 'phone' : 'desktop'})`, async t => {
  const suffix = mobile ? 'phone' : 'desktop', key = 'investigation-' + suffix;
  await put(admin,csrf,key,{name:'Žár '+suffix,solved:false,questions:[{text:'Proč zvoní věž?',answer:'Strážce se vrátil.'}]},0,'mysteries');
  await put(admin,csrf,key+'-open',{name:'Open '+suffix,questions:[{text:'Where is the bell '+suffix+'?',answer:'   '}]},0,'mysteries');
  await put(admin,csrf,key+'-manual',{name:'Manual '+suffix,solved:true,questions:[{text:'Manual unanswered '+suffix+'?',answer:''}]},0,'mysteries');
  await put(admin,csrf,key+'-character',{name:'Žofie '+suffix,knowledge:2,unknown:[{text:'Character question '+suffix+'?',answer:''},{text:'Old question '+suffix+'?',answer:'Answer preserved '+suffix}]},0,'characters');
  await put(admin,csrf,key+'-hidden',{name:'Private source '+suffix,visibility:'dm',questions:[{text:'Private question '+suffix+'?',answer:''}]},0,'mysteries');
  await put(admin,csrf,key+'-unrevealed',{name:'Unrevealed '+suffix,knowledge:1,unknown:[{text:'Unrevealed question '+suffix+'?',answer:''}]},0,'characters');
  const dm = await open(t,'dm',mobile), player = await open(t,'player',mobile);
  await dm.page.goto('/#/mysteries/'+key);
  const reading = dm.page.locator('.investigation-reading');
  assert.equal(await reading.locator('.investigation-badge').textContent(),'Solved');
  assert.match(await reading.textContent() ?? '',/0 open \/ 1 questions/);
  await reading.locator('summary').click();
  await reading.getByText('Strážce se vrátil.',{exact:true}).waitFor();
  assert.equal((await record(key,'mysteries')).value.solved,false);
  await dm.page.goto('/#/mysteries');
  const solvedCard = dm.page.locator('a.record-row[href="#/mysteries/'+key+'"]');
  await solvedCard.locator('.is-solved').waitFor();
  const queue = dm.page.locator('codex-investigation-queue');
  await queue.getByRole('searchbox').fill('character question '+suffix);
  await queue.getByText('Character question '+suffix+'?',{exact:true}).waitFor();
  const source = queue.getByRole('link',{name:'Žofie '+suffix,exact:true});
  assert.equal(await source.getAttribute('href'),'#/characters/'+key+'-character');
  await queue.getByRole('link',{name:'Edit Žofie '+suffix,exact:true}).click();
  await dm.page.getByLabel('Name',{exact:true}).waitFor();
  await dm.page.getByRole('button',{name:'Cancel',exact:true}).last().click();
  await queue.getByRole('searchbox').fill('manual unanswered '+suffix);
  await queue.getByText('Manual unanswered '+suffix+'?',{exact:true}).waitFor();
  await queue.getByRole('searchbox').fill('strazce');
  await queue.locator('summary').click();
  assert.ok(await queue.getByText('Strážce se vrátil.',{exact:true}).count() >= 1);
  if(process.env['CODEX_UI_SCREENSHOTS']==='1') await queue.screenshot({path:resolve(output,'investigation-queue-'+suffix+'.png')});
  await player.page.goto('/#/mysteries');
  const playerQueue = player.page.locator('codex-investigation-queue');
  await playerQueue.getByRole('searchbox').waitFor();
  assert.ok(!(await playerQueue.textContent())?.includes('Private question '+suffix));
  assert.ok(!(await playerQueue.textContent())?.includes('Unrevealed question '+suffix));
  const filters = player.page.locator('.collection-filter-picker'); await filters.locator('summary').click();
  await filters.getByRole('combobox',{name:'Filter by',exact:true}).selectOption('solved');
  await filters.getByRole('combobox',{name:'Value',exact:true}).selectOption('true');
  await filters.getByRole('button',{name:'Add filter',exact:true}).click();
  await player.page.getByRole('button',{name:'Apply view',exact:true}).click();
  assert.equal(await player.page.locator('a.record-row[href="#/mysteries/'+key+'-open"]').count(),0);
  await player.page.locator('a.record-row[href="#/mysteries/'+key+'"]').waitFor();
  await player.page.evaluate(()=>localStorage.setItem('codex_lang','cs')); await player.page.reload();
  await player.page.locator('codex-investigation-queue').getByRole('searchbox').fill('STRAZCE');
  await player.page.locator('codex-investigation-queue summary').click();
  assert.match(await player.page.locator('codex-investigation-queue summary').textContent() ?? '', /Zodpovězené otázky/);
  assert.ok(await player.page.locator('a.record-row[href="#/mysteries/'+key+'"]').getByText('Vyřešeno',{exact:true}).count());
  assert.ok(await player.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});

for (const mobile of [false,true]) for (const locale of ['en','cs']) for (const theme of ['classic','moonlit']) for (const fonts of ['bundled','fallback']) {
  test(`compact profiles and collection controls work on ${mobile?'phone':'desktop'} in ${locale}/${theme} with ${fonts} fonts`, async t => {
    const suffix = [mobile?'phone':'desktop',locale,theme,fonts].join('-'), key = 'compact-'+suffix;
    await put(admin,csrf,key,{name:'Sparse '+suffix,description:'A clear purpose near the top.'},0,'characters');
    await put(admin,csrf,key+'-rich',{name:'Rich '+suffix,title:'Scout',description:'A detailed campaign member.',species:'Elf',age:120,status:'alive',faction:'party',known:['Guards the northern road.']},0,'characters');
    await put(admin,csrf,key+'-faction',{name:'Faction '+suffix,description:'Protect the northern road.'},0,'factions');
    const dm = await open(t,'dm',mobile,fonts === 'fallback');
    const portrait = Buffer.from(await dm.page.evaluate(() => {
      const canvas=document.createElement('canvas'); canvas.width=90; canvas.height=120;
      const ctx=canvas.getContext('2d')!; ctx.fillStyle='#729ca5'; ctx.fillRect(0,0,90,120);
      ctx.fillStyle='#213e49'; ctx.fillRect(15,20,60,100);
      return canvas.toDataURL('image/png').split(',')[1]!;
    }),'base64');
    const uploaded=await jsonResponse(await admin.post('/api/media/character-portrait/'+key+'-rich',{
      headers:{'X-Codex-CSRF':csrf,'Content-Type':'image/png','X-Codex-Filename':'portrait.png'},data:portrait}));
    const rich=await record(key+'-rich','characters');
    await put(admin,csrf,key+'-rich',{...rich.value,portrait:uploaded.url},rich.revision,'characters');
    const currentAppearance=await record('appearance','settings');
    await jsonResponse(await admin.post('/api/campaign/transactions',{headers:{'X-Codex-CSRF':csrf},data:{
      contractVersion:'campaign-mutation.v1',mutations:[{operation:'put',collection:'settings',key:'appearance',expectedRevision:currentAppearance?.revision??0,value:{theme}}],
    }}));
    await dm.page.evaluate(locale=>localStorage.setItem('codex_lang',locale),locale);
    await dm.page.goto('/#/characters/'+key); await dm.page.reload();
    await dm.page.locator('#record-title').waitFor();
    assert.equal(await dm.page.locator('html').getAttribute('data-theme'),theme);
    const mark=await dm.page.locator('.record-portrait-placeholder').boundingBox(); assert.ok(mark && mark.height<=48 && mark.width<=48);
    const overview=await dm.page.locator('.character-wiki').boundingBox(); assert.ok(overview && (!mobile || overview.y<650),'sparse prose is reachable in the first phone screen');
    const extra=dm.page.locator('.character-empty-details');
    assert.equal(await extra.getAttribute('open'),null);
    await extra.locator('summary').focus(); await dm.page.keyboard.press('Enter');
    await extra.getByRole('button',{name:locale==='en'?'Edit Age':'Upravit: Věk',exact:true}).waitFor();
    await extra.locator('summary').click();
    if(process.env['CODEX_UI_SCREENSHOTS']==='1') await dm.page.screenshot({path:resolve(output,'compact-profile-'+suffix+'.png')});
    await dm.page.goto('/#/characters/'+key+'-rich'); await dm.page.locator('img.record-portrait').waitFor();
    const art=await dm.page.locator('img.record-portrait').boundingBox(); assert.ok(art && Math.abs(art.width/art.height-.75)<.02);
    await dm.page.goto('/#/factions/'+key+'-faction'); await dm.page.locator('#record-title').waitFor();
    const emblem=await dm.page.locator('.record-portrait-placeholder').boundingBox(); assert.ok(emblem && emblem.height<=48);
    await dm.page.goto('/#/characters?q='+encodeURIComponent(suffix));
    const list=dm.page.locator('codex-collection-browser');
    const roster=list.locator('.collection-roster');
    await roster.waitFor(); assert.equal(await roster.locator('[aria-pressed="true"]').textContent(),locale==='en'?'All characters':'Všechny postavy');
    assert.equal(await list.locator('.collection-view-options').getAttribute('open'),null);
    assert.equal(await list.locator('a.record-row').count(),2);
    await roster.getByRole('button',{name:locale==='en'?'NPCs':'Cizí postavy',exact:true}).click();
    assert.equal(await list.locator('a.record-row').count(),1);
    await dm.page.reload(); await list.locator('a.record-row').waitFor();
    assert.equal(await list.locator('a.record-row').count(),1);
    await roster.getByRole('button',{name:locale==='en'?'All characters':'Všechny postavy',exact:true}).click();
    await list.locator('img.record-row-mark').waitFor();
    const cardArt=await list.locator('img.record-row-mark').boundingBox(); assert.ok(cardArt && Math.abs(cardArt.width/cardArt.height-.75)<.02);
    if(process.env['CODEX_UI_SCREENSHOTS']==='1') await dm.page.screenshot({path:resolve(output,'compact-collection-default-'+suffix+'.png')});
    const options=list.locator('.collection-view-options');
    await options.locator('summary').focus(); await dm.page.keyboard.press('Enter');
    await options.getByRole('combobox').first().selectOption('updatedAt');
    await list.getByRole('button',{name:locale==='en'?'Apply view':'Použít zobrazení',exact:true}).click();
    assert.equal(await dm.page.evaluate(()=>document.activeElement?.textContent?.trim()),locale==='en'?'Apply view':'Použít zobrazení');
    await dm.page.reload(); await options.getByRole('combobox').first().waitFor();
    assert.equal(await options.getByRole('combobox').first().inputValue(),'updatedAt');
    if(process.env['CODEX_UI_SCREENSHOTS']==='1') await dm.page.screenshot({path:resolve(output,'compact-collection-'+suffix+'.png')});
    // Page zoom reduces the CSS viewport and changes responsive breakpoints.
    // CSS zoom only magnifies elements and can disappear on full navigation.
    for (const width of [720, 320]) {
      await dm.page.setViewportSize({ width, height: 800 });
      await dm.page.goto('/#/characters?q='+encodeURIComponent(suffix));
      await list.locator('a.record-row').first().waitFor();
      await assertViewportReflow(dm.page, 'collection', width);
      await dm.page.goto('/#/characters/'+key);
      await dm.page.locator('#record-title').waitFor();
      await assertViewportReflow(dm.page, 'profile', width);
    }
  });
}

test('campaign save feedback distinguishes dirty, pending, confirmed and failed edits', async t => {
  await put(admin,csrf,'feedback-town',{name:'Feedback town'});
  const dm=await open(t,'dm'); await dm.page.goto('/#/locations/feedback-town');
  await dm.page.getByRole('button',{name:'Edit',exact:true}).click();
  await dm.page.getByLabel('Name',{exact:true}).fill('Feedback saved');
  await dm.page.locator('.record-form-status').getByText('Unsaved changes',{exact:true}).waitFor();
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;}); t.after(()=>release());
  await dm.page.route('**/api/campaign/transactions',async route=>{await gate; await route.continue();});
  await dm.page.getByRole('button',{name:'Save entry',exact:true}).last().click();
  await dm.page.locator('.record-form-status').getByText('Saving…',{exact:true}).waitFor();
  assert.equal(await dm.page.locator('.record-save-confirmation').count(),0);
  assert.ok(await dm.page.getByRole('button',{name:'Cancel',exact:true}).isDisabled());
  release(); await dm.page.getByRole('heading',{name:'Feedback saved',exact:true}).waitFor();
  await dm.page.locator('.record-save-confirmation').getByText('Entry saved to campaign.',{exact:true}).waitFor();
  await dm.page.unroute('**/api/campaign/transactions');
  await dm.page.getByRole('button',{name:'Edit',exact:true}).click();
  await dm.page.getByLabel('Name',{exact:true}).fill('A later draft');
  assert.equal(await dm.page.locator('.record-save-confirmation').count(),0);
  const current=await record('feedback-town');
  await put(admin,csrf,'feedback-town',{...current.value,name:'Remote change'},current.revision);
  await dm.page.getByRole('button',{name:'Save entry',exact:true}).last().click();
  await dm.page.locator('.record-form-status').getByText('Changes not saved. Your draft is kept.',{exact:true}).waitFor();
  assert.equal(await dm.page.getByLabel('Name',{exact:true}).inputValue(),'A later draft');
  dm.page.once('dialog',dialog=>dialog.accept());
  await dm.page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await dm.page.locator('.application-alert').count(),0);
  await dm.page.getByRole('heading',{name:'Remote change',exact:true}).waitFor();
});

test('empty profile fields keep keyboard focus when saved or cancelled', async t => {
  await put(admin,csrf,'focus-character',{name:'Focus character',description:'Short overview.'},0,'characters');
  const dm=await open(t,'dm',true); await dm.page.goto('/#/characters/focus-character');
  await dm.page.locator('.character-empty-details > summary').click();
  await dm.page.getByRole('button',{name:'Edit Age',exact:true}).click();
  const age=dm.page.getByRole('textbox',{name:'Age',exact:true});
  await age.fill('30'); await age.press('Escape');
  assert.equal(await dm.page.evaluate(()=>document.activeElement?.getAttribute('data-edit-field')),'age');
  assert.equal((await record('focus-character','characters')).value.age,undefined);
  await dm.page.getByRole('button',{name:'Edit Age',exact:true}).click();
  await age.fill('31'); await age.press('Enter');
  await dm.page.getByRole('button',{name:'Edit Age',exact:true}).filter({hasText:'31'}).waitFor();
  await dm.page.waitForFunction(()=>document.activeElement?.getAttribute('data-edit-field')==='age');
  assert.equal(await dm.page.locator('.character-empty-details [data-edit-field="age"]').count(),0);
});
