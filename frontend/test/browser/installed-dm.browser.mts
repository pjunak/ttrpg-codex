import { exercisePackageCleanup } from "./installed-cleanup-fixture.mts";
import { exercisePlanningReader } from "./installed-planning-reader-fixture.mts";
import { exerciseRecordPanels } from "./installed-record-panels-fixture.mts";
import { required } from './fixture-types.mts';
import type { APIRequestContext, Browser, Page } from 'playwright';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { FixtureCollection, FixtureRecord } from './fixture-types.mts';
import { plannerTab } from './installed-planner-dialog-fixture.mts';
import { exercisePlannerSelection } from './installed-planner-selection-fixture.mts';
import { exercisePlannerActions, exercisePlannerCreationFailures } from './installed-planner-actions-fixture.mts';
import { exercisePlannerCanvas } from './installed-planner-canvas-fixture.mts';
import { exercisePlannerLive } from './installed-planner-live-fixture.mts';
import { exerciseImportCenter } from './installed-import-center-fixture.mts';
import { exerciseAddonManager } from './installed-addon-manager-fixture.mts';
import { exerciseConfiguration } from './installed-configuration-fixture.mts';
import { exerciseUninstall } from './installed-uninstall-fixture.mts';
import { exerciseSettings, exerciseSettingsFailure, exerciseSettingsCardStability } from './installed-settings-fixture.mts';
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
import { installDmPackage, dmToolsPermissions } from './installed-dm-fixture.mts';
import { importQuest, planningImport, replacementImportPackage } from './installed-import-fixture.mts';
import { exercisePlannerEditing } from './installed-planner-fixture.mts';
import { exercisePlannerFlows } from './installed-planner-flow-fixture.mts';
import { exercisePlannerConcurrency } from './installed-planner-concurrency-fixture.mts';
import { exercisePlannerNavigation, unloadBlocked, attemptHash } from './installed-planner-navigation-fixture.mts';
import { exercisePlannerAnnotations } from './installed-planner-annotation-fixture.mts';
import { exercisePlannerStructure } from './installed-planner-structure-fixture.mts';
import { exerciseCzechInterface } from './installed-interface-localization-fixture.mts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-dm');
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, browser: Browser, admin: APIRequestContext, csrf: string, origin: string, hostOutput = '';
before(async () => {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = (portProbe.address() as AddressInfo).port; await new Promise(resolve => portProbe.close(resolve)); origin = `http://127.0.0.1:${port}`;
  // This suite explicitly exercises manually retained packages and reviewed cleanup.
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_ADDON_AUTO_CLEANUP: 'false', CODEX_DM_PASSWORD: 'local-graph-fixture-dm', CODEX_PLAYER_PASSWORD: 'local-graph-fixture-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: origin });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Host startup. */ }
    if (host.exitCode !== null) break;
    await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-graph-fixture-dm' } }))).csrfToken;
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: 'arrival', expectedRevision: 0, value: { id: 'arrival', name: 'Arrival', short: 'At the northern gate.', sitting: 1, order: 1, visibility: 'public' } },
    { operation: 'put', collection: 'events', key: 'dinner', expectedRevision: 0, value: { id: 'dinner', name: 'Dinner', sitting: 1, order: 2, visibility: 'public' } },
    { operation: 'put', collection: 'events', key: 'secret-event', expectedRevision: 0, value: { id: 'secret-event', name: 'Hidden meeting', sitting: 1, order: 3, visibility: 'dm' } },
  ] } }));
  await jsonResponse(await admin.post("/api/media/world-map/main", { headers: { "X-Codex-CSRF": csrf, "Content-Type": "image/svg+xml", "X-Codex-Filename": "fixture-map.svg" }, data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#252018"/></svg>') }));
  browser = await chromium.launch({ headless: true });
});

async function disable(id: string) {
  const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  return jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: snapshot.state.revision } }));
}
async function open(t: TestContext, role = 'dm', mobile = false) {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  t.after(() => context.close());
  if (role) await jsonResponse(await context.request.post('/api/login', { data: { password: `local-graph-fixture-${role}` } }));
  await context.addInitScript(() => { if (window === window.top && !localStorage.getItem('codex_lang')!) localStorage.setItem('codex_lang', 'en'); });
  const page = await context.newPage(); await page.goto('/#/dm'); await page.locator('#dm-page-title').waitFor(); return page;
}
function slotRoot(page: Page, mode: string) {
  const root = page.locator('[data-dm-dashboard-slot]');
  return mode === 'isolated' ? root.frameLocator('iframe') : root;
}

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} rule details preserve drafts, keyboard focus and generation lifetime`, async t => {
  const id=`rule-details-${mode}`;await installDmPackage(admin,csrf,{id,mode,edits:true,ruleDetails:true});t.after(()=>disable(id));
  const page=await open(t,'dm',mode==='isolated'),surface=slotRoot(page,mode);
  await surface.getByLabel('Fixture notes').fill('Draft survives rule inspection');
  const trigger=surface.getByRole('button',{name:'Inspect saved rule',exact:true});await trigger.focus();await trigger.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Synthetic total',exact:true});await dialog.waitFor();assert.match(await dialog.innerText(),/10 \+ 2/);assert.match(await dialog.innerText(),/Saved explanations remain visible/);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  // The isolated acknowledgement crosses MessagePort after the host closes.
  for(let attempt=0;attempt<50&&!(await trigger.evaluate(element=>element===document.activeElement));attempt++)await sleep(20);
  assert.equal(await trigger.evaluate(element=>element===document.activeElement),true,JSON.stringify(await trigger.evaluate(()=>({active:document.activeElement?.outerHTML,focused:document.hasFocus()}))));
  assert.equal(await surface.getByLabel('Fixture notes').inputValue(),'Draft survives rule inspection');assert.equal(await unloadBlocked(page),true);
  await trigger.press('Space');await dialog.waitFor();await disable(id);await dialog.waitFor({state:'detached'});
});

test('DM panel preserves the fallback cards and hidden sidebar tool access on desktop and phone', async t => {
  const id = 'dm-fallback'; await installDmPackage(admin, csrf, { id, slot: false }); t.after(() => disable(id));
  for (const mobile of [false, true]) {
    const page = await open(t, 'dm', mobile);
    await page.locator(`[data-addon-health="${id}"]`).waitFor();
    assert.equal(await page.locator('.dm-count-card[data-dm-collection]').count(), 8);
    assert.match(await page.locator('[data-dm-collection="events"]').textContent().then(required), /1\s*\/\s*3/u);
    const tool = page.locator('.dm-panel').getByRole('link', { name: /Fixture planner/ }); await tool.waitFor();
    assert.equal(await page.locator('[data-addon-navigation] a').count(), 0);
    const style = await page.locator('#dm-page-title').evaluate(element => ({ color: getComputedStyle(element).color, font: getComputedStyle(element).fontFamily }));
    assert.equal(style.color, 'rgb(200, 160, 64)'); assert.match(style.font, /Cinzel/u);
    assert.equal(await page.locator('.dm-actions > a').evaluate(element => getComputedStyle(element).color), 'rgb(200, 160, 64)');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, mobile ? 'fallback-phone.png' : 'fallback-desktop.png'), fullPage: true });
    await tool.click(); await page.getByRole('heading', { name: 'Fixture planner page' }).waitFor();
    await page.goto('/#/dm'); await page.locator('[data-dm-collection="events"]').click(); await page.locator('.tl-shell').waitFor();
  }
  const dm = await open(t);
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  const hidden = campaign.collections.find((collection: FixtureCollection) => collection.name === 'events')!.records.find((record: FixtureRecord) => record.key === 'secret-event');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: hidden.key, expectedRevision: hidden.revision, value: { ...hidden.value, visibility: 'public' } },
  ] } }));
  await dm.locator('[data-dm-collection="events"] .dm-count-numbers strong').filter({ hasText: /^0$/u }).waitFor();
  await dm.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await dm.reload();
  await dm.getByRole('heading', { name: 'Skrytý obsah' }).waitFor();
  await dm.evaluate(() => localStorage.setItem('codex_lang', 'en')); await dm.reload();
  const currentAuth = await jsonResponse(await dm.context().request.get('/api/auth'));
  await jsonResponse(await dm.context().request.post('/api/view-as', { headers: { 'X-Codex-CSRF': currentAuth.csrfToken }, data: { role: 'player' } }));
  await dm.reload();
  await dm.getByText('This page is available only in DM view.').waitFor();
  assert.equal(await dm.locator('.dm-count-card').count(), 0);
  assert.equal(await dm.locator('.sidebar-footer > a[href="#/dm"]').count(), 0);
  for (const role of ['player', '']) {
    const page = await open(t, role); await page.getByText('This page is available only in DM view.').waitFor();
    assert.equal(await page.locator('[data-dm-dashboard-slot], .dm-count-card, [data-addon-health]').count(), 0);
  }
});

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} DM dashboard mounts only in the DM route and cleans up on replacement and disable`, async t => {
  const id = `dm-${mode}`; await installDmPackage(admin, csrf, { id, mode }); t.after(() => disable(id));
  const page = await open(t, 'dm', mode === 'isolated'), slot = slotRoot(page, mode);
  await slot.getByRole('heading', { name: 'Fixture DM workspace 1.0.0' }).waitFor();
  assert.deepEqual(JSON.parse(await slot.getByLabel('Fixture context').textContent().then(required)), { contractVersion: 'dm-dashboard-context.v1', locale: 'en' });
  assert.equal(await page.locator('codex-dm-dashboard').evaluate((element: HTMLElement & { degraded: boolean }) => element.degraded), false,
    JSON.stringify(await page.locator('codex-app').evaluate((element: HTMLElement & { addonState: unknown }) => element.addonState)));
  await page.locator('[data-dm-collection="events"]').waitFor({ state: 'detached' });
  await slot.getByLabel('Fixture notes').fill('Keep these notes');
  const campaign = await jsonResponse(await admin.get('/api/campaign'));
  const event = campaign.collections.find((collection: FixtureCollection) => collection.name === 'events')!.records.find((record: FixtureRecord) => record.key === 'arrival');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: event.key, expectedRevision: event.revision, value: { ...event.value, short: `Changed ${event.revision}` } },
  ] } }));
  await page.waitForFunction(revision => document.querySelector('codex-dm-dashboard')!.campaign.collections.find(collection => collection.name === 'events')!.records.find(record => record.key === 'arrival')!.revision > revision, event.revision);
  assert.equal(await slot.getByLabel('Fixture notes').inputValue(), 'Keep these notes');
  const player = await open(t, 'player'); assert.equal(await player.locator('[data-dm-dashboard-slot]').count(), 0);
  await page.goto('/#/'); assert.equal(await page.locator(`[data-addon-slot] [data-addon-id="${id}"]`).count(), 0);
  await page.goto(`/#/addons/${id}/planner?item=first`);
  const route = mode === 'isolated' ? page.locator('[data-addon-route-outlet]').frameLocator('iframe') : page.locator('[data-addon-route-outlet]');
  await route.getByRole('heading', { name: 'Fixture planner page' }).waitFor();
  await route.getByLabel('Fixture notes').fill('Keep this draft');
  assert.deepEqual(JSON.parse(await route.getByLabel('Fixture context').textContent().then(required)), { contractVersion: 'addon-route-context.v1', locale: 'en', query: [['item', 'first']] });
  await page.goto(`/#/addons/${id}/planner?item=second&item=third`);
  await route.getByLabel('Fixture context').filter({ hasText: 'second' }).waitFor();
  assert.deepEqual(JSON.parse(await route.getByLabel('Fixture context').textContent().then(required)).query, [['item', 'second'], ['item', 'third']]);
  assert.equal(await route.getByLabel('Fixture notes').inputValue(), 'Keep this draft');
  await page.goto('/#/dm'); await slotRoot(page, mode).getByRole('heading', { name: 'Fixture DM workspace 1.0.0' }).waitFor();
  await installDmPackage(admin, csrf, { id, mode, version: '1.0.1' });
  await slotRoot(page, mode).getByRole('heading', { name: 'Fixture DM workspace 1.0.1' }).waitFor();
  await disable(id); await page.locator('[data-dm-collection="events"]').waitFor();
  assert.equal(await page.locator(`[data-dm-dashboard-slot] [data-addon-id="${id}"]`).count(), 0);
});

