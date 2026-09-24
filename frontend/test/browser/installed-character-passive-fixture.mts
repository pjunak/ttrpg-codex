import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import { createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { exported, printOutput } from './installed-character-output-fixture.mts';

type Row = Record<string, any>;
const frozen = new Map<string, Row>();
const levels = (count: number) => Array.from({ length: count }, (_, index) => ({ id: 'fighter-' + index, classId: 'fighter' }));
const style = (id: string, value: string) => ({ id, slot: 0, value });
const advancement = (feat: string) => [
  style('asi:fighter:19', 'feat'), style('asi:fighter:19:feat', feat),
  { id: 'asi:fighter:19:featability', slot: 0, value: { INT: 1 } },
];
const item = (id: string, ref: string, location = 'carried') => ({
  id, name: id, reference: { kind: 'armor', id: ref }, quantity: 1, location, attuned: false,
  acquisition: 'Retain acquisition', notes: 'Retain equipment notes',
});
const term = (projection: Row, path: string, id: string) => projection.explanations[path].terms.find((row: Row) => row.source?.id === id);
function assertAuthored(actual: Row, expected: Row) {
  assert.equal(actual.notes, expected.notes);
  const { asOf: _a, ...a } = actual.play, { asOf: _b, ...b } = expected.play;
  assert.deepEqual(a, b, 'Passive recalculation preserves authored play');
}
async function seed(f: Fixture, key: string, count: number) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = 'dwarf'; inputs.build.background = 'soldier'; inputs.build.levels = levels(count);
  inputs.build.choices = [style('fighter-fighting-style-feat', 'defense')];
  inputs.notes = 'Keep passive feat notes'; inputs.play.hp = 3; inputs.play.temporaryHp = 2; inputs.play.currency.gp = 31;
  return save(f, key, inputs, 0, 'seed');
}
async function grant(f: Fixture, key: string, stored: Row, feat: string) {
  const result = await f.call('save', { key, operation: 'grant', expectedRevision: stored.revision, operationId: key + '-' + feat,
    summary: 'Accept passive reward', grant: {
      id: '', name: feat, reason: 'Installed passive acceptance', actorId: '', grantedAt: '', active: true,
      effectiveLevel: 19, condition: 'always', feat: { kind: 'feat', id: feat }, effects: [], waivers: [],
    } });
  assert.equal(result.status, 'ready', JSON.stringify(result)); return result;
}

