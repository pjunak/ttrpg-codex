import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import { createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { exported, printOutput } from './installed-character-output-fixture.mts';

const frozenAttunements = new Map<string, Awaited<ReturnType<Fixture['call']>>>();

type Item = { id: string; name: string; reference: { kind: string; id: string }; quantity: number; location: string; attuned: boolean; acquisition: string; notes: string };
const item = (id: string, kind: string, ref: string, location = 'carried', attuned = false): Item => ({
  id, name: id, reference: { kind, id: ref }, quantity: 1, location, attuned, acquisition: 'Keep acquisition ' + id, notes: 'Keep notes ' + id,
});
async function equipmentCharacter(f: Fixture, key: string, inventory: Item[]) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = 'dwarf'; inputs.build.background = 'soldier'; inputs.build.levels = [{ id: 'one', classId: 'fighter' }];
  inputs.notes = 'Keep authored character notes'; inputs.play.hp = 3; inputs.play.inventory = inventory;
  return save(f, key, inputs, 0, 'seed');
}
const text = (locale: string) => locale === 'cs'
  ? { move: 'Přesunout: ', shield: 'Štít', attuned: 'Sladěno', attune: 'Sladit se: ', close: 'Zavřít', layout: 'Rozložení deníku', classic: 'Klasické', saved: /^Uloženo$/,
    capacity: 'Všechna místa pro sladění jsou obsazená. Nejprve zrušte sladění s některým předmětem.' }
  : { move: 'Move ', shield: 'Shield', attuned: 'Attuned', attune: 'Attune ', close: 'Close', layout: 'Sheet layout', classic: 'Classic', saved: /^Saved$/,
    capacity: 'All attunement slots are in use. Unattune an item first.' };

