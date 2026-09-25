import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Fixture, createCharacterRecord, openBuilder, save } from './installed-character-builder-fixture.mts';
import { complete as completeMulticlass } from './installed-character-multiclass-fixture.mts';
import { spellCharacter } from './installed-character-spell-fixture.mts';
import { exported, printOutput, review as reviewImport } from './installed-character-output-fixture.mts';
import { jsonResponse, installReviewedPackage } from './installed-graph-fixture.mts';
import { replacementImportPackage } from './installed-import-fixture.mts';

type Row = Record<string, any>;
type Source = { addonId: string; setId: string; id: string; enabled: boolean };
const accepted = new Map<string, Row>();
const authored = (inputs: Row): Row => { const copy = structuredClone(inputs); delete copy.play.asOf; return copy; };

async function setSources(f: Fixture, sources: Source[]) {
  const policy = await jsonResponse(await f.admin.get('/api/admin/rules-policy'));
  await jsonResponse(await f.admin.post('/api/admin/rules-policy', {
    headers: { 'X-Codex-CSRF': f.csrf }, data: {
      expectedRevision: policy.revision, expectedGraphRevision: policy.graphRevision,
      enabled: sources.map(({ addonId, setId, id }) => ({ addonId, setId, id })),
    },
  }));
}
async function command(f: Fixture, key: string, stored: Row, suffix: string, params: Row) {
  const next = await f.call('save', { key, operationId: key + '-' + suffix, expectedRevision: stored.revision,
    summary: 'Multiclass provider session: ' + suffix, ...params });
  assert.equal(next.status, 'ready', JSON.stringify({ status: next.status, message: next.message, issues: next.evaluation?.issues }));
  return next;
}
async function builtSession(f: Fixture, key: string) {
  let stored = await spellCharacter(f, key, 2), input = structuredClone(stored.state.inputs);
  const levels = (classId: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: classId + '-' + i, classId }));
  input.build.baseScores = { STR: 12, DEX: 14, CON: 10, INT: 15, WIS: 8, CHA: 13 };
  input.build.choices = input.build.choices.filter((row: Row) => row.id !== 'skills:fighter');
  input.build.choices.push({ id: 'skills:fighter', slot: 0, value: 'history' }, { id: 'skills:fighter', slot: 1, value: 'perception' });
  input.build.levels = [...levels('fighter', 4), ...levels('warlock', 1), ...levels('fighter', 7).slice(4), ...levels('wizard', 3)];
  input.build.subclasses = { fighter: 'eldritch-knight', wizard: 'evoker' };
  input.play.currency = { gp: 37, sp: 8 }; input.play.hp = 3; input.play.temporaryHp = 2;
  input.notes = 'Keep the entire multiclass session';
  stored = await completeMulticlass(f, key, input, stored.revision, 'level-eleven');
  assert.deepEqual(stored.evaluation.sheet.spellcasting.slots.filter((n: number) => n > 0), [4, 3, 2]);
  assert.deepEqual(stored.state.inputs.build.spells.castingAbilities, input.build.spells.castingAbilities);
  stored = await command(f, key, stored, 'source-feat', { operation: 'grant', grant: {
    id: '', actorId: '', grantedAt: '', active: true, name: 'Source training', reason: 'Reviewed optional-book training',
    effectiveLevel: 1, condition: 'always', effects: [], waivers: [], feat: { kind: 'feat', id: 'spellfire-spark' },
  } });
  input = structuredClone(stored.state.inputs);
  for (const choice of stored.evaluation.spellOptions.castingAbilityChoices) input.build.spells.castingAbilities[choice.key] ??= 'INT';
  const resource = stored.evaluation.sheet.resources.find((row: Row) => row.name === 'Spellfire Flame');
  assert.ok(resource, 'The session must depend on a selected optional-book resource');
  input.play.resourceUses[resource.key] = 1;
  stored = await save(f, key, input, stored.revision, 'source-choice');
  assert.equal(stored.evaluation.ready, true, JSON.stringify(stored.evaluation.issues));
  return stored;
}

