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
import { jsonResponse, installReviewedPackage } from './installed-graph-fixture.mjs';
import { attemptHash, unloadBlocked } from './installed-planner-navigation-fixture.mjs';
import { exerciseCzechSheet } from './installed-sheet-localization-fixture.mjs';

const archivePath = process.env.CODEX_SHEETS_ZIP;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-sheets');
let directory, host, browser, admin, csrf, origin, base, hostOutput = '';
before(async () => {
  if (!archivePath) return;
  const archive = await readFile(resolve(archivePath));
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`;
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
  const state = await jsonResponse(await admin.get('/api/admin/addons/dnd-sheets'));
  base = `/api/addons/dnd-sheets/generations/${state.state.activeGenerationId}/data`;
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

async function seed(key) {
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [
    { operation: 'put', collection: 'characters', key, expectedRevision: 0, value: { id: key, name: 'Mira of the North', knowledge: 4, visibility: 'public', description: 'The old lighthouse keeper.' } },
  ] } }));
  await put(key, {
    v: 3, player: 'River', className: 'Wizard', species: 'Human', background: 'Sage', level: 5,
    abilities: { STR: 10, DEX: 14, CON: 14, INT: 18, WIS: 12, CHA: 10 }, hp: 21, maxHp: 32, ac: 12, tempHp: 3, initiative: 2, speed: 30, profBonus: 3,
    saveProf: { INT: true, WIS: true }, skillProf: { arcana: true, animalHandling: true }, skillExpertise: { arcana: true }, currency: { cp: 12, sp: 6, ep: 0, gp: 34, pp: 2 },
    inventory: [{ id: 'staff', name: 'Walking staff', qty: 1, location: 'ready', notes: 'A carved raven' }, { id: 'rope', name: 'Rope', qty: 1, location: 'pack', notes: '' }, { id: 'cloak', name: 'Travel cloak', qty: 1, location: 'equipped', attuned: true }],
    resources: [{ id: 'luck', name: 'Lucky charm', current: 1, max: 2 }], resourceUses: { 'slot-1': 2 }, notes: 'Keep the promise.', homebrew: { clue: 'blue lantern' },
    rulesProvider: { materialized: { spellcasting: { perClass: [{ classId: 'wizard', ability: 'INT', saveDC: 15, spellAttack: 7 }] }, resources: [{ key: 'slot-1', name: 'Spell Slots (1st)', max: 4 }], weapons: [{ name: 'Walking staff', attackBonus: 3, damage: '1d6' }], languages: ['Common', 'Dwarvish'] } },
  }, 0);
}
async function put(key, value, revision) { return jsonResponse(await admin.post(`${base}/transactions`, { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'addon-data-transaction.v1', mutations: [{ operation: 'put', kind: 'record-extension', dataId: 'dnd-sheets', key, expectedRevision: revision, value }] } })); }
async function get(key) { return jsonResponse(await admin.post(`${base}/get`, { data: { contractVersion: 'addon-data-get.v1', kind: 'record-extension', dataId: 'dnd-sheets', key } })); }

test('campaign recovery refreshes installed Sheets and preserves unsaved add-on drafts', { skip: !archivePath }, async t => {
  const key = 'campaign-recovery'; await seed(key);
  const point = (await jsonResponse(await admin.post('/api/recovery', { headers: { 'X-Codex-CSRF': csrf }, data: {} }))).points[0];
  const original = await get(key); await put(key, { ...original.value, hp: 5 }, original.revision);
  const changed = await get(key);
  const page = await open(t, key), sheet = page.locator('.addon-dnd-sheets');
  assert.equal(await sheet.locator('.dse-hp .dse-number').first().textContent(), '5');
  const restore = async () => {
    const current = await jsonResponse(await admin.get('/api/recovery'));
    return jsonResponse(await admin.post('/api/recovery/restore', { headers: { 'X-Codex-CSRF': csrf }, data: { id: point.id, expectedRevision: current.revision } }));
  };
  await restore();
  await page.waitForFunction(() => document.querySelector('.dse-hp .dse-number')?.textContent === '21');
  assert.ok((await get(key)).revision > changed.revision);
  assert.deepEqual((await get(key)).value.homebrew, { clue: 'blue lantern' });
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Notes', exact: true }).click();
  await page.route(writes, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'UNAVAILABLE', message: 'offline' } }) }));
  await sheet.getByRole('textbox', { name: 'Sheet notes' }).fill('Draft survives campaign recovery.');
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await sheet.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  await restore(); await page.getByRole('alert').filter({ hasText: 'Your unsaved edits are still open' }).waitFor();
  await sheet.getByRole('tab', { name: 'Notes', exact: true }).click();
  assert.equal(await sheet.getByRole('textbox', { name: 'Sheet notes' }).inputValue(), 'Draft survives campaign recovery.');
  assert.equal(await unloadBlocked(page), true);
  assert.equal((await get(key)).value.notes, 'Keep the promise.');
});
async function open(t, key, mobile = false, role = 'dm', configure = async () => {}) {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  t.after(() => context.close()); await jsonResponse(await context.request.post('/api/login', { data: { password: `local-sheets-${role}` } }));
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await configure(page);
  await page.goto(`/#/characters/${key}`);
  await page.locator('#character-view-addons').click();
  await page.locator('.dse-backpack').waitFor(); return page;
}
async function saved(page) { await page.locator('.dnd-save-status').getByText('Saved.', { exact: true }).waitFor(); }
const writes = '**/api/addons/dnd-sheets/generations/*/data/transactions';

for (const mobile of [false, true]) test(`character profile and installed sheet preserve editing state on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath }, async t => {
  const key = `profile-tabs-${mobile}`; await seed(key);
  const page = await open(t, key, mobile, mobile ? 'player' : 'dm');
  const sheet = page.locator('.addon-dnd-sheets');
  const profileTab = page.locator('#character-view-profile');
  const sheetTab = page.locator('#character-view-addons');
  const initial = await get(key);
  await sheet.evaluate(element => { window.originalCharacterSheet = element; });
  await sheetTab.press('Home');
  await page.locator('#record-title').waitFor();
  assert.equal(await sheet.isVisible(), false);
  assert.equal(await profileTab.getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('A profile draft');
  await profileTab.press('End');
  assert.equal(await sheet.isVisible(), true);
  assert.equal(await sheet.evaluate(element => element === window.originalCharacterSheet), true);
  assert.equal(await page.locator('[name="name"]').isVisible(), false);
  assert.equal((await get(key)).revision, initial.revision, 'view changes never save a record');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Notes', exact: true }).click();
  await page.route(writes, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'UNAVAILABLE', message: 'offline' } }) }));
  await sheet.getByRole('textbox', { name: 'Sheet notes' }).fill('A sheet draft');
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await sheet.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  await profileTab.click();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'A profile draft');
  assert.equal(await unloadBlocked(page), true);
  await page.screenshot({ path: resolve(output, `profile-editor-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  const save = await page.getByRole('button', { name: 'Save entry', exact: true }).boundingBox();
  assert.ok(save.y >= 0 && save.y + save.height <= (mobile ? 784 : 1100), 'Save stays above the mobile navigation and inside the viewport');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await sheetTab.click();
  await sheet.getByRole('tab', { name: 'Notes', exact: true }).click();
  assert.equal(await sheet.getByRole('textbox', { name: 'Sheet notes' }).inputValue(), 'A sheet draft');
  assert.equal((await get(key)).value.notes, initial.value.notes);
});

