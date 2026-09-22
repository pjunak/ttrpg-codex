import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import { createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { unloadBlocked } from './installed-planner-navigation-fixture.mts';

export async function readyCharacter(f: Fixture, key: string) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = 'dwarf'; inputs.build.background = 'soldier';
  inputs.build.levels = [{ id: 'one', classId: 'fighter' }]; inputs.build.choices = [];
  for (let round = 0; round < 6; round++) {
    const { evaluation } = await f.call('evaluate', { key, operation: 'build', inputs, expectedRevision: 0 });
    if (evaluation.ready) break;
    for (const choice of [...evaluation.plan.creationChoices, ...evaluation.plan.creationAbilityChoices, ...evaluation.plan.classChoices]) {
      if (inputs.build.choices.some((row: { id: string }) => row.id === choice.id)) continue;
      if (choice.kind === 'abilityBudget') {
        let remaining = Number(choice.budget); const value: Record<string, number> = {};
        for (const ability of choice.eligible) { const amount = Math.min(remaining, Number(choice.perAbilityMax)); if (amount) value[ability] = amount; remaining -= amount; }
        inputs.build.choices.push({ id: choice.id, slot: 0, value });
      } else {
        const options = evaluation.guidance.choices[choice.id]?.options ?? [];
        for (let slot = 0; slot < Number(choice.count ?? 1) && options[slot]; slot++) inputs.build.choices.push({ id: choice.id, slot, value: options[slot].id });
      }
    }
  }
  const built = await save(f, key, inputs, 0, 'seed');
  assert.equal(built.evaluation.ready, true, JSON.stringify(built.evaluation.issues));
  const rested = await f.call('save', { key, operation: 'play', operationId: key + '-rest', expectedRevision: built.revision, summary: 'Start with full HP', change: { operation: 'rest', rest: 'long' } });
  assert.equal(rested.status, 'ready'); assert.ok(rested.state.inputs.play.hp > 2);
  return rested;
}

async function damage(sheet: Locator) {
  await sheet.locator('#dnd-tab-sheet').click();
  await sheet.getByRole('button', { name: 'Damage', exact: true }).click();
  await sheet.locator('.dse-hp-adjust').getByLabel('Amount', { exact: true }).fill('2');
  await sheet.locator('.dse-hp-adjust').getByRole('button', { name: 'Damage', exact: true }).click();
}

async function loseReply(page: Page, method: string, delivered: boolean, operation?: string) {
  const attempts: Record<string, any>[] = [];
  await page.route('**/services/call', async route => {
    const body = route.request().postDataJSON();
    if (body?.method !== method || operation && body.params.operation !== operation) { await route.continue(); return; }
    attempts.push(body.params);
    if (attempts.length === 1) {
      if (delivered) assert.equal((await route.fetch()).ok(), true);
      await route.abort('failed');
    } else await route.continue();
  });
  return attempts;
}

async function retry(page: Page, status: Locator, attempts: unknown[], locale = 'en') {
  assert.equal(await status.getAttribute('data-ui-state'), 'error');
  assert.equal(await unloadBlocked(page), true);
  assert.equal(await status.evaluate(node => node === document.activeElement), true, 'Recovery must receive keyboard focus');
  const action = status.getByRole('button', { name: locale === 'cs' ? 'Zkusit znovu' : 'Retry', exact: true });
  await action.focus(); await action.press('Enter');
  await status.filter({ hasText: locale === 'cs' ? /^Uloženo$/ : /^Saved$/ }).waitFor();
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], attempts[0], 'Retry must preserve the whole command, ID, revision and review token');
  assert.equal(await unloadBlocked(page), false);
}