test('failed dashboard rendering and activation retain useful DM fallback and retry', async t => {
  const id = 'dm-failed'; await installDmPackage(admin, csrf, { id, failure: 'mount' }); t.after(() => disable(id));
  const page = await open(t); await page.locator('.dm-panel [role="alert"]').waitFor();
  await page.locator('.dm-panel').getByRole('link', { name: /Fixture planner/ }).waitFor();
  assert.equal(await page.locator('.dm-panel').textContent().then(required).then(text => text.includes('Private fixture')), false);
  await page.getByRole('button', { name: 'Reload add-on tools' }).click();
  await page.locator('.dm-panel [role="alert"]').waitFor();
  await installDmPackage(admin, csrf, { id, version: '1.0.1', failure: 'activation' });
  await page.locator(`[data-addon-health="${id}"] .failed`).waitFor();
  assert.equal(await page.locator('.dm-panel').getByRole('link', { name: /Fixture planner/ }).count(), 0);
  await page.locator('[data-dm-collection="events"]').waitFor();
  await installDmPackage(admin, csrf, { id: 'dm-healthy' }); t.after(() => disable('dm-healthy'));
  await slotRoot(page, 'integrated').getByRole('heading', { name: 'Fixture DM workspace 1.0.0' }).waitFor();
  await page.locator(`[data-addon-health="${id}"] .failed`).waitFor();
  await installDmPackage(admin, csrf, { id, version: '1.0.2' });
  await slotRoot(page, 'integrated').getByRole('heading', { name: 'Fixture DM workspace 1.0.2' }).waitFor();
  await page.locator('[data-dm-collection="events"]').waitFor({ state: 'detached' });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('reviewed DM Tools dashboard preserves the classic layout and opens durable planner links', async t => {
  const archive = await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP)));
  await installReviewedPackage(admin, csrf, 'dm-tools', archive, dmToolsPermissions); t.after(() => disable('dm-tools'));
  const page = await open(t); const panel = page.locator('.dm-panel');
  const dashboard = page.locator('.dm-tools-dashboard');
  await dashboard.locator('[data-stat="total"] .dm-dashboard-value').filter({ hasText: /^0$/u }).waitFor();
  assert.equal(await dashboard.locator('.dm-dashboard-tile').count(), 5);
  await dashboard.getByRole('link', { name: /Story Planner/ }).click();
  await page.getByRole('heading', { name: 'Story Planner', exact: true }).waitFor();
  await page.getByRole('button', { name: '+ Quest', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Northern trail');
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await page.getByText('Details saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Enter this canvas', exact: true }).click();
  await page.locator('.dm-planner-breadcrumbs .active').filter({ hasText: 'Northern trail' }).waitFor();
  const questURL = page.url();
  await page.getByRole('button', { name: '+ Event', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Hidden meeting');
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await page.getByText('Details saved.', { exact: true }).waitFor();
  await plannerTab(page, 'Notes'); await page.getByRole('button', { name: 'Add DM note', exact: true }).click();
  await page.getByText('DM note added.', { exact: true }).waitFor();
  await page.goto('/#/dm');
  await dashboard.locator('[data-stat="total"] .dm-dashboard-value').filter({ hasText: /^2$/u }).waitFor();
  assert.equal(await dashboard.locator('[data-stat="notes"] .dm-dashboard-value').textContent().then(required), '1');
  assert.equal(await dashboard.locator('.dm-dashboard-recent a strong').first().textContent().then(required), 'Hidden meeting');
  assert.equal(await dashboard.locator('.dm-dashboard-warning').count(), 0);
  const recent = dashboard.getByRole('link', { name: /Hidden meeting/ });
  const eventLink = await recent.getAttribute('href');
  for (const mobile of [false, true]) {
    const view = mobile ? await open(t, 'dm', true) : page;
    await view.locator('.dm-tools-dashboard [data-stat="total"] .dm-dashboard-value').filter({ hasText: /^2$/u }).waitFor();
    assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const titleStyle = await view.locator('.dm-tools-dashboard h2').evaluate(element => ({ color: getComputedStyle(element).color, font: getComputedStyle(element).fontFamily }));
    assert.equal(titleStyle.color, 'rgb(200, 160, 64)'); assert.match(titleStyle.font, /Cinzel/u);
    await view.screenshot({ path: resolve(output, mobile ? 'planning-phone.png' : 'planning-desktop.png'), fullPage: true });
    if (mobile) {
      await view.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await view.reload();
      await view.getByRole('heading', { name: 'Plánování kampaně', exact: true }).waitFor();
      await view.getByRole('link', { name: /Plánovač příběhu/ }).waitFor();
    }
  }
  await recent.click();
  await page.locator('.dm-plan-card.selected h3').filter({ hasText: 'Hidden meeting' }).waitFor();
  await page.reload(); await page.getByRole("button", { name: "Edit item", exact: true }).click(); await page.getByLabel('Title', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Hidden meeting');
  const secondTab = await page.context().newPage(); await secondTab.goto(`/${eventLink}`);
  await secondTab.locator('.dm-plan-card.selected h3').filter({ hasText: 'Hidden meeting' }).waitFor();
  await secondTab.goto('/#/dm'); await secondTab.locator('.dm-tools-dashboard').waitFor();
  await secondTab.goto('/#/addons/dm-tools/planner?item=one&item=two');
  await secondTab.getByRole('link', { name: 'Open campaign canvas' }).click();
  await secondTab.locator('.dm-plan-card h3').filter({ hasText: 'Northern trail' }).waitFor();
  await secondTab.close();
  await page.getByLabel('Title', { exact: true }).fill('Unsaved draft');
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Unsaved draft');
  await page.goto(questURL); await page.locator('.dm-planner-breadcrumbs .active').filter({ hasText: 'Northern trail' }).waitFor();
  await page.getByRole('button', { name: 'Campaign', exact: true }).click();
  await page.locator('.dm-plan-card h3').filter({ hasText: 'Northern trail' }).waitFor();
  await page.goBack(); await page.locator('.dm-planner-breadcrumbs .active').filter({ hasText: 'Northern trail' }).waitFor();
  await page.goto('/#/addons/dm-tools/planner?item=quest-missing'); await page.getByText('This planning item no longer exists.', { exact: true }).waitFor();
  await page.goto('/#/addons/dm-tools/planner?item=one&item=two'); await page.getByText('Invalid planner link.', { exact: true }).waitFor();
  assert.equal(await unloadBlocked(page), true);
  await page.goto(`/${eventLink}`);
  await page.getByRole('button', { name: 'Edit item', exact: true }).click();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Unsaved draft');
  await page.getByRole('form', { name: 'Planning item details' }).getByRole('button', { name: 'Discard edits', exact: true }).click();
  await page.goto('/#/addons/dm-tools/planner');
  await page.locator('.dm-plan-card h3').filter({ hasText: 'Northern trail' }).waitFor();
  const queryPattern = '**/api/addons/dm-tools/generations/*/data/query';
  await page.route(queryPattern, route => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/#/dm'); await dashboard.getByRole('alert').waitFor();
  await dashboard.getByRole('link', { name: /Story Planner/ }).waitFor();
  await page.unroute(queryPattern); await dashboard.getByRole('button', { name: 'Refresh overview' }).click();
  await dashboard.locator('[data-stat="total"] .dm-dashboard-value').filter({ hasText: /^2$/u }).waitFor();
  await page.goto('/#/dm'); await panel.getByRole('link', { name: /Import Center/ }).click();
  await page.getByRole('heading', { name: 'Import Center', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'DM Tools planning', exact: true }).waitFor();
  for (const role of ['player', '']) {
    const visitor = await open(t, role);
    assert.equal(await visitor.locator('.dm-tools-dashboard').count(), 0);
    assert.equal((await visitor.locator('.dm-panel').textContent().then(required)).includes('Hidden meeting'), false);
  }
});

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} edit state protects navigation and expires with its mounted view`, async t => {
  const id = `dm-edits-${mode}`;
  await installDmPackage(admin, csrf, { id, mode, slot: false, edits: true }); t.after(() => disable(id));
  const page = await open(t), hash = `#/addons/${id}/planner`;
  page.setDefaultTimeout(10_000);
  await page.goto(`/${hash}`);
  const root = page.locator('[data-addon-route-outlet]');
  const surface = mode === 'isolated' ? root.frameLocator('iframe') : root;
  await surface.getByLabel('Fixture notes').fill('Keep this draft');
  await page.waitForFunction(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await attemptHash(page, '#/timeline'); await page.waitForURL(`**/${hash}`);
  assert.equal(await surface.getByLabel('Fixture notes').inputValue(), 'Keep this draft');
  // Query retention is explicit; this fixture does not opt in.
  await attemptHash(page, `${hash}?item=another`); await page.waitForURL(`**/${hash}`);
  await surface.getByLabel('Fixture notes').fill('');
  await page.waitForFunction(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return !event.defaultPrevented; });
  await page.evaluate(() => { location.hash = '#/timeline'; }); await page.locator('.tl-shell').waitFor();
  assert.equal(await unloadBlocked(page), false);
  await page.goto(`/${hash}`); await surface.getByLabel('Fixture notes').fill('Retire this generation');
  await page.waitForFunction(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await disable(id);
  await page.locator('[data-addon-route-outlet] input, [data-addon-route-outlet] iframe').waitFor({ state: 'detached' });
  assert.equal(await unloadBlocked(page), false);
});

for (const mode of ['integrated', 'isolated']) test(`installed ${mode} subscriptions refresh only their package and stop on abort`, async t => {
  const id = `live-${mode}`, other = `live-other-${mode}`;
  await installDmPackage(admin, csrf, { id, mode, live: true }); t.after(() => disable(id));
  await installDmPackage(admin, csrf, { id: other, slot: false, live: true }); t.after(() => disable(other));
  const page = await open(t), slot = slotRoot(page, mode), output = slot.getByLabel('Data changes'); await output.waitFor();
  const write = async (addonId: string, expectedRevision: number) => {
    const generation = (await jsonResponse(await admin.get(`/api/admin/addons/${addonId}`))).state.activeGenerationId;
    await jsonResponse(await admin.post(`/api/addons/${addonId}/generations/${generation}/data/transactions`, { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'addon-data-transaction.v1', mutations: [{ operation: 'put', kind: 'collection', dataId: 'notes', key: 'note', expectedRevision, value: { text: 'Changed elsewhere' } }] } }));
  };
  await write(other, 0); await write(id, 0); await output.filter({ hasText: 'notes' }).waitFor();
  assert.deepEqual(JSON.parse(await output.textContent().then(required)).filter((change: { reason: string }) => change.reason === 'changed'), [{ reason: 'changed', kind: 'collection', dataId: 'notes' }]);
  await slot.getByRole('button', { name: 'Stop changes', exact: true }).click(); const before = await output.textContent().then(required);
  await write(id, 1); await page.waitForTimeout(250); assert.equal(await output.textContent().then(required), before);
});

if (process.env.CODEX_DM_TOOLS_ZIP) for (const mobile of [false, true]) test(`installed Czech interface retains authored records, planner links, notes and undo on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools')); await exerciseCzechInterface({ t, open, admin, csrf, output, mobile });
});

if (process.env.CODEX_DM_TOOLS_ZIP) for (const mobile of [false, true]) test(`installed planner action parity creates, connects, resets and explains shortcuts on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools')); await exercisePlannerActions({ t, open, admin, csrf, output, mobile });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner reconciles lost creation responses and retains provisional drafts', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools')); await exercisePlannerCreationFailures({ t, open, admin, csrf });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner selects and moves groups, retains modal drafts and deletes mixed selections atomically', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools')); await exercisePlannerSelection({ t, open, admin, csrf, output });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner and overview update live without losing edits or canvas state', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools')); await exercisePlannerLive({ t, open, admin, csrf });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner protects drafts on navigation, Back, sign-out and reload', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools'));
  await exercisePlannerNavigation({ t, open, admin, csrf });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner changes kind and parent while preserving structure, drafts and annotations', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools'));
  await exercisePlannerStructure({ t, open, admin, csrf, output });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner restores item fields and retains drafts through edits, conflicts and failed saves', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools'));
  await exercisePlannerEditing({ t, open, admin, csrf, output });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner edits flows and keeps consequence deletion atomic', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools'));
  await exercisePlannerFlows({ t, open, admin, csrf, output });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planner rejects unseen children, annotations and simultaneous flow cycles', async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools'));
  await exercisePlannerConcurrency({ t, open, admin, csrf });
});

