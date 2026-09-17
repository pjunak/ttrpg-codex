import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';

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
