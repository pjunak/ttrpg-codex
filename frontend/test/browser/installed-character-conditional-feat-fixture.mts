import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { choose, createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';

type Choice = { id: string; slot: number; value: unknown };
const mastery = (owner: string) => 'feat:elemental-adept@' + encodeURIComponent(owner) + ':energy-mastery';
const advancement = (level: number) => 'asi:fighter:' + level + ':feat';
const selected = (inputs: {build: {choices: Choice[]}}, owner: string) => inputs.build.choices.find(choice => choice.id === mastery(owner))?.value;

async function elementalCharacter(f: Fixture, key: string) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
  inputs.build.levels = Array.from({length: 6}, (_, index) => ({id: 'level-' + index, classId: 'fighter'}));
  inputs.notes = 'Keep authored notes and play state'; inputs.play.hp = 3;
  let stored = await save(f, key, inputs, 0, 'seed');
  // The source still has narrative prerequisites. Only an authenticated DM
  // adjudication authorizes them; these tests do not infer spellcasting from prose.
  stored = await f.call('save', {key, operation: 'grant', operationId: key + '-review',
    summary: 'Adjudicate source prerequisite', expectedRevision: stored.revision,
    grant: {id: '', actorId: '', grantedAt: '', name: 'Reviewed prerequisite', reason: 'Installed choice acceptance',
      active: true, effectiveLevel: 4, condition: 'always', effects: [], waivers: ['feat:elemental-adept']}});
  assert.equal(stored.status, 'ready', JSON.stringify(stored));
  const next = structuredClone(stored.state.inputs);
  next.build.choices = [4, 6].flatMap(level => [
    {id: 'asi:fighter:' + level, slot: 0, value: 'feat'},
    {id: advancement(level), slot: 0, value: 'elemental-adept'},
    {id: 'asi:fighter:' + level + ':featability', slot: 0, value: {INT: 1}},
    {id: mastery(advancement(level)), slot: 0, value: level === 4 ? 'fire' : 'cold'},
  ]);
  stored = await save(f, key, next, stored.revision, 'choices');
  assert.equal(stored.evaluation.sheet.abilities.INT.score, 14, 'each advancement keeps its own ability increase');
  return stored;
}