if (process.env.CODEX_DM_TOOLS_ZIP) for (const mobile of [false, true]) test(`Import Center restores routing, review and provider-independent imports on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await exerciseImportCenter({ t, root, output, open, admin, csrf, disable, mobile });
});

if (process.env.CODEX_DM_TOOLS_ZIP) test('installed planning imports preview, cancel, commit atomically and reject stale reviews', async t => {
  const archive = await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP)));
  await installReviewedPackage(admin, csrf, 'dm-tools', archive, dmToolsPermissions); t.after(() => disable('dm-tools'));
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}`;
  const headers = { 'X-Codex-CSRF': csrf };
  const records = async (dataBase = base) => (await jsonResponse(await admin.post(`${dataBase}/data/query`, { headers,
    data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId: 'planning_items', limit: 200, where: [] } }))).documents;
  const page = await open(t); await page.goto('/#/addons/dm-tools/imports');
  await page.getByRole('heading', { name: 'DM Tools planning', exact: true }).waitFor();
  const chooser = page.locator('.dm-tools-import input[type="file"]');
  const select = async (document: unknown) => chooser.setInputFiles({ name: 'planning.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  const preview = async (document: unknown) => {
    const response = page.waitForResponse(response => response.url().endsWith('/services/call') && response.request().postDataJSON().method === 'preview');
    await select(document);
    const body = await jsonResponse(await response);
    await page.getByText('Preview ready. No campaign data has changed.', { exact: true }).waitFor();
    return body.result;
  };
  const document = planningImport([importQuest('import-quest', 'Imported northern trail')]);
  const before = await records();
  const player = await open(t, 'player');
  const playerSession = await jsonResponse(await player.context().request.post('/api/login', { data: { password: 'local-graph-fixture-player' } }));
  const forbidden = await player.context().request.post(`${base}/services/call`, { headers: { 'X-Codex-CSRF': playerSession.csrfToken },
    data: { contractVersion: 'addon-service-call.v1', contract: 'codex.import-adapter', providerAddonId: 'dm-tools', providerVersion: '2.0.0', providerGeneration: generation, bindingRevision: 0,
      method: 'preview', params: { contractVersion: 'import-preview.v1', format: 'dm-tools-planning', document }, deadlineMs: 3000 } });
  assert.equal(forbidden.status(), 403); assert.deepEqual(await records(), before);
  await preview(document); assert.deepEqual(await records(), before);
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  await page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
  assert.equal(await page.locator('.dm-import-preview').count(), 0); assert.deepEqual(await records(), before);
  const reviewed = await preview(document);
  assert.equal(reviewed.summary.creates, 1);
  const overviewWatcher = await open(t), plannerWatcher = await open(t);
  const total = overviewWatcher.locator('.dm-tools-dashboard [data-stat="total"] .dm-dashboard-value'); await total.waitFor();
  const previousTotal = Number((await total.textContent().then(required)).replace(/\D/gu, ''));
  await plannerWatcher.goto('/#/addons/dm-tools/planner'); await plannerWatcher.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  const commitResponse = page.waitForResponse(response => response.url().endsWith('/services/call') && response.request().postDataJSON().method === 'commit');
  await page.getByRole('button', { name: 'Commit reviewed import', exact: true }).click();
  const committed = await jsonResponse(await commitResponse); assert.equal(committed.result.writes, 1);
  await page.getByText('Import committed: 1 writes and 0 deletions.', { exact: true }).waitFor();
  await plannerWatcher.locator('.dm-plan-card[data-item-id="import-quest"]').filter({ hasText: 'Imported northern trail' }).waitFor();
  await total.filter({ hasText: new RegExp(`^${previousTotal + 1}$`, 'u') }).waitFor();
  await overviewWatcher.close(); await plannerWatcher.close();
  const stored = (await records()).find((record: FixtureRecord) => record.key === 'import-quest');
  assert.equal(stored.value.title, 'Imported northern trail'); assert.equal(stored.value.updatedAt, 1000);
  const replay = await admin.post(`${base}/services/call`, { headers, data: { contractVersion: 'addon-service-call.v1', contract: 'codex.import-adapter', providerAddonId: 'dm-tools', providerVersion: '2.0.0', providerGeneration: generation, bindingRevision: 0,
    method: 'commit', params: { contractVersion: 'import-commit.v1', token: reviewed.token }, deadlineMs: 3000, idempotencyKey: reviewed.token } });
  assert.equal(replay.status(), 404); assert.deepEqual((await records()).find((record: FixtureRecord) => record.key === stored.key), stored);

  const update = { ...importQuest('import-quest', 'Overwritten by import'), operation: 'update', expectedUpdatedAt: 1000 };
  await preview(planningImport([update, importQuest('import-atomic-new')], 2000));
  await jsonResponse(await admin.post(`${base}/data/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations: [
    { operation: 'put', kind: 'collection', dataId: 'planning_items', key: stored.key, expectedRevision: stored.revision, value: { ...stored.value, title: 'Concurrent local edit', updatedAt: 3000 } },
  ] } }));
  await page.getByRole('button', { name: 'Commit reviewed import', exact: true }).click();
  await page.getByText('Data changed. Choose the file again to review a new preview.', { exact: true }).waitFor();
  assert.equal(await page.locator('.dm-import-preview').count(), 0);
  assert.equal((await records()).find((record: FixtureRecord) => record.key === 'import-quest').value.title, 'Concurrent local edit');
  assert.equal((await records()).some((record: FixtureRecord) => record.key === 'import-atomic-new'), false);

  // A new annotation outside the reviewed write set also invalidates the preview.
  await preview(planningImport([importQuest('import-unseen-conflict')], 3200));
  await jsonResponse(await admin.post(`${base}/data/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations: [
    { operation: 'put', kind: 'collection', dataId: 'dm_notes', key: 'import-unseen-note', expectedRevision: 0, value: { id: 'import-unseen-note', schemaVersion: 3, title: 'Added after preview', body: '', anchorIds: ['import-quest'], updatedAt: 3201 } },
  ] } }));
  await page.getByRole('button', { name: 'Commit reviewed import', exact: true }).click();
  await page.getByText('Data changed. Choose the file again to review a new preview.', { exact: true }).waitFor();
  assert.equal((await records()).some((record: FixtureRecord) => record.key === 'import-unseen-conflict'), false);

  const callPattern = '**/api/addons/dm-tools/generations/*/services/call';
  await preview(planningImport([importQuest('import-uncertain')], 3500));
  await page.route(callPattern, async route => {
    if (route.request().postDataJSON().method !== 'commit') return route.continue();
    const response = await route.fetch(); assert.equal(response.ok(), true);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }) });
  });
  await page.getByRole('button', { name: 'Commit reviewed import', exact: true }).click();
  await page.getByText('Could not confirm the import. Check the destination data before choosing the file again for a new preview.', { exact: true }).waitFor();
  await page.unroute(callPattern);
  assert.equal((await records()).some((record: FixtureRecord) => record.key === 'import-uncertain'), true);
  assert.equal(await page.locator('.dm-import-preview').count(), 0);


 const { promise: held, resolve: releaseResponse } = Promise.withResolvers<void>(), { promise: received, resolve: receivedResponse } = Promise.withResolvers<void>();
  t.after(() => releaseResponse());
  await page.route(callPattern, async route => {
    if (route.request().postDataJSON().method !== 'preview') return route.continue();
    const response = await route.fetch(); receivedResponse(); await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await select(planningImport([importQuest('import-cancelled')], 4000)); await received;
  await page.goto('/#/dm'); releaseResponse(); await page.unroute(callPattern);
  await page.goto('/#/addons/dm-tools/imports');
  await page.getByRole('heading', { name: 'DM Tools planning', exact: true }).waitFor();
  assert.equal(await page.locator('.dm-import-preview').count(), 0);
  assert.equal((await records()).some((record: FixtureRecord) => record.key === 'import-cancelled'), false);

  await preview(planningImport([importQuest('import-replaced')], 5000));
  await installReviewedPackage(admin, csrf, 'dm-tools', replacementImportPackage(archive), dmToolsPermissions);
  const newGeneration = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  assert.notEqual(newGeneration, generation);
  await page.locator(`dm-tools-import-center-${newGeneration}`).waitFor();
  await page.getByRole('heading', { name: 'DM Tools planning', exact: true }).waitFor();
  assert.equal(await page.locator('.dm-import-preview').count(), 0);
  const stale = await admin.post(`${base}/services/connect`, { headers, data: { contractVersion: 'addon-service-connect.v1', contract: 'codex.import-adapter', range: '^2.0.0', cardinality: 'many', includeOwn: true } });
  assert.equal(stale.status(), 409);
  await preview(planningImport([importQuest('import-replaced')], 5000));
  await page.getByRole('button', { name: 'Commit reviewed import', exact: true }).click();
  await page.getByText('Import committed: 1 writes and 0 deletions.', { exact: true }).waitFor();
  const newBase = `/api/addons/dm-tools/generations/${newGeneration}`;
  const beforeReplacement = await records(newBase);
  const replacement = planningImport([importQuest('import-replaced')], 6000, 'replace');
  const deletionReview = await preview(replacement);
  assert.ok(deletionReview.summary.deletes > 0);
  await page.getByRole('button', { name: `Commit replacement with ${deletionReview.summary.deletes} deletions`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
  assert.deepEqual(await records(newBase), beforeReplacement);
  await preview(replacement);
  await page.getByRole('button', { name: /^Commit replacement with \d+ deletions$/u }).click();
  await page.locator('.dm-tools-import [role="status"]').filter({ hasText: /^Import committed:/u }).waitFor();
  assert.deepEqual((await records(newBase)).map((record: FixtureRecord) => record.key), ['import-replaced']);
});

test('player preview opens in a separate tab with player data, media and live updates while the DM remains signed in', async t => {
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'characters', key: 'preview-visible', expectedRevision: 0, value: { id: 'preview-visible', name: 'Preview visible hero', visibility: 'public' } },
    { operation: 'put', collection: 'characters', key: 'preview-hidden', expectedRevision: 0, value: { id: 'preview-hidden', name: 'Preview hidden hero', visibility: 'dm' } },
  ] } }));
  const upload = async (key: string) => jsonResponse(await admin.post(`/api/media/character-portrait/${key}`, {
    headers: { 'X-Codex-CSRF': csrf, 'Content-Type': 'image/svg+xml', 'X-Codex-Filename': 'portrait.svg' },
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#c8a040"/></svg>'),
  }));
  const portrait = await upload('preview-visible'), hiddenPortrait = await upload('preview-hidden');
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'characters', key: 'preview-visible', expectedRevision: 1, value: { id: 'preview-visible', name: 'Preview visible hero', portrait: portrait.url, visibility: 'public' } },
  ] } }));
  for (const mobile of [false, true]) {
    const dm = await open(t, 'dm', mobile), context = dm.context();
    const original = await jsonResponse(await context.request.get('/api/auth'));
    if (mobile) await dm.locator('[data-menu-toggle]').click();
    await dm.locator('.account-menu summary').click();
    const opened = context.waitForEvent('page');
    await dm.getByRole('button', { name: 'View as player', exact: true }).click();
    const preview = await opened;
    await preview.locator('.player-preview-notice').filter({ hasText: 'Your DM tab remains signed in.' }).waitFor();
    assert.equal(await preview.evaluate(() => window.opener === null), true);
    assert.match(preview.url(), /\?playerPreview=1#\/$/u);
    const token = await preview.evaluate(() => sessionStorage.getItem('codex_player_preview'));
    const headers = { 'X-Codex-Player-Preview': required(token) };
    const player = await jsonResponse(await context.request.get('/api/auth', { headers }));
    assert.equal(player.role, 'player'); assert.equal(player.realRole, 'player'); assert.notEqual(player.csrfToken, original.csrfToken);
    assert.deepEqual(await jsonResponse(await context.request.get('/api/auth')), original);
    assert.equal(await dm.locator('#dm-page-title').count(), 1);
    assert.equal(await preview.locator('.sidebar-footer > a[href="#/dm"]').count(), 0);
    assert.equal(await preview.locator('.account-panel input[name="password"]').count(), 0);
    await preview.evaluate(() => { location.hash = '#/characters/preview-visible'; });
    await preview.getByRole('heading', { name: 'Preview visible hero', exact: true }).waitFor();
    const image = preview.locator(`img[src^="${portrait.url}?"]`).first();
    await image.waitFor(); await preview.waitForFunction(() => [...document.images].some(image => image.src.includes('playerPreviewToken=') && image.complete && image.naturalWidth > 0));
    assert.equal((await context.request.get(hiddenPortrait.url)).status(), 200);
    assert.equal((await context.request.get(`${hiddenPortrait.url}?playerPreviewToken=${token}`)).status(), 404);
    assert.equal((await context.request.get('/api/backup', { headers })).status(), 403);
    assert.equal((await context.request.get('/api/admin/addons/dm-tools', { headers })).status(), 403);
    assert.equal((await context.request.post('/api/view-as', { headers: { ...headers, 'X-Codex-CSRF': player.csrfToken }, data: { role: 'dm' } })).status(), 403);
    const campaign = await jsonResponse(await context.request.get('/api/campaign', { headers }));
    assert.equal(campaign.collections.find((collection: FixtureCollection) => collection.name === 'characters').records.some((record: FixtureRecord) => record.key === 'preview-hidden'), false);
    const hello = await preview.evaluate(async () => {
      const response = await fetch(`/api/events?playerPreviewToken=${sessionStorage.getItem('codex_player_preview')}`);
      const reader = response.body!.getReader(); const { value } = await reader.read(); await reader.cancel(); return new TextDecoder().decode(value);
    });
    assert.match(hello, /"audience":"public"/u);
    const current = (await jsonResponse(await admin.get('/api/campaign'))).collections.find((collection: FixtureCollection) => collection.name === 'characters').records.find((record: FixtureRecord) => record.key === 'preview-visible');
    const nextName = mobile ? 'Preview visible phone update' : 'Preview visible desktop update';
    await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
      { operation: 'put', collection: 'characters', key: current.key, expectedRevision: current.revision, value: { ...current.value, name: nextName } },
    ] } }));
    await preview.getByRole('heading', { name: nextName, exact: true }).waitFor();
    await preview.goto('/#/characters/preview-visible'); await preview.getByRole('heading', { name: nextName, exact: true }).waitFor();
    assert.match(preview.url(), /\?playerPreview=1#/u);
    await preview.reload(); await preview.getByRole('heading', { name: nextName, exact: true }).waitFor();
    await preview.screenshot({ path: resolve(output, mobile ? 'player-preview-phone.png' : 'player-preview-desktop.png'), fullPage: true });
    assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const closed = preview.waitForEvent('close');
    await preview.locator('.player-preview-notice').getByRole('button', { name: 'Close player preview', exact: true }).click(); await closed;
    assert.equal((await context.request.get('/api/auth', { headers })).status(), 401);
    assert.deepEqual(await jsonResponse(await context.request.get('/api/auth')), original);
    const latest = (await jsonResponse(await admin.get('/api/campaign'))).collections.find((collection: FixtureCollection) => collection.name === 'characters').records.find((record: FixtureRecord) => record.key === 'preview-visible');
    await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
      { operation: 'put', collection: 'characters', key: latest.key, expectedRevision: latest.revision, value: { ...latest.value, name: 'Preview visible hero' } },
    ] } }));
  }
});