export function registerCharacterCommandTests(enabled: boolean, fixture: () => Fixture) {
  for (const delivered of [false, true]) test('uncertain play command retries once ' + (delivered ? 'after a lost acknowledgment' : 'after failed delivery'), { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'command-play-' + delivered, initial = await readyCharacter(f, key);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    const attempts = await loseReply(page, 'save', delivered, 'play');
    await damage(sheet); await status.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal((await read()).revision, initial.revision + (delivered ? 1 : 0));
    assert.equal(await sheet.getByRole('button', { name: 'Damage', exact: true }).isDisabled(), true);
    assert.equal(await sheet.getByLabel('Current HP', { exact: true }).isDisabled(), true);
    await retry(page, status, attempts);
    const saved = await read();
    assert.equal(saved.revision, initial.revision + 1); assert.equal(saved.state.inputs.play.hp, initial.state.inputs.play.hp - 2);
    await sheet.getByRole('button', { name: 'Damage', exact: true }).waitFor();
    assert.equal(await sheet.getByRole('button', { name: 'Damage', exact: true }).isEnabled(), true, 'Acknowledgment refresh must restore current play guidance');
    assert.equal(await sheet.getByLabel('Current HP', { exact: true }).inputValue(), String(saved.state.inputs.play.hp));
  });

  for (const locale of ['en', 'cs']) test('uncertain grant, amendment and revocation retain one action (' + locale + ')', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'command-grant-' + locale, inputs = await createCharacter(f, key);
    let previous = await save(f, key, inputs, 0, 'seed');
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    const cs = locale === 'cs', text = cs
      ? { give: 'Přidat dar od PJ', name: 'Název', reason: 'Důvod', amendReason: 'Důvod úpravy', apply: 'Použít dar PJ', amend: 'Upravit dar: Reward', revoke: 'Odvolat dar: Reward', retry: 'Zkusit znovu' }
      : { give: 'Give a DM grant', name: 'Name', reason: 'Reason', amendReason: 'Reason for amendment', apply: 'Apply DM grant', amend: 'Amend Reward', revoke: 'Revoke Reward', retry: 'Retry' };
    if (cs) {
      await sheet.locator('#dnd-tab-tools').click(); await sheet.getByLabel('Rozložení deníku').selectOption('classic');
      await sheet.locator('#dnd-tab-builder').click();
    }
    await sheet.locator('#dnd-builder-tab-dm-given').click();
    for (const operation of ['grant', 'amend-grant', 'revoke-grant']) {
      const attempts = await loseReply(page, 'save', true, operation);
      await sheet.getByRole('button', { name: operation === 'grant' ? text.give : operation === 'amend-grant' ? text.amend : text.revoke, exact: true }).click();
      if (operation !== 'revoke-grant') {
        const dialog = sheet.getByRole('dialog');
        if (operation === 'grant') await dialog.getByLabel(text.name, { exact: true }).fill('Reward');
        await dialog.getByLabel(operation === 'grant' ? text.reason : text.amendReason, { exact: true }).fill(operation + ' quest reward');
        await dialog.getByRole('button', { name: text.apply, exact: true }).click();
      }
      await status.getByRole('button', { name: text.retry, exact: true }).waitFor();
      assert.equal(await sheet.getByRole('dialog').count(), 0);
      assert.equal(await sheet.getByRole('button', { name: text.give, exact: true }).isDisabled(), true);
      if (operation !== 'revoke-grant') assert.match(await status.innerText(), new RegExp(operation + ' quest reward'));
      if (operation === 'grant') {
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.waitForFunction(() => (document.querySelector('.campaign-sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
        await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
        await status.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(f.output, 'command-recovery-phone-' + locale + '.png') });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (cs) assert.match(await status.innerText(), /Akce už může být uložená/);
      }
      await retry(page, status, attempts, locale);
      const saved = await read(); assert.equal(saved.revision, previous.revision + 1);
      assert.equal(saved.state.inputs.grants.length, operation === 'revoke-grant' ? 0 : 1);
      if (operation === 'amend-grant') assert.equal(saved.state.inputs.grants[0].id, previous.state.inputs.grants[0].id);
      previous = saved; await page.unroute('**/services/call');
    }
  });

  for (const delivered of [false, true]) test('reviewed import retries the approved token ' + (delivered ? 'after a lost acknowledgment' : 'after failed delivery'), { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'command-import-' + delivered, inputs = await createCharacter(f, key);
    const initial = await save(f, key, inputs, 0, 'seed'), { page, sheet, status, read } = await openBuilder(t, f, key);
    await sheet.locator('#dnd-tab-tools').click(); await sheet.getByRole('button', { name: 'Import character', exact: true }).click();
    const replacement = structuredClone(initial.state.inputs); replacement.notes = 'Exactly reviewed import';
    await sheet.getByLabel('Or paste the export').fill(JSON.stringify({ format: 'dnd-character.v1', schemaVersion: '4.0.0', inputs: replacement }));
    let previews = 0; page.on('request', request => { if (request.url().endsWith('/services/call') && request.postDataJSON()?.method === 'preview') previews++; });
    await sheet.getByRole('button', { name: 'Review import', exact: true }).click();
    const attempts = await loseReply(page, 'commit', delivered);
    await sheet.getByRole('button', { name: 'Replace character', exact: true }).click();
    await status.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(await sheet.getByRole('dialog').count(), 0, 'A failed commit must expose accessible recovery outside the closed review dialog');
    assert.equal(await sheet.getByRole('button', { name: 'Import character', exact: true }).isDisabled(), true);
    assert.equal(await sheet.getByRole('button', { name: 'Export character', exact: true }).isEnabled(), true);
    assert.equal((await read()).revision, initial.revision + (delivered ? 1 : 0));
    await retry(page, status, attempts);
    assert.equal(previews, 1, 'Retry must not create another review');
    const saved = await read(); assert.equal(saved.revision, initial.revision + 1); assert.equal(saved.state.inputs.notes, replacement.notes);
    assert.deepEqual(saved.state.inputs.build, replacement.build);
  });

  test('background read started before a command cannot replace its newer result', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'command-old-read', initial = await readyCharacter(f, key);
    const otherKey = 'command-refresh-source', other = await createCharacter(f, otherKey);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    let hold = true; t.after(() => release());
    await page.route('**/services/call', async route => {
      if (hold && route.request().postDataJSON()?.method === 'load') {
        hold = false; const response = await route.fetch(); assert.equal((await response.json()).result.revision, initial.revision);
        started(); await held; await route.fulfill({ response });
      } else await route.continue();
    });
    // A real extension event starts a read of this character without changing it.
    await save(f, otherKey, other, 0, 'event'); await entered;
    await damage(sheet); await status.filter({ hasText: /^Saved$/ }).waitFor();
    const received = page.waitForResponse(response => response.request().postDataJSON()?.method === 'load' && response.url().endsWith('/services/call'));
    release(); await (await received).finished();
    await sheet.locator('#dnd-tab-tools').click(); await sheet.locator('#dnd-tab-sheet').click();
    assert.equal(await sheet.getByLabel('Current HP', { exact: true }).inputValue(), String(initial.state.inputs.play.hp - 2));
    const saved = await read(); assert.equal(saved.revision, initial.revision + 1); assert.equal(saved.state.inputs.play.hp, initial.state.inputs.play.hp - 2);
    assert.equal(await unloadBlocked(page), false);
  });

  test('uncertain command never rebases over a later edit and failed checking preserves recovery', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'command-conflict', initial = await readyCharacter(f, key);
    const { page, sheet, status, read } = await openBuilder(t, f, key), attempts = await loseReply(page, 'save', true, 'play');
    await damage(sheet); await status.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const committed = await read(), input = structuredClone(committed.state.inputs); input.notes = 'Preserve the other editor';
    const newer = await save(f, key, input, committed.revision, 'concurrent');
    await status.getByRole('button', { name: 'Retry', exact: true }).click();
    await status.filter({ hasText: 'Check the saved character before deciding' }).waitFor();
    assert.deepEqual(attempts[1], attempts[0]); assert.equal(attempts.length, 2);
    assert.equal(await status.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
    assert.equal(await unloadBlocked(page), true);
    const check = status.getByRole('button', { name: 'Check saved character', exact: true });
    page.once('dialog', dialog => { assert.match(dialog.message(), /Any action already saved will remain/); return dialog.dismiss(); });
    await check.focus(); await check.press('Enter'); assert.equal(await unloadBlocked(page), true);
    let failLoad = true;
    await page.route('**/services/call', async route => {
      if (failLoad && route.request().postDataJSON()?.method === 'load') { failLoad = false; await route.abort('failed'); }
      else await route.fallback();
    });
    page.once('dialog', dialog => dialog.accept()); await check.click();
    await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
    assert.equal(failLoad, false); assert.equal(await unloadBlocked(page), true);
    assert.equal(await sheet.getByRole('button', { name: 'Damage', exact: true }).isDisabled(), true);
    page.once('dialog', dialog => dialog.accept()); await check.click();
    await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
    assert.equal(await unloadBlocked(page), false);
    const loaded = await read(); assert.equal(loaded.revision, newer.revision); assert.equal(loaded.state.inputs.notes, input.notes);
    assert.equal(loaded.state.inputs.play.hp, initial.state.inputs.play.hp - 2); assert.equal(attempts.length, 2);
    assert.equal(await sheet.getByLabel('Current HP', { exact: true }).inputValue(), String(loaded.state.inputs.play.hp));
  });
}