async function write(page, action) {
  const response = page.waitForResponse(response => response.url().endsWith('/data/transactions') && response.request().method() === 'POST');
  await action(); await jsonResponse(await response);
  await page.waitForFunction(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return !event.defaultPrevented; });
}

for (const mobile of [false, true]) test(`installed Sheets restores Compact/Classic play on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath }, async t => {
  const key = `play-${mobile}`; await seed(key); const page = await open(t, key, mobile), sheet = page.locator('.addon-dnd-sheets');
  assert.equal(await sheet.locator('.dse-ability').count(), 6);
  assert.equal(await sheet.locator('.dse-skill').count(), 18);
  const style = await sheet.locator('.dse-ability').first().evaluate(node => ({ background: getComputedStyle(node).backgroundColor, radius: getComputedStyle(node).borderRadius, padding: getComputedStyle(node).padding }));
  assert.deepEqual(style, { background: 'rgb(28, 21, 9)', radius: '12px', padding: '8px 12px' });
  assert.equal(await sheet.getByRole('tab', { selected: true }).evaluate(node => getComputedStyle(node).borderBottomColor), 'rgb(200, 160, 64)');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await sheet.screenshot({ path: resolve(output, `compact-${mobile ? 'phone' : 'desktop'}.png`) });
  assert.equal(await sheet.locator('input').count(), 0);
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await write(page, () => sheet.getByRole('button', { name: 'Decrease hit points', exact: true }).click());
  assert.equal((await get(key)).value.hp, 20);
  await write(page, () => sheet.getByRole('combobox', { name: 'Move Rope', exact: true }).selectOption('ready')); await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await write(page, () => sheet.getByRole('button', { name: 'Use Spell Slots (1st)', exact: true }).click());
  assert.equal((await get(key)).value.resourceUses['slot-1'], 1);
  await write(page, () => sheet.getByRole('button', { name: 'Use Lucky charm', exact: true }).click());
  assert.equal((await get(key)).value.resources[0].current, 0);
  assert.match(await sheet.locator('.dse-attack').textContent(), /Walking staff.*\+3.*1d6/);
  await sheet.getByRole('tab', { name: 'Settings', exact: true }).click();
  await sheet.getByRole('combobox', { name: 'Sheet layout' }).selectOption('classic');
  await sheet.getByRole('tab', { name: 'Character Sheet', exact: true }).click();
  await sheet.locator('.dse-layout-classic').waitFor();
  assert.equal(await sheet.locator('.dse-dock').count(), 0);
  await sheet.getByRole('button', { name: 'Done editing', exact: true }).click();
  await sheet.screenshot({ path: resolve(output, `classic-${mobile ? 'phone' : 'desktop'}.png`) });
  await page.reload(); await sheet.locator('.dse-layout-classic').waitFor();
  assert.equal(await sheet.locator('.dse-hp .dse-number').first().textContent(), '20');
  assert.equal((await get(key)).value.inventory.find(item => item.id === 'rope').location, 'ready');
  assert.deepEqual((await get(key)).value.homebrew, { clue: 'blue lantern' });
  await sheet.getByRole('tab', { name: 'Character Sheet', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await sheet.getByRole('tab', { name: 'Combat', exact: true }).getAttribute('aria-selected'), 'true');
});

test('installed Sheets retains a failed draft, retries and handles concurrent edits without overwrite', { skip: !archivePath }, async t => {
  const key = 'draft'; await seed(key); const page = await open(t, key), sheet = page.locator('.addon-dnd-sheets');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Notes', exact: true }).click();
  await page.route(writes, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'offline' } }) }));
  await sheet.getByRole('textbox', { name: 'Sheet notes' }).fill('This draft must survive.');
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await sheet.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  assert.equal(await sheet.getByRole('tab', { name: 'Combat', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await unloadBlocked(page), true);
  await attemptHash(page, '#/timeline'); await page.waitForURL(`**/#/characters/${key}`);
  assert.equal((await get(key)).value.notes, 'Keep the promise.');
  await page.unroute(writes); await sheet.getByRole('button', { name: 'Retry save', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.dnd-save-status [role=alert]'));
  assert.equal((await get(key)).value.notes, 'This draft must survive.');
  assert.equal(await unloadBlocked(page), false);
  const server = await get(key); await put(key, { ...server.value, hp: 8 }, server.revision);
  await sheet.getByRole('tab', { name: 'Notes', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Sheet notes' }).fill('Conflicting draft');
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await sheet.getByText(/The sheet changed elsewhere/).waitFor();
  assert.equal((await get(key)).value.hp, 8);
  const download = page.waitForEvent('download'); await sheet.getByRole('button', { name: 'Export draft' }).click();
  const stream = await (await download).createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(), /Conflicting draft/);
  await sheet.getByRole('button', { name: 'Reload saved sheet' }).click();
  await page.waitForFunction(() => document.querySelector('.addon-dnd-sheets [aria-label="Current HP"]')?.value === '8');
  assert.equal(await sheet.getByRole('spinbutton', { name: 'Current HP', exact: true }).inputValue(), '8');
});

test('installed Sheets follows the host player editing policy', { skip: !archivePath }, async t => {
  const key = 'reader'; await seed(key); const page = await open(t, key, true, 'player'), sheet = page.locator('.addon-dnd-sheets');
  assert.equal(await sheet.locator('input').count(), 0);
  assert.equal(await sheet.getByRole('button', { name: /Add item/ }).count(), 0);
  await sheet.screenshot({ path: resolve(output, 'player-reading-phone.png') });
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('button', { name: /Add item/ }).waitFor();
  assert.equal(await sheet.getByRole('button', { name: /Add item/ }).count(), 1);
  assert.equal(await sheet.getByRole('textbox', { name: 'Item name' }).count(), 3);
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await write(page, () => sheet.getByRole('button', { name: 'Use Spell Slots (1st)', exact: true }).click());
  assert.equal((await get(key)).value.resourceUses['slot-1'], 1);
  await sheet.screenshot({ path: resolve(output, 'player-phone.png') });
});

test('installed Sheets keeps custom equipment usable without an engine', { skip: !archivePath }, async t => {
  const key = 'custom-equipment'; await seed(key); const page = await open(t, key);
  await page.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await page.getByRole('button', { name: /Add item/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add equipment', exact: true });
  await dialog.getByText(/equipment catalog is unavailable/).waitFor();
  await dialog.getByRole('textbox', { name: 'Custom item name' }).fill('Lighthouse key');
  await dialog.getByRole('button', { name: 'Select custom item', exact: true }).click();
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  await write(page, () => dialog.getByRole('button', { name: 'Add items to backpack' }).click());
  assert.equal((await get(key)).value.inventory.at(-1).name, 'Lighthouse key');
  await page.reload(); await page.locator('.dse-backpack').getByText('Lighthouse key', { exact: true }).waitFor();
});

for (const mobile of [false, true]) test(`installed Sheets provider diagnostics preserve standalone values in ${mobile ? 'Czech on phone' : 'English on desktop'}`, { skip: !archivePath }, async t => {
  const key = `provider-standalone-${mobile}`; await seed(key); const original = await get(key);
  const page = await open(t, key, mobile, mobile ? 'player' : 'dm', async page => {
    if (mobile) await page.addInitScript(() => localStorage.setItem('codex_lang', 'cs'));
  }), sheet = page.locator('.addon-dnd-sheets');
  await sheet.locator('.dnd-sheet-engine').click();
  const panel = sheet.locator('.dnd-provider-status');
  await panel.locator('[data-rules-status="missing-engine"]').waitFor();
  await panel.getByRole('heading', { name: mobile ? 'Pravidla a jejich zdroje' : 'Rules and providers' }).waitFor();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/services/connect')),
    panel.getByRole('button', { name: mobile ? 'Ověřit připojení pravidel' : 'Check rules connection', exact: true }).click()]);
  await page.waitForFunction(() => !document.querySelector('.dnd-provider-status button')?.disabled);
  assert.deepEqual(await get(key), original);
  assert.equal(await unloadBlocked(page), false);
  await panel.screenshot({ path: resolve(output, `providers-${mobile ? 'cs-phone' : 'en-desktop'}.png`) });
  await panel.locator('summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await sheet.getByRole('button', { name: mobile ? 'Upravit deník' : 'Edit sheet', exact: true }).click();
  assert.equal(await sheet.getByRole('textbox', { name: mobile ? 'Hráč' : 'Player', exact: true }).inputValue(), 'River');
  assert.equal(await sheet.getByRole('textbox', { name: mobile ? 'Povolání' : 'Class', exact: true }).inputValue(), 'Wizard');
  await sheet.getByRole('combobox', { name: mobile ? 'Rozložení deníku' : 'Sheet layout' }).selectOption('classic');
  assert.equal(await unloadBlocked(page), false);
  await page.reload(); await sheet.locator('.dse-layout-classic').waitFor();
  await sheet.getByRole('tab', { name: mobile ? 'Deník postavy' : 'Character Sheet', exact: true }).waitFor();
  assert.deepEqual(await get(key), original);
});

test('installed Sheets provider reconnection retains a failed Czech draft', { skip: !archivePath }, async t => {
  const key = 'provider-draft'; await seed(key); const original = await get(key);
  const connects = '**/api/addons/dnd-sheets/generations/*/services/connect';
  const page = await open(t, key, true, 'dm', async page => {
    await page.addInitScript(() => localStorage.setItem('codex_lang', 'cs'));
    await page.route(connects, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'SERVICE_UNAVAILABLE' } }) }));
  }), sheet = page.locator('.addon-dnd-sheets');
  await sheet.locator('.dnd-sheet-engine').click();
  await sheet.locator('[data-rules-status="connection-error"]').waitFor();
  await sheet.getByRole('button', { name: 'Upravit deník', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Poznámky', exact: true }).click();
  await page.route(writes, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'UNAVAILABLE' } }) }));
  await sheet.getByRole('textbox', { name: 'Poznámky deníku' }).fill('Rozepsaná zpráva pro River.');
  await sheet.getByRole('tab', { name: 'Nastavení', exact: true }).click();
  await sheet.getByRole('button', { name: 'Zkusit uložit znovu', exact: true }).waitFor();
  await page.unroute(connects);
  await sheet.getByRole('button', { name: 'Ověřit připojení pravidel', exact: true }).click();
  await sheet.locator('[data-rules-status="missing-engine"]').waitFor();
  assert.deepEqual(await get(key), original);
  assert.equal(await unloadBlocked(page), true);
  await sheet.getByRole('tab', { name: 'Poznámky', exact: true }).click();
  assert.equal(await sheet.getByRole('textbox', { name: 'Poznámky deníku' }).inputValue(), 'Rozepsaná zpráva pro River.');
  await page.unroute(writes);
  await write(page, () => sheet.getByRole('button', { name: 'Zkusit uložit znovu', exact: true }).click());
  await sheet.getByText('Uloženo.', { exact: true }).waitFor();
  assert.equal((await get(key)).value.notes, 'Rozepsaná zpráva pro River.');
  assert.deepEqual((await get(key)).value.homebrew, original.value.homebrew);
});

