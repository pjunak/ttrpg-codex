import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import { jsonResponse } from './installed-graph-fixture.mts';
import { openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { spellCharacter } from './installed-character-spell-fixture.mts';

type Row = Record<string, any>;
const messages = (locale: string) => locale === 'cs' ? {
  saved: /^Uloženo$/, add: 'Přidat úroveň', shield: 'Štít', damage: 'Poškození', amount: 'Množství',
  cast: 'Seslat získané kouzlo', short: 'Krátký odpočinek', long: 'Dlouhý odpočinek',
  tools: 'Nástroje', export: 'Exportovat postavu', import: 'Importovat postavu', paste: 'Nebo vložte export',
  authorize: 'Jako současný PJ schvaluji importované dary', review: 'Zkontrolovat import', replace: 'Nahradit postavu',
  close: 'Zavřít', print: 'Tisk / PDF', preview: 'Otevřít náhled tisku', equipment: 'Vybavení', spells: 'Kouzla',
  currency: 'Měna', level: 'Úroveň 2: Fighter', layout: 'Rozložení deníku',
} : {
  saved: /^Saved$/, add: 'Add level', shield: 'Shield', damage: 'Damage', amount: 'Amount',
  cast: 'Cast granted spell', short: 'Short rest', long: 'Long rest',
  tools: 'Tools', export: 'Export character', import: 'Import character', paste: 'Or paste the export',
  authorize: 'Authorize imported DM grants as the current DM', review: 'Review import', replace: 'Replace character',
  close: 'Close', print: 'Print / PDF', preview: 'Open print preview', equipment: 'Equipment', spells: 'Spells',
  currency: 'Currency', level: 'Level 2: Fighter', layout: 'Sheet layout',
};

export async function exported(page: Page, sheet: Locator, locale: string) {
  const downloadEvent = page.waitForEvent('download');
  await sheet.getByRole('button', { name: messages(locale).export, exact: true }).click();
  const download = await downloadEvent, path = await download.path(); assert.ok(path);
  return JSON.parse(await readFile(path, 'utf8')) as Row;
}
export async function review(sheet: Locator, locale: string, envelope: Row, authorize: boolean) {
  const text = messages(locale);
  await sheet.getByRole('button', { name: text.import, exact: true }).click();
  await sheet.getByLabel(text.paste, { exact: true }).fill(JSON.stringify(envelope));
  if (authorize) await sheet.getByRole('checkbox', { name: text.authorize, exact: true }).check();
  await sheet.getByRole('button', { name: text.review, exact: true }).click();
  await sheet.page().waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
  assert.equal(await sheet.getByRole('button', { name: text.replace, exact: true }).count(), 1, await sheet.locator('[data-character-status]').innerText());
}
export async function printOutput(page: Page, sheet: Locator, locale: string, include = true) {
  const text = messages(locale);
  await sheet.getByRole('button', { name: text.print, exact: true }).click();
  if (!include) for (const name of [text.equipment, text.spells]) await sheet.getByRole('checkbox', { name, exact: true }).uncheck();
  const popupEvent = page.waitForEvent('popup');
  await sheet.getByRole('button', { name: text.preview, exact: true }).click();
  const popup = await popupEvent; await popup.getByRole('heading', { level: 1 }).waitFor();
  return popup;
}
async function assertPrint(popup: Page, locale: string, state: Row, include: boolean) {
  const text = messages(locale), body = await popup.locator('body').innerText();
  assert.equal(await popup.getByRole('heading', { name: text.currency, exact: true }).count(), 1, 'Saved currency must be present in print');
  const coins = popup.locator('section').filter({ has: popup.getByRole('heading', { name: text.currency, exact: true }) });
  for (const [coin, value] of Object.entries(state.inputs.play.currency)) {
    assert.equal(await coins.locator('dt').filter({ hasText: new RegExp('^' + coin.toUpperCase() + '$') }).locator('xpath=following-sibling::dd[1]').innerText(), String(value));
  }
  assert.ok(body.includes(text.level), 'Default print identifies the saved class and level without requiring provenance');
  assert.ok(body.includes('Dwarf') && body.includes('Soldier'), 'Default print identifies the saved origin');
  assert.equal(await popup.getByRole('heading', { name: text.equipment, exact: true }).count(), include ? 1 : 0);
  if (include) { assert.ok(body.includes('Travel Shield')); assert.ok(body.includes('Keep shield notes <b>literal</b>')); assert.ok(body.includes('Detect Magic')); }
  assert.equal(await popup.locator('script').count(), 0);
}

export function registerCharacterOutputTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) test('character session preserves play through transfer and print (' + locale + ')', { skip: !enabled, timeout: 90000 }, async t => {
    const f = fixture(), key = 'whole-session-' + locale, text = messages(locale);
    let stored = await spellCharacter(f, key, 1);
    const inputs = structuredClone(stored.state.inputs);
    inputs.play.inventory.push({ id: 'travel-shield', name: 'Travel Shield', reference: { kind: 'armor', id: 'shield' }, quantity: 1, location: 'carried', attuned: false, acquisition: 'Session reward', notes: 'Keep shield notes <b>literal</b>' });
    stored = await save(f, key, inputs, stored.revision, 'session-start');
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    const settled = async () => { await status.filter({ hasText: text.saved }).waitFor(); return read(); };
    if (locale === 'cs') {
      await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel(text.layout, { exact: true }).selectOption('classic');
      await sheet.locator('#dnd-tab-builder').click();
    }
    await sheet.locator('#dnd-builder-tab-fighter').click(); await sheet.getByRole('button', { name: text.add, exact: true }).click();
    let next = await settled();
    assert.equal(next.state.inputs.build.levels.length, 2); assert.equal(next.state.inputs.play.hp, stored.state.inputs.play.hp);
    assert.ok(next.state.projection.sheet.derived.maxHp > stored.state.projection.sheet.derived.maxHp);
    await sheet.locator('#dnd-tab-sheet').click();
    await sheet.getByRole('button', { name: '+ ' + text.shield, exact: true }).click();
    await sheet.getByRole('dialog').getByRole('button', { name: 'Travel Shield', exact: true }).click();
    await settled();
    for (const [coin, value] of [['GP', '37'], ['SP', '8']]) { await sheet.getByLabel(coin!, { exact: true }).fill(value!); await settled(); }
    await sheet.getByRole('button', { name: text.damage, exact: true }).click();
    const damage = sheet.locator('.dse-hp-adjust'); await damage.getByLabel(text.amount, { exact: true }).fill('2');
    await damage.getByRole('button', { name: text.damage, exact: true }).click(); next = await settled();
    assert.equal(next.state.inputs.play.hp, stored.state.inputs.play.hp - 2);
    await sheet.locator('#dnd-tab-spells').click();
    const grant = next.evaluation.spellOptions.granted.find((row: Row) => row.ref === 'detect-magic');
    const free = grant.slots.find((id: string) => id.startsWith('charge:'));
    await sheet.locator('[data-spell-grant][data-spell-name="Detect Magic"]').getByRole('button', { name: text.cast, exact: true }).click();
    next = await settled(); assert.equal(next.state.inputs.play.resourceUses[free], 1);
    await sheet.locator('#dnd-tab-combat').click(); await sheet.getByRole('button', { name: text.short, exact: true }).click();
    next = await settled(); assert.equal(next.state.inputs.play.resourceUses[free], 1);
    await sheet.getByRole('button', { name: text.long, exact: true }).click(); next = await settled();
    assert.equal(next.state.inputs.play.resourceUses[free], 0); assert.equal(next.state.inputs.play.hp, next.state.projection.sheet.derived.maxHp);
    await sheet.locator('#dnd-tab-spells').click();
    await sheet.locator('[data-spell-grant]').filter({ hasText: 'Detect Magic' }).getByRole('button', { name: text.cast, exact: true }).click();
    stored = await settled(); assert.equal(stored.state.inputs.play.resourceUses[free], 1);
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-tools').click();
    const envelope = await exported(page, sheet, locale);
    assert.deepEqual(envelope.inputs, stored.state.inputs); assert.deepEqual(envelope.savedProjection, stored.state.projection);
    assert.equal(envelope.externalHistory, undefined);
    await sheet.locator('#dnd-tab-sheet').click(); await sheet.getByLabel('GP', { exact: true }).fill('12'); next = await settled();
    await sheet.locator('#dnd-tab-tools').click();
    await review(sheet, locale, envelope, true);
    await sheet.getByRole('dialog').getByRole('button', { name: text.close, exact: true }).click();
    assert.deepEqual((await read()).state, next.state, 'Canceling review must keep the current saved character');
    assert.equal(await sheet.getByRole('button', { name: text.import, exact: true }).evaluate(node => node === document.activeElement), true, 'Cancel returns focus to the transfer action');
    await review(sheet, locale, envelope, true);
    await sheet.getByRole('button', { name: text.replace, exact: true }).click(); next = await settled();
    assert.deepEqual(next.state.inputs.play.inventory, envelope.inputs.play.inventory);
    assert.deepEqual(next.state.inputs.play.currency, envelope.inputs.play.currency);
    const oldOwner = '@' + encodeURIComponent('grant:' + envelope.inputs.grants[0].id), newOwner = '@' + encodeURIComponent('grant:' + next.state.inputs.grants[0].id);
    assert.notEqual(oldOwner, newOwner, 'Imported grants receive new authenticated identities');
    const renamed = (key: string) => key.replace(oldOwner, newOwner);
    assert.deepEqual(next.state.inputs.play.resourceUses, Object.fromEntries(Object.entries(envelope.inputs.play.resourceUses).map(([id, value]) => [renamed(id), value])));
    assert.deepEqual(next.state.inputs.build.choices, envelope.inputs.build.choices.map((choice: Row) => ({ ...choice, id: renamed(choice.id) })));
    assert.deepEqual(next.state.inputs.build.spells.grantChoices, Object.fromEntries(Object.entries(envelope.inputs.build.spells.grantChoices).map(([id, value]) => [renamed(id), value])));
    assert.equal(next.state.inputs.notes, envelope.inputs.notes);
    assert.equal(next.state.inputs.grants.length, 1); assert.equal(next.state.inputs.grants[0].actorId, next.actorId);
    const popup = await printOutput(page, sheet, locale); await assertPrint(popup, locale, next.state, true);
    await popup.emulateMedia({ media: 'print' });
    await popup.screenshot({ path: resolve(f.output, 'session-print-' + locale + '.png'), fullPage: true });
    await popup.pdf({ path: resolve(f.output, 'session-print-' + locale + '.pdf'), format: 'A4' }); await popup.close();
    await sheet.getByRole('dialog').getByRole('button', { name: text.close, exact: true }).click();
    const minimal = await printOutput(page, sheet, locale, false); await assertPrint(minimal, locale, next.state, false); await minimal.close();
    await sheet.getByRole('dialog').getByRole('button', { name: text.close, exact: true }).click();
    await page.setViewportSize({ width: 390, height: 1000 }); await page.addStyleTag({ content: 'html {font-size:200% !important;}' });
    await page.screenshot({ path: resolve(f.output, 'session-tools-' + locale + '.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal((await read()).revision, next.revision, 'Export and print never save or recalculate');
  });

  test('saved print includes currency and identity without provenance', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'print-parity', seed = await spellCharacter(f, key, 1), inputs = structuredClone(seed.state.inputs);
    inputs.build.levels.push({ id: 'second', classId: 'fighter' }); inputs.play.currency = { gp: 37, sp: 8 };
    inputs.play.inventory.push({ id: 'travel-shield', name: 'Travel Shield', reference: { kind: 'armor', id: 'shield' }, quantity: 1, location: 'carried', attuned: false, acquisition: 'Session reward', notes: 'Keep shield notes <b>literal</b>' });
    const saved = await save(f, key, inputs, seed.revision, 'print'), { page, sheet } = await openBuilder(t, f, key);
    await sheet.locator('#dnd-tab-tools').click(); const popup = await printOutput(page, sheet, 'en');
    await assertPrint(popup, 'en', saved.state, true); await popup.close();
  });

  test('player transfer keeps DM authorization separate from saved output', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'player-transfer', stored = await spellCharacter(f, key, 1);
    const context = await f.browser.newContext({ baseURL: f.origin }); t.after(() => context.close());
    const login = await jsonResponse(await context.request.post('/api/login', { data: { password: 'local-character-player' } }));
    const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
    let connection: { url: string; body: Row } | undefined, previews = 0;
    page.on('request', request => { if (!request.url().endsWith('/services/call')) return; const body = request.postDataJSON(); if (body?.method === 'load') connection = { url: request.url(), body }; if (body?.method === 'preview') previews++; });
    await page.goto(f.origin + '/#/characters/' + key); await page.locator('#character-view-addons').click();
    const sheet = page.locator('.addon-dnd-character'); await sheet.locator('#dnd-tab-tools').click();
    const envelope = await exported(page, sheet, 'en'); assert.deepEqual(envelope.inputs, stored.state.inputs);
    await sheet.getByRole('button', { name: 'Import character', exact: true }).click();
    assert.equal(await sheet.getByRole('checkbox', { name: 'Authorize imported DM grants as the current DM', exact: true }).count(), 0);
    await sheet.getByLabel('Or paste the export', { exact: true }).fill(JSON.stringify(envelope));
    await sheet.getByRole('button', { name: 'Review import', exact: true }).click();
    const dialog = sheet.getByRole('dialog'), error = dialog.getByRole('alert');
    assert.match(await error.innerText(), /Imported DM grants must be reviewed and authorized/);
    assert.equal(await error.evaluate(node => node === document.activeElement), true);
    assert.equal(await sheet.getByLabel('Or paste the export', { exact: true }).inputValue(), JSON.stringify(envelope));
    assert.equal(previews, 0); assert.ok(connection);
    const forged = await context.request.post(connection.url, { headers: { 'X-Codex-CSRF': login.csrfToken }, data: { ...connection.body, method: 'preview', params: { contractVersion: 'character.v2', key, operation: 'import', operationId: 'player-forged-import', expectedRevision: stored.revision, inputs: envelope.inputs, reauthorizeGrants: true } } });
    assert.equal(forged.status(), 403, 'The worker must also reject forged player authorization');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await sheet.getByRole('button', { name: 'Import character', exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(await sheet.getByRole('button', { name: 'Replace character', exact: true }).count(), 0);
    assert.deepEqual((await f.call('load', { key })).state, stored.state);
  });
}

export async function verifyFrozenSessionOutputs(t: TestContext, f: Fixture) {
  for (const locale of ['en', 'cs']) {
    const key = 'whole-session-' + locale, { page, sheet, read } = await openBuilder(t, f, key, locale);
    const frozen = await read(); assert.equal(frozen.status, 'unavailable');
    await sheet.locator('#dnd-tab-tools').click();
    const envelope = await exported(page, sheet, locale); assert.deepEqual(envelope.inputs, frozen.state.inputs);
    const popup = await printOutput(page, sheet, locale); await assertPrint(popup, locale, frozen.state, true); await popup.close();
    assert.equal((await read()).revision, frozen.revision);
    await page.context().close();
  }
}
