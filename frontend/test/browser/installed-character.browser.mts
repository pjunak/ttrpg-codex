import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { chromium, request, type APIRequestContext, type Browser } from 'playwright';
import { jsonResponse, installReviewedPackage, enableAllRuleSources } from './installed-graph-fixture.mts';
import { unloadBlocked } from './installed-planner-navigation-fixture.mts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-character');
const paths = [process.env.CODEX_ENGINE_ZIP, process.env.CODEX_SHEETS_ZIP, process.env.CODEX_COMPENDIUM_ZIP];
const enabled = paths.every(Boolean);
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, admin: APIRequestContext, browser: Browser, csrf: string, origin: string, hostOutput = '';
before(async () => {
  if (!enabled) return;
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = (probe.address() as AddressInfo).port; await new Promise(done => probe.close(done)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], { cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-character-dm', CODEX_PLAYER_PASSWORD: 'local-character-player' }, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await request.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Local fixture starting. */ } await sleep(100); }
  assert.ok(ready, hostOutput); csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-character-dm' } }))).csrfToken;
  const ids = ['dnd-engine', 'dnd-sheets', 'dnd-2024-compendium'];
  for (let index = 0; index < paths.length; index++) await installReviewedPackage(admin, csrf, ids[index]!, await readFile(resolve(paths[index]!)), []);
  await enableAllRuleSources(admin, csrf);
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection: 'characters', key: 'new-hero', expectedRevision: 0, value: { id: 'new-hero', name: 'New Hero', knowledge: 4, visibility: 'public' } }] } }));
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close(); await admin?.dispose(); if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; }
  if (directory) { const child = relative(output, directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
async function call(method: string, params: Record<string, unknown>) {
  const state = await jsonResponse(await admin.get('/api/admin/addons/dnd-sheets'));
  const base = `/api/addons/dnd-sheets/generations/${state.state.activeGenerationId}/services`, headers = { 'X-Codex-CSRF': csrf };
  const connection = await jsonResponse(await admin.post(`${base}/connect`, { headers, data: { contractVersion: 'addon-service-connect.v1', contract: 'dnd5e.character', range: '^1.0.0', cardinality: 'many', includeOwn: true } }));
  const target = connection.providers.find((provider: { addonId: string }) => provider.addonId === 'dnd-sheets'); assert.ok(target);
  return (await jsonResponse(await admin.post(`${base}/call`, { headers, data: { contractVersion: 'addon-service-call.v1', contract: 'dnd5e.character', providerAddonId: target.addonId, providerVersion: target.contractVersion, providerGeneration: target.generation, bindingRevision: target.bindingRevision, method, params: { contractVersion: 'character.v1', key: 'new-hero', ...params }, deadlineMs: 30000 } }))).result;
}

test('installed character coordinator loads typed creation policy and rejects browser head writes', { skip: !enabled }, async () => {
  const loaded = await call('load', {});
  assert.equal(loaded.status, 'ready', JSON.stringify(loaded)); assert.equal(loaded.revision, 0); assert.equal(loaded.evaluation.ready, false); assert.equal(loaded.policy.maximumLevel, 20);
  const state = await jsonResponse(await admin.get('/api/admin/addons/dnd-sheets'));
  const response = await admin.post(`/api/addons/dnd-sheets/generations/${state.state.activeGenerationId}/data/transactions`, { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'addon-data-transaction.v1', mutations: [{ operation: 'put', kind: 'record-extension', dataId: 'dnd-sheets', key: 'new-hero', expectedRevision: 0, value: {} }] } });
  assert.equal(response.status(), 403, 'browser mutated a retained character head');
});

test('installed replacement sheet recovers drafts and offers accessible rule details on desktop and phone', { skip: !enabled }, async () => {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, storageState: await admin.storageState() });
    const page = await context.newPage(), failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
    await page.goto(`${origin}/#/characters/new-hero`);
    await page.locator('#character-view-addons').click();
    const sheet = page.locator('.addon-dnd-character');
    try { await sheet.getByRole('heading', { name: 'Origin and abilities' }).waitFor(); }
    catch (error) { await page.screenshot({ path: resolve(output, `failed-character-${width}.png`), fullPage: true }); throw new Error(`${String(error)}\nPage errors: ${JSON.stringify(failures)}\nPage: ${(await page.locator('body').innerText()).slice(0, 8000)}`); }
    await sheet.getByLabel('Character notes', { exact: true }).fill(`Recovered draft ${width}`);
    page.once('dialog', dialog => dialog.accept());
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.getByLabel('Character notes', { exact: true }).waitFor();
    assert.equal(await sheet.getByLabel('Character notes', { exact: true }).inputValue(), `Recovered draft ${width}`);
    await page.screenshot({ path: resolve(output, `character-layout-${width}.png`), fullPage: true });
    assert.ok(await sheet.evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), JSON.stringify(await sheet.evaluate(element => [...element.querySelectorAll('*')].filter(node=>node.getBoundingClientRect().right>document.documentElement.clientWidth).map(node=>({tag:node.tagName,class:node.className,width:node.getBoundingClientRect().width,text:node.textContent?.slice(0,60)})).slice(0,10))));
    const details = sheet.locator('codex-addon-rule-details').first(); await details.getByRole('button').first().click();
    await details.getByRole('dialog').waitFor(); await page.keyboard.press('Escape'); await details.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(failures, []); await page.screenshot({ path: resolve(output, `character-${width}.png`), fullPage: true }); await context.close();
  }
});

