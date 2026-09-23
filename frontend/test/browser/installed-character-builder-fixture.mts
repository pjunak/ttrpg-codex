import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import type { APIRequestContext, Browser, Locator } from 'playwright';
import { jsonResponse } from './installed-graph-fixture.mts';

export interface Fixture {
  admin: APIRequestContext; browser: Browser; csrf: string; origin: string; output: string;
  call(method: string, params: Record<string, unknown>): ReturnType<typeof jsonResponse>;
}
export async function createCharacterRecord(f: Fixture, key: string) {
  await jsonResponse(await f.admin.post('/api/campaign/transactions', {
    headers: { 'X-Codex-CSRF': f.csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [{
      operation: 'put', collection: 'characters', key, expectedRevision: 0,
      value: { id: key, name: key, knowledge: 4, visibility: 'public' },
    }] },
  }));
  const loaded = await f.call('load', { key });
  if (loaded.status !== 'ready' || !loaded.evaluation) {
    const providers = await Promise.all(['dnd-sheets', 'dnd-engine', 'dnd-2024-compendium'].map(async id => {
      const snapshot = await jsonResponse(await f.admin.get('/api/admin/addons/' + id));
      return { id, state: snapshot.state, runtime: snapshot.runtime };
    }));
    assert.fail('Character creation requires connected rules: ' + JSON.stringify({ key, loaded, providers }));
  }
  return loaded;
}
export async function createCharacter(f: Fixture, key: string) {
  const loaded = await createCharacterRecord(f, key);
  const inputs = loaded.evaluation.inputs;
  inputs.build.method = 'array'; inputs.build.baseScores = { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 };
  return inputs;
}
export async function save(f: Fixture, key: string, inputs: Record<string, unknown>, revision: number, suffix: string) {
  const result = await f.call('save', { key, operation: 'build', operationId: key + '-' + suffix,
    summary: 'Builder acceptance', expectedRevision: revision, inputs });
  assert.equal(result.status, 'ready', JSON.stringify({ status: result.status, issues: result.evaluation?.guidance.saveIssues }));
  return result;
}
export async function openBuilder(t: TestContext, f: Fixture, key: string, locale = 'en') {
  const context = await f.browser.newContext({ storageState: await f.admin.storageState(), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => context.close()); await context.addInitScript(locale => localStorage.setItem('codex_lang', locale), locale);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(f.origin + '/#/characters/' + key); await page.locator('#character-view-addons').click();
  const sheet = page.locator('.addon-dnd-character');
  await sheet.locator('#dnd-tab-builder').click();
  await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
  return { page, sheet, status: sheet.locator('[data-character-status]'), read: () => f.call('load', { key }) };
}
async function focused(control: Locator) {
  assert.equal(await control.evaluate(node => node === document.activeElement), true, 'Navigation must focus the visible editable control');
  assert.equal(await control.isVisible(), true);
}
export async function choose(sheet: Locator, name: string, value: string) {
  const combo = sheet.getByRole('combobox', { name, exact: true });
  await combo.fill(value); await sheet.getByRole('option', { name: value, exact: true }).click();
}
type Descriptor = { id: string; kind: string; count?: number; classId?: string; ability?: { id: string; eligible: string[]; budget: number } };
type Option = { id: string; label: string };

export function registerCharacterBuilderTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) test('Builder next-choice navigation uses visible host controls on enlarged phones (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'builder-nav-' + locale, inputs = await createCharacter(f, key);
    await save(f, key, inputs, 0, 'seed');
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    const text = locale === 'cs'
      ? { next: 'Další volba: ', species: 'Vybrat druh', speciesField: 'Druh', background: 'Vybrat zázemí', backgroundField: 'Zázemí', lineage: 'Vybrat rodovou linii', lineageField: 'Rodová linie', first: 'Vybrat první povolání', add: 'Přidat povolání', saved: /^Uloženo$/ }
      : { next: 'Next choice: ', species: 'Choose species', speciesField: 'Species', background: 'Choose background', backgroundField: 'Background', lineage: 'Choose lineage', lineageField: 'Lineage', first: 'Choose first class', add: 'Add class', saved: /^Saved$/ };
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(() => (document.querySelector('.campaign-sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await sheet.locator('.dse-build-rail > summary').click();
    assert.equal(await sheet.locator('.dse-build-rail').evaluate(node => (node as HTMLDetailsElement).open), false);
    const next = sheet.getByRole('button', { name: text.next + text.species, exact: true });
    await next.focus(); await next.press('Enter');
    await focused(sheet.getByRole('combobox', { name: text.speciesField, exact: true }));
    await choose(sheet, text.speciesField, 'Elf'); await status.filter({ hasText: text.saved }).waitFor();
    await sheet.getByRole('button', { name: text.next + text.background, exact: true }).press('Enter');
    await focused(sheet.getByRole('combobox', { name: text.backgroundField, exact: true }));
    await choose(sheet, text.backgroundField, 'Soldier'); await status.filter({ hasText: text.saved }).waitFor();
    await sheet.getByRole('button', { name: text.next + text.lineage, exact: true }).press('Enter');
    await focused(sheet.getByRole('combobox', { name: text.lineageField, exact: true }));
    const lineage = await sheet.locator('[data-builder-target="lineage"] select option').evaluateAll(options => options.map(node => ({ id: (node as HTMLOptionElement).value, label: node.textContent! })).find(option => option.id)!);
    await choose(sheet, text.lineageField, lineage.label); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal(await sheet.locator('.dse-build-rail').evaluate(node => (node as HTMLDetailsElement).open), false, 'Rerenders preserve the collapsed progress rail');
    await sheet.locator('.dse-build-rail > summary').click();
    await sheet.locator('.dse-build-rail').getByRole('button', { name: text.first + ' →', exact: true }).press('Enter');
    await focused(sheet.getByRole('combobox', { name: text.add, exact: true }));
    const tabs = await sheet.locator('.dnd-builder-tabs').boundingBox(), active = await sheet.locator('#dnd-builder-tab-add-class').boundingBox();
    assert.ok(tabs && active && active.x >= tabs.x - 1 && active.x + active.width <= tabs.x + tabs.width + 1, 'The selected Builder tab remains visible after guided navigation');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(f.output, 'builder-next-phone-' + locale + '.png') });
    await choose(sheet, text.add, 'Fighter'); await status.filter({ hasText: text.saved }).waitFor();
    const stored = await read(); assert.equal(stored.state.inputs.build.lineage, lineage.id);
    assert.equal(stored.state.inputs.build.levels[0].classId, 'fighter');
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-builder').click();
    assert.equal(await sheet.getByRole('combobox', { name: text.speciesField, exact: true }).inputValue(), 'Elf');
  });

  test('Builder guidance opens subclass and required spell controls with keyboard focus', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture();
    for (const classId of ['fighter', 'wizard']) {
      const key = 'builder-target-' + classId, inputs = await createCharacter(f, key);
      inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
      inputs.build.levels = Array.from({ length: classId === 'fighter' ? 3 : 1 }, (_, index) => ({ id: 'level-' + index, classId }));
      await save(f, key, inputs, 0, 'seed');
      const { sheet } = await openBuilder(t, f, key);
      if (classId === 'fighter') {
        await sheet.locator('.dse-build-rail').getByRole('button', { name: 'Choose Fighter subclass →', exact: true }).press('Enter');
        await focused(sheet.getByRole('combobox', { name: 'Subclass', exact: true }));
      } else {
        for (const [target, label] of [['cantrips:wizard', 'Choose Wizard cantrips →'], ['spellbook:wizard', 'Choose Wizard spellbook spells →']]) {
          await sheet.locator('.dse-build-rail').getByRole('button', { name: label, exact: true }).press('Enter');
          const group = sheet.locator('[data-builder-target="' + target + '"]');
          assert.equal(await group.evaluate(node => (node as HTMLDetailsElement).open), true);
          await focused(group.getByLabel('Filter spells', { exact: true }));
        }
      }
    }
  });

  test('earlier class order and level edits preserve valid sibling choices through installed autosave', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'builder-preserve', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    inputs.build.levels = [{ id: 'rogue-one', classId: 'rogue' }];
    inputs.notes = 'Keep authored notes through repair';
    let evaluated = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
    const descriptors = evaluated.evaluation.plan.classChoices as Descriptor[];
    const skills = descriptors.find(choice => choice.kind === 'skills'); assert.ok(skills, JSON.stringify(descriptors));
    const options = evaluated.evaluation.guidance.choices[skills.id].options as Option[];
    inputs.build.choices = options.slice(0, skills.count).map((option, slot) => ({ id: skills.id, slot, value: option.id }));
    assert.equal(inputs.build.choices.length, 4);
    const first = structuredClone(inputs.build.choices[0]);
    await save(f, key, inputs, 0, 'seed');
    inputs.build.levels.unshift({ id: 'fighter-first', classId: 'fighter' });
    const reduced = await save(f, key, inputs, 1, 'changed-first-class');
    assert.deepEqual(reduced.state.inputs.build.choices.filter((choice: { id: string }) => choice.id === skills.id), [first]);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    await sheet.locator('#dnd-builder-tab-levels').click();
    await sheet.getByRole('button', { name: 'Remove level', exact: true }).first().click();
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    const repaired = await read();
    assert.deepEqual(repaired.state.inputs.build.choices.filter((choice: { id: string }) => choice.id === skills.id), [first]);
    assert.equal(repaired.state.inputs.notes, inputs.notes);
    const issue = repaired.evaluation.guidance.sections.flatMap((section: { issues: { id: string; label: string }[] }) => section.issues).find((issue: { id: string }) => issue.id === skills.id); assert.ok(issue);
    await sheet.locator('.dse-build-rail').getByRole('button', { name: issue.label + ' →', exact: true }).press('Enter');
    const group = sheet.locator('[id="character-choice-' + encodeURIComponent(skills.id) + '"]');
    await focused(group.getByRole('combobox', { name: 'Selection 2', exact: true }));
    assert.equal(await group.getByRole('combobox', { name: 'Selection 1', exact: true }).inputValue(), options[0]!.label);
    for (let slot = 1; slot < 4; slot++) {
      await choose(group, 'Selection ' + (slot + 1), options[slot]!.label);
      await status.filter({ hasText: /^Saved$/ }).waitFor();
    }
    let stored = await read();
    stored.state.inputs.build.levels.push(...[2, 3, 4].map(level => ({ id: 'rogue-' + level, classId: 'rogue' })));
    evaluated = await f.call('evaluate', { key, operation: 'build', inputs: stored.state.inputs, expectedRevision: stored.revision });
    const advancement = (evaluated.evaluation.plan.classChoices as Descriptor[]).find(choice => choice.kind === 'asiMode'); assert.ok(advancement?.ability);
    stored.state.inputs.build.choices.push({ id: advancement.id, slot: 0, value: 'asi' }, { id: advancement.ability.id, slot: 0, value: { STR: 1, DEX: 1 } });
    stored = await save(f, key, stored.state.inputs, stored.revision, 'level-four');
    const before = stored.state.inputs.build.choices.filter((choice: { id: string }) => choice.id === skills.id);
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-builder').click();
    await sheet.locator('#dnd-builder-tab-rogue').click();
    const lastLevel = sheet.locator('.dse-build-level').last(), hpMode = lastLevel.getByRole('combobox', { name: 'HP gain', exact: true });
    await hpMode.focus(); await hpMode.selectOption('rolled'); await status.filter({ hasText: /^Saved$/ }).waitFor();
    await focused(hpMode);
    assert.equal((await read()).state.inputs.build.levels[3].hitPoints, 1);
    await sheet.locator('#dnd-builder-tab-levels').click(); await sheet.getByRole('button', { name: 'Remove level', exact: true }).last().click();
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    stored = await read();
    assert.equal(stored.state.inputs.build.levels.length, 3);
    assert.equal(stored.state.inputs.build.choices.some((choice: { id: string }) => choice.id.startsWith(advancement.id)), false);
    assert.deepEqual(stored.state.inputs.build.choices.filter((choice: { id: string }) => choice.id === skills.id), before);
    assert.equal(stored.state.inputs.notes, inputs.notes);
  });

  test('packaged class Expertise choices use the correct acquisition levels and skill pools', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture();
    const cases = [
      { classId: 'rogue', levels: [1, 5, 6], grants: [['rogue-expertise', 1, 2], ['rogue-expertise-6', 6, 2]] },
      { classId: 'bard', levels: [1, 2, 8, 9], grants: [['bard-expertise', 2, 2], ['bard-expertise-9', 9, 2]] },
      { classId: 'ranger', levels: [1, 2, 8, 9], grants: [['ranger-deft-explorer-expertise', 2, 1], ['ranger-expertise', 9, 2]] },
      { classId: 'wizard', levels: [1, 2], grants: [['wizard-scholar', 2, 1]] },
    ] as const;
    for (const scenario of cases) {
      const key = 'expertise-levels-' + scenario.classId, inputs = await createCharacter(f, key);
      inputs.build.species = 'dwarf'; inputs.build.background = 'sage';
      for (const level of scenario.levels) {
        inputs.build.levels = Array.from({ length: level }, (_, index) => ({ id: 'level-' + index, classId: scenario.classId }));
        const { evaluation } = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
        const descriptors = evaluation.plan.classChoices as (Descriptor & { source: { level: number } })[];
        for (const [id, acquired, count] of scenario.grants) {
          const descriptor = descriptors.find(choice => choice.id === id);
          if (level < acquired) { assert.equal(descriptor, undefined, id + ' acquired too early'); continue; }
          assert.equal(descriptor?.kind, 'expertise', id);
          assert.equal(descriptor.count, count, id);
          assert.equal(descriptor.source.level, acquired, id);
          const options = evaluation.guidance.choices[id].options as Option[];
          assert.deepEqual(options.map(option => option.id).sort(), ['arcana', 'history'], id + ' must use proficient skills');
        }
        if (scenario.classId === 'ranger' && level >= 2) {
          const languages = descriptors.find(choice => choice.id === 'ranger-deft-explorer-languages');
          assert.equal(languages?.count, 2);
          assert.ok(evaluation.guidance.choices[languages.id].options.some((option: Option) => option.id === 'druidic'));
        }
      }
    }
    const key = 'expertise-multiclass', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    inputs.build.levels = [...Array.from({ length: 5 }, (_, index) => ({ id: 'rogue-' + index, classId: 'rogue' })), { id: 'fighter-one', classId: 'fighter' }];
    const { evaluation } = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
    assert.equal(evaluation.guidance.choices['rogue-expertise-6'], undefined, 'Character level six is not Rogue level six');
  });

  test('installed Expertise repairs preserve sibling slots, update totals and survive reload', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'expertise-repair', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    inputs.build.levels = Array.from({ length: 6 }, (_, index) => ({ id: 'rogue-' + index, classId: 'rogue' }));
    inputs.notes = 'Retain these notes while replacing Expertise';
    inputs.play.hp = 5;
    const { evaluation } = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
    const skills = (evaluation.plan.classChoices as Descriptor[]).find(choice => choice.kind === 'skills'); assert.ok(skills);
    inputs.build.choices = [
      ...['acrobatics', 'insight', 'perception', 'stealth'].map((value, slot) => ({ id: skills.id, slot, value })),
      { id: 'rogue-expertise', slot: 0, value: 'stealth' }, { id: 'rogue-expertise', slot: 1, value: 'athletics' },
      { id: 'rogue-expertise-6', slot: 0, value: 'insight' }, { id: 'rogue-expertise-6', slot: 1, value: 'perception' },
    ];
    const seeded = await save(f, key, inputs, 0, 'seed');
    assert.equal(seeded.evaluation.sheet.skills.stealth.total, 8);
    assert.equal(seeded.evaluation.sheet.skills.athletics.total, 8);
    assert.equal(seeded.evaluation.guidance.choices['rogue-expertise-6'].options.some((option: Option) => option.id === 'stealth'), false);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    await sheet.locator('#dnd-builder-tab-rogue').click();
    const group = (id: string) => sheet.locator('[id="character-choice-' + encodeURIComponent(id) + '"]');
    await choose(group(skills.id), 'Selection 4', 'Investigation'); await status.filter({ hasText: /^Saved$/ }).waitFor();
    let stored = await read();
    assert.deepEqual(stored.state.inputs.build.choices.filter((choice: { id: string }) => choice.id === 'rogue-expertise'),
      [{ id: 'rogue-expertise', slot: 1, value: 'athletics' }]);
    assert.equal(stored.evaluation.sheet.skills.stealth.expertise, false);
    assert.equal(stored.evaluation.sheet.skills.stealth.proficient, false);
    assert.equal(stored.evaluation.sheet.skills.insight.expertise, true);
    assert.equal(stored.state.inputs.play.hp, 5);
    const issue = stored.evaluation.guidance.sections.flatMap((section: { issues: { id: string; label: string }[] }) => section.issues).find((issue: { id: string }) => issue.id === 'rogue-expertise'); assert.ok(issue);
    await sheet.locator('.dse-build-rail').getByRole('button', { name: issue.label + ' →', exact: true }).press('Enter');
    await focused(group('rogue-expertise').getByRole('combobox', { name: 'Selection 1', exact: true }));
    assert.equal(await group('rogue-expertise').getByRole('combobox', { name: 'Selection 2', exact: true }).inputValue(), 'Athletics');
    await choose(group('rogue-expertise'), 'Selection 1', 'Investigation'); await status.filter({ hasText: /^Saved$/ }).waitFor();
    assert.equal((await read()).evaluation.sheet.skills.investigation.total, 7);

    // Moving an earlier grant onto a later skill keeps the earlier decision
    // and withdraws only the old dependent slot, without erasing its sibling.
    await choose(group('rogue-expertise'), 'Selection 1', 'Insight'); await status.filter({ hasText: /^Saved$/ }).waitFor();
    stored = await read();
    assert.deepEqual(stored.state.inputs.build.choices.filter((choice: { id: string }) => choice.id === 'rogue-expertise-6'),
      [{ id: 'rogue-expertise-6', slot: 1, value: 'perception' }]);
    await choose(group('rogue-expertise-6'), 'Selection 1', 'Investigation'); await status.filter({ hasText: /^Saved$/ }).waitFor();
    assert.equal((await read()).evaluation.sheet.skills.investigation.total, 7);
    await group('rogue-expertise-6').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(f.output, 'expertise-choices.png') });

    await sheet.locator('#dnd-builder-tab-levels').click(); await sheet.getByRole('button', { name: 'Remove level', exact: true }).last().click();
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    stored = await read();
    assert.equal(stored.state.inputs.build.choices.some((choice: { id: string }) => choice.id === 'rogue-expertise-6'), false);
    assert.equal(stored.evaluation.sheet.skills.insight.expertise, true);
    assert.equal(stored.evaluation.sheet.skills.investigation.expertise, false);
    assert.equal(stored.state.inputs.notes, inputs.notes);
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-rogue').click();
    assert.equal(await group('rogue-expertise').getByRole('combobox', { name: 'Selection 1', exact: true }).inputValue(), 'Insight');
    assert.equal(await group('rogue-expertise').getByRole('combobox', { name: 'Selection 2', exact: true }).inputValue(), 'Athletics');
    assert.equal(await group('rogue-expertise-6').count(), 0);
  });

}