test('player preview fails closed after missing storage or DM logout and reports blocked pop-ups', async t => {
  const dm = await open(t), context = dm.context();
  const blank = await context.newPage(); await blank.goto('/?playerPreview=1#/dm');
  await blank.locator('.player-preview-notice').filter({ hasText: 'unavailable or expired' }).waitFor();
  assert.equal(await blank.locator('.dm-count-card').count(), 0);
  assert.equal(await blank.locator('.account-panel input[name="password"]').count(), 0);
  await blank.close();
  await dm.locator('.account-menu summary').click();
  await dm.evaluate(() => { window.savedOpen = window.open; window.open = () => null; });
  await dm.getByRole('button', { name: 'View as player', exact: true }).click();
  await dm.getByRole('alert').filter({ hasText: 'Allow pop-ups' }).waitFor();
  await dm.evaluate(() => { window.open = window.savedOpen; });
  const opened = context.waitForEvent('page'); await dm.getByRole('button', { name: 'View as player', exact: true }).click();
  const preview = await opened; await preview.locator('.player-preview-notice').filter({ hasText: 'Your DM tab remains signed in.' }).waitFor();
  await jsonResponse(await context.request.post('/api/logout'));
  await preview.reload(); await preview.locator('.player-preview-notice').filter({ hasText: 'unavailable or expired' }).waitFor();
  assert.equal(await preview.locator('.sidebar-footer > a[href="#/dm"]').count(), 0);
  assert.equal(await preview.locator('.account-panel input[name="password"]').count(), 0);
});