test('installed character creation, DM grant, play and restoration retain exact revisions', { skip: !enabled }, async () => {
  const initial = await call('load', {}), input = initial.evaluation.inputs;
  input.build.method = 'array'; input.build.baseScores = { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 };
  input.build.species = 'dwarf'; input.build.background = 'soldier'; input.build.levels = [{ id: 'level-one', classId: 'fighter' }];
  type Descriptor = Record<string, unknown>;
  for (let round = 0; round < 5; round++) {
    const response = await call('evaluate', { operation: 'build', inputs: input, expectedRevision: 0 });
    assert.equal(response.status, 'ready', JSON.stringify(response));
    if (response.evaluation.ready) break;
    const plan = response.evaluation.plan, guidance = response.evaluation.guidance.choices;
    for (const descriptor of [...plan.creationChoices, ...plan.creationAbilityChoices, ...plan.classChoices] as Descriptor[]) {
      const id = String(descriptor.id); if (input.build.choices.some((choice: { id: string }) => choice.id === id)) continue;
      if (descriptor.kind === 'abilityBudget') {
        const assignment: Record<string, number> = {}; let remaining = Number(descriptor.budget);
        for (const ability of descriptor.eligible as string[]) { const amount = Math.min(remaining, Number(descriptor.perAbilityMax)); if (amount > 0) assignment[ability] = amount; remaining -= amount; }
        input.build.choices.push({ id, slot: 0, value: assignment });
      } else {
        const choices = guidance[id]?.options ?? [];
        for (let slot = 0; slot < Number(descriptor.count ?? 1) && choices[slot]; slot++) input.build.choices.push({ id, slot, value: choices[slot].id });
      }
    }
  }
  const create = await call('preview', { operation: 'build', inputs: input, expectedRevision: 0, operationId: 'installed-create', summary: 'Create a rules-checked fighter' });
  assert.ok(create.token, JSON.stringify(create.evaluation?.issues ?? create));
  const saved = await call('commit', { token: create.token, operationId: 'installed-create', expectedRevision: 0 }); assert.equal(saved.revision, 1, JSON.stringify(saved));
  const grant = await call('preview', { operation: 'grant', expectedRevision: 1, operationId: 'installed-grant', summary: 'DM Constitution reward', grant: { id: 'untrusted', actorId: 'untrusted', grantedAt: '', name: 'Quest reward', reason: 'Rescued the village', active: true, effectiveLevel: 1, condition: 'always', effects: [{ target: 'abilityScore', key: 'CON', mode: 'add', value: 2 }], waivers: [] } });
  assert.ok(grant.token, JSON.stringify(grant)); const granted = await call('commit', { token: grant.token, operationId: 'installed-grant', expectedRevision: 1 }); assert.equal(granted.revision, 2);
  assert.equal(granted.state.projection.sheet.derived.maxHp, saved.state.projection.sheet.derived.maxHp + 1); assert.notEqual(granted.state.inputs.grants[0].actorId, 'untrusted');
  const restore = await call('preview', { operation: 'restore', revision: 1, expectedRevision: 2, operationId: 'installed-restore', summary: 'Restore creation decisions', reauthorizeGrants: true }); assert.ok(restore.token, JSON.stringify(restore));
  const restored = await call('commit', { token: restore.token, operationId: 'installed-restore', expectedRevision: 2 }); assert.equal(restored.revision, 3);
  assert.deepEqual((await call('revision', { revision: 1 })).state, saved.state); assert.deepEqual((await call('history', {})).history.map((entry: { revision: number }) => entry.revision), [3, 2, 1]);
});

