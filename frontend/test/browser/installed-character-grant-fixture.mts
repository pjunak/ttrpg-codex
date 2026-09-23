import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { choose, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { spellCharacter } from './installed-character-spell-fixture.mts';
import { jsonResponse } from './installed-graph-fixture.mts';
import { changeUnusedSource } from './installed-character-rules-recovery-fixture.mts';

type Row = Record<string, any>;
export function registerCharacterGrantTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) test('amended grants preserve effect focus, item ownership and spent play through rules reload (' + locale + ')',
    { skip: !enabled, timeout: 90000 }, async t => {
      const f = fixture(), key = 'grant-amend-' + locale, cs = locale === 'cs';
      let stored = await spellCharacter(f, key, 2);
      const spells = stored.evaluation.spellOptions.granted.filter((row: Row) => row.ref === 'detect-magic');
      for (const [index, spell] of spells.entries()) {
        stored = await f.call('save', { key, operation: 'play', operationId: key + '-cast-' + index,
          expectedRevision: stored.revision, summary: 'Spend a separate granted cast',
          change: { operation: 'cast-granted-spell', key: spell.key, slot: spell.slots.find((slot: string) => slot.startsWith('charge:')) } });
        assert.equal(stored.status, 'ready');
      }
      const inputs = structuredClone(stored.state.inputs);
      inputs.play.inventory.push(...['old', 'new'].map(id => ({ id, name: id + ' charm', quantity: 1, location: 'carried', attuned: false, acquisition: 'Quest', notes: 'Keep item notes' })));
      stored = await save(f, key, inputs, stored.revision, 'items');
      const initial = structuredClone(stored), firstID = stored.state.inputs.grants[0].id;
      const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
      const text = cs ? {
        amend: 'Upravit dar: wizard training', reason: 'Důvod úpravy', add: 'Přidat účinek', remove: 'Odebrat účinek',
        effect: 'Účinek', amount: 'Množství', applies: 'Platí pro', item: 'Konkrétní předmět',
        feat: 'Získaná odbornost (nepovinné)', apply: 'Použít dar PJ', saved: /^Uloženo$/,
        adopt: 'Použít aktuální pravidla', revoke: 'Odvolat dar: wizard training',
      } : {
        amend: 'Amend wizard training', reason: 'Reason for amendment', add: 'Add effect', remove: 'Remove effect',
        effect: 'Effect', amount: 'Amount', applies: 'Applies to', item: 'Item instance',
        feat: 'Granted feat (optional)', apply: 'Apply DM grant', saved: /^Saved$/,
        adopt: 'Adopt current rules', revoke: 'Revoke wizard training',
      };
      if (cs) {
        await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel('Rozložení deníku', { exact: true }).selectOption('classic');
        await sheet.locator('#dnd-tab-builder').click();
      }
      await sheet.locator('#dnd-builder-tab-dm-given').click();
      await sheet.getByRole('button', { name: text.amend, exact: true }).click();
      const dialog = sheet.getByRole('dialog'), effects = dialog.locator('.character-panel .character-panel');
      await dialog.getByLabel(text.reason, { exact: true }).fill('Amend mechanics and item');
      for (let index = 0; index < 2; index++) {
        await dialog.getByRole('button', { name: text.add, exact: true }).click();
        assert.equal(await effects.nth(index).getByLabel(text.effect, { exact: true }).evaluate(node => node === document.activeElement), true, 'Adding an effect must focus its target');
      }
      const second = effects.nth(1).getByLabel(text.effect, { exact: true });
      await second.focus(); await second.selectOption('abilityScore');
      assert.equal(await second.evaluate(node => node === document.activeElement), true, 'Changing a target must retain that effect control');
      await effects.nth(1).getByLabel(text.amount, { exact: true }).fill('1');
      await dialog.getByRole('button', { name: text.apply, exact: true }).click();
      assert.equal(await dialog.isVisible(), true, 'An incomplete effect must stay editable');
      assert.equal(await effects.nth(1).getByLabel(text.applies, { exact: true }).evaluate(node => node === document.activeElement), true);
      assert.equal((await read()).revision, initial.revision, 'Incomplete effects must not submit a command');
      await effects.nth(1).getByLabel(text.applies, { exact: true }).selectOption('STR');
      await effects.nth(0).getByRole('button', { name: text.remove, exact: true }).click();
      assert.equal(await effects.first().getByLabel(text.effect, { exact: true }).evaluate(node => node === document.activeElement), true);
      assert.equal(await effects.first().getByLabel(text.amount, { exact: true }).inputValue(), '1');
      await dialog.getByRole('button', { name: text.add, exact: true }).click();
      await effects.nth(1).getByLabel(text.effect, { exact: true }).selectOption('speed');
      await effects.nth(1).getByLabel(text.amount, { exact: true }).fill('5');
      assert.equal(await dialog.getByRole('combobox', { name: text.feat, exact: true }).inputValue(), 'Magic Initiate');
      await choose(dialog, text.item, 'old charm');
      await page.setViewportSize({ width: 390, height: 1000 }); await page.addStyleTag({ content: 'html { font-size:200% !important; }' });
      assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'The enlarged grant editor must fit the phone');
      assert.equal(await effects.getByRole('button', { name: text.remove, exact: true }).evaluateAll(buttons => buttons.every(button => {
        const range = document.createRange(); range.selectNodeContents(button);
        return range.getBoundingClientRect().height <= 2 * Number.parseFloat(getComputedStyle(button).lineHeight) + 1;
      })), true, 'Enlarged effect actions must wrap between words, without splitting each word');
      await effects.first().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(f.output, 'grant-editor-phone-' + locale + '.png') });
      assert.equal(await effects.evaluateAll(nodes => nodes.every(node => {
        const target = node.querySelector('select')!, heading = node.querySelector('h3')!;
        return heading.textContent!.includes(target.selectedOptions[0]!.text) && heading.scrollWidth <= heading.clientWidth;
      })), true, 'Each effect must expose its full selected name in a wrapping heading');
      await dialog.getByRole('button', { name: text.apply, exact: true }).click();
      await status.filter({ hasText: text.saved }).waitFor();
      stored = await read(); assert.equal(stored.revision, initial.revision + 1);
      assert.deepEqual(stored.state.inputs.grants.map((row: Row) => row.id), initial.state.inputs.grants.map((row: Row) => row.id));
      assert.deepEqual(stored.state.inputs.grants[1], initial.state.inputs.grants[1]);
      assert.deepEqual(stored.state.inputs.build, initial.state.inputs.build);
      assert.equal(stored.evaluation.sheet.abilities.STR.score, initial.evaluation.sheet.abilities.STR.score + 1);
      assert.equal(stored.evaluation.sheet.derived.speed, initial.evaluation.sheet.derived.speed + 5);
      assert.deepEqual(stored.state.inputs.play.resourceUses, initial.state.inputs.play.resourceUses);
      assert.equal(stored.state.inputs.play.inventory.find((row: Row) => row.id === 'old').grantId, firstID);

      // Rebind the same acquisition; its selected spells and spent uses retain their keys.
      await sheet.getByRole('button', { name: text.amend, exact: true }).click();
      await dialog.getByLabel(text.reason, { exact: true }).fill('Move mechanics to new charm');
      await choose(dialog, text.item, 'new charm');
      await dialog.getByRole('button', { name: text.apply, exact: true }).click();
      await status.filter({ hasText: text.saved }).waitFor(); stored = await read();
      assert.equal(stored.state.inputs.play.inventory.find((row: Row) => row.id === 'old').grantId, undefined);
      assert.equal(stored.state.inputs.play.inventory.find((row: Row) => row.id === 'new').grantId, firstID);
      assert.deepEqual(stored.state.inputs.play.resourceUses, initial.state.inputs.play.resourceUses);
      const beforeReload = structuredClone(stored);
      const provider = await jsonResponse(await f.admin.get('/api/admin/addons/dnd-engine'));
      await jsonResponse(await f.admin.post('/api/admin/addons/dnd-engine/reload', {
        headers: { 'X-Codex-CSRF': f.csrf }, data: { expectedStateRevision: provider.state.revision },
      }));
      const restarted = await read();
      assert.equal(restarted.status, 'ready'); assert.equal(restarted.rulesChanged, false, 'Restarting the same package retains its rules identity');
      assert.deepEqual(restarted.state, beforeReload.state);
      await changeUnusedSource(t, f, beforeReload);
      await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-tools').click();
      await sheet.getByRole('button', { name: text.adopt, exact: true }).waitFor();
      const changed = await read(); assert.equal(changed.rulesChanged, true);
      assert.equal(changed.revision, beforeReload.revision); assert.deepEqual(changed.state, beforeReload.state, 'Reload alone must not rewrite the saved character');
      await sheet.getByRole('button', { name: text.adopt, exact: true }).click();
      await status.filter({ hasText: text.saved }).waitFor(); stored = await read();
      const normalized = structuredClone(stored.state.inputs); normalized.play.asOf = beforeReload.state.inputs.play.asOf;
      assert.deepEqual(normalized, beforeReload.state.inputs, 'Explicit adoption preserves authored play and grant identity');
      assert.equal(stored.rulesChanged, false);

      await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-dm-given').click();
      await sheet.getByRole('button', { name: text.revoke, exact: true }).click();
      await status.filter({ hasText: text.saved }).waitFor(); stored = await read();
      assert.deepEqual(stored.state.inputs.grants, [initial.state.inputs.grants[1]]);
      assert.equal(stored.state.inputs.play.inventory.find((row: Row) => row.id === 'new').grantId, undefined);
      const sibling = spells.find((row: Row) => row.source.acquisition.id === 'grant:' + initial.state.inputs.grants[1].id);
      const siblingKey = sibling.slots.find((slot: string) => slot.startsWith('charge:'));
      assert.equal(stored.state.inputs.play.resourceUses[siblingKey], 1, 'Revocation must not refresh another grant');
      assert.deepEqual(stored.state.inputs.play.inventory, initial.state.inputs.play.inventory);
      assert.equal(stored.state.inputs.notes, initial.state.inputs.notes);
      assert.equal(stored.state.inputs.play.hp, initial.state.inputs.play.hp);
      assert.equal(stored.evaluation.sheet.abilities.STR.score, initial.evaluation.sheet.abilities.STR.score);
      assert.equal(stored.evaluation.sheet.derived.speed, initial.evaluation.sheet.derived.speed);
      await page.reload(); await page.locator('#character-view-addons').click();
      assert.deepEqual((await read()).state, stored.state, 'The final amended session survives reopening');
    });
}
