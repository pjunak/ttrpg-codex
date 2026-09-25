import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import type { Locator } from 'playwright';
import { openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { readyCharacter } from './installed-character-command-fixture.mts';
import { exported, printOutput } from './installed-character-output-fixture.mts';
import { jsonResponse } from './installed-graph-fixture.mts';

type Row = Record<string, any>;
const frozen = new Map<string, { stored: Row; display: Record<string, string[]> }>();
const groups = ['saves', 'skills', 'expertise', 'armor', 'weapons', 'tools', 'languages'];
const training = (root: Locator, group: string) => root.locator('.dse-proficiencies [data-training="' + group + '"]');
const text = (locale: string) => locale === 'cs' ? {
  heading: 'Zběhlosti', wisdom: 'Moudrost', medicine: 'Lékařství', none: 'Žádné zaznamenané',
  saves: ['Síla', 'Odolnost'], armor: ['Lehké zbroje', 'Střední zbroje', 'Těžké zbroje', 'Štíty'],
  weapons: ['Jednoduché zbraně', 'Válečné zbraně'], revoke: 'Odvolat dar: Field training',
} : {
  heading: 'Proficiencies', wisdom: 'Wisdom', medicine: 'Medicine', none: 'None recorded',
  saves: ['Strength', 'Constitution'], armor: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'],
  weapons: ['Simple weapons', 'Martial weapons'], revoke: 'Revoke Field training',
};
async function snapshot(root: Locator): Promise<Record<string, string[]>> {
  return Object.fromEntries(await Promise.all(groups.map(async group => {
    const values = [];
    for (const item of await training(root, group).locator('li').all()) {
      const content = await item.locator('codex-addon-rule-details').count() ? item.getByRole('button').first() : item;
      values.push(await content.innerText());
    }
    return [group, values];
  })));
}
async function assertIndicators(sheet: Locator, wisdom: boolean, locale: string) {
  await sheet.locator('#dnd-tab-sheet').click();
  const names = locale === 'cs'
    ? ['Síla — záchranný hod: Zběhlost', 'Moudrost — záchranný hod: ' + (wisdom ? 'Zběhlost' : 'Bez zběhlosti')]
    : ['Strength — saving throw: Proficient', 'Wisdom — saving throw: ' + (wisdom ? 'Proficient' : 'Untrained')];
  for (const [index, name] of names.entries()) {
    const marker = sheet.getByRole('img', { name, exact: true }); await marker.waitFor();
    assert.equal(await marker.getAttribute('data-proficient'), String(index === 0 || wisdom));
    assert.equal(await marker.locator('svg').evaluate(node => getComputedStyle(node).fill !== 'none'), index === 0 || wisdom);
  }
}
function assertPlay(actual: Row, expected: Row) {
  const { asOf: _actualClock, ...actualPlay } = actual, { asOf: _expectedClock, ...expectedPlay } = expected;
  assert.deepEqual(actualPlay, expectedPlay, 'Training edits preserve all authored play values');
}
async function addRogueTraining(f: Fixture, key: string, initial: Row) {
  const inputs = structuredClone(initial.state.inputs);
  inputs.build.levels.push({ id: 'rogue-one', classId: 'rogue' });
  inputs.play.hp = 3; inputs.play.temporaryHp = 2; inputs.play.currency.gp = 27;
  inputs.notes = 'Preserve multiclass training notes';
  inputs.play.inventory.push({ id: 'kit', name: 'Training kit', quantity: 1, location: 'stored', attuned: false, acquisition: 'Keep acquisition', notes: 'Keep notes <b>literal</b>' });
  for (let round = 0; round < 8; round++) {
    const { evaluation } = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: initial.revision });
    if (evaluation.ready) break;
    for (const choice of evaluation.plan.classChoices) {
      const options = evaluation.guidance.choices[choice.id]?.options ?? [];
      for (let slot = 0; slot < Number(choice.count ?? 1) && options[slot]; slot++) {
        if (!inputs.build.choices.some((row: Row) => row.id === choice.id && row.slot === slot))
          inputs.build.choices.push({ id: choice.id, slot, value: options[slot].id });
      }
    }
  }
  const stored = await save(f, key, inputs, initial.revision, 'multiclass');
  assert.equal(stored.evaluation.ready, true, JSON.stringify(stored.evaluation.issues));
  assert.equal(Object.values(stored.state.projection.sheet.proficiencies.skills).filter(value => value === 'expertise').length, 2);
  return stored;
}
async function assertTraining(sheet: Locator, stored: Row, locale: string, granted: boolean) {
  await sheet.locator('#dnd-tab-combat').click();
  await sheet.getByRole('heading', { name: text(locale).heading, exact: true }).waitFor();
  const view = await snapshot(sheet), facts = stored.state.projection.sheet.proficiencies;
  assert.deepEqual(view.saves, [...text(locale).saves, ...(granted ? [text(locale).wisdom] : [])]);
  assert.deepEqual(view.armor, text(locale).armor);
  assert.deepEqual(view.weapons, text(locale).weapons);
  assert.equal(view.skills!.length, Object.values(facts.skills).filter(value => value === 'proficient').length);
  assert.equal(view.expertise!.length, 2);
  assert.equal(view.skills!.includes(text(locale).medicine), granted);
  assert.ok(!view.skills!.some(name => view.expertise!.includes(name)), 'Expertise is listed once, separately from ordinary training');
  assert.ok(view.tools!.some(name => /Thieves/i.test(name)), 'Multiclass tool training remains visible');
  assert.ok(view.languages!.length > 0);
  assert.doesNotMatch(await sheet.locator('.dse-proficiencies').innerText(), /\b(?:true|false|none)\b|thieves-tools|animalHandling|sleightOfHand/);
  return view;
}

