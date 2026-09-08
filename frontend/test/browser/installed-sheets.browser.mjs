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
async function open(t, key, mobile = false, role = 'dm') {
  const context = await browser.newContext({ baseURL: origin, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  t.after(() => context.close()); await jsonResponse(await context.request.post('/api/login', { data: { password: `local-sheets-${role}` } }));
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(`/#/characters/${key}`); await page.locator('.dse-backpack').waitFor(); return page;
}
async function saved(page) { await page.locator('.dnd-save-status').getByText('Saved.', { exact: true }).waitFor(); }
const writes = '**/api/addons/dnd-sheets/generations/*/data/transactions';
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
  await equipment.getByRole('combobox', { name: 'Equipment category', exact: true }).selectOption('weapon');
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
