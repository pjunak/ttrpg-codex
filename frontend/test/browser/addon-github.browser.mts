import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { visualFixturePlugin } from './visual-fixture.mts';
interface GitHubSource { repo: string; channel: 'actions' | 'release'; branch: string; artifact: string }
interface GitHubLink { addonId: string; revision: number; source: GitHubSource }

let server: PreviewServer, browser: Browser, origin: string;
const output = fileURLToPath(new URL('../../test-results/addon-github/', import.meta.url));
before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error', plugins: [visualFixturePlugin()], preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const mobile of [false, true]) test(`GitHub installation, token management and reviewed updates (${mobile ? 'phone' : 'desktop'})`, async t => {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 }, extraHTTPHeaders: { 'X-Fixture-Role': 'dm' } });
  t.after(() => context.close()); const page = await context.newPage(); page.setDefaultTimeout(7000);
  await page.addInitScript(() => { if (!localStorage.getItem('codex_lang')) localStorage.setItem('codex_lang', 'en'); });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const source: GitHubSource = { repo: 'owner/private', channel: 'actions', branch: '', artifact: 'reviewed-package' };
  let links: GitHubLink[] = [], active = '', target = 'a'.repeat(64), revision = 0, downloads = 0, checks = 0, tokenWrites = 0, lostTokenResponse = false, failDiscovery = false;
  let reviewed = '', discoveryError = 'GITHUB_UNAVAILABLE';
  let heldDiscovery: Promise<void> | undefined, finishDiscovery: (() => void) | undefined;
  t.after(() => finishDiscovery?.());
  const tokens = new Map<string, string>();
  const generations: { addonId: string; generationId: string; version: string; installedAt: string }[] = [];
  const status = () => ({ contractVersion: 'addon-github.v1', sources: links, credentials: { defaultSource: tokens.has('') ? 'stored' : 'none', environmentConfigured: false, repositories: [...tokens.keys()].filter(Boolean) } });
  const review = (state = 'prepared') => ({ reviewId: 'review-1', addonId: 'example', generationId: reviewed, proposalSha256: 'e'.repeat(64), status: state,
    proposal: { addonId: 'example', generationId: reviewed, targetManifest: { id: 'example', name: 'GitHub test', version: generations.find(g => g.generationId === reviewed)!.version, permissions: [] },
      ...(active ? { currentManifest: { version: generations.find(g => g.generationId === active)!.version } } : {}), changes: { runtimeChanged: false }, requiredPermissionIds: [], restartedAddonIds: [], blockers: [] } });
  await page.route('**/api/admin/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname, body = req.headers()['content-type']?.includes('application/json') && req.postData() ? req.postDataJSON() as Record<string, unknown> : {};
    if (req.method() === 'POST') assert.equal(req.headers()['x-codex-csrf'], 'x'.repeat(32));
    let value: unknown;
    if (path === '/api/admin/addon-github') value = status();
    else if (path.endsWith('/addon-github/token')) {
      tokenWrites++; const repo = String(body.repo).toLowerCase(), token = String(body.token);
      if (token) tokens.set(repo, token); else tokens.delete(repo);
      if (lostTokenResponse) { lostTokenResponse = false; await route.abort('failed'); return; } value = status();
    } else if (path.endsWith('/addon-github/source')) {
      if (body.remove) links = []; else links = [{ addonId: String(body.addonId), revision: Number(body.revision)+1, source: body.source as GitHubSource }]; value = status();
    } else if (path.endsWith('/addon-github/discover')) {
      checks++; if (heldDiscovery) { const held = heldDiscovery; heldDiscovery = undefined; await held; }
      if (failDiscovery) { await route.fulfill({ status: 502, json: { error: { kind: discoveryError } } }); return; }
      value = { source, candidates: [{ id: target, name: 'reviewed-package', version: target, digest: '', active: target === active, provenance: { commit: target.slice(0, 40), runId: '1234', runAttempt: 2, publishedAt: '2026-09-15T10:00:00Z', notes: '', notesTruncated: false } }] };
    } else if (path.endsWith('/addon-github/stage')) {
      downloads++; assert.equal(body.candidateId, target);
      const generation = { addonId: 'example', generationId: target, version: '1.0.0', installedAt: '2026-09-10T10:00:00Z' };
      if (!generations.some(g => g.generationId === target)) generations.push(generation);
      if (!links.length) links = [{ addonId: 'example', revision: 1, source }]; value = generation;
    } else if (path === '/api/admin/addons/generations') {
      const generation = { addonId: 'example', generationId: 'c'.repeat(64), version: '2.0.0', installedAt: '2026-09-12T10:00:00Z' };
      generations.push(generation); value = generation;
    }
    else if (path === '/api/admin/addons') value = { contractVersion: 'addon-inventory.v1', addonIds: generations.length ? ['example'] : [] };
    else if (path === '/api/admin/addons/example') value = { state: { addonId: 'example', revision, ...(active ? { activeGenerationId: active } : {}) }, generations, events: [] };
    else if (path === '/api/admin/addons/example/activation-reviews') { reviewed = String(body.generationId); value = review(); }
    else if (path.endsWith('/approval')) value = review('approved');
    else if (path.endsWith('/activation')) { active = reviewed; revision++; value = { state: { addonId: 'example', activeGenerationId: active } }; }
    else { await route.fulfill({ status: 404, json: { error: { kind: 'NOT_FOUND' } } }); return; }
    await route.fulfill({ json: value });
  });
  await page.goto(`${origin}/#/settings`); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), add = manager.getByRole('button', { name: 'Add add-on', exact: true });
  const check = manager.getByRole('button', { name: 'Check for updates', exact: true });
  const dialog = manager.getByRole('dialog'), sourceRow = manager.locator('[data-github-addon="example"]');
  await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  for (const button of [add, check]) assert.equal(await button.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'toolbar labels fit their buttons');
  assert.equal(await manager.locator('input[type="file"]:visible, input[name="repo"]:visible').count(), 0);
  await check.click(); await manager.getByText('No GitHub repositories are linked yet.', { exact: false }).waitFor();
  await add.click(); await dialog.getByRole('heading', { name: 'Choose a source' }).waitFor();
  const githubChoice = dialog.getByRole('button', { name: 'GitHub Install from a repository', exact: false });
  await githubChoice.focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await githubChoice.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await add.evaluate(el => el === document.activeElement), true);
  await add.click(); await githubChoice.click();
  const connect = dialog.locator('form.addon-install-form');
  await connect.locator('input[name="repo"]').fill('owner/private');
  assert.equal(await connect.getByLabel('Package source').inputValue(), 'release', 'new sources default to durable releases');
  assert.equal(await connect.locator('input[name="token"]').count(), 0);
  await connect.getByText('Use this for normal installation and updates.', { exact: false }).waitFor();
  assert.equal(await connect.getByLabel('Package source').getAttribute('aria-describedby'), 'github-source-help');
  await connect.getByLabel('Private repository').check();
  await dialog.getByRole('link', { name: 'Create a fine-grained token on GitHub.' }).waitFor();
  await connect.getByRole('button', { name: 'Find package', exact: true }).click();
  assert.equal(checks, 0, 'a private source requires access before discovery');
  await connect.getByLabel('Package source').selectOption('actions');
  await connect.getByText('For add-on developers or repositories that do not publish packages.', { exact: false }).waitFor();
  await connect.locator('input[name="token"]').fill('synthetic-private-token');
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await dialog.screenshot({ path: `${output}/${mobile ? 'phone' : 'desktop'}-private-wizard.png` });
  heldDiscovery = new Promise<void>(resolve => { finishDiscovery = resolve; });
  await connect.getByRole('button', { name: 'Find package', exact: true }).click();
  await connect.getByRole('button', { name: 'Checking repository…', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true);
  finishDiscovery!();
  await dialog.getByRole('button', { name: 'Download and review' }).waitFor();
  assert.equal(tokenWrites, 1); assert.equal(tokens.get('owner/private'), 'synthetic-private-token');
  assert.equal(await connect.locator('input[name="token"]').inputValue(), '');
  assert.equal(await manager.textContent().then(text => text?.includes('synthetic-private-token')), false);
  // Editing the source invalidates the displayed selection before it can be downloaded.
  await connect.locator('input[name="repo"]').fill('owner/changed');
  await dialog.getByRole('button', { name: 'Download and review' }).waitFor({ state: 'detached' });
  await connect.locator('input[name="repo"]').fill('owner/private');
  await connect.getByRole('button', { name: 'Find package', exact: true }).click();
  await dialog.getByRole('button', { name: 'Download and review' }).waitFor();
  assert.equal(downloads, 0); await dialog.getByRole('button', { name: 'Download and review' }).click();
  const reviewPanel = dialog.locator('.addon-review');
  await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor();
  assert.equal(await page.locator('#addon-review-title').evaluate(el => el === document.activeElement), true);
  assert.equal(active, ''); await reviewPanel.getByRole('button', { name: 'Approve and activate' }).click();
  await dialog.waitFor({ state: 'detached' }); await manager.getByText('Add-on state updated.', { exact: true }).waitFor();
  await check.click(); await sourceRow.getByText('Up to date', { exact: true }).waitFor();
  // A new commit remains an update even when the package version is unchanged.
  target = 'b'.repeat(64); await check.click();
  await sourceRow.getByRole('button', { name: 'Download and review' }).click();
  await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor(); assert.equal(active, 'a'.repeat(64));
  await reviewPanel.getByRole('button', { name: 'Cancel review' }).click(); assert.equal(active, 'a'.repeat(64));
  await check.click(); await sourceRow.getByRole('button', { name: 'Download and review' }).click();
  await reviewPanel.getByRole('button', { name: 'Approve and activate' }).click();
  await dialog.waitFor({ state: 'detached' }); await manager.getByText('Add-on state updated.', { exact: true }).waitFor(); assert.equal(active, target);
  failDiscovery = true; await check.click(); await sourceRow.getByRole('alert').filter({ hasText: 'GitHub could not be reached' }).waitFor();
  discoveryError = 'GITHUB_TLS'; await check.click(); await sourceRow.getByRole('alert').filter({ hasText: 'trusted certificates' }).waitFor();
  failDiscovery = false; await check.click(); await sourceRow.getByText('Up to date', { exact: true }).waitFor();
  await sourceRow.getByText('Build #1234 · attempt 2', { exact: true }).waitFor();
  assert.equal(await sourceRow.getByRole('link', { name: 'Open build on GitHub' }).getAttribute('href'), 'https://github.com/owner/private/actions/runs/1234');
  assert.equal(await sourceRow.locator('code').filter({ hasText: target.slice(0, 40) }).first().isVisible(), true);
  // Source editing and token replacement stay attached to the installed add-on.
  await sourceRow.locator(':scope > details > summary').click(); await sourceRow.getByRole('button', { name: 'Edit GitHub source' }).click();
  await connect.locator('input[name="repo"]').waitFor(); assert.equal(await connect.locator('input[name="repo"]').inputValue(), 'owner/private');
  assert.equal(await connect.getByLabel('Package source').inputValue(), 'actions', 'existing linked sources keep their selected channel');
  lostTokenResponse = true; await connect.locator('input[name="token"]').fill('replacement-private-token');
  await connect.getByRole('button', { name: 'Check and save source' }).click();
  await dialog.getByRole('alert').waitFor(); await dialog.locator('.addon-install-step[aria-busy="false"]').waitFor();
  assert.equal(await connect.locator('input[name="token"]').inputValue(), ''); assert.equal(tokenWrites, 2);
  await connect.getByRole('button', { name: 'Check and save source' }).click();
  await dialog.waitFor({ state: 'detached' }); await sourceRow.getByText('Up to date', { exact: true }).waitFor();
  assert.equal(tokenWrites, 2, 'retry reads saved access without replaying the token write');
  // ZIPs enter the same review and do not replace the active version on cancellation.
  await add.click(); await dialog.getByRole('button', { name: 'ZIP file Upload', exact: false }).click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'example.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic package') });
  await dialog.getByRole('button', { name: 'Inspect ZIP', exact: true }).click();
  await reviewPanel.getByRole('heading', { name: 'Review activation: GitHub test' }).waitFor(); assert.equal(active, target);
  await reviewPanel.getByRole('button', { name: 'Cancel review' }).click(); assert.equal(active, target);
  await page.reload(); await page.locator('[data-category="addons"]').click(); await sourceRow.waitFor();
  const tokensPanel = manager.locator('.github-tokens'); await tokensPanel.locator(':scope > summary').click();
  await tokensPanel.getByRole('button', { name: 'Remove token', exact: true }).click();
  await manager.getByText('GitHub token settings saved.', { exact: true }).waitFor(); assert.equal(tokens.size, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.ok(checks >= 5);
  await tokensPanel.locator(':scope > summary').click();
  await manager.screenshot({ path: `${output}/${mobile ? 'phone' : 'desktop'}.png` });
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('[data-category="addons"]').click();
  await manager.getByRole('button', { name: 'Zkontrolovat aktualizace', exact: true }).waitFor();
  await sourceRow.locator(':scope > details > summary').click(); await sourceRow.getByRole('button', { name: 'Odpojit repozitář', exact: true }).click();
  await sourceRow.getByRole('button', { name: 'Připojit GitHub', exact: true }).waitFor(); assert.equal(active, target);
  assert.equal(await manager.locator('[data-addon-id="example"]').count(), 1, 'unlinking preserves the installed row');
});