export function registerEquipmentTests(enabled: boolean, fixture: () => Fixture) {
  registerAttunementTransitionTests(enabled, fixture);
  for (const locale of ['en', 'cs']) {
    test('equipment slot replacement preserves stored inventory through both controls (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), key = 'equipment-slots-' + locale, messages = text(locale);
      const inventory = [
        item('old-armor', 'armor', 'chain-mail', 'equipped'), item('new-armor', 'armor', 'plate-armor', 'stored'),
        item('spare-armor', 'armor', 'leather-armor', 'stored'), item('carried-armor', 'armor', 'padded-armor'),
        item('old-shield', 'armor', 'shield', 'equipped'), item('new-shield', 'armor', 'shield', 'stored'), item('spare-shield', 'armor', 'shield', 'stored'),
      ];
      const initial = await equipmentCharacter(f, key, inventory), { page, sheet, status, read } = await openBuilder(t, f, key, locale);
      if (locale === 'cs') { await sheet.locator('#dnd-tab-tools').click(); await sheet.getByRole('combobox', { name: messages.layout, exact: true }).selectOption('classic'); }
      await sheet.locator('#dnd-tab-sheet').click();
      await sheet.locator('[data-equipment-slot="shield"] .dse-equipment-slot').getByRole('button', { name: 'old-shield', exact: true }).waitFor();
      const move = sheet.getByRole('combobox', { name: messages.move + 'new-armor', exact: true });
      await move.focus(); await move.selectOption('equipped'); await status.filter({ hasText: messages.saved }).waitFor();
      assert.equal(await move.evaluate(node => node === document.activeElement), true, 'Inventory moves retain keyboard focus across autosave');
      await sheet.getByRole('button', { name: '+ ' + messages.shield, exact: true }).click();
      const dialog = sheet.getByRole('dialog');
      await dialog.getByRole('button', { name: 'new-shield', exact: true }).focus();
      await dialog.getByRole('button', { name: 'new-shield', exact: true }).press('Enter');
      await status.filter({ hasText: messages.saved }).waitFor();
      assert.equal(await sheet.getByRole('button', { name: '+ ' + messages.shield, exact: true }).evaluate(node => node === document.activeElement), true, 'Slot selection returns focus to the refreshed trigger');
      const stored = await read();
      assert.deepEqual(stored.state.inputs.play.inventory, inventory.map(row => ({
        ...row, location: ['old-armor', 'old-shield'].includes(row.id) ? 'carried' : ['new-armor', 'new-shield'].includes(row.id) ? 'equipped' : row.location,
      })));
      assert.equal(stored.state.inputs.notes, initial.state.inputs.notes); assert.equal(stored.state.inputs.play.hp, 3);
      assert.equal(stored.state.projection.sheet.equipment['new-shield'].slot, 'shield');
      assert.equal(stored.state.projection.sheet.equipment['new-armor'].slot, 'armor');
      await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-sheet').click();
      await sheet.locator('[data-equipment-slot="shield"] .dse-equipment-slot').getByRole('button', { name: 'new-shield', exact: true }).waitFor();
      await sheet.locator('[data-equipment-slot="armor"] .dse-equipment-slot').getByRole('button', { name: 'new-armor', exact: true }).waitFor();
      assert.equal(await sheet.getAttribute('data-layout'), locale === 'cs' ? 'classic' : 'compact');
      await page.setViewportSize({ width: 390, height: 1000 }); await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
      assert.equal(await sheet.locator('.dse-bp-head > button').evaluate(node => {
        const style = getComputedStyle(node);
        return node.clientHeight <= parseFloat(style.lineHeight) * 2 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 1;
      }), true, 'Add item keeps readable words instead of being squeezed beside the backpack heading');
      await sheet.locator('.dse-worn').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(f.output, 'equipment-slots-phone-' + locale + '.png') });
      const geometry = await page.evaluate(() => {
        const roots: (Document | ShadowRoot)[] = [document], elements: HTMLElement[] = [];
        for (const root of roots) for (const node of root.querySelectorAll<HTMLElement>('*')) { elements.push(node); if (node.shadowRoot) roots.push(node.shadowRoot); }
        return { width: document.documentElement.scrollWidth, viewport: innerWidth, overflow: elements.filter(node => node.getBoundingClientRect().right > innerWidth + 1 && node.getClientRects().length).map(node => ({
          tag: node.tagName, cls: node.className, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth, text: node.textContent?.slice(0, 40),
        })).slice(0, 25) };
      });
      assert.equal(geometry.width <= geometry.viewport, true, JSON.stringify(geometry));
    });

    test('equipment attunement explains capacity and preserves explicit repairs (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), key = 'equipment-attunement-' + locale, messages = text(locale);
      let stored = await equipmentCharacter(f, key, [
        item('ring', 'magic-item', 'ring-of-protection', 'equipped', true), item('spare-ring', 'magic-item', 'ring-of-protection'),
        item('amulet', 'magic-item', 'amulet-of-health', 'equipped'),
      ]);
      assert.equal(stored.evaluation.guidance.equipment['spare-ring'].attuneReason, 'duplicate');
      const duplicate = structuredClone(stored.state.inputs); duplicate.play.inventory[1].attuned = true;
      const duplicateResult = await f.call('save', { key, operation: 'build', operationId: key + '-duplicate', expectedRevision: stored.revision, summary: 'Duplicate attunement', inputs: duplicate });
      assert.equal(duplicateResult.status, 'invalid');
      assert.ok(duplicateResult.evaluation.guidance.saveIssues.some((issue: { id: string }) => issue.id === 'attunement-duplicate:spare-ring'));
      assert.deepEqual((await f.call('load', { key })).state, stored.state);
      const grant = { id: '', actorId: '', grantedAt: '', active: true, name: 'Bounded capacity', reason: 'Installed capacity acceptance',
        effectiveLevel: 1, condition: 'always', effects: [{ target: 'attunementLimit', mode: 'add', value: -2 }], waivers: [] };
      stored = await f.call('save', { key, operation: 'grant', operationId: key + '-limit', expectedRevision: stored.revision, summary: grant.reason, grant });
      assert.equal(stored.status, 'ready', JSON.stringify(stored.evaluation?.guidance.saveIssues));
      assert.equal(stored.evaluation.sheet.attunement.limit, 1);
      const rejected = structuredClone(stored.state.inputs); rejected.play.inventory[2].attuned = true;
      const invalid = await f.call('save', { key, operation: 'build', operationId: key + '-forged', expectedRevision: stored.revision, summary: 'Excess attunement', inputs: rejected });
      assert.equal(invalid.status, 'invalid'); assert.ok(invalid.evaluation.guidance.saveIssues.some((issue: { id: string }) => issue.id === 'attunement-capacity'));
      assert.deepEqual((await f.call('load', { key })).state, stored.state);
      const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
      if (locale === 'cs') { await sheet.locator('#dnd-tab-tools').click(); await sheet.getByRole('combobox', { name: messages.layout, exact: true }).selectOption('classic'); }
      await sheet.locator('#dnd-tab-sheet').click();
      const amulet = sheet.getByRole('button', { name: messages.attune + 'amulet', exact: true });
      assert.equal(await amulet.isDisabled(), true); assert.equal(await amulet.getAttribute('aria-description'), messages.capacity);
      await page.setViewportSize({ width: 390, height: 1000 }); await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
      await sheet.getByRole('button', { name: '+ ' + messages.attuned, exact: true }).click();
      const dialog = sheet.getByRole('dialog'), choice = dialog.getByRole('button', { name: 'amulet', exact: true });
      assert.equal(await choice.isDisabled(), true); assert.equal(await dialog.getByText(messages.capacity, { exact: true }).count(), 1);
      assert.equal(await dialog.locator('h2').evaluate(node => node === document.activeElement), true);
      assert.equal(await dialog.evaluate(node => node.scrollTop), 0, 'The dialog starts at its heading instead of skipping blocked choices');
      const description = await choice.getAttribute('aria-describedby'); assert.ok(description);
      assert.equal(await dialog.locator('[id="' + description + '"]').innerText(), messages.capacity);
      assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'Translated rejection fits the enlarged phone dialog');
      await page.screenshot({ path: resolve(f.output, 'equipment-attunement-phone-' + locale + '.png') });
      await dialog.getByRole('button', { name: messages.close, exact: true }).click();
      await sheet.getByRole('button', { name: messages.attune + 'ring', exact: true }).click(); await status.filter({ hasText: messages.saved }).waitFor();
      assert.equal(await amulet.isDisabled(), false);
      await sheet.getByRole('button', { name: '+ ' + messages.attuned, exact: true }).click();
      await dialog.getByRole('button', { name: 'amulet', exact: true }).press('Enter'); await status.filter({ hasText: messages.saved }).waitFor();
      const repaired = await read();
      assert.deepEqual(repaired.state.inputs.play.inventory, stored.state.inputs.play.inventory.map((row: Item) => ({ ...row, attuned: row.id === 'amulet' })));
      assert.equal(repaired.state.projection.sheet.abilities.CON.score, 19); assert.equal(repaired.state.inputs.play.hp, 3);
      assert.deepEqual(repaired.state.inputs.grants, stored.state.inputs.grants); assert.equal(repaired.state.inputs.notes, stored.state.inputs.notes);
      await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-sheet').click();
      assert.equal(await amulet.getAttribute('aria-pressed'), 'true');
      assert.equal(await sheet.getByRole('button', { name: messages.attune + 'ring', exact: true }).getAttribute('aria-pressed'), 'false');
    });
  }
}

function registerAttunementTransitionTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) {
    test('equipped attunement selection preserves old allocations and atomic stowing (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), key = 'attunement-locations-' + locale, messages = text(locale);
      const inventory = [
        item('old-ring', 'magic-item', 'ring-of-protection', 'stored', true),
        item('old-amulet', 'magic-item', 'amulet-of-health', 'carried', true),
        item('spare-ring', 'magic-item', 'ring-of-protection'),
      ], expected = structuredClone(inventory);
      const initial = await equipmentCharacter(f, key, inventory), { page, sheet, status, read } = await openBuilder(t, f, key, locale);
      if (locale === 'cs') { await sheet.locator('#dnd-tab-tools').click(); await sheet.getByRole('combobox', { name: messages.layout, exact: true }).selectOption('classic'); }
      await sheet.locator('#dnd-tab-sheet').click();
      const allocations = sheet.locator('[data-equipment-slot="attuned"]');
      assert.equal(await allocations.locator('.dse-equipment-slot').count(), 2);
      assert.equal(await allocations.locator('.dse-equipment-location').allTextContents().then(values => values.sort()).then(values => values.join('|')),
        (locale === 'cs' ? ['V batohu', 'Uložené'] : ['Carried', 'Stored']).sort().join('|'));
      assert.equal((await read()).state.projection.sheet.attunement.count, 2);
      const move = (id: string) => sheet.getByRole('combobox', { name: messages.move + id, exact: true });
      const stow = (id: string) => sheet.getByRole('button', { name: (locale === 'cs' ? 'Uložit a zrušit sladění: ' : 'Stow & unattune ') + id, exact: true });
      await move('old-ring').selectOption('carried'); await status.filter({ hasText: messages.saved }).waitFor();
      expected[0]!.location = 'carried'; assert.deepEqual((await read()).state.inputs.play.inventory, expected, 'Ordinary moves retain allocations');
      await move('old-ring').selectOption('equipped'); await status.filter({ hasText: messages.saved }).waitFor();
      const beforeStow = await read();
      await stow('old-ring').focus(); await stow('old-ring').press('Enter'); await status.filter({ hasText: messages.saved }).waitFor();
      expected[0]!.location = 'stored'; expected[0]!.attuned = false;
      const stowed = await read();
      assert.equal(stowed.revision, beforeStow.revision + 1);
      assert.deepEqual(stowed.state.inputs.play.inventory, expected);
      assert.equal(await move('old-ring').evaluate(node => node === document.activeElement), true, 'A disappearing action keeps focus on the same item');
      const spare = sheet.getByRole('button', { name: messages.attune + 'spare-ring', exact: true });
      assert.equal(stowed.evaluation.guidance.equipment['spare-ring'].canAttune, true);
      assert.equal(await spare.isDisabled(), true);
      assert.equal(await spare.getAttribute('aria-description'), locale === 'cs' ? 'Před sladěním si tento předmět vybavte.' : 'Equip this item before attuning it.');
      await sheet.getByRole('button', { name: '+ ' + messages.attuned, exact: true }).click();
      const dialog = sheet.getByRole('dialog');
      assert.equal(await dialog.getByRole('button', { name: 'old-ring', exact: true }).count(), 0);
      assert.equal(await dialog.getByRole('button', { name: 'spare-ring', exact: true }).count(), 0);
      await dialog.getByRole('button', { name: messages.close, exact: true }).click();
      await move('spare-ring').selectOption('equipped'); await status.filter({ hasText: messages.saved }).waitFor();
      expected[2]!.location = 'equipped';
      await sheet.getByRole('button', { name: '+ ' + messages.attuned, exact: true }).click();
      await dialog.getByRole('button', { name: 'spare-ring', exact: true }).press('Enter'); await status.filter({ hasText: messages.saved }).waitFor();
      expected[2]!.attuned = true; assert.deepEqual((await read()).state.inputs.play.inventory, expected);
      await page.setViewportSize({ width: locale === 'cs' ? 320 : 390, height: 1000 });
      await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
      await page.mouse.move(0, 0); await page.keyboard.press('Escape');
      await stow('spare-ring').focus(); await stow('spare-ring').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(f.output, 'attunement-stow-phone-' + locale + '.png') });
      await stow('spare-ring').press('Enter'); await status.filter({ hasText: messages.saved }).waitFor();
      expected[2]!.location = 'stored'; expected[2]!.attuned = false;
      assert.deepEqual((await read()).state.inputs.play.inventory, expected);
      await move('spare-ring').selectOption('equipped'); await status.filter({ hasText: messages.saved }).waitFor();
      await spare.click(); await status.filter({ hasText: messages.saved }).waitFor();
      await sheet.getByRole('spinbutton', { name: locale === 'cs' ? 'Množství: spare-ring' : 'spare-ring quantity', exact: true }).fill('0');
      await status.filter({ hasText: messages.saved }).waitFor();
      expected[2]!.quantity = 0; expected[2]!.location = 'carried';
      const saved = await read();
      assert.deepEqual(saved.state.inputs.play.inventory, expected);
      assert.equal(saved.state.projection.sheet.attunement.count, 1);
      assert.deepEqual(saved.state.inputs.grants, initial.state.inputs.grants); assert.equal(saved.state.inputs.notes, initial.state.inputs.notes);
      assert.equal(saved.state.inputs.play.hp, initial.state.inputs.play.hp);
      await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-sheet').click();
      assert.equal(await allocations.locator('.dse-equipment-slot').count(), 1);
      assert.equal(await allocations.getByRole('button', { name: 'old-amulet', exact: true }).count(), 1);
      assert.deepEqual((await read()).state, saved.state);
    });

    test('stow and unattune retries the complete transition once (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), key = 'attunement-retry-' + locale, messages = text(locale), delivered = locale === 'cs';
      const inventory = [item('ring', 'magic-item', 'ring-of-protection', 'equipped', true), item('amulet', 'magic-item', 'amulet-of-health', 'stored', true)];
      const initial = await equipmentCharacter(f, key, inventory), { page, sheet, status, read } = await openBuilder(t, f, key, locale);
      const requests: unknown[] = [];
      await page.route('**/services/call', async route => {
        const body = route.request().postDataJSON();
        if (body?.method !== 'save') { await route.continue(); return; }
        requests.push(body.params);
        if (requests.length === 1) { if (delivered) await route.fetch(); await route.abort('failed'); }
        else await route.continue();
      });
      await sheet.locator('#dnd-tab-sheet').click();
      await sheet.getByRole('button', { name: (locale === 'cs' ? 'Uložit a zrušit sladění: ' : 'Stow & unattune ') + 'ring', exact: true }).click();
      const retry = status.getByRole('button', { name: locale === 'cs' ? 'Zkusit znovu' : 'Retry', exact: true });
      await retry.waitFor();
      const expected = inventory.map(row => row.id === 'ring' ? { ...row, location: 'stored', attuned: false } : row);
      const uncertain = await read();
      assert.equal(uncertain.revision, initial.revision + (delivered ? 1 : 0));
      assert.deepEqual(uncertain.state.inputs.play.inventory, delivered ? expected : inventory, 'The worker commits both fields or neither');
      await retry.click(); await status.filter({ hasText: messages.saved }).waitFor();
      assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0], 'Exact operation, revision and complete inputs are retried');
      const saved = await read(); assert.equal(saved.revision, initial.revision + 1);
      assert.deepEqual(saved.state.inputs.play.inventory, expected);
      assert.equal(saved.state.projection.sheet.attunement.count, 1);
      assert.equal(await sheet.getByRole('button', { name: messages.attune + 'ring', exact: true }).isDisabled(), true);
      await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-sheet').click();
      assert.deepEqual((await read()).state, saved.state); frozenAttunements.set(key, saved);
    });
  }

  for (const conflict of [false, true]) test('stow and unattune preserves ' + (conflict ? 'conflicting inventory changes' : 'independent concurrent edits'), { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'attunement-concurrent-' + conflict;
    const initial = await equipmentCharacter(f, key, [item('ring', 'magic-item', 'ring-of-protection', 'equipped', true)]);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    let enter!: () => void, release!: () => void, hold = true;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    t.after(() => release());
    await page.route('**/services/call', async route => {
      if (hold && route.request().postDataJSON()?.method === 'save') { hold = false; enter(); await held; }
      await route.continue();
    });
    await sheet.locator('#dnd-tab-sheet').click();
    await sheet.getByRole('button', { name: 'Stow & unattune ring', exact: true }).click(); await entered;
    const remoteInputs = structuredClone(initial.state.inputs);
    if (conflict) remoteInputs.play.inventory[0].location = 'carried';
    else remoteInputs.play.currency.gp = 42;
    const remote = await save(f, key, remoteInputs, initial.revision, 'remote'); release();
    if (conflict) {
      await status.getByRole('button', { name: 'Reload saved character', exact: true }).waitFor();
      assert.deepEqual((await read()).state, remote.state, 'No partial local stow or unattune overwrites the remote item');
      page.once('dialog', dialog => dialog.accept());
      await status.getByRole('button', { name: 'Reload saved character', exact: true }).click();
      await sheet.getByRole('button', { name: 'Stow & unattune ring', exact: true }).waitFor();
      assert.equal(await sheet.getByRole('combobox', { name: 'Move ring', exact: true }).inputValue(), 'carried');
      assert.equal(await sheet.getByRole('button', { name: 'Attune ring', exact: true }).getAttribute('aria-pressed'), 'true');
    } else {
      await status.filter({ hasText: /^Saved$/ }).waitFor();
      const saved = await read(); assert.equal(saved.revision, initial.revision + 2);
      assert.deepEqual(saved.state.inputs.play.inventory, [{ ...initial.state.inputs.play.inventory[0], location: 'stored', attuned: false }]);
      assert.equal(saved.state.inputs.play.currency.gp, 42);
    }
  });
}