export function registerProficiencyTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) test('installed saved proficiencies follow multiclass training and DM withdrawal (' + locale + ')', { skip: !enabled, timeout: 90000 }, async t => {
    const f = fixture(), key = 'training-ui-' + locale, cs = locale === 'cs';
    const initial = await readyCharacter(f, key);
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    if (cs) {
      await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel('Rozložení deníku', { exact: true }).selectOption('classic');
    }
    await assertIndicators(sheet, false, locale);
    await sheet.locator('#dnd-tab-combat').click();
    await training(sheet, 'expertise').getByText(text(locale).none, { exact: true }).waitFor();
    let stored = await addRogueTraining(f, key, initial);
    const beforeGrant = structuredClone(stored.state.inputs);
    stored = await f.call('save', { key, operation: 'grant', expectedRevision: stored.revision, operationId: key + '-grant',
      summary: 'Record field training', grant: { id: '', actorId: '', grantedAt: '', name: 'Field training',
        reason: 'Practised with a mentor', active: true, effectiveLevel: 2, condition: 'always',
        effects: [{ target: 'proficiency', key: 'WIS', mode: 'set', value: 1 }, { target: 'proficiency', key: 'medicine', mode: 'set', value: 1 }], waivers: [] } });
    assert.equal(stored.status, 'ready'); assert.equal(stored.evaluation.ready, true);
    assertPlay(stored.state.inputs.play, beforeGrant.play); assert.equal(stored.state.inputs.notes, beforeGrant.notes);
    const provider = await jsonResponse(await f.admin.get('/api/admin/addons/dnd-engine'));
    await jsonResponse(await f.admin.post('/api/admin/addons/dnd-engine/reload', { headers: { 'X-Codex-CSRF': f.csrf }, data: { expectedStateRevision: provider.state.revision } }));
    const restarted = await read(); assert.equal(restarted.rulesChanged, false); assert.deepEqual(restarted.state, stored.state);
    await page.reload(); await page.locator('#character-view-addons').click();
    if (cs) {
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.waitForFunction(() => (document.querySelector('.campaign-sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
      await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
    }
    await assertIndicators(sheet, true, locale);
    const activeDisplay = await assertTraining(sheet, stored, locale, true);
    const skill = training(sheet, 'skills').getByRole('button', { name: text(locale).medicine, exact: true });
    await skill.focus(); await skill.press('Enter');
    const dialog = sheet.getByRole('dialog'); await dialog.waitFor();
    assert.match(await dialog.innerText(), /ability modifier \+ proficiency multiplier/);
    await page.keyboard.press('Escape'); assert.equal(await skill.evaluate(node => node === (node.getRootNode() as Document | ShadowRoot).activeElement), true);
    await sheet.locator('.dse-proficiencies').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const id of groups) assert.equal(await training(sheet, id).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, id);
    await page.screenshot({ path: resolve(f.output, key + '.png') });
    await sheet.locator('#dnd-tab-tools').click();
    assert.deepEqual((await exported(page, sheet, locale)).inputs, stored.state.inputs);
    const popup = await printOutput(page, sheet, locale, false);
    assert.deepEqual(await snapshot(popup.locator('body')), activeDisplay); await popup.close();
    await sheet.getByRole('dialog').getByRole('button', { name: cs ? 'Zavřít' : 'Close', exact: true }).click();
    await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-dm-given').click();
    await sheet.getByRole('button', { name: text(locale).revoke, exact: true }).click();
    await status.filter({ hasText: cs ? /^Uloženo$/ : /^Saved$/ }).waitFor(); stored = await read();
    assertPlay(stored.state.inputs.play, beforeGrant.play); assert.equal(stored.state.inputs.notes, beforeGrant.notes);
    await assertIndicators(sheet, false, locale);
    const display = await assertTraining(sheet, stored, locale, false);
    await page.reload(); await page.locator('#character-view-addons').click();
    assert.deepEqual(await assertTraining(sheet, stored, locale, false), display);
    assert.deepEqual((await read()).state, stored.state, 'Reading and printing never write training');
    frozen.set(key, { stored: structuredClone(stored), display }); await page.context().close();
  });
}

export async function verifyFrozenProficiencies(t: TestContext, f: Fixture) {
  assert.equal(frozen.size, 2, "Both training sessions must precede provider-free acceptance");
  for (const [key, expected] of frozen) {
    const locale = key.endsWith('-cs') ? 'cs' : 'en', { page, sheet, read } = await openBuilder(t, f, key, locale);
    const loaded = await read(); assert.equal(loaded.status, 'unavailable'); assert.deepEqual(loaded.state, expected.stored.state);
    let queries = 0; await page.route('**/services/call', async route => {
      if (route.request().postDataJSON()?.method === 'query-records') queries++;
      await route.continue();
    });
    assert.deepEqual(await assertTraining(sheet, loaded, locale, false), expected.display);
    const expert = training(sheet, 'expertise').getByRole('button').first();
    await expert.press('Enter'); const dialog = sheet.getByRole('dialog'); await dialog.waitFor();
    await dialog.locator(':scope > details > summary').filter({ hasText: locale === 'cs' ? 'Uložené údaje zdroje' : 'Saved source evidence' }).click();
    const evidence = expected.stored.state.projection.evidence.find((row: Row) => row.reference.kind === 'class' && row.reference.id === 'rogue');
    assert.ok((await dialog.innerText()).includes(evidence.hash)); await page.keyboard.press('Escape');
    assert.equal(await expert.evaluate(node => node === (node.getRootNode() as Document | ShadowRoot).activeElement), true);
    await sheet.locator('#dnd-tab-tools').click();
    assert.deepEqual((await exported(page, sheet, locale)).inputs, expected.stored.state.inputs);
    const popup = await printOutput(page, sheet, locale, false);
    assert.deepEqual(await snapshot(popup.locator('body')), expected.display); await popup.close();
    assert.equal(queries, 0); assert.deepEqual((await read()).state, expected.stored.state); await page.context().close();
  }
}
