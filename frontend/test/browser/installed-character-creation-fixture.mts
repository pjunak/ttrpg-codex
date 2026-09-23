import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import type { Locator } from 'playwright';
import { jsonResponse } from './installed-graph-fixture.mts';
import { choose, createCharacterRecord, type Fixture } from './installed-character-builder-fixture.mts';

type Row = Record<string, any>;
const created = new Map<string, { state: Row; revision: number }>();
export async function verifyFrozenCreatedCharacters(f: Fixture) {
  for (const [key, previous] of created) {
    const frozen = await f.call('load', { key });
    assert.equal(frozen.status, 'unavailable');
    assert.deepEqual(frozen.state, previous.state, 'Provider removal must preserve every UI-created choice and play value');
    assert.equal(frozen.revision, previous.revision);
  }
}
const target = (sheet: Locator, id: string) => sheet.locator('[data-builder-target=' + JSON.stringify(id) + '], [id=' + JSON.stringify('character-choice-' + encodeURIComponent(id)) + ']');

export function registerCharacterCreationTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) test('blank character reaches saved play entirely through Builder controls (' + locale + ')', { skip: !enabled, timeout: 120000 }, async t => {
    const f = fixture(), key = 'ui-created-' + locale, wizard = locale === 'cs';
    const text = wizard ? {
      method: 'Způsob tvorby', species: 'Druh', background: 'Zázemí',
      add: 'Přidat povolání', layout: 'Rozložení deníku', saved: /^Uloženo$/, long: 'Dlouhý odpočinek',
    } : {
      method: 'Creation method', species: 'Species', background: 'Background',
      add: 'Add class', layout: 'Sheet layout', saved: /^Saved$/, long: 'Long rest',
    };
    // Only the host article is seeded. Every sheet choice and play mutation below uses the UI.
    assert.equal((await createCharacterRecord(f, key)).state, undefined);
    const context = await f.browser.newContext({ baseURL: f.origin, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await jsonResponse(await context.request.post('/api/login', { data: { password: wizard ? 'local-character-player' : 'local-character-dm' } }));
    await context.addInitScript(value => localStorage.setItem('codex_lang', value), locale);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => {
      if (!t.passed) await page.screenshot({ path: resolve(f.output, 'creation-failure-' + locale + '.png'), fullPage: true });
      await context.close(); assert.deepEqual(errors, []);
    });
    await page.goto('/#/characters/' + key); await page.locator('#character-view-addons').click();
    const sheet = page.locator('.addon-dnd-character'), status = sheet.locator('[data-character-status]');
    const read = () => f.call('load', { key });
    const settled = async () => { await status.filter({ hasText: text.saved }).waitFor(); return read(); };
    await sheet.locator('#dnd-builder-tab-character').waitFor();
    await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
    assert.equal(await sheet.locator('#dnd-tab-builder').getAttribute('aria-selected'), 'true', 'An empty sheet opens directly in Builder');
    if (wizard) {
      await sheet.getByLabel(text.method, { exact: true }).selectOption('array'); await settled();
      await target(sheet, 'abilities').getByLabel('INT', { exact: true }).selectOption('15'); await settled();
      await target(sheet, 'abilities').getByLabel('CON', { exact: true }).selectOption('14'); await settled();
    } else {
      for (const [ability, score] of Object.entries({ STR: 15, DEX: 14, CON: 14, INT: 10, WIS: 10 })) {
        const control = target(sheet, 'abilities').getByLabel(ability, { exact: true });
        for (let value = 8; value < score; value++) await control.press('ArrowUp');
        await settled();
      }
    }
    await choose(sheet, text.species, 'Dwarf'); await settled();
    await choose(sheet, text.background, wizard ? 'Sage' : 'Soldier'); await settled();
    await sheet.locator('#dnd-builder-tab-add-class').click();
    await choose(sheet, text.add, wizard ? 'Wizard' : 'Fighter'); await settled();
    let stored: Row = await read();
    for (let step = 0; !stored.evaluation.ready && step < 40; step++) {
      const issues = stored.evaluation.guidance.sections.flatMap((section: Row) => section.issues);
      const issue = issues.find((row: Row) => row.repair) ?? issues[0];
      assert.ok(issue, JSON.stringify(stored.evaluation.issues));
      t.diagnostic('Complete UI choice: ' + issue.id);
      await sheet.locator('.dse-builder-next').press('Enter');
      const group = target(sheet, issue.id);
      await group.waitFor();
      assert.equal(await group.evaluate(node => node.contains(document.activeElement)), true, 'Next choice focuses its owning controls');
      const descriptors = [...stored.evaluation.plan.creationChoices, ...stored.evaluation.plan.creationAbilityChoices, ...stored.evaluation.plan.classChoices];
      const descriptor = descriptors.find((row: Row) => row.id === issue.id);
      if (descriptor?.kind === 'abilityBudget') {
        let remaining = descriptor.budget;
        const preferred = wizard ? ['INT', 'CON', 'WIS'] : ['STR', 'CON', 'DEX'];
        for (const ability of preferred.filter(id => descriptor.eligible.includes(id))) {
          const amount = Math.min(remaining, descriptor.perAbilityMax);
          for (let point = 0; point < amount; point++) await group.getByLabel(ability, { exact: true }).press('ArrowUp');
          if (amount) await settled();
          remaining -= amount; if (!remaining) break;
        }
        assert.equal(remaining, 0);
      } else if (descriptor) {
        const selected = stored.state.inputs.build.choices.filter((row: Row) => row.id === issue.id).map((row: Row) => row.value);
        const option = stored.evaluation.guidance.choices[issue.id].options.find((row: Row) => !selected.includes(row.id));
        assert.ok(option, 'An eligible finite choice must be available');
        const pending = group.locator('[data-builder-pending]').first();
        const combo = pending.getByRole('combobox');
        await combo.fill(option.label); await sheet.getByRole('option', { name: option.label, exact: true }).click();
      } else if (await group.getByRole('checkbox').count()) {
        const preferred = issue.id === 'spellbook:wizard' ? ['Magic Missile', 'Shield', 'Detect Magic', 'Feather Fall', 'Mage Armor', 'Sleep'] :
          issue.id === 'cantrips:wizard' ? ['Fire Bolt', 'Light', 'Mage Hand'] : ['Minor Illusion', 'Ray of Frost', 'Detect Magic'];
        let control: Locator | undefined;
        for (const name of preferred) {
          const candidate = group.getByRole('checkbox', { name, exact: true });
          if (await candidate.count() && !(await candidate.isChecked()) && await candidate.isEnabled()) { control = candidate; break; }
        }
        control ??= group.locator('input[type=checkbox]:not(:checked):enabled').first();
        const name = await control.evaluate(node => node.parentElement!.textContent!);
        const filter = group.getByRole('searchbox');
        await filter.fill(name);
        if (issue.id === 'spellbook:wizard') await group.locator('select').selectOption('1');
        await control.focus(); await control.press('Space'); await settled();
        const current = group.getByRole('checkbox', { name, exact: true });
        assert.equal(await current.isVisible(), true, 'Saving a spell choice keeps the selection group open');
        assert.equal(await current.evaluate(node => node === document.activeElement), true, 'Selecting a spell preserves keyboard position');
        assert.equal(await filter.inputValue(), name, 'Autosave preserves the current search');
        if (issue.id === 'spellbook:wizard') assert.equal(await group.locator('select').inputValue(), '1');
        await filter.fill('');
      } else {
        await group.locator('select').selectOption('INT');
      }
      stored = await settled();
    }
    assert.equal(stored.evaluation.ready, true, JSON.stringify(stored.evaluation.guidance.sections));
    assert.equal(stored.state.inputs.build.method, wizard ? 'array' : 'point-buy');
    assert.equal(stored.state.inputs.build.levels[0].classId, wizard ? 'wizard' : 'fighter');
    assert.equal(stored.state.inputs.build.species, 'dwarf');
    await sheet.locator('#dnd-builder-tab-dm-given').click();
    assert.equal(await sheet.getByRole('button', { name: wizard ? 'Přidat dar od PJ' : 'Give a DM grant', exact: true }).count(), wizard ? 0 : 1);
    await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel(text.layout, { exact: true }).selectOption(wizard ? 'classic' : 'compact');
    await sheet.locator('#dnd-tab-combat').click(); await sheet.getByRole('button', { name: text.long, exact: true }).click();
    stored = await settled(); assert.ok(stored.state.inputs.play.hp > 0);
    assert.equal(stored.state.inputs.play.hp, stored.state.projection.sheet.derived.maxHp);
    if (wizard) {
      await sheet.locator('#dnd-tab-spells').click();
      await sheet.getByText('Spravovat kouzla', { exact: true }).click();
      const prepared = target(sheet, 'prepared:wizard');
      await prepared.locator('summary').click();
      const spell = prepared.getByRole('checkbox', { name: 'Magic Missile', exact: true });
      await prepared.getByRole('searchbox').fill('Magic');
      await prepared.locator('select').selectOption('1');
      await spell.check(); stored = await settled();
      assert.equal(await spell.isVisible(), true, 'Manage spells stays open after preparing a spell');
      assert.equal(await spell.evaluate(node => node === document.activeElement), true);
      assert.equal(await prepared.getByRole('searchbox').inputValue(), 'Magic');
      assert.equal(await prepared.locator('select').inputValue(), '1');
      assert.deepEqual(stored.state.inputs.play.preparedSpells.wizard, ['magic-missile']);
      await spell.press('Space'); stored = await settled();
      assert.deepEqual(stored.state.inputs.play.preparedSpells.wizard, []);
      assert.equal(await spell.evaluate(node => node === document.activeElement), true, 'Unpreparing a spell keeps keyboard focus');
      await spell.press('Space'); stored = await settled();
      const slot = stored.evaluation.spellOptions.classes.find((row: Row) => row.classId === 'wizard').castSlots['magic-missile'][0];
      await sheet.locator('[data-spell-name="Magic Missile"]').getByRole('button', { name: 'Seslat', exact: true }).click();
      stored = await settled(); assert.equal(stored.state.inputs.play.resourceUses[slot], 1);
      const grant = stored.evaluation.spellOptions.granted.find((row: Row) => row.ref === 'detect-magic');
      const charge = grant.slots.find((id: string) => id.startsWith('charge:')); assert.ok(charge);
      await sheet.locator('[data-spell-grant][data-spell-name="Detect Magic"]').getByRole('button', { name: 'Seslat získané kouzlo', exact: true }).click();
      stored = await settled(); assert.equal(stored.state.inputs.play.resourceUses[charge], 1);
      await sheet.locator('#dnd-tab-combat').click(); await sheet.getByRole('button', { name: text.long, exact: true }).click();
      stored = await settled();
      assert.equal(stored.state.inputs.play.resourceUses[slot], 0); assert.equal(stored.state.inputs.play.resourceUses[charge], 0);
      await sheet.locator('#dnd-tab-spells').click();
      assert.equal(await prepared.getByRole('searchbox').inputValue(), 'Magic', 'Returning to Spells retains its local filters');
      assert.equal(await spell.isVisible(), true);
      await page.screenshot({ path: resolve(f.output, 'creation-prepared-' + locale + '.png'), fullPage: true });
    }
    await sheet.locator('#dnd-tab-sheet').click(); await sheet.getByLabel('GP', { exact: true }).fill('19');
    stored = await settled();
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(() => (document.querySelector('.campaign-sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const ability = sheet.locator('.dse-ability').filter({ has: page.locator('.dse-ability-title > span:first-child').filter({ hasText: wizard ? /^Obratnost$/ : /^Dexterity$/ }) });
    const label = ability.locator('.dse-skill > span:nth-child(2)').filter({ hasText: wizard ? 'Akrobacie' : 'Acrobatics' });
    assert.equal(await label.evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) * 1.6), true,
      'Enlarged skill names must remain readable instead of wrapping into a few letters per line');
    await ability.screenshot({ path: resolve(f.output, 'creation-ability-phone-' + locale + '.png') });
    await page.screenshot({ path: resolve(f.output, 'creation-ready-phone-' + locale + '.png'), fullPage: true });
    await page.reload(); await page.locator('#character-view-addons').click();
    await sheet.getByLabel('GP', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
    assert.equal(await sheet.getAttribute('data-layout'), wizard ? 'classic' : 'compact');
    assert.equal(await sheet.getByLabel('GP', { exact: true }).inputValue(), '19');
    const reloaded = await read(); assert.deepEqual(reloaded.state, stored.state); assert.equal(reloaded.evaluation.ready, true);
    created.set(key, { state: reloaded.state, revision: reloaded.revision });
  });
}