for (const mobile of [false, true]) test(`one update check supports consecutive add-on updates (${mobile ? 'phone' : 'desktop'})`, async t => {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 }, extraHTTPHeaders: { 'X-Fixture-Role': 'dm' } });
  t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  await page.addInitScript(() => localStorage.setItem('codex_lang', 'en'));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const ids = ['first', 'second'];
  const active: Record<string, string> = { first: 'a'.repeat(64), second: 'b'.repeat(64) };
  const target: Record<string, string> = { first: 'c'.repeat(64), second: 'd'.repeat(64) };
  const generations = new Map(ids.map(addonId => [addonId, [{ addonId, generationId: active[addonId]!, version: '1.0.0', installedAt: '2026-09-10T10:00:00Z' }]]));
  const links = ids.map(addonId => ({ addonId, revision: 1, source: { repo: `owner/${addonId}`, channel: 'release', branch: '', artifact: '' } }));
  const checked: string[] = [];
  const review = (addonId: string, status = 'prepared') => ({
    reviewId: addonId, addonId, generationId: target[addonId], proposalSha256: 'e'.repeat(64), status,
    proposal: { addonId, generationId: target[addonId], targetManifest: { id: addonId, name: addonId, version: '2.0.0', permissions: [] },
      currentManifest: { version: '1.0.0' }, changes: { runtimeChanged: true }, requiredPermissionIds: [], restartedAddonIds: [], blockers: [] },
  });
  await page.route('**/api/admin/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() as Record<string, unknown> : {};
    if (req.method() === 'POST') assert.equal(req.headers()['x-codex-csrf'], 'x'.repeat(32));
    let value: unknown;
    const addonId = path.split('/')[4]!;
    if (path === '/api/admin/addon-github') value = { contractVersion: 'addon-github.v1', sources: links, credentials: { defaultSource: 'none', environmentConfigured: false, repositories: [] } };
    else if (path.endsWith('/addon-github/discover')) {
      const id = String(body.addonId); checked.push(id);
      value = { source: links.find(link => link.addonId === id)!.source, candidates: [{ id: target[id], name: id, version: '2.0.0', digest: '', active: false }] };
    } else if (path.endsWith('/addon-github/stage')) {
      const id = String(body.addonId); assert.equal(body.candidateId, target[id]);
      const generation = { addonId: id, generationId: target[id]!, version: '2.0.0', installedAt: '2026-09-14T10:00:00Z' };
      if (!generations.get(id)!.some(g => g.generationId === target[id])) generations.get(id)!.push(generation);
      value = generation;
    } else if (path === '/api/admin/addons') value = { contractVersion: 'addon-inventory.v1', addonIds: ids };
    else if (path.endsWith('/activation-reviews')) value = review(addonId);
    else if (path.endsWith('/approval')) value = review(addonId, 'approved');
    else if (path.endsWith('/activation')) {
      active[addonId] = target[addonId]!; value = { state: { addonId, activeGenerationId: active[addonId] } };
    } else if (ids.includes(addonId)) value = { state: { addonId, revision: 1, activeGenerationId: active[addonId] }, generations: generations.get(addonId), events: [] };
    else { await route.fulfill({ status: 404, json: { error: { kind: 'NOT_FOUND' } } }); return; }
    await route.fulfill({ json: value });
  });
  await page.goto(`${origin}/#/settings`); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), dialog = manager.getByRole('dialog');
  const first = manager.locator('[data-github-addon="first"]'), second = manager.locator('[data-github-addon="second"]');
  const download = (row: typeof first) => row.getByRole('button', { name: 'Download and review' });
  await manager.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await download(second).waitFor(); assert.deepEqual(checked, ids);
  await download(first).click();
  await dialog.getByRole('button', { name: 'Cancel review' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await download(first).count(), 1, 'cancelled review keeps its update');
  assert.equal(await download(second).count(), 1, 'staging preserves the other update');
  await download(first).click(); await dialog.getByRole('button', { name: 'Approve and activate' }).click();
  await dialog.waitFor({ state: 'detached' }); await manager.getByText('Add-on state updated.', { exact: true }).waitFor();
  assert.equal(active.first, target.first);
  assert.equal(await download(first).count(), 0, 'changed add-on no longer offers its stale candidate');
  await download(second).click(); await dialog.getByRole('button', { name: 'Approve and activate' }).click();
  await dialog.waitFor({ state: 'detached' }); await manager.getByText('Add-on state updated.', { exact: true }).waitFor();
  assert.equal(active.second, target.second); assert.deepEqual(checked, ids, 'both updates use the original single check');
});

