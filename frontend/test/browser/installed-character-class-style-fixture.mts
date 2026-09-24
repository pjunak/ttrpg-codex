import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import { createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { exported, printOutput } from './installed-character-output-fixture.mts';

type Row = Record<string, any>;
const frozen = new Map<string, Row>();
const styles = ['archery', 'blind-fighting', 'defense', 'dueling', 'great-weapon-fighting',
  'interception', 'protection', 'thrown-weapon-fighting', 'two-weapon-fighting', 'unarmed-fighting'];
const levels = (classId: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: classId + '-' + i, classId }));
const choice = (id: string, value: string) => ({ id, slot: 0, value });
const group = (sheet: Locator, id: string) => sheet.locator('[id="character-choice-' + encodeURIComponent(id) + '"]');
const options = (evaluation: Row, id: string): string[] => (evaluation.guidance.choices[id]?.options ?? []).map((row: Row) => row.id);
const alternative = (classId: string) => classId === 'paladin' ? 'blessed-warrior' : 'druidic-warrior';
const spellKey = (classId: string) => 'feature:' + classId + '-fighting-style:' + alternative(classId) + '-cantrips';

function assertAuthored(actual: Row, expected: Row) {
  assert.equal(actual.notes, expected.notes);
  const { asOf: _actual, ...actualPlay } = actual.play, { asOf: _expected, ...expectedPlay } = expected.play;
  assert.deepEqual(actualPlay, expectedPlay);
}
async function base(f: Fixture, key: string, classId: string, count = 2) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = 'dwarf'; inputs.build.background = 'soldier'; inputs.build.levels = levels(classId, count);
  inputs.notes = 'Keep class training notes'; inputs.play.hp = 1; inputs.play.temporaryHp = 2; inputs.play.currency.gp = 23;
  return inputs;
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