export function registerMulticlassProviderTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en', 'cs']) test('whole multiclass session survives selected-source loss and incompatible rules (' + locale + ')',
    { skip: !enabled, timeout: 120000 }, async t => {
      const f = fixture(), key = 'multiclass-provider-' + locale, cs = locale === 'cs';
      const start = performance.now();
      const checkpoint = (phase: string) => t.diagnostic(phase + ': ' + Math.round(performance.now() - start) + ' ms');
      let stored = await builtSession(f, key);
      checkpoint('Character prepared');
      t.diagnostic('Saved multiclass state bytes: ' + Buffer.byteLength(JSON.stringify(stored.state)));
      const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
      const saved = cs ? /^Uloženo$/ : /^Saved$/;
      const selectTab = async (tab: string) => {
        await sheet.locator('#dnd-tab-' + tab).click();
        await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
      };
      // Observe each real transition instead of reloading every catalog and
      // hiding whether the open character actually responds to changed rules.
      const transition = async (change: () => Promise<unknown>, state: 'changed' | 'connected' | 'unavailable') => {
        const refreshed = page.waitForResponse(async response => {
          if (!response.url().endsWith('/services/call') || !response.ok()) return false;
          const request = response.request().postDataJSON();
          if (request?.method !== 'load' || request.params?.key !== key) return false;
          const result = (await response.json()).result;
          return state === 'unavailable' ? result?.status === 'unavailable' :
            result?.status === 'ready' && Boolean(result.rulesChanged) === (state === 'changed');
        });
        const [response] = await Promise.all([refreshed, change()]);
        await selectTab('tools');
        const message = state === 'unavailable'
          ? cs ? 'Kompatibilní pravidla nejsou dostupná. Uložené hodnoty a poznámky jsou nadále přístupné.' : 'Compatible rules are unavailable. Saved values and notes remain accessible.'
          : state === 'changed'
            ? cs ? 'Pravidla se změnila. Pro další úpravy je nejprve přijměte.' : 'The rules changed. Adopt them to continue editing.'
            : cs ? 'Pravidla jsou připojena.' : 'Rules are connected.';
        await sheet.getByText(message, { exact: true }).waitFor();
        return (await response.json()).result as Row;
      };
      if (cs) {
        await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel('Rozložení deníku', { exact: true }).selectOption('classic');
        await page.setViewportSize({ width: 390, height: 1000 }); await page.addStyleTag({ content: 'html {font-size:200% !important;}' });
      }
      await sheet.locator('#dnd-tab-spells').click();
      for (const [classId, spell, slot] of [['Fighter', 'Shield', 'pact-slot'], ['Warlock', 'Hellish Rebuke', 'slot-1'], ['Wizard', 'Shield', 'slot-3']]) {
        const group = sheet.getByRole('heading', { name: cs ? 'Kouzla: ' + classId : classId + ' spells', exact: true }).locator('..');
        const row = group.locator('.dnd-spell-row[data-spell-name="' + spell + '"]').first();
        await row.getByLabel(cs ? 'Použít pozici' : 'Spend slot', { exact: true }).selectOption(slot!);
        await row.getByRole('button', { name: cs ? 'Seslat' : 'Cast', exact: true }).focus();
        await page.keyboard.press('Enter'); await status.filter({ hasText: saved }).waitFor();
      }
      const grantKeys: string[] = [];
      for (const spell of stored.evaluation.spellOptions.granted.filter((row: Row) => row.ref === 'detect-magic')) {
        const slot = spell.slots.find((key: string) => key.startsWith('charge:')); grantKeys.push(slot);
        const row = sheet.locator('[data-spell-grant="' + spell.key + '"]');
        await row.getByLabel(cs ? 'Zdroj získaného seslání' : 'Granted cast resource', { exact: true }).selectOption(slot);
        await row.getByRole('button', { name: cs ? 'Seslat získané kouzlo' : 'Cast granted spell', exact: true }).click();
        await status.filter({ hasText: saved }).waitFor();
      }
      stored = await read();
      for (const key of ['pact-slot', 'slot-1', 'slot-3', ...grantKeys]) assert.equal(stored.state.inputs.play.resourceUses[key], 1);
      checkpoint('Casts saved');
      const beforeAmend = structuredClone(stored), grant = structuredClone(stored.state.inputs.grants[0]);
      grant.reason = 'Preserve acquired spells while adding speed'; grant.effects = [{ target: 'speed', mode: 'add', value: 5 }];
      stored = await command(f, key, stored, 'amend', { operation: 'amend-grant', grantId: grant.id, grant });
      assert.deepEqual(stored.state.inputs.build, beforeAmend.state.inputs.build);
      assert.deepEqual(authored(stored.state.inputs).play, authored(beforeAmend.state.inputs).play);
      assert.equal(stored.evaluation.sheet.derived.speed, beforeAmend.evaluation.sheet.derived.speed + 5);

      const policy = await jsonResponse(await f.admin.get('/api/admin/rules-policy')), sources = (policy.sources as Source[]).filter(row => row.enabled);
      assert.ok(stored.state.projection.evidence.some((row: Row) => row.book === 'hof' && row.reference.id === 'spellfire-spark'));
      let restoreSources = true;
      t.after(async () => { if (restoreSources) await setSources(f, sources); });
      let changed = await transition(() => setSources(f, sources.filter(row => row.id !== 'hof')), 'changed');
      assert.equal(changed.rulesChanged, true); assert.deepEqual(changed.state, stored.state); assert.equal(changed.revision, stored.revision);
      assert.ok(changed.evaluation.issues.some((row: Row) => row.severity === 'blocker' && JSON.stringify(row).includes('spellfire-spark')));
      const denied = await f.call('save', { key, operation: 'adopt-rules', operationId: key + '-deny-missing-source',
        summary: 'Cannot silently erase selected source choices', expectedRevision: stored.revision, adoptRules: true });
      assert.equal(denied.status, 'invalid'); assert.deepEqual((await read()).state, stored.state);
      await selectTab('sheet');
      assert.equal(await sheet.getByLabel(cs ? 'Aktuální životy' : 'Current HP', { exact: true }).isDisabled(), true);

      changed = await transition(() => setSources(f, sources), 'connected'); restoreSources = false;
      assert.deepEqual(changed.state, stored.state);
      assert.equal(changed.rulesChanged, false, 'Restoring the exact source set restores its identity without a write');
      assert.equal(changed.revision, stored.revision);
      assert.equal(await sheet.getByRole('button', { name: cs ? 'Použít aktuální pravidla' : 'Adopt current rules', exact: true }).count(), 0);

      checkpoint('Selected sources restored');
      const archive = await readFile(resolve(process.env.CODEX_ENGINE_ZIP!));
      let restoreProvider = true;
      t.after(async () => { if (restoreProvider) await installReviewedPackage(f.admin, f.csrf, 'dnd-engine', archive, []); });
      const consumer = await jsonResponse(await f.admin.get('/api/admin/addons/dnd-sheets'));
      const base = '/api/addons/dnd-sheets/generations/' + consumer.state.activeGenerationId + '/services';
      const connection = await jsonResponse(await f.admin.post(base + '/connect', { headers: { 'X-Codex-CSRF': f.csrf },
        data: { contractVersion: 'addon-service-connect.v1', contract: 'dnd5e.rules-engine', range: '^4.0.0', cardinality: 'one' } }));
      const old = connection.providers[0]; assert.ok(old);
      const replacement = replacementImportPackage(archive, '4.0.1', (files, manifest) => {
        if (cs) {
          manifest.services.provides[0].version = '5.0.0';
          const service = JSON.parse(files['contracts/rules-engine.service.json']!.toString());
          service.version = '5.0.0'; files['contracts/rules-engine.service.json'] = JSON.stringify(service);
        } else {
          const schema = JSON.parse(files['contracts/character.response.schema.json']!.toString());
          schema.properties.contractVersion.const = 'rules-character-response.v99';
          files['contracts/character.response.schema.json'] = JSON.stringify(schema);
        }
      });
      await transition(() => installReviewedPackage(f.admin, f.csrf, 'dnd-engine', replacement, []), 'unavailable');
      checkpoint('Incompatible provider installed');
      const stale = await f.admin.post(base + '/call', { headers: { 'X-Codex-CSRF': f.csrf }, data: {
        contractVersion: 'addon-service-call.v1', contract: 'dnd5e.rules-engine', providerAddonId: old.addonId,
        providerVersion: old.contractVersion, providerGeneration: old.generation, bindingRevision: old.bindingRevision,
        method: 'evaluate-character', params: { contractVersion: 'rules-character.v1', inputs: stored.state.inputs }, deadlineMs: 30000,
      } });
      assert.equal(stale.status(), 409, await stale.text());
      const frozen = await read(); assert.equal(frozen.status, 'unavailable'); assert.deepEqual(frozen.state, stored.state);
      assert.equal(frozen.revision, stored.revision);
      const blocked = await f.call('save', { key, operation: 'play', operationId: key + '-blocked-rest', summary: 'No compatible rules',
        expectedRevision: stored.revision, change: { operation: 'rest', rest: 'long' } });
      assert.equal(blocked.status, 'unavailable'); assert.deepEqual((await read()).state, stored.state);
      await selectTab('tools');
      assert.deepEqual((await exported(page, sheet, locale)).inputs, stored.state.inputs);
      const popup = await printOutput(page, sheet, locale), printed = await popup.locator('body').innerText();
      for (const name of ['Fighter', 'Warlock', 'Wizard', 'Spellfire Spark', 'Detect Magic', 'Retain notes']) assert.ok(printed.includes(name), name);
      await popup.close(); await sheet.getByRole('dialog').getByRole('button', { name: cs ? 'Zavřít' : 'Close', exact: true }).click();
      if (cs) await page.addStyleTag({ content: 'html {font-size:200% !important;}' });
      await sheet.locator('#dnd-tab-sheet').click();
      await sheet.getByLabel(cs ? 'Aktuální životy' : 'Current HP', { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(f.output, 'multiclass-frozen-' + locale + '.png') });
      assert.deepEqual((await read()).state, stored.state);

      checkpoint('Frozen session checked');
      const restored = await transition(() => installReviewedPackage(f.admin, f.csrf, 'dnd-engine', archive, []), 'connected'); restoreProvider = false;
      checkpoint('Original provider restored');
      assert.equal(restored.status, 'ready'); assert.equal(restored.rulesChanged, false);
      assert.deepEqual(restored.state, stored.state); assert.equal(restored.revision, stored.revision);
      await selectTab('combat');
      await sheet.getByRole('button', { name: cs ? 'Krátký odpočinek' : 'Short rest', exact: true }).click();
      await status.filter({ hasText: saved }).waitFor(); stored = await read();
      assert.equal(stored.state.inputs.play.resourceUses['pact-slot'], 0);
      for (const key of ['slot-1', 'slot-3', ...grantKeys]) assert.equal(stored.state.inputs.play.resourceUses[key], 1);
      const spentSource = stored.evaluation.sheet.resources.find((row: Row) => row.name === 'Spellfire Flame');
      assert.equal(stored.state.inputs.play.resourceUses[spentSource.key], 1);
      checkpoint('Short rest saved');
      const beforeLevel = structuredClone(stored), input = structuredClone(stored.state.inputs);
      input.build.levels.push({ id: 'wizard-four', classId: 'wizard' });
      input.build.spells.spellbook.wizard.push('see-invisibility', 'web');
      stored = await completeMulticlass(f, key, input, stored.revision, 'level-twelve');
      assert.equal(stored.state.inputs.play.hp, beforeLevel.state.inputs.play.hp);
      assert.deepEqual(stored.state.inputs.play.resourceUses, beforeLevel.state.inputs.play.resourceUses);
      assert.equal(stored.state.inputs.build.levels.length, 12);
      checkpoint('Level twelve saved');
      const beforeRevoke = structuredClone(stored);
      stored = await command(f, key, stored, 'revoke', { operation: 'revoke-grant', grantId: grant.id });
      const surviving = beforeRevoke.evaluation.spellOptions.granted.find((row: Row) => row.ref === 'detect-magic' && row.source.acquisition.id !== 'grant:' + grant.id);
      const survivingKey = surviving.slots.find((slot: string) => slot.startsWith('charge:'));
      assert.equal(stored.state.inputs.play.resourceUses[survivingKey], 1, 'The surviving acquisition retains its spent cast');
      assert.equal(stored.state.inputs.grants.some((row: Row) => row.id === grant.id), false);
      assert.equal(stored.evaluation.sheet.derived.speed, beforeRevoke.evaluation.sheet.derived.speed - 5);
      assert.deepEqual(stored.state.inputs.play.inventory, beforeRevoke.state.inputs.play.inventory);
      assert.equal(stored.state.inputs.notes, beforeRevoke.state.inputs.notes);
      await page.reload(); await page.locator('#character-view-addons').click();
      await selectTab('sheet'); assert.deepEqual((await read()).state, stored.state);
      accepted.set(key, structuredClone(stored.state));
      checkpoint('Restored session accepted');
    });

  for (const locale of ['en', 'cs']) test('first character import labels complete review groups (' + locale + ')',
    { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), cs = locale === 'cs', key = 'first-import-' + locale;
      const source = await spellCharacter(f, key + '-source', 1);
      const original = await openBuilder(t, f, key + '-source', locale);
      await original.sheet.locator('#dnd-tab-tools').click();
      const envelope = await exported(original.page, original.sheet, locale);
      await original.page.context().close();
      const blank = await createCharacterRecord(f, key); assert.equal(blank.revision, 0); assert.ok(!blank.state);
      const { page, sheet, read } = await openBuilder(t, f, key, locale);
      await sheet.locator('#dnd-tab-tools').click();
      if (cs) {
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.addStyleTag({ content: 'html {font-size:200% !important;}' });
      }
      await reviewImport(sheet, locale, envelope, true);
      const dialog = sheet.getByRole('dialog'), summaries = await dialog.locator('summary').allTextContents();
      for (const name of cs ? ['Postava', 'Pravidla', 'Vypočtené hodnoty'] : ['Character', 'Rules', 'Calculated values']) {
        assert.equal(summaries.filter(text => text.trim() === name).length, 2, 'Root group and complete change need meaningful labels: ' + name);
      }
      assert.ok(summaries.every(text => text.trim() && !text.trim().startsWith('›')), JSON.stringify(summaries));
      for (const summary of await dialog.locator('details details > summary').all()) await summary.click();
      const text = await dialog.innerText();
      for (const item of source.state.inputs.play.inventory) {
        assert.ok(text.includes(item.name)); assert.ok(text.includes(item.notes));
      }
      assert.ok(text.includes(source.state.inputs.notes));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal((await read()).revision, 0, 'Review must not write the initially empty sheet');
      await dialog.getByRole('button', { name: cs ? 'Zavřít' : 'Close', exact: true }).click();
      const cancelled = await read(); assert.equal(cancelled.revision, 0); assert.ok(!cancelled.state);
    });
}

export async function verifyFrozenMulticlassSessions(t: TestContext, f: Fixture) {
  assert.equal(accepted.size, 2, 'Both multiclass sessions must precede provider-free acceptance');
  for (const [key, state] of accepted) {
    const locale = key.endsWith('-cs') ? 'cs' : 'en', frozen = await f.call('load', { key });
    assert.equal(frozen.status, 'unavailable'); assert.deepEqual(frozen.state, state);
    const { page, sheet } = await openBuilder(t, f, key, locale);
    try {
      await sheet.locator('#dnd-tab-tools').click();
      const portable = await exported(page, sheet, locale);
      assert.deepEqual(portable.inputs, state.inputs); assert.deepEqual(portable.savedProjection, state.projection);
      const popup = await printOutput(page, sheet, locale);
      for (const name of ['Fighter', 'Warlock', 'Wizard', 'Spellfire Spark', 'Detect Magic']) assert.ok((await popup.locator('body').innerText()).includes(name), name);
      await popup.close(); assert.deepEqual((await f.call('load', { key })).state, state);
    } finally { await page.context().close(); }
  }
}