export function registerConditionalFeatTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) test('Conditional feats reject duplicates and repair through shared phone choices (' + locale + ')',
    {skip: !enabled, timeout: 60000}, async t => {
      const f = fixture(), key = 'conditional-choice-' + locale, stored = await elementalCharacter(f, key);
      const first = advancement(4), second = advancement(6);
      const next = structuredClone(stored.state.inputs);
      next.build.choices.find((choice: Choice) => choice.id === mastery(second)).value = 'fire';
      const rejected = await f.call('save', {key, operation: 'build', operationId: key + '-duplicate',
        summary: 'Attempt duplicate choice', expectedRevision: stored.revision, inputs: next});
      assert.equal(rejected.status, 'invalid');
      assert.equal(rejected.evaluation.guidance.canSave, false);
      assert.ok(rejected.evaluation.issues.some((issue: {id: string}) => issue.id === 'invalid-option:' + mastery(second) + '#0'));
      assert.equal((await f.call('load', {key})).revision, stored.revision);

      const {page, sheet, status, read} = await openBuilder(t, f, key, locale);
      await sheet.locator('#dnd-builder-tab-character').click();
      await page.setViewportSize({width: 390, height: 1000});
      await page.addStyleTag({content: 'html { font-size:200% !important; }'});
      const group = (owner: string) => sheet.locator('[id="character-choice-' + encodeURIComponent(mastery(owner)) + '"]');
      const field = locale === 'cs' ? 'Volba 1' : 'Selection 1', saved = locale === 'cs' ? /^Uloženo$/ : /^Saved$/;
      assert.equal(await group(first).getByRole('combobox', {name: field, exact: true}).inputValue(), 'Fire');
      assert.equal(await group(second).getByRole('combobox', {name: field, exact: true}).inputValue(), 'Cold');
      assert.equal(stored.evaluation.guidance.choices[mastery(second)].options.some((option: {id: string}) => option.id === 'fire'), false);

      await choose(group(first), field, 'Cold');
      await status.filter({hasText: saved}).waitFor();
      let latest = await read();
      assert.equal(selected(latest.state.inputs, first), 'cold');
      assert.equal(selected(latest.state.inputs, second), undefined, 'withdraw only the now-invalid saved later choice');
      assert.equal(latest.evaluation.guidance.canSave, true);
      assert.equal(latest.evaluation.guidance.choices[mastery(second)].done, false);
      const later = group(second).getByRole('combobox', {name: field, exact: true});
      await later.focus(); await later.fill('Fire');
      await group(second).getByRole('option', {name: 'Fire', exact: true}).waitFor();
      await later.press('ArrowDown'); await later.press('Enter');
      await status.filter({hasText: saved}).waitFor();
      assert.equal(await later.evaluate(node => node === document.activeElement), true);
      latest = await read();
      assert.equal(selected(latest.state.inputs, first), 'cold'); assert.equal(selected(latest.state.inputs, second), 'fire');
      assert.equal(latest.state.inputs.notes, stored.state.inputs.notes); assert.equal(latest.state.inputs.play.hp, 3);
      assert.equal(latest.evaluation.sheet.abilities.INT.score, 14);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await group(second).scrollIntoViewIfNeeded();
      await page.screenshot({path: resolve(f.output, 'conditional-feat-phone-' + locale + '.png')});
      await page.reload(); await page.locator('#character-view-addons').click();
      await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-character').click();
      assert.equal(await group(first).getByRole('combobox', {name: field, exact: true}).inputValue(), 'Cold');
      assert.equal(await group(second).getByRole('combobox', {name: field, exact: true}).inputValue(), 'Fire');
    });

  test('Conditional feat grants exhaust their pool and release choices on revocation', {skip: !enabled, timeout: 60000}, async () => {
    const f = fixture(), key = 'conditional-capacity';
    let stored = await elementalCharacter(f, key);
    const grant = {id: '', actorId: '', grantedAt: '', name: 'Elemental training', reason: 'Installed acceptance',
      active: true, effectiveLevel: 4, condition: 'always', effects: [], waivers: [], feat: {kind: 'feat', id: 'elemental-adept'}};
    const owners: string[] = [];
    for (const value of ['acid', 'lightning', 'thunder']) {
      const previous = new Set(stored.state.inputs.grants.map((row: {id: string}) => row.id));
      stored = await f.call('save', {key, operation: 'grant', operationId: key + '-' + value,
        summary: 'Grant distinct training', expectedRevision: stored.revision, grant});
      assert.equal(stored.status, 'ready', JSON.stringify(stored));
      const owner = 'grant:' + stored.state.inputs.grants.find((row: {id: string}) => !previous.has(row.id)).id;
      owners.push(owner);
      const next = structuredClone(stored.state.inputs);
      next.build.choices.push({id: mastery(owner), slot: 0, value});
      stored = await save(f, key, next, stored.revision, value + '-pick');
    }
    const rejected = await f.call('save', {key, operation: 'grant', operationId: key + '-exhausted',
      summary: 'Attempt sixth acquisition', expectedRevision: stored.revision, grant});
    assert.equal(rejected.status, 'invalid');
    assert.ok(rejected.evaluation.guidance.saveIssues.some((issue: {message: string}) => issue.message === 'No distinct options remain for another acquisition of this feat.'));
    assert.equal((await f.call('load', {key})).revision, stored.revision);
    stored = await f.call('save', {key, operation: 'revoke-grant', operationId: key + '-revoke',
      summary: 'Withdraw one training', expectedRevision: stored.revision, grantId: owners[0]!.slice('grant:'.length)});
    assert.equal(stored.status, 'ready', JSON.stringify(stored));
    assert.equal(selected(stored.state.inputs, owners[0]!), undefined);
    assert.equal(selected(stored.state.inputs, owners[1]!), 'lightning');
    assert.equal(selected(stored.state.inputs, owners[2]!), 'thunder');
    assert.equal(selected(stored.state.inputs, advancement(6)), 'cold');
    assert.equal(stored.evaluation.guidance.choices[mastery(advancement(6))].options.some((option: {id: string}) => option.id === 'acid'), true);
    assert.equal(stored.state.inputs.play.hp, 3);
    assert.deepEqual((await f.call('load', {key})).state.inputs, stored.state.inputs);
  });
}