test('installed Sheets provider diagnostics recover missing data and compare saved provenance without writes', { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  await installReviewedPackage(admin, csrf, 'dnd-engine', await readFile(resolve(process.env.CODEX_ENGINE_ZIP)), []);
  const key = 'provider-sources'; await seed(key); const original = await get(key);
  const page = await open(t, key), sheet = page.locator('.addon-dnd-sheets');
  await sheet.locator('.dnd-sheet-engine').click();
  await sheet.getByRole('button', { name: 'Check rules connection', exact: true }).click();
  await sheet.locator('[data-rules-status="missing"]').waitFor();
  assert.deepEqual(await get(key), original);
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('button', { name: 'Preview computed values', exact: true }).click();
  await sheet.locator('.dnd-sheet-computed').waitFor();
  assert.equal(await sheet.getByRole('button', { name: 'Apply computed fallback values', exact: true }).count(), 0);
  assert.deepEqual(await get(key), original);
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', await readFile(resolve(process.env.CODEX_COMPENDIUM_ZIP)), []);
  // Activating an optional provider restarts its consumers through the host lifecycle.
  await sheet.locator('.dse-backpack').waitFor();
  await sheet.locator('.dnd-sheet-engine').click();
  await sheet.getByRole('button', { name: 'Check rules connection', exact: true }).click();
  await sheet.locator('[data-rules-status="ready"]').waitFor();
  await sheet.locator('.dnd-provider-status summary').click();
  await sheet.locator('.dnd-provider-status').getByText('dnd-2024-compendium', { exact: true }).waitFor();
  assert.deepEqual(await get(key), original);
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('button', { name: 'Preview computed values', exact: true }).click();
  await sheet.getByRole('button', { name: 'Apply computed fallback values', exact: true }).waitFor();
  assert.deepEqual(await get(key), original);
  await write(page, () => sheet.getByRole('button', { name: 'Apply computed fallback values', exact: true }).click());
  const computed = await get(key);
  assert.equal(computed.value.rulesProvider.identity.providerAddonId, 'dnd-2024-compendium');
  assert.equal(computed.value.hp, original.value.hp);
  assert.deepEqual(computed.value.inventory, original.value.inventory.map(item => ({ notes: '', ...item })));
  await sheet.locator('[data-provider-comparison="same"]').waitFor();
  const calls = '**/api/addons/dnd-sheets/generations/*/services/call';
  await page.route(calls, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'STALE_BINDING' } }) }));
  await sheet.getByRole('button', { name: 'Preview computed values', exact: true }).click();
  await sheet.locator('[data-rules-status="stale"]').waitFor();
  await page.unroute(calls);
  await sheet.getByRole('button', { name: 'Check rules connection', exact: true }).click();
  await sheet.locator('[data-rules-status="ready"]').waitFor();
  assert.deepEqual(await get(key), computed);
  assert.equal(await sheet.getByRole('button', { name: 'Apply computed fallback values', exact: true }).count(), 0);
  await put(key, { ...computed.value, rulesProvider: { ...computed.value.rulesProvider, identity: { ...computed.value.rulesProvider.identity, contentRevision: 'previous-content' } } }, computed.revision);
  const older = await get(key); await page.reload(); await sheet.locator('.dnd-sheet-engine').click();
  await sheet.getByRole('button', { name: 'Check rules connection', exact: true }).click();
  await sheet.locator('[data-provider-comparison="changed"]').waitFor();
  assert.deepEqual(await get(key), older);
  await sheet.locator('.dnd-provider-status').screenshot({ path: resolve(output, 'providers-source-changed.png') });
});