export function registerClassStyleTests(enabled: boolean, fixture: () => Fixture) {
  test('installed class Fighting Styles unlock at their own levels and retain feat restrictions', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'class-style-levels', inputs = await base(f, key, 'fighter', 1);
    for (const classId of ['fighter', 'paladin', 'ranger']) {
      const id = classId + '-fighting-style';
      inputs.build.levels = levels(classId, 1);
      inputs.build.choices = classId === 'fighter' ? [] : [choice(id + '-option', 'fighting-style')];
      let result = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
      assert.equal(Boolean(result.evaluation.guidance.choices[id + '-feat']), classId === 'fighter');
      inputs.build.levels = levels(classId, classId === 'fighter' ? 1 : 2);
      result = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
      assert.deepEqual(options(result.evaluation, id + '-feat').sort(), [...styles].sort());
      inputs.build.choices.push(choice(id + '-feat', 'two-weapon-fighting'));
      result = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
      assert.equal(result.evaluation.guidance.canSave, true, JSON.stringify(result.evaluation.guidance.saveIssues));
      assert.ok(result.evaluation.sheet.feats.some((row: Row) => row.id === 'two-weapon-fighting'));
      inputs.build.choices.at(-1).value = 'tough';
      result = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
      assert.equal(result.evaluation.guidance.canSave, false, 'A class style slot cannot grant an ordinary feat');
    }
  });

  test('installed Champion extra style keeps separate ownership and rejects duplicate styles', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'class-style-champion', inputs = await base(f, key, 'fighter', 7);
    inputs.build.subclasses = { fighter: 'champion' };
    inputs.build.choices = [choice('fighter-fighting-style-feat', 'archery'), choice('champion-additional-fighting-style-feat', 'defense')];
    const stored = await save(f, key, inputs, 0, 'seed');
    assert.deepEqual(stored.evaluation.sheet.feats.filter((row: Row) => styles.includes(row.id)).map((row: Row) => row.id).sort(), ['archery', 'defense']);
    assert.equal(options(stored.evaluation, 'champion-additional-fighting-style-feat').includes('archery'), false);
    const forged = structuredClone(stored.state.inputs); forged.build.choices[1].value = 'archery';
    const rejected = await f.call('save', { key, operation: 'build', inputs: forged, expectedRevision: stored.revision,
      operationId: key + '-duplicate', summary: 'Reject duplicate class styles' });
    assert.equal(rejected.status, 'invalid'); assert.deepEqual((await f.call('load', { key })).state, stored.state);
    const earlier = structuredClone(stored.state.inputs); earlier.build.levels.pop();
    const removed = await save(f, key, earlier, stored.revision, 'remove-level');
    assert.deepEqual(removed.state.inputs.build.choices, [choice('fighter-fighting-style-feat', 'archery')]);
    assert.equal(removed.evaluation.sheet.feats.some((row: Row) => row.id === 'defense'), false);
    assertAuthored(removed.state.inputs, stored.state.inputs);
  });

  for (const classId of ['paladin', 'ranger']) test('installed class cantrip alternative preserves casting and source ownership (' + classId + ')', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'class-style-' + classId, inputs = await base(f, key, classId);
    const id = classId + '-fighting-style', spells = spellKey(classId), picked = classId === 'paladin' ? ['guidance', 'sacred-flame'] : ['guidance', 'starry-wisp'];
    inputs.build.choices = [choice(id + '-option', alternative(classId))]; inputs.build.spells.grantChoices[spells] = picked;
    const stored = await save(f, key, inputs, 0, 'cantrips');
    const pending = stored.evaluation.spellOptions.pendingChoices.find((row: Row) => row.key === spells);
    assert.equal(pending.choose, 2); assert.equal(pending.spellLevel, 0);
    assert.deepEqual(pending.from.class, [classId === 'paladin' ? 'cleric' : 'druid']);
    assert.equal(pending.source.classId, classId); assert.equal(pending.eligibleSpellIds.includes('magic-missile'), false);
    const granted = stored.evaluation.sheet.spellcasting.granted.filter((row: Row) => row.source.id === id);
    assert.deepEqual(granted.map((row: Row) => row.ref).sort(), [...picked].sort());
    assert.ok(granted.every((row: Row) => row.castingAbility === (classId === 'paladin' ? 'CHA' : 'WIS') && row.source.classId === classId));
    const forged = structuredClone(stored.state.inputs); forged.build.spells.grantChoices[spells] = ['guidance', 'magic-missile'];
    const rejected = await f.call('save', { key, operation: 'build', inputs: forged, expectedRevision: stored.revision,
      operationId: key + '-wrong-list', summary: 'Reject an ineligible grant spell' });
    assert.equal(rejected.status, 'invalid'); assert.deepEqual((await f.call('load', { key })).state, stored.state);
    const revised = structuredClone(stored.state.inputs); revised.build.choices = [choice(id + '-option', 'fighting-style'), choice(id + '-feat', 'archery')];
    const changed = await save(f, key, revised, stored.revision, 'style');
    assert.equal(changed.state.inputs.build.spells.grantChoices[spells], undefined);
    assert.equal(changed.evaluation.sheet.spellcasting.granted.some((row: Row) => row.source.id === id), false);
    assertAuthored(changed.state.inputs, stored.state.inputs);
    const withdrawn = structuredClone(changed.state.inputs); withdrawn.build.levels.pop();
    const removed = await save(f, key, withdrawn, changed.revision, 'remove-level');
    assert.equal(removed.state.inputs.build.choices.some((row: Row) => row.id.startsWith(id)), false);
    assertAuthored(removed.state.inputs, stored.state.inputs);
  });

  for (const locale of ['en', 'cs']) test('class training uses shared choices and spell controls with durable output (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), cs = locale === 'cs', classId = cs ? 'ranger' : 'paladin', key = 'class-style-ui-' + locale;
    const inputs = await base(f, key, classId), initial = await save(f, key, inputs, 0, 'seed');
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    const id = classId + '-fighting-style', spells = spellKey(classId), saved = cs ? /^Uloženo$/ : /^Saved$/;
    if (cs) {
      await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel('Rozložení deníku', { exact: true }).selectOption('classic');
      await sheet.locator('#dnd-tab-builder').click(); await page.setViewportSize({ width: 390, height: 1000 });
      await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
    }
    const pick = async (choiceId: string, label: string) => {
      const control = group(sheet, choiceId).getByRole('combobox', { name: cs ? 'Volba 1' : 'Selection 1', exact: true });
      await control.fill(label); await group(sheet, choiceId).getByRole('option', { name: label, exact: true }).waitFor();
      await control.press('ArrowDown'); await savedAfter(page, key, () => control.press('Enter'));
      await status.filter({ hasText: saved }).waitFor();
      assert.equal(await control.evaluate(node => node === document.activeElement), true);
    };
    await sheet.locator('#dnd-builder-tab-' + classId).click();
    await pick(id + '-option', 'Fighting Style'); await pick(id + '-feat', 'Archery');
    await pick(id + '-option', cs ? 'Druidic Warrior' : 'Blessed Warrior');
    assert.equal((await read()).state.inputs.build.choices.some((row: Row) => row.id === id + '-feat'), false);
    await sheet.locator('#dnd-builder-tab-spells').click();
    const picker = sheet.locator('[data-spell-picker="' + spells + '"]');
    await picker.locator('summary').click();
    for (const spell of ['Guidance', cs ? 'Starry Wisp' : 'Sacred Flame']) {
      const control = picker.getByRole('checkbox', { name: spell, exact: true });
      await control.focus(); await savedAfter(page, key, () => control.press('Space')); await status.filter({ hasText: saved }).waitFor();
      assert.equal(await control.evaluate(node => node === document.activeElement), true);
    }
    const selectedRow = picker.locator('.dnd-workflow-controls').filter({ has: page.getByRole('checkbox', { name: 'Guidance', exact: true }) });
    const labelBounds = await selectedRow.locator('label').boundingBox();
    const detailsBounds = await selectedRow.getByRole('button', { name: cs ? 'Podrobnosti' : 'Details', exact: true }).boundingBox();
    assert.ok(labelBounds && detailsBounds && (detailsBounds.x >= labelBounds.x + labelBounds.width + 3 ||
      detailsBounds.y >= labelBounds.y + labelBounds.height + 3), 'Spell selection and Details keep visible space when inline or wrapped');
    assert.equal(await picker.getByRole('checkbox', { name: 'Magic Missile', exact: true }).count(), 0);
    await picker.getByRole('checkbox', { name: 'Guidance', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(f.output, 'class-style-cantrips-' + locale + '.png') });
    const selected = await read(); assertAuthored(selected.state.inputs, initial.state.inputs);
    await sheet.locator('#dnd-builder-tab-' + classId).click(); await pick(id + '-option', 'Fighting Style');
    assert.equal((await read()).state.inputs.build.spells.grantChoices[spells], undefined);
    await pick(id + '-option', cs ? 'Druidic Warrior' : 'Blessed Warrior');
    // Re-enter the alternative through the same saved-data path and retain it for provider-free checks.
    const again = await read(), resumed = structuredClone(again.state.inputs);
    resumed.build.spells.grantChoices[spells] = selected.state.inputs.build.spells.grantChoices[spells];
    await save(f, key, resumed, again.revision, 'resume-cantrips');
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-spells').click();
    await sheet.getByRole('button', { name: 'Guidance', exact: true }).first().waitFor();
    let stored = await read(); assertAuthored(stored.state.inputs, initial.state.inputs);
    await sheet.locator('#dnd-tab-tools').click();
    const envelope = await exported(page, sheet, locale); assert.deepEqual(envelope.inputs, stored.state.inputs);
    const popup = await printOutput(page, sheet, locale); assert.match(await popup.locator('body').innerText(), /Guidance/); await popup.close();
    assert.deepEqual((await read()).state, stored.state); frozen.set(key, structuredClone(stored));
  });
}