export function registerPassiveFeatTests(enabled: boolean, fixture: () => Fixture) {
  test('installed passive Defense follows worn body armor and style withdrawal', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'passive-armor'; let stored = await seed(f, key, 1);
    const original = structuredClone(stored.state.inputs);
    for (const [ref, location, shield, ac, active] of [
      ['leather-armor', 'carried', false, 12, false], ['leather-armor', 'stored', true, 14, false],
      ['leather-armor', 'equipped', false, 14, true], ['scale-mail', 'equipped', true, 19, true],
      ['plate-armor', 'equipped', false, 19, true],
    ] as const) {
      const inputs = structuredClone(stored.state.inputs);
      inputs.play.inventory = [item('suit', ref, location), ...(shield ? [item('guard', 'shield', 'equipped')] : [])];
      stored = await save(f, key, inputs, stored.revision, ref + '-' + location);
      assert.equal(stored.state.projection.sheet.derived.armorClass, ac);
      assert.equal(term(stored.state.projection, 'derived.armorClass', 'defense')?.status, active ? 'applied' : 'inactive');
      assertAuthored(stored.state.inputs, inputs);
    }
    const changed = structuredClone(stored.state.inputs);
    changed.build.choices = [style('fighter-fighting-style-feat', 'blind-fighting')];
    stored = await save(f, key, changed, stored.revision, 'blind');
    assert.equal(stored.state.projection.sheet.derived.armorClass, 18);
    assert.equal(stored.state.projection.sheet.senses.blindsight, 10);
    assert.equal(term(stored.state.projection, 'derived.armorClass', 'defense'), undefined);
    assertAuthored(stored.state.inputs, changed); assert.equal(stored.state.inputs.notes, original.notes);
    changed.build.choices = [style('fighter-fighting-style-feat', 'archery')];
    stored = await save(f, key, changed, stored.revision, 'remove-blind');
    assert.equal(stored.state.projection.sheet.senses.blindsight, undefined);
  });

  test('installed passive boons add once, replace cleanly and preserve bounded current HP', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'passive-boons'; let stored = await seed(f, key, 19);
    const base = structuredClone(stored), baseHP = base.state.projection.sheet.derived.maxHp;
    for (const feat of ['boon-of-fortitude', 'boon-of-speed', 'boon-of-truesight']) {
      const inputs = structuredClone(stored.state.inputs);
      inputs.build.choices = [style('fighter-fighting-style-feat', 'defense'), ...advancement(feat)];
      stored = await save(f, key, inputs, stored.revision, feat);
      const projection = stored.state.projection;
      assert.equal(projection.sheet.derived.maxHp, baseHP + (feat === 'boon-of-fortitude' ? 40 : 0));
      assert.equal(projection.sheet.derived.speed, feat === 'boon-of-speed' ? 60 : 30);
      assert.equal(projection.sheet.senses.truesight, feat === 'boon-of-truesight' ? 60 : undefined);
      assertAuthored(stored.state.inputs, base.state.inputs);
      const path = feat === 'boon-of-fortitude' ? 'derived.maxHp' : feat === 'boon-of-speed' ? 'derived.speed' : 'senses.truesight';
      assert.ok(term(projection, path, feat), 'Passive contribution retains source evidence');
      const reloaded = await f.call('load', { key }); assert.deepEqual(reloaded.state, stored.state);
    }
    let inputs = structuredClone(stored.state.inputs);
    inputs.build.choices = [style('fighter-fighting-style-feat', 'defense'), ...advancement('boon-of-fortitude')];
    inputs.play.hp = baseHP + 20;
    stored = await save(f, key, inputs, stored.revision, 'fortitude-damaged');
    assert.equal(stored.state.inputs.play.hp, baseHP + 20);
    inputs = structuredClone(stored.state.inputs); inputs.build.choices = [style('fighter-fighting-style-feat', 'defense')];
    stored = await save(f, key, inputs, stored.revision, 'remove-fortitude');
    assert.equal(stored.state.inputs.play.hp, baseHP, 'Lowering maximum follows the existing HP clamp');
    assert.equal(stored.state.inputs.play.temporaryHp, 2); assert.equal(stored.state.inputs.play.currency.gp, 31);
    inputs = structuredClone(stored.state.inputs); inputs.build.choices.push(...advancement('boon-of-fortitude'));
    stored = await save(f, key, inputs, stored.revision, 'restore-fortitude');
    assert.equal(stored.state.inputs.play.hp, baseHP, 'Raising maximum never heals');
  });

  for (const locale of ['en', 'cs']) test('installed passive stats use shared details, equipment autosave and outputs (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'passive-ui-' + locale, cs = locale === 'cs';
    let stored = await seed(f, key, 19), inputs = structuredClone(stored.state.inputs);
    const baseHP = stored.state.projection.sheet.derived.maxHp;
    inputs.build.subclasses = { fighter: 'champion' };
    inputs.build.choices = [style('fighter-fighting-style-feat', 'blind-fighting'),
      style('champion-additional-fighting-style-feat', 'defense'), ...advancement('boon-of-fortitude')];
    inputs.play.inventory = [item('suit', 'chain-mail', 'equipped'), item('guard', 'shield', 'equipped')];
    stored = await save(f, key, inputs, stored.revision, 'passives');
    stored = await grant(f, key, stored, 'boon-of-speed');
    stored = await grant(f, key, stored, 'boon-of-truesight');
    const initial = structuredClone(stored.state.inputs);
    assert.equal(stored.state.projection.sheet.derived.maxHp, baseHP + 40);
    assert.equal(stored.state.projection.sheet.derived.speed, 60);
    assert.equal(stored.state.projection.sheet.senses.blindsight, 10);
    assert.equal(stored.state.projection.sheet.senses.truesight, 60);
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    if (cs) {
      await sheet.locator('#dnd-tab-tools').click();
      await sheet.getByRole('combobox', { name: 'Rozložení deníku', exact: true }).selectOption('classic');
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.waitForFunction(() => (document.querySelector('.campaign-sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
      await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
    }
    await sheet.locator('#dnd-tab-sheet').click();
    await sheet.locator('.dse-counter').getByRole('button', { name: String(baseHP + 40), exact: true }).waitFor();
    const armor = sheet.locator('.dse-ac');
    await armor.getByRole('button', { name: '19', exact: true }).click();
    const details = sheet.getByRole('dialog'); await details.waitFor();
    assert.match(await details.innerText(), /Defense/); await page.keyboard.press('Escape');
    const move = sheet.getByRole('combobox', { name: (cs ? 'Přesunout: ' : 'Move ') + 'suit', exact: true });
    await move.focus(); await move.selectOption('carried'); await status.filter({ hasText: cs ? /^Uloženo$/ : /^Saved$/ }).waitFor();
    assert.equal(await move.evaluate(node => node === document.activeElement), true);
    stored = await read(); assert.equal(stored.state.projection.sheet.derived.armorClass, 14);
    assert.equal(term(stored.state.projection, 'derived.armorClass', 'defense')?.status, 'inactive');
    await move.selectOption('equipped'); await status.filter({ hasText: cs ? /^Uloženo$/ : /^Saved$/ }).waitFor();
    assertAuthored((await read()).state.inputs, initial);
    await sheet.locator('#dnd-tab-combat').click();
    await sensePanel(sheet, locale).getByRole('button', { name: cs ? 'Mimosmyslové vnímání' : 'Blindsight', exact: true }).waitFor();
    assert.match(await sensePanel(sheet, locale).innerText(), /10 ft/);
    assert.match(await sensePanel(sheet, locale).innerText(), /60 ft/);
    await sensePanel(sheet, locale).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(f.output, key + '.png') });
    await page.reload(); await page.locator('#character-view-addons').click();
    await sheet.locator('#dnd-tab-tools').click();
    stored = await read(); const envelope = await exported(page, sheet, locale);
    assert.deepEqual(envelope.inputs, stored.state.inputs);
    const popup = await printOutput(page, sheet, locale);
    await assertPrintedStats(popup, stored.state.projection);
    const printed = await popup.locator('body').innerText();
    for (const name of ['Blind Fighting', 'Defense', 'Boon of Fortitude', 'Boon of Speed', 'Boon of Truesight']) assert.ok(printed.includes(name), name);
    await popup.close(); assert.deepEqual((await read()).state, stored.state);
    frozen.set(key, structuredClone(stored)); await page.context().close();
  });
}
const sensePanel = (sheet: Locator, locale: string) => sheet.getByRole('heading', { name: locale === 'cs' ? 'Smysly' : 'Senses', exact: true }).locator('..');
async function assertPrintedStats(page: Page, projection: Row) {
  const numbers = await page.locator('.character-projection > .character-stats').first().locator(':scope > div > strong').allTextContents();
  assert.deepEqual(numbers.slice(0, 5), ['armorClass', 'initiative', 'speed', 'proficiencyBonus', 'maxHp'].map(key => String(projection.sheet.derived[key])));
}