after(async () => {
  await browser?.close(); await admin?.dispose();
  if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; }
  if (directory) {
    const child = relative(output, directory);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

if (process.env.CODEX_DM_TOOLS_ZIP) for (const mobile of [false, true]) test(`reviewed planner annotations edit targets, quantities and shared notes on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools'));
  await exercisePlannerAnnotations({ t, open, admin, csrf, output, mobile });
});


for (const mode of ['integrated', 'isolated']) test(`installed ${mode} route reference catalogs respect grants and player visibility`, async t => {
  const id = `reference-${mode}`, secret = `private-${mode}`;
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'events', key: secret, expectedRevision: 0, value: { id: secret, name: 'Private reference event', visibility: 'dm' } },
    ...(mode === 'isolated' ? Array.from({ length: 200 }, (_, index) => ({ operation: 'put', collection: 'events', key: `zz-reference-${index}`, expectedRevision: 0,
      value: { id: `zz-reference-${index}`, name: 'é'.repeat(200), visibility: 'public' } })) : []),
  ] } }));
  await installDmPackage(admin, csrf, { id, mode, slot: false, references: true }); t.after(() => disable(id));
  for (const role of ['dm', 'player']) {
    const page = await open(t, role); await page.goto(`/#/addons/${id}/planner`);
    const route = mode === 'isolated' ? page.locator('[data-addon-route-outlet]').frameLocator('iframe') : page.locator('[data-addon-route-outlet]');
    const context = route.getByLabel('Fixture context'); await context.filter({ hasText: '"ready":true' }).waitFor();
    const catalog = JSON.parse(await context.textContent().then(required)).recordReferences;
    if (mode === 'isolated') assert.equal(catalog.truncated, true);
    assert.ok(catalog.records.some((record: { id: string }) => record.id === 'arrival'));
    assert.equal(catalog.records.some((record: { id: string }) => record.id === secret), role === 'dm');
    assert.ok(catalog.records.every((record: { collection: string }) => record.collection === 'events' && Object.keys(record).sort().join(',') === 'collection,href,id,label'));
    await route.getByLabel('Fixture notes').fill('Retain mounted draft');
    if (role === 'dm') {
      const campaign = await jsonResponse(await admin.get('/api/campaign'));
      const event = campaign.collections.find((collection: FixtureCollection) => collection.name === 'events').records.find((record: FixtureRecord) => record.key === secret);
      await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
        { operation: 'put', collection: 'events', key: secret, expectedRevision: event.revision, value: { ...event.value, name: 'Updated private reference' } },
      ] } }));
      await context.filter({ hasText: 'Updated private reference' }).waitFor();
      assert.equal(await route.getByLabel('Fixture notes').inputValue(), 'Retain mounted draft');
    }
  }
});

