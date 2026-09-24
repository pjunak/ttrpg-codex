import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import { createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { exported, printOutput } from './installed-character-output-fixture.mts';

type Row = Record<string, any>;
const frozenCharacters = new Map<string, Row>();
const styles = ['archery', 'blind-fighting', 'defense', 'dueling', 'great-weapon-fighting',
  'interception', 'protection', 'thrown-weapon-fighting', 'two-weapon-fighting', 'unarmed-fighting'];
const levels = (classId: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: classId + '-' + index, classId }));
const group = (sheet: Locator, id: string) => sheet.locator('[id="character-choice-' + encodeURIComponent(id) + '"]');
const featOptions = (evaluation: Row, id: string): string[] => evaluation.guidance.choices[id].featOptions.map((row: Row) => row.id);
const featChoices = (id: string, feat: string, ability?: string) => [
  { id, slot: 0, value: 'feat' }, { id: id + ':feat', slot: 0, value: feat },
  ...(ability ? [{ id: id + ':featability', slot: 0, value: { [ability]: 1 } }] : []),
];

function assertAuthored(actual: Row, expected: Row) {
  assert.equal(actual.notes, expected.notes);
  const { asOf: _actualTimestamp, ...actualPlay } = actual.play, { asOf: _expectedTimestamp, ...expectedPlay } = expected.play;
  assert.deepEqual(actualPlay, expectedPlay, 'Changing advancement choices preserves authored play state');
}
async function lateCharacter(f: Fixture, key: string) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
  const fighter = levels('fighter', 4);
  inputs.build.levels = [...fighter.slice(0, 3), ...levels('rogue', 15), fighter[3]];
  inputs.build.choices = [{ id: 'asi:fighter:4', slot: 0, value: 'feat' }];
  inputs.notes = 'Keep advancement notes'; inputs.play.hp = 3; inputs.play.currency.gp = 37;
  return save(f, key, inputs, 0, 'seed');
}
async function savedAfter(page: Page, key: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse(response => {
    if (!response.url().endsWith('/services/call')) return false;
    const request = response.request().postDataJSON();
    return request?.method === 'save' && request.params?.key === key;
  });
  await action(); const saved = await response; assert.equal(saved.ok(), true);
  const body = await saved.json(); assert.equal(body.result?.status, 'ready', JSON.stringify(body.result?.evaluation?.guidance.saveIssues ?? body));
}

