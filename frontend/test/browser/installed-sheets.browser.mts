import type { APIRequestContext, Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, request as playwrightRequest } from 'playwright';
import { jsonResponse, installReviewedPackage } from './installed-graph-fixture.mts';
import { unloadBlocked } from './installed-planner-navigation-fixture.mts';

const archivePath = process.env.CODEX_SHEETS_ZIP;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-sheets');
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, browser: Browser, admin: APIRequestContext, csrf: string, origin: string, hostOutput = '';
before(async () => {
  if (!archivePath) return;
  const archive = await readFile(resolve(archivePath));
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-sheets-dm', CODEX_PLAYER_PASSWORD: 'local-sheets-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-sheets-dm' } }))).csrfToken;
  await installReviewedPackage(admin, csrf, 'dnd-sheets', archive, []);
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

// Rules-dependent creation and saved-revision workflows are exercised by
// installed-character.browser.mts. These cases cover the independent package.
for (const role of ['dm','player']) test(`standalone character package preserves drafts for ${role}`,{skip:!archivePath},async t=>{
  const key=`standalone-${role}`;
  await jsonResponse(await admin.post('/api/campaign/transactions',{headers:{'X-Codex-CSRF':csrf},data:{contractVersion:'campaign-mutation.v1',mutations:[{operation:'put',collection:'characters',key,expectedRevision:0,value:{id:key,name:'Standalone hero',visibility:'public',knowledge:4}}]}}));
  const context=await browser.newContext({baseURL:origin,viewport:{width:390,height:850}});t.after(()=>context.close());
  await jsonResponse(await context.request.post('/api/login',{data:{password:`local-sheets-${role}`}}));
  const page=await context.newPage();await page.goto(`/#/characters/${key}`);await page.locator('#character-view-addons').click();
  const sheet=page.locator('.addon-dnd-character');await sheet.getByLabel('Character notes',{exact:true}).waitFor();
  assert.match(await sheet.innerText(),/Compatible rules are unavailable/);
  await sheet.getByLabel('Character notes',{exact:true}).fill('Standalone draft survives');
  assert.equal(await unloadBlocked(page),true);
  await sheet.getByRole('button',{name:'Review build changes',exact:true}).click();
  await sheet.getByRole('dialog').waitFor();assert.equal(await sheet.getByRole('button',{name:'Save new revision',exact:true}).count(),0);
  await sheet.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  page.once('dialog',dialog=>dialog.accept());await page.reload();await page.locator('#character-view-addons').click();
  assert.equal(await sheet.getByLabel('Character notes',{exact:true}).inputValue(),'Standalone draft survives');
  assert.equal(await sheet.getByRole('button',{name:'Give a DM grant',exact:true}).count(),role==='dm'?1:0);
  await sheet.getByRole('button',{name:'Import character',exact:true}).click();
  await sheet.getByLabel('Or paste the export').fill('{"v":3,"hp":21}');
  await sheet.getByRole('button',{name:'Review import',exact:true}).click();
  assert.match(await sheet.locator('[data-character-status]').textContent()??'',/Retired sheets and raw objects are not supported/);
  assert.equal(await sheet.getByRole('button',{name:'Save new revision',exact:true}).count(),0);
});