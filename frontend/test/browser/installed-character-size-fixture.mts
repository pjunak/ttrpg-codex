import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import type { Locator } from 'playwright';
import { choose, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { readyCharacter } from './installed-character-command-fixture.mts';
import { exported, printOutput } from './installed-character-output-fixture.mts';
import { jsonResponse } from './installed-graph-fixture.mts';

type Row = Record<string, any>;
type Source = { addonId: string; setId: string; id: string; enabled: boolean };
const sizedCharacters = new Map<string, Row>();
const group = (sheet: Locator, id: string) => sheet.locator('[id="character-choice-' + encodeURIComponent(id) + '"]');
const sizeTile = (sheet: Locator, locale: string) => sheet.locator('.dse-vitals .codex-tile').filter({ has: sheet.page().locator('.dse-stat-label').filter({ hasText: locale === 'cs' ? /^Velikost$/ : /^Size$/ }) });
const sizeChoice = (species: string, value: string) => ({ id: 'species:' + species + ':size', slot: 0, value });

async function human(f: Fixture, key: string) {
  const initial = await readyCharacter(f, key), inputs = structuredClone(initial.state.inputs);
  inputs.build.species = 'human';
  inputs.build.choices.push({ id: 'species:human:skillful', slot: 0, value: 'arcana' }, { id: 'species:human:versatile', slot: 0, value: 'tough' });
  inputs.notes = 'Keep chosen-size notes'; inputs.play.hp = 3; inputs.play.currency.gp = 37;
  inputs.play.resourceUses['hit-dice-d10'] = 1;
  return save(f, key, inputs, initial.revision, 'human');
}

function assertAuthored(actual: Row, expected: Row) {
  assert.equal(actual.notes, expected.notes);
  for (const key of ['hp', 'temporaryHp', 'currency', 'inventory', 'resourceUses', 'preparedSpells']) assert.deepEqual(actual.play[key], expected.play[key], key);
}

export function registerCharacterSizeTests(enabled: boolean, fixture: () => Fixture) {
  test('installed species size options follow all fourteen source records and reject forged choices', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'species-size-catalog', initial = await readyCharacter(f, key);
    for (const species of ['aasimar', 'human', 'tiefling', 'changeling', 'khoravar', 'shifter', 'warforged', 'flamekin', 'lorwyn-changeling', 'rimekin', 'dhampir', 'hexblood', 'lupin', 'reborn']) {
      for (const size of ['Small', 'Medium']) {
        const inputs = structuredClone(initial.state.inputs); inputs.build.species = species;
        inputs.build.choices.push(sizeChoice(species, size));
        const before = structuredClone(inputs), result = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: initial.revision });
        assert.deepEqual(inputs, before);
        assert.equal(result.evaluation.sheet.derived.size, size, species);
        assert.deepEqual(result.evaluation.guidance.choices['species:' + species + ':size'].options.map((row: Row) => row.id).sort(), ['Medium', 'Small'], species);
        assert.equal(result.evaluation.issues.some((row: Row) => row.id.includes('option:species:' + species + ':size')), false, species);
        assert.deepEqual(result.evaluation.explanations['derived.size'].sources, [{ kind: 'species', id: species }]);
      }
    }
    const inputs = structuredClone(initial.state.inputs); inputs.build.species = 'human';
    for (const choice of [sizeChoice('human', 'Large'), { ...sizeChoice('human', 'Small'), slot: 1 }]) {
      inputs.build.choices = [...initial.state.inputs.build.choices, choice];
      const rejected = await f.call('save', { key, operation: 'build', inputs, expectedRevision: initial.revision, operationId: key + '-forged-' + choice.slot, summary: 'Reject forged size' });
      assert.equal(rejected.status, 'invalid'); assert.equal(rejected.evaluation.guidance.canSave, false);
      assert.deepEqual((await f.call('load', { key })).state, initial.state);
    }
  });

  for (const locale of ['en', 'cs']) test('species size autosaves with shared keyboard controls and saved output (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'species-size-' + locale, initial = await human(f, key);
    assert.equal(initial.evaluation.ready, false); assert.equal(initial.evaluation.guidance.canSave, true);
    assert.equal(initial.state.projection.sheet.derived.size, null, 'An existing character never receives an invented default');
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    const cs = locale === 'cs', selection = cs ? 'Volba 1' : 'Selection 1', small = cs ? 'Malá' : 'Small', medium = cs ? 'Střední' : 'Medium', saved = cs ? /^Uloženo$/ : /^Saved$/;
    if (cs) {
      await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel('Rozložení deníku', { exact: true }).selectOption('classic');
      await sheet.locator('#dnd-tab-builder').click(); await page.setViewportSize({ width: 390, height: 1000 });
      await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
    }
    await sheet.locator('#dnd-builder-tab-character').click();
    const control = group(sheet, 'species:human:size').getByRole('combobox', { name: selection, exact: true });
    await control.fill(small); await sheet.getByRole('option', { name: small, exact: true }).waitFor();
    await control.press('ArrowDown'); await control.press('Enter'); await status.filter({ hasText: saved }).waitFor();
    assert.equal(await control.evaluate(node => node === document.activeElement), true, 'Autosave retains the owning enhanced control');
    let stored = await read(); assert.equal(stored.evaluation.ready, true, JSON.stringify(stored.evaluation.issues));
    assert.equal(stored.state.projection.sheet.derived.size, 'Small'); assertAuthored(stored.state.inputs, initial.state.inputs);
    await group(sheet, 'species:human:size').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(f.output, 'species-size-choice-' + locale + '.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await choose(group(sheet, 'species:human:size'), selection, medium); await status.filter({ hasText: saved }).waitFor();
    assert.equal((await read()).state.projection.sheet.derived.size, 'Medium');
    await choose(group(sheet, 'species:human:size'), selection, small); await status.filter({ hasText: saved }).waitFor();
    await page.reload(); await page.locator('#character-view-addons').click();
    await sheet.locator('#dnd-tab-sheet').click(); await sizeTile(sheet, locale).getByRole('button', { name: small, exact: true }).waitFor();
    if (cs) await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
    await sizeTile(sheet, locale).scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(f.output, 'species-size-sheet-' + locale + '.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await sheet.locator('#dnd-tab-tools').click();
    stored = await read(); const envelope = await exported(page, sheet, locale);
    assert.deepEqual(envelope.inputs.build.choices, stored.state.inputs.build.choices);
    const popup = await printOutput(page, sheet, locale); assert.match(await popup.locator('body').innerText(), cs ? /Velikost\s+Malá/u : /Size\s+Small/u); await popup.close();
    assertAuthored((await read()).state.inputs, initial.state.inputs);
    sizedCharacters.set(key, structuredClone(stored));
  });

  test('changing species withdraws only its own size and preserves play and other choices', { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = 'species-size-repair'; let stored = await human(f, key);
    let inputs = structuredClone(stored.state.inputs); inputs.build.choices.push(sizeChoice('human', 'Small'));
    stored = await save(f, key, inputs, stored.revision, 'small');
    const before = structuredClone(stored.state.inputs), siblings = before.build.choices.filter((row: Row) => !row.id.startsWith('species:human:'));
    inputs = structuredClone(before); inputs.build.species = 'dwarf';
    stored = await save(f, key, inputs, stored.revision, 'fixed');
    assert.equal(stored.evaluation.ready, true); assert.equal(stored.state.projection.sheet.derived.size, 'Medium');
    assert.deepEqual(stored.state.inputs.build.choices, siblings); assertAuthored(stored.state.inputs, before);
    inputs = structuredClone(stored.state.inputs); inputs.build.species = 'human';
    stored = await save(f, key, inputs, stored.revision, 'human-again');
    assert.equal(stored.state.projection.sheet.derived.size, null);
    assert.equal(stored.state.inputs.build.choices.some((row: Row) => row.id === 'species:human:size'), false);
    assertAuthored(stored.state.inputs, before);
  });

  test('saved species size survives reprint adoption and refuses missing-source recalculation', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'species-size-source', seed = await readyCharacter(f, key), inputs = structuredClone(seed.state.inputs);
    inputs.build.species = 'dhampir'; inputs.build.choices.push(sizeChoice('dhampir', 'Small'));
    inputs.play.hp = 3; inputs.play.currency.gp = 37; inputs.notes = 'Retain reprint size';
    let stored = await save(f, key, inputs, seed.revision, 'small');
    const sources = (await jsonResponse(await f.admin.get('/api/admin/rules-policy'))).sources as Source[];
    const set = async (disabled: string[]) => {
      const current = await jsonResponse(await f.admin.get('/api/admin/rules-policy'));
      await jsonResponse(await f.admin.post('/api/admin/rules-policy', { headers: { 'X-Codex-CSRF': f.csrf }, data: {
        expectedRevision: current.revision, expectedGraphRevision: current.graphRevision,
        enabled: sources.filter(source => source.enabled && !disabled.includes(source.id)).map(({ addonId, setId, id }) => ({ addonId, setId, id })),
      } }));
    };
    t.after(() => set([]));
    await set(['rhw']);
    const changed = await f.call('load', { key }); assert.equal(changed.rulesChanged, true); assert.deepEqual(changed.state, stored.state);
    const adopted = await f.call('save', { key, operation: 'adopt-rules', operationId: key + '-adopt', expectedRevision: changed.revision, summary: 'Adopt reprint', adoptRules: true });
    assert.equal(adopted.status, 'ready', JSON.stringify(adopted.evaluation?.issues)); assertAuthored(adopted.state.inputs, stored.state.inputs);
    assert.equal(adopted.state.projection.sheet.derived.size, 'Small');
    assert.deepEqual(adopted.state.inputs.build.choices, stored.state.inputs.build.choices); stored = adopted;
    await set(['rhw', 'aboh']);
    const unavailable = await f.call('load', { key }); assert.deepEqual(unavailable.state, stored.state);
    const rejected = await f.call('save', { key, operation: 'adopt-rules', operationId: key + '-missing', expectedRevision: stored.revision, summary: 'Missing source', adoptRules: true });
    assert.equal(rejected.status, 'invalid'); assert.deepEqual((await f.call('load', { key })).state, stored.state);
    await set([]);
    const restored = await f.call('save', { key, operation: 'adopt-rules', operationId: key + '-restore', expectedRevision: stored.revision, summary: 'Restore sources', adoptRules: true });
    assert.equal(restored.status, 'ready'); assert.equal(restored.state.projection.sheet.derived.size, 'Small');
    assertAuthored(restored.state.inputs, stored.state.inputs);
  });
}

export async function verifyFrozenSizes(t: TestContext, f: Fixture) {
  for (const [key, expected] of sizedCharacters) {
    const locale = key.endsWith('-cs') ? 'cs' : 'en', { page, sheet, read } = await openBuilder(t, f, key, locale);
    const loaded = await read(); assert.equal(loaded.status, 'unavailable'); assert.deepEqual(loaded.state, expected.state); assert.equal(loaded.revision, expected.revision);
    let queries = 0; await page.route('**/services/call', async route => { if (route.request().postDataJSON()?.method === 'query-records') queries++; await route.continue(); });
    await sheet.locator('#dnd-tab-sheet').click();
    await sizeTile(sheet, locale).getByRole('button', { name: locale === 'cs' ? 'Malá' : 'Small', exact: true }).waitFor();
    await sheet.locator('#dnd-tab-tools').click();
    const popup = await printOutput(page, sheet, locale);
    assert.match(await popup.locator('body').innerText(), locale === 'cs' ? /Velikost\s+Malá/u : /Size\s+Small/u); await popup.close();
    assert.equal(queries, 0); assert.deepEqual((await read()).state, expected.state);
  }
}