test('installed character play records real bounded actions and preserves past snapshots', { skip: !enabled }, async () => {
  let current = await call('load', {});
  const apply = async (change: Record<string,unknown>, id: string) => {
    const p = await call('preview',{operation:'play',change,expectedRevision:current.revision,operationId:id,summary:id});
    assert.ok(p.token,JSON.stringify(p));
    current = await call('commit',{token:p.token,operationId:id,expectedRevision:current.revision});
    assert.equal(current.status,'ready');
  };
  await apply({operation:'rest',rest:'long'},'installed-long-rest');
  const maximum = current.state.projection.sheet.derived.maxHp;
  await apply({operation:'set-temporary-hp',amount:3},'installed-temp-hp');
  await apply({operation:'damage',amount:5},'installed-damage');
  assert.equal(current.state.inputs.play.hp,maximum-2); assert.equal(current.state.inputs.play.temporaryHp,0);
  const revision = current.revision;
  await assert.rejects(()=>call('preview',{operation:'play',change:{operation:'set-hp',amount:maximum+1},expectedRevision:revision,operationId:'invalid-overheal',summary:'Invalid direct HP'}));
  assert.equal((await call('load',{})).revision,revision);
  await apply({operation:'heal',amount:100},'installed-heal');assert.equal(current.state.inputs.play.hp,maximum);
  const old=await call('revision',{revision});assert.equal(old.state.inputs.play.hp,maximum-2);
  assert.ok(current.state.projection.evidence.every((source:{packageGeneration:string;hash:string})=>source.packageGeneration.length===64&&source.hash.length===64));
});