export function registerCharacterAdvancementTests(enabled: boolean, fixture: () => Fixture) {
  test('installed advancement categories admit every qualified Fighting Style and reject missing features', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'advancement-styles', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    for (const classId of ['fighter', 'paladin', 'ranger', 'wizard']) {
      inputs.build.levels = levels(classId, 4);
      inputs.build.choices = [{ id: 'asi:' + classId + ':4', slot: 0, value: 'feat' }];
      const { evaluation } = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
      const options = featOptions(evaluation, 'asi:' + classId + ':4');
      for (const id of styles) assert.equal(options.includes(id), classId !== 'wizard', classId + ': ' + id);
      assert.ok(options.includes('tough')); assert.ok(options.includes('skill-expert'));
      assert.equal(options.some(id => id.startsWith('boon-of-')), false, 'No level-four Epic Boons');
    }
    const stored = await save(f, key, inputs, 0, 'wizard');
    inputs.build.choices = featChoices('asi:wizard:4', 'two-weapon-fighting');
    const rejected = await f.call('save', { key, operation: 'build', inputs, expectedRevision: stored.revision,
      operationId: key + '-forged', summary: 'Reject unmet style prerequisite' });
    assert.equal(rejected.status, 'invalid');
    assert.deepEqual((await f.call('load', { key })).state, stored.state);
  });

  test('installed Epic Boons use acquisition level and withdraw only the removed advancement', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'advancement-order', initial = await lateCharacter(f, key), inputs = structuredClone(initial.state.inputs);
    const id = 'asi:fighter:4';
    const options = featOptions(initial.evaluation, id);
    for (const feat of ['tough', 'skill-expert', 'archery', 'boon-of-combat-prowess', 'boon-of-irresistible-offense']) assert.ok(options.includes(feat), feat);
    assert.equal(options.includes('boon-of-spell-recall'), false);
    inputs.build.choices = featChoices(id, 'boon-of-combat-prowess', 'INT');
    const stored = await save(f, key, inputs, initial.revision, 'boon');
    assert.equal(stored.evaluation.sheet.abilities.INT.score, 13);
    assert.equal(stored.evaluation.sheet.abilities.INT.cap, 30);
    const early = structuredClone(stored.state.inputs);
    early.build.levels = [...levels('fighter', 4), ...levels('rogue', 15)];
    const rejected = await f.call('save', { key, operation: 'build', inputs: early, expectedRevision: stored.revision,
      operationId: key + '-too-early', summary: 'Reject retroactive eligibility' });
    assert.equal(rejected.status, 'invalid');
    assert.equal(featOptions(rejected.evaluation, id).includes('boon-of-combat-prowess'), false);
    assert.deepEqual((await f.call('load', { key })).state, stored.state);
    const removed = structuredClone(stored.state.inputs); removed.build.levels.pop();
    const result = await save(f, key, removed, stored.revision, 'remove-level');
    assert.equal(result.state.inputs.build.choices.some((row: Row) => row.id.startsWith(id)), false);
    assert.equal(result.evaluation.sheet.abilities.INT.score, 12);
    assert.equal(result.evaluation.sheet.abilities.INT.cap, 20); assertAuthored(result.state.inputs, stored.state.inputs);
  });

  test('installed Spell Recall requires acquired Spellcasting rather than Pact Magic or innate spells', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'advancement-spellcasting', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    for (const [classId, subclass, eligible] of [
      ...['artificer', 'bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'wizard'].map(id => [id, '', true] as const),
      ['fighter', 'eldritch-knight', true], ['rogue', 'arcane-trickster', true],
      ['fighter', '', false], ['warlock', '', false],
    ] as const) {
      inputs.build.levels = levels(classId, 19); inputs.build.subclasses = subclass ? { [classId]: subclass } : {};
      inputs.build.choices = featChoices('asi:' + classId + ':19', 'boon-of-spell-recall', 'INT');
      const { evaluation } = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
      assert.equal(featOptions(evaluation, 'asi:' + classId + ':19').includes('boon-of-spell-recall'), eligible, classId + ':' + subclass);
      assert.equal(evaluation.guidance.canSave, eligible, JSON.stringify(evaluation.guidance.saveIssues));
    }
    inputs.build.levels = levels('fighter', 19); inputs.build.species = 'tiefling'; inputs.build.lineage = 'infernal';
    inputs.build.choices = featChoices('asi:fighter:19', 'boon-of-spell-recall', 'INT');
    let result = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
    assert.equal(featOptions(result.evaluation, 'asi:fighter:19').includes('boon-of-spell-recall'), false);
    assert.equal(result.evaluation.guidance.canSave, false);
    const fighter = levels('fighter', 4);
    inputs.build.species = 'dwarf'; inputs.build.lineage = '';
    inputs.build.baseScores = { STR: 15, DEX: 13, CON: 12, INT: 14, WIS: 10, CHA: 8 };
    inputs.build.levels = [...fighter.slice(0, 3), ...levels('rogue', 15), fighter[3], ...levels('wizard', 1)];
    inputs.build.choices = featChoices('asi:fighter:4', 'boon-of-spell-recall', 'INT');
    result = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
    assert.equal(featOptions(result.evaluation, 'asi:fighter:4').includes('boon-of-spell-recall'), false, 'A later caster level cannot qualify an earlier feat');
    assert.equal(result.evaluation.guidance.canSave, false);
  });

  for (const locale of ['en', 'cs']) test('advancement choices autosave through shared controls and retain saved output (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'advancement-ui-' + locale, initial = await lateCharacter(f, key);
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale), cs = locale === 'cs';
    const selection = cs ? 'Volba 1' : 'Selection 1', saved = cs ? /^Uloženo$/ : /^Saved$/;
    if (cs) {
      await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel('Rozložení deníku', { exact: true }).selectOption('classic');
      await sheet.locator('#dnd-tab-builder').click(); await page.setViewportSize({ width: 390, height: 1000 });
      await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
    }
    await sheet.locator('#dnd-builder-tab-fighter').click();
    const id = 'asi:fighter:4', control = group(sheet, id + ':feat').getByRole('combobox', { name: selection, exact: true });
    const pick = async (label: string) => {
      await control.fill(label); await group(sheet, id + ':feat').getByRole('option', { name: label, exact: true }).waitFor();
      await control.press('ArrowDown');
      await savedAfter(page, key, () => control.press('Enter')); await status.filter({ hasText: saved }).waitFor();
      assert.equal(await control.evaluate(node => node === document.activeElement), true);
    };
    await pick('Boon of Combat Prowess');
    const ability = group(sheet, id + ':featability');
    assert.equal(await ability.locator('input').count(), 6);
    for (const name of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) assert.equal(await ability.getByLabel(name, { exact: true }).isVisible(), true);
    await savedAfter(page, key, () => ability.getByLabel('INT', { exact: true }).press('ArrowUp')); await status.filter({ hasText: saved }).waitFor();
    assert.equal((await read()).state.projection.sheet.abilities.INT.score, 13);
    await pick('Two Weapon Fighting');
    let stored = await read();
    assert.equal(stored.state.inputs.build.choices.some((row: Row) => row.id === id + ':featability'), false);
    assert.equal(stored.state.projection.sheet.abilities.INT.cap, 20); assert.equal(stored.state.projection.sheet.abilities.INT.score, 12);
    await pick('Boon of Combat Prowess');
    await savedAfter(page, key, () => ability.getByLabel('INT', { exact: true }).press('ArrowUp')); await status.filter({ hasText: saved }).waitFor();
    await group(sheet, id).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(f.output, 'advancement-choice-' + locale + '.png') });
    await page.reload(); await page.locator('#character-view-addons').click();
    await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-fighter').click();
    assert.equal(await control.inputValue(), 'Boon of Combat Prowess');
    assert.equal(await ability.getByLabel('INT', { exact: true }).inputValue(), '1');
    stored = await read(); assertAuthored(stored.state.inputs, initial.state.inputs);
    assert.equal(stored.state.projection.sheet.abilities.INT.cap, 30);
    await sheet.locator('#dnd-tab-combat').click();
    const feats = sheet.locator('.dse-section').filter({ has: page.getByRole('heading', { name: cs ? 'Odbornosti' : 'Feats', exact: true }) });
    await feats.getByRole('button', { name: 'Boon of Combat Prowess', exact: true }).waitFor();
    if (cs) await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
    await feats.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(f.output, 'advancement-feats-' + locale + '.png') });
    await sheet.locator('#dnd-tab-tools').click();
    const envelope = await exported(page, sheet, locale); assert.deepEqual(envelope.inputs, stored.state.inputs);
    const popup = await printOutput(page, sheet, locale); assert.match(await popup.locator('body').innerText(), /Boon of Combat Prowess/); await popup.close();
    assert.deepEqual((await read()).state, stored.state); frozenCharacters.set(key, structuredClone(stored));
  });
}

export async function verifyFrozenAdvancements(t: TestContext, f: Fixture) {
  for (const [key, expected] of frozenCharacters) {
    const locale = key.endsWith('-cs') ? 'cs' : 'en', { page, sheet, read } = await openBuilder(t, f, key, locale);
    const stored = await read(); assert.equal(stored.status, 'unavailable'); assert.deepEqual(stored.state, expected.state);
    let queries = 0; await page.route('**/services/call', async route => {
      if (route.request().postDataJSON()?.method === 'query-records') queries++;
      await route.continue();
    });
    await sheet.locator('#dnd-tab-combat').click();
    await sheet.getByRole('button', { name: 'Boon of Combat Prowess', exact: true }).waitFor();
    await sheet.locator('#dnd-tab-tools').click();
    const envelope = await exported(page, sheet, locale); assert.deepEqual(envelope.inputs, expected.state.inputs);
    const popup = await printOutput(page, sheet, locale); assert.match(await popup.locator('body').innerText(), /Boon of Combat Prowess/); await popup.close();
    assert.equal(queries, 0); assert.deepEqual((await read()).state, expected.state);
    await page.context().close();
  }
}