export async function verifyFrozenPassiveFeats(t: TestContext, f: Fixture) {
  for (const [key, expected] of frozen) {
    const locale = key.endsWith('-cs') ? 'cs' : 'en', { page, sheet, read } = await openBuilder(t, f, key, locale);
    const loaded = await read(); assert.equal(loaded.status, 'unavailable'); assert.deepEqual(loaded.state, expected.state);
    let queries = 0; await page.route('**/services/call', async route => {
      if (route.request().postDataJSON()?.method === 'query-records') queries++;
      await route.continue();
    });
    await sheet.locator('#dnd-tab-sheet').click();
    await sheet.locator('.dse-ac').getByRole('button', { name: '19', exact: true }).click();
    const dialog = sheet.getByRole('dialog'); await dialog.waitFor(); assert.match(await dialog.innerText(), /Defense/);
    await dialog.locator(':scope > details > summary').filter({ hasText: locale === 'cs' ? 'Uložené údaje zdroje' : 'Saved source evidence' }).click();
    const evidence = expected.state.projection.evidence.find((row: Row) => row.reference.id === 'defense');
    assert.ok((await dialog.innerText()).includes(evidence.hash)); await page.keyboard.press('Escape');
    await sheet.locator('#dnd-tab-tools').click();
    assert.deepEqual((await exported(page, sheet, locale)).inputs, expected.state.inputs);
    const popup = await printOutput(page, sheet, locale);
    await assertPrintedStats(popup, expected.state.projection);
    assert.match(await popup.locator('body').innerText(), /Boon of Fortitude/); await popup.close();
    assert.equal(queries, 0); assert.deepEqual((await read()).state, expected.state);
    await page.context().close();
  }
}