test('installed Sheets uses real catalog labels and keeps scores stable across recalculation', { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  await installReviewedPackage(admin, csrf, 'dnd-engine', await readFile(resolve(process.env.CODEX_ENGINE_ZIP)), []);
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', await readFile(resolve(process.env.CODEX_COMPENDIUM_ZIP)), []);
  const key = 'automated'; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, abilities: { ...initial.value.abilities, INT: 16 }, background: 'Acolyte', classes: [{ classId: 'wizard', level: 5 }], abilityGrants: [{ id: 'bgasi', assign: { INT: 2 } }] }, initial.revision);
  const page = await open(t, key), sheet = page.locator('.addon-dnd-sheets');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Builder', exact: true }).click();
  await sheet.getByRole('button', { name: 'Load builder', exact: true }).click();
  await sheet.locator('.dnd-builder-class-row').waitFor();
  assert.match(await sheet.locator('.dnd-builder-class-row select').first().textContent(), /Fighter/);
  for (let i = 0; i < 2; i++) {
    await write(page, () => sheet.getByRole('button', { name: 'Recalculate and save fallback values', exact: true }).click());
    await sheet.getByText('Computed fallback values saved.', { exact: true }).waitFor();
    const document = await get(key);
    assert.equal(document.value.baseStats.INT, 16); assert.equal(document.value.abilities.INT, 18);
    assert.equal(document.value.hp, 21); assert.equal(document.value.resourceUses['slot-1'], 2);
    assert.ok(document.value.rulesProvider.materialized.resources.some(resource => resource.key === 'slot-1'));
  }
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await sheet.getByRole('button', { name: 'Use Spell Slots (1st)', exact: true }).waitFor();
});