for (const mobile of [false,true]) test(`historical packages download into the exact activation review (${mobile ? 'phone' : 'desktop'})`,async t=>{
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1400,height:1000},extraHTTPHeaders:{'X-Fixture-Role':'dm'}});
 t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(7000);
 await page.addInitScript(()=>localStorage.setItem('codex_lang','en'));
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
 const old='a'.repeat(64),current='b'.repeat(64);
 const generation=(hash:string)=>({addonId:'example',generationId:hash,version:hash===old?'1.0.0':'2.0.0',installedAt:'2026-09-10T10:00:00Z'});
 let staged=false,activations=0,fail=true,downloads=0,active=current;
 await page.route('**/api/admin/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='POST')assert.equal(req.headers()['x-codex-csrf'],'x'.repeat(32));
  let value:unknown;
  if(path==='/api/admin/addon-package-storage')value={contractVersion:'addon-package-storage.v1',automatic:true,pending:0,packages:active===current?[{addonId:'example',generationId:old,version:'1.0.0',available:false,active:false,downloadable:true}]:[]};
  else if(path==='/api/admin/addon-package-storage/restore'){
   downloads++;assert.deepEqual(req.postDataJSON(),{addonId:'example',generationId:old});
   if(fail){fail=false;await route.fulfill({status:503,json:{error:{kind:'PACKAGE_UNAVAILABLE'}}});return;}
   staged=true;value=generation(old);
  }
  else if(path==='/api/admin/addon-github')value={contractVersion:'addon-github.v1',sources:[],credentials:{defaultSource:'none',environmentConfigured:false,repositories:[]}};
  else if(path==='/api/admin/addons')value={contractVersion:'addon-inventory.v1',addonIds:['example']};
  else if(path==='/api/admin/addons/example')value={state:{addonId:'example',revision:1,activeGenerationId:active},generations:staged?[generation(old),generation(current)]:[generation(current)],events:[]};
  else if(path.endsWith('/activation-reviews')||path.endsWith('/approval')){
   if(path.endsWith('/activation-reviews'))assert.equal(req.postDataJSON().generationId,old);
   value={reviewId:'history-review',addonId:'example',generationId:old,proposalSha256:'c'.repeat(64),status:path.endsWith('/approval')?'approved':'prepared',proposal:{addonId:'example',generationId:old,targetManifest:{id:'example',name:'Historical test',version:'1.0.0',permissions:[]},currentManifest:{version:'2.0.0'},changes:{runtimeChanged:false},requiredPermissionIds:[],restartedAddonIds:[],blockers:[]}};
  }else if(path.endsWith('/activation')){activations++;active=old;value={state:{addonId:'example',activeGenerationId:old}};}
  else{await route.fulfill({status:404,json:{error:{kind:'NOT_FOUND'}}});return;}
  await route.fulfill({json:value});
 });
 await page.goto(`${origin}/#/settings/addons`);
 const manager=page.locator('codex-addon-manager'),storage=manager.locator('codex-package-storage');
 await storage.getByText('Previous builds',{exact:true}).click();
 await storage.getByRole('button',{name:'Download and review'}).click();
 await storage.getByRole('alert').waitFor();assert.equal(activations,0);assert.equal(staged,false);
 await storage.getByRole('button',{name:'Try again',exact:true}).click();
 await storage.getByText('Previous builds',{exact:true}).click();
 await storage.getByRole('button',{name:'Download and review'}).click();
 await manager.getByRole('dialog').getByRole('heading',{name:'Review activation: Historical test',exact:true}).waitFor();
 assert.equal(downloads,2);assert.equal(activations,0);
 await manager.getByRole('button',{name:'Approve and activate',exact:true}).click();
 await manager.getByText('Add-on state updated.',{exact:true}).waitFor();assert.equal(activations,1);
 await page.goto(`${origin}/#/settings/addons/example/packages/${old}`);
 await manager.getByRole('dialog').getByRole('heading',{name:'Review activation: Historical test',exact:true}).waitFor();
 assert.equal(downloads,2);assert.equal(activations,1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:fileURLToPath(new URL(`../../test-results/addon-github/history-${mobile?'phone':'desktop'}.png`,import.meta.url)),fullPage:true});
});