test('installed sheet retains failed drafts, reviews transfers and prints exact saved revisions', {skip:!enabled},async t=>{
  const context=await browser.newContext({storageState:await admin.storageState(),viewport:{width:1280,height:1000}});t.after(()=>context.close());
  const page=await context.newPage();await page.goto(`${origin}/#/characters/new-hero`);await page.locator('#character-view-addons').click();
  const sheet=page.locator('.addon-dnd-character');await sheet.getByRole('heading',{name:'Play state',exact:true}).waitFor();
  const original=await call('load',{});
  await sheet.getByLabel('Sheet layout').selectOption('classic');assert.equal(await sheet.getAttribute('data-layout'),'classic');
  await sheet.getByLabel('Character notes',{exact:true}).fill('Durable session notes');
  await sheet.getByRole('button',{name:'Save notes',exact:true}).click();
  const review=sheet.getByRole('dialog',{name:'Review character changes',exact:true});await review.waitFor();
  let failed=false;
  await page.route('**/services/call',async route=>{
    if(route.request().postDataJSON()?.method==='commit'&&!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{kind:'UNAVAILABLE',message:'Temporary test interruption'}})});}else await route.continue();
  });
  await review.getByRole('button',{name:'Save new revision',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.addon-dnd-character')?.getAttribute('aria-busy')===null);
  assert.equal((await call('load',{})).revision,original.revision);assert.equal(await unloadBlocked(page),true);
  assert.equal(await sheet.getByLabel('Character notes',{exact:true}).inputValue(),'Durable session notes');
  await review.getByRole('button',{name:'Save new revision',exact:true}).click();await review.waitFor({state:'hidden'});
  const saved=await call('load',{});assert.equal(saved.revision,original.revision+1);assert.equal(saved.state.inputs.notes,'Durable session notes');
  const downloadPromise=page.waitForEvent('download');await sheet.getByRole('button',{name:'Export saved revision',exact:true}).click();
  const download=await downloadPromise, path=await download.path();assert.ok(path);
  const envelope=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(envelope.savedProjection,saved.state.projection);assert.deepEqual(envelope.inputs,saved.state.inputs);
  await sheet.getByRole('button',{name:'Import character',exact:true}).click();
  const imported=sheet.getByRole('dialog',{name:'Import current character',exact:true});
  envelope.inputs.notes='Imported replacement notes';await imported.getByLabel('Or paste the export').fill(JSON.stringify(envelope));
  await imported.getByRole('button',{name:'Review import',exact:true}).click();await review.waitFor();
  assert.equal((await call('load',{})).revision,saved.revision);await review.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal((await call('load',{})).state.inputs.notes,'Durable session notes');
  await sheet.getByRole('button',{name:'Print / PDF',exact:true}).click();
  const printOptions=sheet.getByRole('dialog',{name:'Print / PDF',exact:true});await printOptions.getByLabel('Provenance').check();
  const popupPromise=page.waitForEvent('popup');await printOptions.getByRole('button',{name:'Open print preview',exact:true}).click();
  const printed=await popupPromise;await printed.getByRole('heading',{name:'New Hero',exact:true}).waitFor();
  assert.match(await printed.locator('body').innerText(),new RegExp(`Saved character revision ${saved.revision}`));
  assert.match(await printed.locator('body').innerText(),/Durable session notes/);
  for(const format of ['A4','Letter'] as const){const pdf=await printed.pdf({format,path:resolve(output,`character-${format}.pdf`),printBackground:true});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');}
  await printed.screenshot({path:resolve(output,'character-print.png'),fullPage:true});await printed.close();
});

test('installed history comparison, file import and Czech drafts use the current saved model', {skip:!enabled},async t=>{
  const context=await browser.newContext({storageState:await admin.storageState(),viewport:{width:390,height:900}});t.after(()=>context.close());
  const page=await context.newPage();await page.goto(`${origin}/#/characters/new-hero`);await page.locator('#character-view-addons').click();
  const sheet=page.locator('.addon-dnd-character');await sheet.getByRole('heading',{name:'Play state',exact:true}).waitFor();
  const original=await call('load',{});
  await sheet.getByRole('navigation').getByRole('button',{name:'History',exact:true}).click();await sheet.getByRole('button',{name:'Compare saved revisions',exact:true}).click();
  const compare=sheet.getByRole('dialog',{name:'Compare saved revisions',exact:true});await compare.getByLabel('Earlier revision').fill('1');await compare.getByLabel('Later revision').fill('2');await compare.getByRole('button',{name:'Show comparison',exact:true}).click();
  const differences=sheet.getByRole('dialog',{name:'Revision 1 → 2',exact:true});await differences.waitFor();assert.match(await differences.innerText(),/Quest reward|Grants/);assert.equal((await call('load',{})).revision,original.revision);await differences.getByRole('button',{name:'Close',exact:true}).click();
  const envelope={format:'dnd-character.v1',schemaVersion:'4.0.0',inputs:structuredClone(original.state.inputs),savedProjection:original.state.projection,savedRules:original.state.rules};envelope.inputs.notes='Imported from a reviewed file';
  await sheet.getByRole('button',{name:'Import character',exact:true}).click();const transfer=sheet.getByRole('dialog',{name:'Import current character',exact:true});
  await transfer.getByLabel('Choose a file').setInputFiles({name:'character.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(envelope))});
  await page.waitForFunction(()=>document.querySelector('.addon-dnd-character')?.getAttribute('aria-busy')===null);
  assert.equal(JSON.parse(await transfer.getByLabel('Or paste the export').inputValue()).inputs.notes,envelope.inputs.notes);
  await transfer.getByRole('button',{name:'Review import',exact:true}).click();const review=sheet.getByRole('dialog',{name:'Review character changes',exact:true});await review.waitFor();assert.equal((await call('load',{})).revision,original.revision);
  await review.getByRole('button',{name:'Save new revision',exact:true}).click();await review.waitFor({state:'hidden'});
  const imported=await call('load',{});assert.equal(imported.state.inputs.notes,envelope.inputs.notes);assert.deepEqual((await call('revision',{revision:original.revision})).state,original.state);
  await page.evaluate(()=>localStorage.setItem('codex_lang','cs'));await page.reload();await page.locator('#character-view-addons').click();
  await sheet.getByRole('button',{name:'Uložit poznámky',exact:true}).waitFor();await sheet.getByRole('button',{name:'Tvorba',exact:true}).click();
  const notes=sheet.getByLabel('Poznámky k postavě',{exact:true});await notes.fill('Český koncept po importu');page.once('dialog',dialog=>dialog.accept());await page.reload();await page.locator('#character-view-addons').click();await notes.waitFor();assert.equal(await notes.inputValue(),'Český koncept po importu');
  assert.match(await sheet.locator('[data-character-status]').innerText(),/koncept/i);
  const details=sheet.locator('codex-addon-rule-details').first();await details.getByRole('button').first().click();await details.getByRole('button',{name:'Zavřít podrobnosti pravidla',exact:true}).waitFor();await page.keyboard.press('Escape');
  assert.ok(await sheet.evaluate(element=>element.scrollWidth<=document.documentElement.clientWidth));
});

test('installed character retains concurrent drafts and appends campaign recovery', {skip:!enabled},async t=>{
  const original=await call('load',{}), headers={'X-Codex-CSRF':csrf};
  const checkpoint=await jsonResponse(await admin.post('/api/recovery',{headers,data:{}}));
  const context=await browser.newContext({storageState:await admin.storageState()});t.after(()=>context.close());
  const page=await context.newPage();await page.goto(`${origin}/#/characters/new-hero`);await page.locator('#character-view-addons').click();
  const sheet=page.locator('.addon-dnd-character'), notes=sheet.getByLabel('Character notes',{exact:true});await notes.waitFor();
  await notes.fill('Concurrent browser draft');
  const changed=structuredClone(original.state.inputs);changed.notes='Saved in another editor';
  const request={operation:'notes',operationId:'concurrent-notes',expectedRevision:original.revision,inputs:changed,summary:'Other editor notes'};
  const preview=await call('preview',request);await call('commit',{token:preview.token,operationId:request.operationId,expectedRevision:original.revision});
  await sheet.locator('[data-character-status]').filter({hasText:'saved character changed'}).waitFor();
  assert.equal(await notes.inputValue(),'Concurrent browser draft');assert.equal(await unloadBlocked(page),true);
  await sheet.getByRole('navigation').getByRole('button',{name:'Build',exact:true}).click();await sheet.getByRole('button',{name:'Rebase this draft for a new review',exact:true}).waitFor();
  const listing=await jsonResponse(await admin.get('/api/recovery'));
  await jsonResponse(await admin.post('/api/recovery/restore',{headers,data:{id:checkpoint.points[0].id,expectedRevision:listing.revision}}));
  const recovered=await call('load',{});assert.equal(recovered.revision,original.revision+2);assert.deepEqual(recovered.state,original.state);
  assert.equal((await call('revision',{revision:original.revision+1})).state.inputs.notes,'Saved in another editor');
  assert.equal(await notes.inputValue(),'Concurrent browser draft');
  page.once('dialog',dialog=>dialog.accept());await page.reload();await page.locator('#character-view-addons').click();await notes.waitFor();assert.equal(await notes.inputValue(),'Concurrent browser draft');
  await sheet.getByRole('button',{name:'Reload saved character',exact:true}).click();await sheet.getByRole('button',{name:'Discard draft and reload',exact:true}).click();
  await sheet.getByRole('navigation').getByRole('button',{name:'History',exact:true}).click();await sheet.getByRole('button',{name:'Export with history',exact:true}).click();
  const archiveDialog=sheet.getByRole('dialog',{name:'Export with history',exact:true});await archiveDialog.getByLabel('Recent revisions').fill('1');
  const pending=page.waitForEvent('download',{timeout:5000});await archiveDialog.getByRole('button',{name:'Download history archive',exact:true}).click();const download=await pending.catch(async error=>{throw new Error(`${String(error)}; sheet status: ${await sheet.locator('[data-character-status]').innerText()}; busy: ${await sheet.getAttribute('aria-busy')}`);}),path=await download.path();assert.ok(path);
  const body=await readFile(path,'utf8'),archive=JSON.parse(body);assert.equal(archive.externalHistory.length,1);assert.deepEqual(archive.externalHistory[0].state,recovered.state);
  await archiveDialog.getByRole('button',{name:'Close',exact:true}).click();await sheet.getByRole('button',{name:'Import character',exact:true}).click();
  const transfer=sheet.getByRole('dialog',{name:'Import current character',exact:true});
  const area=transfer.getByLabel('Or paste the export');await area.focus();
  await area.evaluate((node:HTMLTextAreaElement,text)=>{const data=new DataTransfer();data.setData('text/plain',text);node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},body);
  assert.equal(await area.inputValue(),body);
  await area.evaluate((node:HTMLTextAreaElement)=>{const data=new DataTransfer();data.setData('text/plain','x'.repeat(1000001));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});assert.equal(await area.inputValue(),body,'oversized paste replaced the retained transfer');
  await transfer.getByRole('button',{name:'Save frozen import on this device',exact:true}).click();
  await page.reload();await page.locator('#character-view-addons').click();await sheet.getByRole('button',{name:'Import character',exact:true}).click();assert.equal(await transfer.getByLabel('Or paste the export').inputValue(),body);
  await transfer.getByRole('button',{name:'Inspect external history',exact:true}).click();await sheet.getByRole('dialog',{name:'External history · unverified provenance',exact:true}).waitFor();assert.equal((await call('load',{})).revision,recovered.revision);
});

test('installed sheet reviews source-policy adoption and remains readable without providers', {skip:!enabled},async t=>{
  const before=await call('load',{}), policy=await jsonResponse(await admin.get('/api/admin/rules-policy'));
  type Source={addonId:string;setId:string;id:string;enabled:boolean};
  const unused=(policy.sources as Source[]).find(source=>source.enabled&&!before.state.projection.evidence.some((entry:{book:string})=>entry.book===source.id));assert.ok(unused);
  await jsonResponse(await admin.post('/api/admin/rules-policy',{headers:{'X-Codex-CSRF':csrf},data:{expectedRevision:policy.revision,expectedGraphRevision:policy.graphRevision,enabled:(policy.sources as Source[]).filter(source=>source.enabled&&source.id!==unused.id).map(({addonId,setId,id})=>({addonId,setId,id}))}}));
  const changed=await call('load',{});assert.equal(changed.rulesChanged,true,JSON.stringify({status:changed.status,message:changed.message}));assert.deepEqual(changed.state,before.state);
  const request={operation:'adopt-rules',operationId:'adopt-source-policy',summary:'Review allowed sources',expectedRevision:changed.revision};
  const unapproved=await call('preview',request);assert.equal(unapproved.status,'rules-changed');assert.equal(unapproved.token,undefined);
  const reviewed=await call('preview',{...request,adoptRules:true});assert.ok(reviewed.token,JSON.stringify(reviewed));
  const adopted=await call('commit',{token:reviewed.token,operationId:request.operationId,expectedRevision:changed.revision});assert.notDeepEqual(adopted.state.rules,before.state.rules);
  assert.deepEqual((await call('revision',{revision:before.revision})).state,before.state);
  for(const id of ['dnd-sheets','dnd-engine','dnd-2024-compendium']){const addon=await jsonResponse(await admin.get(`/api/admin/addons/${id}`));await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`,{headers:{'X-Codex-CSRF':csrf},data:{expectedStateRevision:addon.state.revision}}));}
  for(const [index,id] of ['dnd-engine','dnd-sheets'].entries())await installReviewedPackage(admin,csrf,id,await readFile(resolve(paths[index]!)),[]);
  const frozen=await call('load',{});assert.equal(frozen.status,'unavailable');assert.deepEqual(frozen.state,adopted.state);
  const context=await browser.newContext({storageState:await admin.storageState()});t.after(()=>context.close());
  const page=await context.newPage();await page.goto(`${origin}/#/characters/new-hero`);await page.locator('#character-view-addons').click();
  const sheet=page.locator('.addon-dnd-character');await sheet.getByRole('heading',{name:'Play state',exact:true}).waitFor();
  assert.equal(await sheet.getByRole('button',{name:'Heal',exact:true}).isDisabled(),true);assert.equal(await sheet.getByRole('button',{name:'Export saved revision',exact:true}).isEnabled(),true);
  await sheet.getByLabel('Character notes',{exact:true}).fill('Notes while rules are disabled');await sheet.getByRole('button',{name:'Save notes',exact:true}).click();
  const review=sheet.getByRole('dialog',{name:'Review character changes',exact:true});await review.getByRole('button',{name:'Save new revision',exact:true}).click();await review.waitFor({state:'hidden'});
  const noted=await call('load',{});assert.equal(noted.state.inputs.notes,'Notes while rules are disabled');assert.deepEqual(noted.state.projection,adopted.state.projection);
});