test('installed Sheets saves Builder foundations, subclass and split ability grants', { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  const key = 'builder-workflow'; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, classes: [{ classId: 'wizard', level: 5 }] }, initial.revision);
  const page = await open(t, key), sheet = page.locator('.addon-dnd-sheets');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Builder', exact: true }).click(); await sheet.getByRole('button', { name: 'Load builder', exact: true }).click();
  await sheet.getByLabel('Species', { exact: true }).waitFor();
  await write(page, () => sheet.getByLabel('Species', { exact: true }).selectOption({ label: 'Elf' }));
  await write(page, () => sheet.getByLabel('Lineage', { exact: true }).selectOption({ label: 'High Elf' }));
  await write(page, () => sheet.getByLabel('Background', { exact: true }).selectOption({ label: 'Acolyte' }));
  await write(page, () => sheet.getByRole('combobox', { name: 'Class 1 subclass', exact: true }).selectOption({ label: 'Abjurer' }));
  await write(page, async () => { await sheet.getByLabel('Base INT', { exact: true }).fill('15'); await sheet.getByLabel('Base INT', { exact: true }).press('Tab'); });
  const origin = sheet.locator('.dnd-builder-choices fieldset').filter({ has: page.getByLabel('bgasi INT', { exact: true }) });
  await write(page, async () => { await origin.getByLabel('bgasi INT', { exact: true }).fill('2'); await origin.getByLabel('bgasi INT', { exact: true }).press('Tab'); });
  await write(page, async () => { await origin.getByLabel('bgasi WIS', { exact: true }).fill('1'); await origin.getByLabel('bgasi WIS', { exact: true }).press('Tab'); });
  await origin.getByText('3 / 3 ability points assigned', { exact: true }).waitFor();
  const saved = (await get(key)).value;
  assert.equal(saved.baseStats.INT, 15); assert.equal(saved.abilities.INT, 17); assert.equal(saved.species, 'Elf'); assert.equal(saved.lineage, 'high-elf'); assert.equal(saved.subclass, 'Abjurer');
  assert.equal(saved.classes[0].subclass, 'abjurer'); assert.equal(saved.inventory.length, 3); assert.equal(saved.notes, 'Keep the promise.'); assert.equal(saved.homebrew.clue, 'blue lantern');
  await sheet.screenshot({ path: resolve(output, 'builder-desktop.png') });
});

for (const mobile of [false, true]) test(`installed Sheets equipment, spells and reviewed rests persist on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  const key = `session-workflow-${mobile}`; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, classes: [{ classId: 'wizard', level: 5 }], hp: 5 }, initial.revision);
  const page = await open(t, key, mobile), sheet = page.locator('.dnd-sheet-shell');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('button', { name: /Add item/ }).click();
  const equipment = page.getByRole('dialog', { name: 'Add equipment', exact: true });
  await equipment.waitFor();
  assert.equal(await equipment.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(28, 21, 9)');
  await equipment.getByRole('button', { name: 'Open Weapons', exact: true }).click();
  await equipment.getByRole('button', { name: 'Open martial', exact: true }).click();
  await equipment.getByRole('button', { name: 'Open melee', exact: true }).click();
  assert.match(await equipment.getByRole('navigation', { name: 'Equipment folders' }).textContent(), /All equipment.*Weapons.*martial.*melee/);
  await equipment.getByRole('searchbox', { name: 'Search equipment', exact: true }).fill('Longsword');
  await equipment.getByRole('button', { name: 'Select Longsword', exact: true }).click();
  await equipment.getByRole('spinbutton', { name: 'Selected Longsword quantity', exact: true }).fill('2');
  await equipment.getByRole('spinbutton', { name: 'Selected Longsword quantity', exact: true }).press('Tab');
  await equipment.getByRole('textbox', { name: 'Custom item name', exact: true }).fill('Star chart');
  await equipment.getByRole('button', { name: 'Select custom item', exact: true }).click();
  await equipment.screenshot({ path: resolve(output, `equipment-${mobile ? 'phone' : 'desktop'}.png`) });
  await write(page, () => equipment.getByRole('button', { name: 'Add items to backpack' }).click());
  const inventory = (await get(key)).value.inventory;
  assert.equal(inventory.length, 5); assert.equal(inventory[3].ref, 'longsword'); assert.equal(inventory[3].kind, 'weapon'); assert.equal(inventory[3].qty, 2); assert.equal(inventory[3].snapshot.name, 'Longsword');
  await sheet.getByRole('tab', { name: 'Spellbook', exact: true }).click();
  await sheet.getByRole('button', { name: 'Manage class spells', exact: true }).click();
  await sheet.getByRole('searchbox', { name: 'Search spells', exact: true }).fill('Mage Armor');
  const spell = sheet.locator('[data-spell="mage-armor"]'); await spell.waitFor();
  await write(page, () => spell.getByRole('button', { name: 'Learn spell', exact: true }).click());
  await write(page, () => spell.getByRole('button', { name: 'Prepare', exact: true }).click());
  await spell.getByRole('combobox', { name: 'Casting slot for Mage Armor', exact: true }).selectOption('slot-1');
  await write(page, () => spell.getByRole('button', { name: 'Cast', exact: true }).click());
  let state = (await get(key)).value;
  assert.deepEqual(state.spellbook.wizard, ['mage-armor']); assert.deepEqual(state.preparedSpells.wizard, ['mage-armor']); assert.equal(state.resourceUses['slot-1'], 1);
  assert.equal(state.spells.find(item => item.id === 'snapshot:mage-armor').name, 'Mage Armor');
  assert.equal(state.spells.find(item => item.id === 'snapshot:mage-armor').level, 1);
  await sheet.screenshot({ path: resolve(output, `spellbook-${mobile ? 'phone' : 'desktop'}.png`) });
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click();
  await sheet.getByRole('button', { name: /Spend d6 hit die/ }).click();
  const healing = page.getByRole('dialog', { name: 'Review hit-die healing', exact: true }); await healing.waitFor();
  assert.equal((await get(key)).value.hp, 5);
  await write(page, () => healing.getByRole('button', { name: 'Apply changes', exact: true }).click());
  state = (await get(key)).value; assert.equal(state.hp, 11); assert.equal(state.resourceUses['hit-dice-d6'], 4);
  await sheet.getByRole('button', { name: 'Short rest', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review short rest', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await get(key)).value.resourceUses['slot-1'], 1);
  await sheet.getByRole('button', { name: 'Long rest', exact: true }).click();
  const rest = page.getByRole('dialog', { name: 'Review long rest', exact: true });
  await rest.screenshot({ path: resolve(output, `rest-${mobile ? 'phone' : 'desktop'}.png`) });
  await write(page, () => rest.getByRole('button', { name: 'Apply changes', exact: true }).click());
  state = (await get(key)).value; assert.equal(state.hp, state.maxHp); assert.equal(state.tempHp, 0); assert.equal(state.resourceUses['slot-1'], undefined); assert.equal(state.resources[0].current, 1); assert.equal(state.inventory.length, 5);
  await page.reload(); await page.locator('.dse-backpack').getByText('Star chart', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

for (const mobile of [false, true]) test(`installed Sheets spell grants, copying and rituals retain data on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  const key = `spell-tools-${mobile}`; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, classes: [{ classId: 'wizard', level: 5 }], feats: [{ featId: 'magic-initiate' }], species: 'Elf', lineage: 'high-elf',
    currency: { ...initial.value.currency, gp: 100 }, inventory: [...initial.value.inventory, { id: 'scroll', name: 'Scroll of Alarm', qty: 2, location: 'pack', notes: 'From the lighthouse' }] }, initial.revision);
  const page = await open(t, key, mobile), sheet = page.locator('.dnd-sheet-shell');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Spellbook', exact: true }).click();
  await sheet.getByRole('button', { name: 'Manage class spells', exact: true }).click();
  await write(page, () => sheet.getByRole('combobox', { name: 'Magic Initiate casting ability', exact: true }).selectOption('WIS'));
  const choice = sheet.locator('[data-grant="feat:magic-initiate:mi-spell"]');
  await choice.getByRole('combobox').selectOption('cure-wounds');
  await write(page, () => choice.getByRole('button', { name: 'Choose spell', exact: true }).click());
  const granted = sheet.locator('[data-granted-spell="feat:magic-initiate:cure-wounds"]');
  await granted.getByRole('combobox').selectOption('charge-cure-wounds');
  await write(page, () => granted.getByRole('button', { name: 'Cast granted spell', exact: true }).click());
  assert.equal((await get(key)).value.resourceUses['charge-cure-wounds'], 0);
  assert.equal(await granted.locator('option[value="charge-cure-wounds"]').isDisabled(), true);
  assert.equal((await get(key)).value.grantCastingAbilities['feat:magic-initiate:magic-initiate-casting'], 'WIS');
  await sheet.getByRole('searchbox', { name: 'Search spells', exact: true }).fill('Alarm');
  const alarm = sheet.locator('[data-spell="alarm"]');
  async function reviewCopy() {
    await alarm.getByRole('button', { name: 'Copy · 50 GP', exact: true }).click();
    const copying = page.getByRole('dialog');
    await copying.getByRole('combobox', { name: 'Scroll to consume', exact: true }).selectOption('scroll');
    await copying.getByRole('button', { name: 'Review copying', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Review spell copying', exact: true }); await review.waitFor(); return review;
  }
  let review = await reviewCopy();
  assert.match(await review.textContent(), /100.*50.*Scroll of Alarm/);
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await get(key)).value.currency.gp, 100);
  review = await reviewCopy();
  await review.screenshot({ path: resolve(output, `copy-review-${mobile ? 'phone' : 'desktop'}.png`) });
  await page.route(writes, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'offline' } }) }));
  await review.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await sheet.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  let state = (await get(key)).value;
  assert.equal(state.currency.gp, 100); assert.equal(state.inventory.find(item => item.id === 'scroll').qty, 2); assert.equal(await unloadBlocked(page), true);
  await page.unroute(writes); await write(page, () => sheet.getByRole('button', { name: 'Retry save', exact: true }).click());
  state = (await get(key)).value;
  assert.equal(state.currency.gp, 50); assert.equal(state.inventory.find(item => item.id === 'scroll').qty, 1);
  assert.equal(state.inventory.find(item => item.id === 'scroll').notes, 'From the lighthouse'); assert.deepEqual(state.spellbook.wizard, ['alarm']);
  await sheet.getByRole('button', { name: 'Manage class spells', exact: true }).click();
  await sheet.getByRole('searchbox', { name: 'Search spells', exact: true }).fill('Alarm');
  const beforeUses = structuredClone(state.resourceUses);
  await write(page, () => alarm.getByRole('button', { name: 'Cast as ritual', exact: true }).click());
  state = (await get(key)).value;
  assert.deepEqual(state.resourceUses, beforeUses); assert.equal(state.notes, 'Keep the promise.'); assert.equal(state.homebrew.clue, 'blue lantern');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await sheet.screenshot({ path: resolve(output, `spell-tools-${mobile ? 'phone' : 'desktop'}.png`) });
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click(); await sheet.getByRole('button', { name: 'Long rest', exact: true }).click();
  await write(page, () => page.getByRole('dialog', { name: 'Review long rest', exact: true }).getByRole('button', { name: 'Apply changes', exact: true }).click());
  assert.equal((await get(key)).value.resourceUses['charge-cure-wounds'], undefined);
  await page.reload(); await page.locator('.dse-backpack').getByText('Scroll of Alarm', { exact: true }).waitFor();
  assert.deepEqual((await get(key)).value.spellbook.wizard, ['alarm']);
});