export async function verifyFrozenAttunements(t: TestContext, f: Fixture) {
  assert.equal(frozenAttunements.size, 2, 'Both equipment retry sessions must precede provider-free acceptance');
  for (const [key, expected] of frozenAttunements) {
    const locale = key.endsWith('-cs') ? 'cs' : 'en', { page, sheet, read } = await openBuilder(t, f, key, locale);
    const loaded = await read(); assert.equal(loaded.status, 'unavailable'); assert.deepEqual(loaded.state, expected.state);
    await sheet.locator('#dnd-tab-sheet').click();
    const allocations = sheet.locator('[data-equipment-slot="attuned"]');
    assert.equal(await allocations.locator('.dse-equipment-slot').count(), 1);
    assert.equal(await allocations.getByRole('button', { name: 'amulet', exact: true }).count(), 1);
    assert.equal(await allocations.locator('.dse-equipment-location').innerText(), locale === 'cs' ? 'Uložené' : 'Stored');
    assert.equal(await sheet.locator('.dse-attunement-actions').count(), 0);
    assert.equal(await sheet.getByRole('button', { name: '+ ' + text(locale).attuned, exact: true }).count(), 0);
    await sheet.locator('#dnd-tab-tools').click();
    assert.deepEqual((await exported(page, sheet, locale)).inputs, expected.state.inputs);
    const popup = await printOutput(page, sheet, locale);
    const body = await popup.locator('body').innerText();
    for (const row of expected.state.inputs.play.inventory as Item[]) { assert.ok(body.includes(row.name)); assert.ok(body.includes(row.notes)); }
    await popup.close();
    assert.deepEqual((await read()).state, expected.state, 'Reading, printing and export never rewrite allocations');
    await page.context().close();
  }
}