for (const mobile of [false, true]) test('release details distinguish same-version packages and explain incompatibility (' + (mobile ? 'Czech phone' : 'English desktop') + ')', async t => {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 }, extraHTTPHeaders: { 'X-Fixture-Role': 'dm' } });
  t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  await page.addInitScript(cs => localStorage.setItem('codex_lang', cs ? 'cs' : 'en'), mobile);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const active = 'a'.repeat(64), next = 'b'.repeat(64);
  let target = active, downloads = 0, approvals = 0;
  const source: GitHubSource = { repo: 'owner/releases', channel: 'release', branch: '', artifact: '' };
  const generation = (id: string) => ({ addonId: 'example', generationId: id, version: '1.0.0', installedAt: '2026-09-15T10:00:00Z' });
  const reason = 'host version is incompatible: host 2.0.0 does not satisfy "^9.0.0"';
  const notes = 'Fixed editor focus.\n<script>throw new Error("unsafe notes")</script>\n[Unsafe](javascript:alert(1))';
  await page.route('**/api/admin/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let value: unknown;
    if (path === '/api/admin/addon-github') value = { contractVersion: 'addon-github.v1', sources: [{ addonId: 'example', revision: 1, source }], credentials: { defaultSource: 'none', environmentConfigured: false, repositories: [] } };
    else if (path.endsWith('/addon-github/discover')) value = { source, candidates: [{ id: target, name: 'example.zip', version: 'v1.0.0', active: target === active, digest: 'sha256:' + target, provenance: { commit: target.slice(0, 40), runId: '', runAttempt: 0, publishedAt: '2026-09-15T10:00:00Z', notes, notesTruncated: true } }] };
    else if (path.endsWith('/addon-github/stage')) { downloads++; assert.equal(route.request().postDataJSON().candidateId, next); value = generation(next); }
    else if (path === '/api/admin/addons') value = { contractVersion: 'addon-inventory.v1', addonIds: ['example'] };
    else if (path === '/api/admin/addons/example') value = { state: { addonId: 'example', revision: 1, activeGenerationId: active }, generations: downloads ? [generation(active), generation(next)] : [generation(active)], events: [] };
    else if (path.endsWith('/activation-reviews')) value = { reviewId: 'blocked-review', addonId: 'example', generationId: next, proposalSha256: 'c'.repeat(64), status: 'prepared', proposal: { addonId: 'example', generationId: next, targetManifest: { id: 'example', name: 'Release test', version: '1.0.0', permissions: [] }, currentManifest: { version: '1.0.0' }, changes: { runtimeChanged: false }, requiredPermissionIds: [], restartedAddonIds: [], blockers: [{ code: 'COMPATIBILITY', message: reason }] } };
    else { if (path.endsWith('/approval') || path.endsWith('/activation')) approvals++; await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ json: value });
  });
  await page.goto(origin + '/#/settings'); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), row = manager.locator('[data-github-addon="example"]');
  const check = manager.getByRole('button', { name: mobile ? 'Zkontrolovat aktualizace' : 'Check for updates', exact: true });
  await check.click();
  await row.getByText(mobile ? 'Aktuální verze' : 'Up to date', { exact: true }).waitFor();
  await row.getByText(active.slice(0, 40), { exact: true }).waitFor();
  assert.equal(downloads, 0);
  target = next; await check.click();
  await row.getByText(next.slice(0, 40), { exact: true }).waitFor();
  await row.getByText('example.zip · v1.0.0', { exact: true }).waitFor();
  const summary = row.locator('summary').filter({ hasText: mobile ? 'Změny ve vydání' : 'Release changes' });
  await summary.focus(); await page.keyboard.press('Enter');
  assert.equal(await row.locator('.github-release-notes').textContent(), notes);
  assert.equal(await row.locator('.github-release-notes script, .github-release-notes a').count(), 0);
  const upstream = row.getByRole('link', { name: mobile ? 'Otevřít vydání na GitHubu' : 'Open release on GitHub' });
  assert.equal(await upstream.getAttribute('href'), 'https://github.com/owner/releases/releases/tag/v1.0.0');
  assert.equal(await upstream.getAttribute('rel'), 'noreferrer');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await row.screenshot({ path: output + '/release-' + (mobile ? 'phone-cs' : 'desktop-en') + '.png' });
  await row.getByRole('button', { name: mobile ? 'Stáhnout a zkontrolovat' : 'Download and review' }).click();
  const dialog = manager.getByRole('dialog');
  await dialog.locator('.addon-blocker-reason').filter({ hasText: reason }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: mobile ? 'Schválit a aktivovat' : 'Approve and activate' }).isDisabled(), true);
  assert.equal(await dialog.locator('details[open]').count(), 0, 'the specific incompatibility is visible without technical disclosures');
  assert.equal(downloads, 1); assert.equal(approvals, 0);
  await dialog.screenshot({ path: output + '/incompatible-' + (mobile ? 'phone-cs' : 'desktop-en') + '.png' });
  await dialog.getByRole('button', { name: mobile ? 'Zrušit kontrolu' : 'Cancel review' }).click();
  assert.equal(approvals, 0);
});