for (const mobile of [false, true]) test(`add-on manager completes package review, update and rollback on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await exerciseAddonManager({ t, open, admin, csrf, output, mobile });
});

for (const mode of ['integrated', 'isolated']) for (const mobile of [false, true]) test(`contributed settings ${mode} saves and protects drafts on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await exerciseSettings({ t, open, admin, csrf, output, mobile, mode });
});

test('contributed settings retry preserves other panels', async t => {
  await exerciseSettingsFailure({ t, open, admin, csrf, output, mobile: false });
});

test('contributed settings cards stay stable when another add-on changes panel order', async t => {
  await exerciseSettingsCardStability({ t, open, admin, csrf, output, mobile: false });
});

for (const mobile of [false, true]) test(`uninstall reviews dependencies and preserves records through reinstall on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await exerciseUninstall({ t, open, admin, csrf, output, mobile });
});

for (const mobile of [false, true]) test(`sourcebook and provider configuration is reviewed and revision guarded on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await exerciseConfiguration({ t, open, admin, csrf, output, mobile });
});

if (process.env.CODEX_DM_TOOLS_ZIP) for (const mobile of [false, true]) test(`planner canvas restores navigation and scaled dragging on ${mobile ? 'phone' : 'desktop'}`, async t => {
  await installReviewedPackage(admin, csrf, 'dm-tools', await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions);
  t.after(() => disable('dm-tools'));
  await exercisePlannerCanvas({ t, open, admin, csrf, output, mobile });
});

for (const mode of ["integrated", "isolated"]) test(`installed ${mode} record panels preserve separate saves and role-visible map context`, async t => { await exerciseRecordPanels({ t, open, admin, csrf, mode }); });

if (process.env.CODEX_DM_TOOLS_ZIP) for (const mobile of [false, true]) test(`installed planning reader renders saved prose and related map content on ${mobile ? "phone" : "desktop"}`, async t => { await installReviewedPackage(admin, csrf, "dm-tools", await readFile(resolve(required(process.env.CODEX_DM_TOOLS_ZIP))), dmToolsPermissions); t.after(() => disable("dm-tools")); await exercisePlanningReader({ t, open, admin, csrf, output, mobile }); });

for (const mobile of [false, true]) test(`saved package cleanup protects recovery and handles lost responses on ${mobile ? "phone" : "desktop"}`, async t => { await exercisePackageCleanup({ t, open, admin, csrf, output, mobile }); });