export async function verifyFrozenClassStyles(t: TestContext, f: Fixture) {
  for (const [key, expected] of frozen) {
    const locale = key.endsWith('-cs') ? 'cs' : 'en', { page, sheet, read } = await openBuilder(t, f, key, locale);
    const stored = await read(); assert.equal(stored.status, 'unavailable'); assert.deepEqual(stored.state, expected.state);
    let queries = 0; await page.route('**/services/call', async route => {
      if (route.request().postDataJSON()?.method === 'query-records') queries++;
      await route.continue();
    });
    await sheet.locator('#dnd-tab-spells').click();
    assert.ok(expected.state.projection.sheet.spellcasting.granted.some((grant: Row) => grant.name === 'Guidance'), key + ': saved grant includes Guidance');
    try { await sheet.getByRole('button', { name: 'Guidance', exact: true }).first().waitFor(); }
    catch (cause) { await page.screenshot({ path: resolve(f.output, key + '-frozen-failed.png') }); throw new Error(key + ': ' + await sheet.innerText(), { cause }); }
    await sheet.getByRole('button', { name: 'Guidance', exact: true }).first().click();
    const details = sheet.getByRole('dialog', { name: 'Guidance', exact: true });
    await details.locator('summary').filter({ hasText: locale === 'cs' ? 'Uložené údaje zdroje' : 'Saved source evidence' }).click();
    const evidence = expected.state.projection.evidence.find((row: Row) => row.reference.kind === 'spell' && row.reference.id === 'guidance');
    assert.ok((await details.innerText()).includes(evidence.hash), 'Provider-free spell details retain the exact saved source hash');
    await page.keyboard.press('Escape');
    await sheet.locator('#dnd-tab-tools').click();
    const envelope = await exported(page, sheet, locale); assert.deepEqual(envelope.inputs, expected.state.inputs);
    const popup = await printOutput(page, sheet, locale); assert.match(await popup.locator('body').innerText(), /Guidance/); await popup.close();
    assert.equal(queries, 0); assert.deepEqual((await read()).state, expected.state);
    await page.context().close();
  }
}