for (const mobile of [false, true]) test(`installed Sheets worn slots replace armor, retain shields and attune on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  const key = `worn-slots-${mobile}`; await seed(key); const initial = await get(key);
  const items = [['leather-armor', 'Leather Armor', 'armor'], ['chain-mail', 'Chain Mail', 'armor'], ['shield', 'Shield', 'armor'], ['cloak-of-protection', 'Cloak of Protection', 'magic-item']].map(([id, name, kind]) => ({ id, name, kind, ref: id, qty: 1, location: 'pack', notes: 'Keep engraving' }));
  await put(key, { ...initial.value, classes: [{ classId: 'fighter', level: 5 }], className: 'Fighter', inventory: [...initial.value.inventory, ...items] }, initial.revision);
  const page = await open(t, key, mobile), sheet = page.locator('.dnd-sheet-shell');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click();
  async function fill(slot, name) {
    await sheet.getByRole('button', { name: `Fill ${slot} slot`, exact: true }).click();
    await write(page, () => page.getByRole('dialog').getByRole('button', { name, exact: true }).click());
  }
  await fill('Armor', 'Leather Armor'); assert.equal((await get(key)).value.ac, 13);
  await fill('Shield', 'Shield'); assert.equal((await get(key)).value.ac, 15);
  await fill('Armor', 'Chain Mail');
  let state = (await get(key)).value;
  assert.equal(state.ac, 18); assert.equal(state.inventory.find(item => item.id === 'leather-armor').location, 'pack');
  assert.equal(state.inventory.find(item => item.id === 'shield').location, 'equipped');
  await fill('Attunement', 'Cloak of Protection');
  state = (await get(key)).value; assert.equal(state.inventory.find(item => item.id === 'cloak-of-protection').attuned, true);
  await sheet.locator('.dse-worn').screenshot({ path: resolve(output, `worn-${mobile ? 'phone' : 'desktop'}.png`) });
  await write(page, () => sheet.getByRole('button', { name: 'End attunement to Cloak of Protection', exact: true }).click());
  await write(page, () => sheet.getByRole('button', { name: 'Unequip Shield', exact: true }).click());
  state = (await get(key)).value;
  assert.equal(state.ac, 16); assert.equal(state.inventory.find(item => item.id === 'shield').location, 'pack'); assert.equal(state.inventory.find(item => item.id === 'cloak-of-protection').attuned, false);
  assert.equal(state.inventory.find(item => item.id === 'chain-mail').notes, 'Keep engraving'); assert.equal(state.homebrew.clue, 'blue lantern');
  await page.reload(); await sheet.locator('.dse-worn').getByText('Chain Mail', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('installed Sheets reviews known spell swaps and persists their class-level history', { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  const key = 'spell-swap'; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, classes: [{ classId: 'warlock', level: 5 }], className: 'Warlock', preparedSpells: { warlock: ['hex'] } }, initial.revision);
  const page = await open(t, key), sheet = page.locator('.dnd-sheet-shell');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click(); await sheet.getByRole('tab', { name: 'Spellbook', exact: true }).click();
  await sheet.getByRole('button', { name: 'Manage class spells', exact: true }).click();
  await sheet.getByRole('button', { name: 'Swap on level-up', exact: true }).click();
  const swap = page.getByRole('dialog'); await swap.getByRole('combobox', { name: 'Replacement spell', exact: true }).selectOption('armor-of-agathys');
  await swap.getByRole('button', { name: 'Review spell swap', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review spell swap', exact: true });
  assert.deepEqual((await get(key)).value.preparedSpells.warlock, ['hex']);
  await write(page, () => review.getByRole('button', { name: 'Apply changes', exact: true }).click());
  const state = (await get(key)).value;
  assert.deepEqual(state.preparedSpells.warlock, ['armor-of-agathys']);
  assert.deepEqual(state.spellSwaps, [{ level: 5, classLevel: 5, classId: 'warlock', out: 'hex', in: 'armor-of-agathys' }]);
  await sheet.getByText('Level-up spell changes · 1', { exact: true }).click();
  assert.match(await sheet.locator('.dnd-spell-history').textContent(), /Warlock 5: Hex → Armor of Agathys/);
  await page.reload(); assert.deepEqual((await get(key)).value.spellSwaps, state.spellSwaps);
});

for (const mobile of [false, true]) test(`installed Builder restores progress navigation, advanced choices and rewards on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  const key = `guided-builder-${mobile}`; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, classes: [{ classId: 'fighter', level: 5 }], className: 'Fighter', manualScores: true }, initial.revision);
  const page = await open(t, key, mobile), sheet = page.locator('.dnd-sheet-shell');
  await sheet.getByRole('button', { name: 'Edit sheet', exact: true }).click(); await sheet.getByRole('tab', { name: 'Builder', exact: true }).click();
  await sheet.getByRole('button', { name: 'Load builder', exact: true }).click();
  const rail = sheet.locator('.dse-build-rail'); await rail.waitFor();
  if (mobile) await rail.locator('summary').click();
  assert.ok(Number(await rail.getByRole('progressbar', { name: 'Build completion' }).getAttribute('value')) > 0);
  await rail.getByRole('button', { name: 'Choose Fighter subclass', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Fighter 5', exact: true, selected: true }).waitFor();
  assert.equal(await sheet.getByRole('tab', { name: 'Fighter 5', exact: true }).getAttribute('aria-selected'), 'true');
  const level3 = sheet.locator('[data-builder-level="fighter:3"]');
  assert.equal(await level3.evaluate(node => node.open), true);
  await write(page, () => level3.getByRole('combobox', { name: 'Fighter subclass', exact: true }).selectOption({ label: 'Battle Master' }));
  const maneuvers = level3.locator('[data-choice="maneuvers"]');
  const first = maneuvers.getByRole('combobox').nth(0);
  await write(page, () => first.selectOption({ label: 'Disarming Attack' }));
  const selected = (await get(key)).value.featureChoices['maneuvers#0'];
  assert.equal(await maneuvers.getByRole('combobox').nth(1).locator(`option[value="${selected}"]`).isDisabled(), true);
  await write(page, () => maneuvers.getByRole('combobox').nth(1).selectOption({ label: 'Precision Attack' }));
  await write(page, () => maneuvers.getByRole('combobox').nth(2).selectOption({ label: 'Trip Attack' }));
  assert.match(await maneuvers.textContent(), /3 \/ 3 selected/);
  const level1 = sheet.locator('[data-builder-level="fighter:1"]'); await level1.locator('summary').first().click();
  const skills = level1.locator('[data-choice="skills:fighter"]');
  await write(page, () => skills.getByRole('combobox').nth(0).selectOption('animal-handling'));
  await write(page, () => skills.getByRole('combobox').nth(1).selectOption('perception'));
  assert.equal((await get(key)).value.skillProf.animalHandling, true);
  const level4 = sheet.locator('[data-builder-level="fighter:4"]'); await level4.locator('summary').first().click();
  await write(page, () => level4.getByRole('combobox', { name: 'Fighter level 4 advancement mode', exact: true }).selectOption('feat'));
  await write(page, () => level4.getByRole('combobox', { name: 'Fighter level 4 advancement feat', exact: true }).selectOption({ label: 'Athlete' }));
  await write(page, async () => { const ability = level4.getByLabel('asi:fighter:4:featability STR', { exact: true }); await ability.fill('1'); await ability.press('Tab'); });
  assert.equal((await get(key)).value.abilities.STR, 11);
  assert.equal(await sheet.getByRole('tab', { name: 'Fighter 5', exact: true }).evaluate(node => getComputedStyle(node).borderBottomColor), 'rgb(200, 160, 64)');
  assert.equal(await sheet.locator('.dnd-builder-class-row').evaluate(row => {
    const bounds = row.getBoundingClientRect();
    return [...row.children].every(child => { const box = child.getBoundingClientRect(); return box.left >= bounds.left - 1 && box.right <= bounds.right + 1; });
  }), true, 'Class controls must remain inside the Builder on narrow screens');
  await sheet.locator('.dse-builder-shell').screenshot({ path: resolve(output, `builder-progression-${mobile ? 'phone' : 'desktop'}.png`) });
  await sheet.getByRole('tab', { name: 'Character', exact: true }).click();
  async function addReward(feat, name, note) {
    await sheet.getByRole('button', { name: 'Add extra feat or reward', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add extra feat or reward', exact: true });
    if (feat) await dialog.getByRole('combobox', { name: 'Extra feat', exact: true }).selectOption(feat);
    else await dialog.getByRole('textbox', { name: 'Custom reward name', exact: true }).fill(name);
    await dialog.getByRole('textbox', { name: 'Source note', exact: true }).fill(note);
    assert.equal(await unloadBlocked(page), true);
    await write(page, () => dialog.getByRole('button', { name: 'Add reward', exact: true }).click());
  }
  const originalHP = (await get(key)).value.maxHp;
  await addReward('tough', '', 'Training at the lighthouse');
  assert.equal((await get(key)).value.maxHp, originalHP + 10);
  await addReward('', 'Friend of the keepers', 'Campaign reward');
  await sheet.getByRole('tab', { name: 'Combat', exact: true }).click(); await sheet.getByRole('button', { name: 'Short rest', exact: true }).click();
  await write(page, () => page.getByRole('dialog', { name: 'Review short rest', exact: true }).getByRole('button', { name: 'Apply changes', exact: true }).click());
  assert.equal((await get(key)).value.maxHp, originalHP + 10);
  await sheet.getByRole('tab', { name: 'Builder', exact: true }).click(); await sheet.getByRole('button', { name: 'Load builder', exact: true }).click();
  await write(page, () => sheet.getByRole('button', { name: 'Remove extra feat Tough', exact: true }).click());
  let state = (await get(key)).value;
  assert.equal(state.maxHp, originalHP); assert.equal(state.extraFeats.length, 1); assert.equal(state.extraFeats[0].sourceNote, 'Campaign reward');
  assert.equal(state.featureChoices['maneuvers#0'], selected); assert.equal(state.inventory.length, 3); assert.equal(state.notes, 'Keep the promise.'); assert.equal(state.homebrew.clue, 'blue lantern');
  const character = sheet.getByRole('tab', { name: 'Character', exact: true }); await character.focus(); await page.keyboard.press('ArrowRight');
  await sheet.getByRole('tab', { name: 'Fighter 5', exact: true, selected: true }).waitFor();
  assert.equal(await sheet.getByRole('tab', { name: 'Fighter 5', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.reload(); await sheet.getByRole('tab', { name: 'Builder', exact: true }).click(); await sheet.getByRole('button', { name: 'Load builder', exact: true }).click();
  await sheet.getByText('Friend of the keepers', { exact: true }).waitFor();
});

for (const mobile of [false, true]) test(`installed Czech sheet completes Builder, equipment, spell and rest workflows on ${mobile ? 'phone' : 'desktop'}`, { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  await installReviewedPackage(admin, csrf, 'dnd-engine', await readFile(resolve(process.env.CODEX_ENGINE_ZIP)), []);
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', await readFile(resolve(process.env.CODEX_COMPENDIUM_ZIP)), []);
  const key = `czech-workflows-${mobile}`; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, classes: [{ classId: 'wizard', level: 5 }], feats: [{ featId: 'magic-initiate' }], species: 'Elf', lineage: 'high-elf', background: 'Acolyte',
    currency: { ...initial.value.currency, gp: 100 }, inventory: [...initial.value.inventory, { id: 'scroll', name: 'Scroll of Alarm', qty: 2, location: 'pack', notes: 'From the lighthouse' }] }, initial.revision);
  const page = await open(t, key, mobile, 'dm', page => page.addInitScript(() => localStorage.setItem('codex_lang', 'cs')));
  await exerciseCzechSheet({ page, key, mobile, output, get, write });
});

test('installed Czech sheet reviews spell swaps and preserves saved references', { skip: !archivePath || !process.env.CODEX_ENGINE_ZIP || !process.env.CODEX_COMPENDIUM_ZIP }, async t => {
  await installReviewedPackage(admin, csrf, 'dnd-engine', await readFile(resolve(process.env.CODEX_ENGINE_ZIP)), []);
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', await readFile(resolve(process.env.CODEX_COMPENDIUM_ZIP)), []);
  const key = 'czech-swap'; await seed(key); const initial = await get(key);
  await put(key, { ...initial.value, classes: [{ classId: 'warlock', level: 5 }], className: 'Warlock', preparedSpells: { warlock: ['hex'] } }, initial.revision);
  const page = await open(t, key, true, 'dm', page => page.addInitScript(() => localStorage.setItem('codex_lang', 'cs'))), sheet = page.locator('.dnd-sheet-shell');
  await sheet.getByRole('button', { name: 'Upravit deník', exact: true }).click();
  await sheet.getByRole('tab', { name: 'Kniha kouzel', exact: true }).click();
  await sheet.getByRole('button', { name: 'Spravovat kouzla povolání' }).click();
  await sheet.getByRole('button', { name: 'Vyměnit při postupu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Výměna kouzla při postupu' });
  await dialog.getByRole('combobox', { name: 'Nové kouzlo', exact: true }).selectOption('armor-of-agathys');
  await dialog.getByRole('button', { name: 'Zkontrolovat výměnu kouzla', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Zkontrolovat výměnu kouzla', exact: true });
  assert.deepEqual((await get(key)).value.preparedSpells.warlock, ['hex']);
  await write(page, () => review.getByRole('button', { name: 'Použít změny' }).click());
  assert.deepEqual((await get(key)).value.preparedSpells.warlock, ['armor-of-agathys']);
  await sheet.getByText('Změny kouzel při postupu · 1', { exact: true }).click();
  assert.match(await sheet.locator('.dnd-spell-history').textContent(), /Warlock 5: Hex → Armor of Agathys/);
  await page.reload();
  assert.deepEqual((await get(key)).value.spellSwaps, [{ level: 5, classLevel: 5, classId: 'warlock', out: 'hex', in: 'armor-of-agathys' }]);
});