export function registerSkillGrantTests(enabled: boolean, fixture: () => Fixture) {
  test('Skill Expert grants and dependent repairs work through installed Builder autosave', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'feat-skill-expert', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    inputs.build.levels = Array.from({ length: 4 }, (_, index) => ({ id: 'fighter-' + index, classId: 'fighter' }));
    inputs.notes = 'Keep authored notes through feat replacement'; inputs.play.hp = 5;
    inputs.build.choices = [
      { id: 'asi:fighter:4', slot: 0, value: 'feat' }, { id: 'asi:fighter:4:feat', slot: 0, value: 'skill-expert' },
      { id: 'asi:fighter:4:featability', slot: 0, value: { STR: 1 } },
      { id: 'feat:skill-expert:skill', slot: 0, value: 'nature' },
      { id: 'feat:skill-expert:expertise', slot: 0, value: 'nature' },
    ];
    const seeded = await save(f, key, inputs, 0, 'seed');
    assert.equal(seeded.evaluation.sheet.skills.nature.proficient, true);
    assert.equal(seeded.evaluation.sheet.skills.nature.expertise, true);
    assert.equal(seeded.evaluation.sheet.skills.nature.total, 5);
    assert.equal(seeded.evaluation.sheet.abilities.STR.score, 16);
    assert.equal(seeded.evaluation.sheet.abilities.STR.cap, 20);
    const skillOptions = seeded.evaluation.guidance.choices['feat:skill-expert:skill'].options.map((option: Option) => option.id);
    assert.equal(skillOptions.length, 16);
    assert.equal(skillOptions.includes('athletics'), false, 'Soldier already grants Athletics');
    assert.equal(skillOptions.includes('intimidation'), false, 'Soldier already grants Intimidation');
    assert.equal(skillOptions.includes('nature'), true, 'the current acquisition retains its selection');
    const advancement = seeded.evaluation.plan.classChoices.find((choice: Descriptor) => choice.id === 'asi:fighter:4');
    assert.deepEqual(advancement.feat.ability.eligible, ['STR','DEX','CON','INT','WIS','CHA']);

    const { page, sheet, status, read } = await openBuilder(t, f, key);
    const group = (id: string) => sheet.locator('[id="character-choice-' + encodeURIComponent(id) + '"]');
    await sheet.locator('#dnd-builder-tab-character').click();
    await choose(group('feat:skill-expert:skill'), 'Selection 1', 'Medicine');
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    let stored = await read();
    assert.equal(stored.state.inputs.build.choices.some((choice: { id: string }) => choice.id === 'feat:skill-expert:expertise'), false);
    assert.equal(stored.evaluation.sheet.skills.nature.expertise, false);
    assert.equal(stored.evaluation.sheet.skills.nature.proficient, false);
    assert.equal(stored.evaluation.sheet.skills.medicine.proficient, true);
    await choose(group('feat:skill-expert:expertise'), 'Selection 1', 'Medicine');
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-builder').click();
    await sheet.locator('#dnd-builder-tab-character').click();
    assert.equal(await group('feat:skill-expert:expertise').getByRole('combobox').inputValue(), 'Medicine');
    stored = await read();
    const changed = structuredClone(stored.state.inputs);
    changed.build.choices = changed.build.choices.filter((choice: { id: string }) => !choice.id.startsWith('asi:fighter:4'));
    changed.build.choices.push({ id: 'asi:fighter:4', slot: 0, value: 'asi' }, { id: 'asi:fighter:4:ability', slot: 0, value: { DEX: 2 } });
    const removed = await save(f, key, changed, stored.revision, 'replace-feat');
    assert.equal(removed.state.inputs.build.choices.some((choice: { id: string }) => choice.id.startsWith('feat:skill-expert:')), false);
    assert.equal(removed.evaluation.sheet.skills.medicine.proficient, false);
    assert.equal(removed.evaluation.sheet.skills.medicine.expertise, false);
    assert.equal(removed.evaluation.sheet.abilities.STR.score, 15);
    assert.equal(removed.state.inputs.notes, inputs.notes); assert.equal(removed.state.inputs.play.hp, 5);
  });

  test('Boon of Skill grants every skill at level nineteen and withdraws its dependent effects', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'feat-boon-skill', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    inputs.build.levels = Array.from({ length: 19 }, (_, index) => ({ id: 'fighter-' + index, classId: 'fighter' }));
    inputs.build.choices = [
      { id: 'asi:fighter:4', slot: 0, value: 'feat' }, { id: 'asi:fighter:4:feat', slot: 0, value: 'skill-expert' },
      { id: 'asi:fighter:4:featability', slot: 0, value: { STR: 1 } },
      { id: 'feat:skill-expert:skill', slot: 0, value: 'nature' }, { id: 'feat:skill-expert:expertise', slot: 0, value: 'nature' },
      { id: 'asi:fighter:19', slot: 0, value: 'feat' }, { id: 'asi:fighter:19:feat', slot: 0, value: 'boon-of-skill' },
      { id: 'asi:fighter:19:featability', slot: 0, value: { STR: 1 } },
      { id: 'feat:boon-of-skill:expertise', slot: 0, value: 'arcana' },
    ];
    const seeded = await save(f, key, inputs, 0, 'seed');
    assert.equal(Object.values(seeded.evaluation.sheet.skills).filter((value: unknown) => (value as {proficient:boolean}).proficient).length, 18);
    assert.equal(seeded.evaluation.sheet.skills.arcana.expertise, true);
    assert.equal(seeded.evaluation.sheet.skills.arcana.total, 13);
    assert.equal(seeded.evaluation.sheet.abilities.STR.score, 17);
    assert.equal(seeded.evaluation.sheet.abilities.STR.cap, 30);
    const options = seeded.evaluation.guidance.choices['feat:boon-of-skill:expertise'].options as Option[];
    assert.equal(options.length, 17); assert.equal(options.some(option => option.id === 'nature'), false);
    const tooEarly = structuredClone(inputs);
    tooEarly.build.choices.find((choice: {id:string}) => choice.id === 'asi:fighter:4:feat').value = 'boon-of-skill';
    const invalid = await f.call('evaluate', { key, operation: 'build', inputs: tooEarly, expectedRevision: seeded.revision });
    assert.equal(invalid.evaluation.guidance.canSave, false, 'later levels cannot qualify an earlier epic boon');
    const changed = structuredClone(seeded.state.inputs);
    changed.build.levels.pop();
    const removed = await save(f, key, changed, seeded.revision, 'remove-source-level');
    assert.equal(removed.state.inputs.build.choices.some((choice: { id: string }) => choice.id.startsWith('feat:boon-of-skill:')), false);
    assert.equal(removed.evaluation.sheet.skills.arcana.proficient, false);
    assert.equal(removed.evaluation.sheet.skills.arcana.expertise, false);
    assert.equal(removed.evaluation.sheet.skills.nature.expertise, true, 'the earlier feat remains');
    assert.equal(removed.evaluation.sheet.abilities.STR.cap, 20);
    assert.equal(removed.evaluation.sheet.abilities.STR.score, 16);
  });

  test("Thieves' Cant languages survive reload and follow Rogue source removal", { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'rogue-languages', inputs = await createCharacter(f, key);
    inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
    inputs.build.levels = [{ id: 'rogue-one', classId: 'rogue' }];
    inputs.build.choices = [{ id: 'rogue-thieves-cant-language', slot: 0, value: 'druidic' }];
    const seeded = await save(f, key, inputs, 0, 'seed');
    const options = seeded.evaluation.guidance.choices['rogue-thieves-cant-language'].options as Option[];
    assert.equal(options.length, 18); assert.equal(options.some(option => option.id === 'thieves-cant'), false);
    assert.ok(seeded.evaluation.sheet.proficiencies.languages.includes('thieves-cant'));
    assert.ok(seeded.evaluation.sheet.proficiencies.languages.includes('druidic'));
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    await sheet.locator('#dnd-builder-tab-rogue').click();
    const group = sheet.locator('[id="character-choice-rogue-thieves-cant-language"]');
    await choose(group, 'Selection 1', 'Undercommon'); await status.filter({ hasText: /^Saved$/ }).waitFor();
    let stored = await read();
    assert.ok(stored.evaluation.sheet.proficiencies.languages.includes('undercommon'));
    assert.equal(stored.evaluation.sheet.proficiencies.languages.includes('druidic'), false);
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-rogue').click();
    assert.equal(await group.getByRole('combobox').inputValue(), 'Undercommon');
    stored = await read();
    const changed = structuredClone(stored.state.inputs); changed.build.levels = [{ id: 'fighter-one', classId: 'fighter' }];
    const removed = await save(f, key, changed, stored.revision, 'remove-rogue');
    assert.equal(removed.evaluation.sheet.proficiencies.languages.includes('thieves-cant'), false);
    assert.equal(removed.evaluation.sheet.proficiencies.languages.includes('undercommon'), false);
    assert.equal(removed.state.inputs.build.choices.some((choice: {id:string}) => choice.id === 'rogue-thieves-cant-language'), false);
  });
}
