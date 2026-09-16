import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import type { APIRequestContext, Browser, Page } from 'playwright';
import { jsonResponse } from './installed-graph-fixture.mts';
import { unloadBlocked } from './installed-planner-navigation-fixture.mts';

interface Fixture {
  admin: APIRequestContext; browser: Browser; csrf: string; origin: string; output: string;
  call(method: string, params: Record<string, unknown>): ReturnType<typeof jsonResponse>;
}
function latch() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function openCharacter(t: TestContext, fixture: Fixture, key: string, equipped = false) {
  const { admin, browser, csrf, origin, call } = fixture;
  await jsonResponse(await admin.post('/api/campaign/transactions', {
    headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'campaign-mutation.v1', mutations: [{
      operation: 'put', collection: 'characters', key, expectedRevision: 0,
      value: { id: key, name: key, knowledge: 4, visibility: 'public' },
    }] },
  }));
  const loaded = await call('load', { key }), inputs = loaded.evaluation.inputs;
  inputs.play.inventory = [{ id: 'keepsake', name: 'Travel dagger', quantity: 1, location: equipped ? 'equipped' : 'carried',
    attuned: false, reference: { kind: 'weapon', id: 'dagger' }, acquisition: '', notes: '' }];
  const initial = await call('save', { key, operation: 'build', operationId: key + '-seed', summary: 'Partial character',
    expectedRevision: 0, inputs });
  assert.equal(initial.status, 'ready', JSON.stringify(initial));
  assert.equal(initial.evaluation.ready, false, 'Partial builds may save without enabling play');
  const context = await browser.newContext({ storageState: await admin.storageState(), viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin + '/#/characters/' + key); await page.locator('#character-view-addons').click();
  const sheet = page.locator('.addon-dnd-character');
  await sheet.locator('.dse-item-notes summary').first().click();
  const name = sheet.getByLabel('Name', { exact: true }).first(), status = sheet.locator('[data-character-status]');
  await name.waitFor(); await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
  assert.equal(await sheet.getByRole('button', { name: 'Heal', exact: true }).isDisabled(), true);
  return { page, sheet, name, status, initial, read: () => call('load', { key }) };
}

// Bypass a stale/client-side range to exercise real worker + Engine rejection,
// without fabricating a response or disabling server validation.
async function invalidCurrency(page: Page, name: string) {
  await page.locator('.addon-dnd-character').evaluate((root, name) => {
    const coins = root.querySelector<HTMLInputElement>('input[aria-label="GP"]')!;
    coins.min = '-1'; coins.value = '-1'; coins.dispatchEvent(new Event('input', { bubbles: true }));
    const title = root.querySelector<HTMLInputElement>('.dse-item-notes input')!;
    title.value = name; title.dispatchEvent(new Event('input', { bubbles: true })); title.focus(); title.setSelectionRange(3, 7);
  }, name);
}

export function registerCharacterSaveTests(enabled: boolean, fixture: () => Fixture) {
  test('rejected autosave retains input, caret and navigation guard until corrected or explicitly discarded', { skip: !enabled, timeout: 60000 }, async t => {
    const { page, sheet, name, status, initial, read } = await openCharacter(t, fixture(), 'save-rejected');
    await invalidCurrency(page, 'Keep rejected input');
    await status.filter({ hasText: 'Currency must use supported coins and non-negative amounts.' }).waitFor();
    assert.equal(await status.getAttribute('data-ui-state'), 'error');
    assert.equal(await name.inputValue(), 'Keep rejected input'); assert.equal((await read()).revision, initial.revision);
    assert.deepEqual(await name.evaluate(node => ({ focused: node === document.activeElement, start: (node as HTMLInputElement).selectionStart, end: (node as HTMLInputElement).selectionEnd })), { focused: true, start: 3, end: 7 });
    assert.equal(await unloadBlocked(page), true);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(() => (document.querySelector('.campaign-sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await status.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(fixture().output, 'autosave-rejected-phone.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.addon-dnd-character *')].filter(node => node.getBoundingClientRect().right > window.innerWidth).map(node => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width, min: getComputedStyle(node).minWidth, text: node.textContent?.slice(0, 50) })).slice(0, 20))));
    for (const accept of [false, true]) {
      page.once('dialog', dialog => { assert.match(dialog.message(), /Discard the unsaved character changes/); return accept ? dialog.accept() : dialog.dismiss(); });
      await status.getByRole('button', { name: 'Reload saved character', exact: true }).click();
      if (!accept) { assert.equal(await name.inputValue(), 'Keep rejected input'); assert.equal(await unloadBlocked(page), true); }
    }
    await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
    await sheet.locator('.dse-item-notes summary').first().click();
    assert.equal(await name.inputValue(), 'Travel dagger'); assert.equal(await unloadBlocked(page), false);
    await invalidCurrency(page, 'Corrected together');
    await status.filter({ hasText: 'Currency must use supported coins and non-negative amounts.' }).waitFor();
    await sheet.getByLabel('GP', { exact: true }).fill('0');
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    const saved = await read(); assert.equal(saved.state.inputs.play.inventory[0].name, 'Corrected together');
    assert.equal(saved.state.inputs.play.currency.gp, 0); assert.equal(saved.revision, initial.revision + 1);
    assert.equal(await unloadBlocked(page), false);
  });


  test('Czech Classic save recovery remains usable with enlarged phone text', { skip: !enabled, timeout: 60000 }, async t => {
    const { page, sheet, status, read } = await openCharacter(t, fixture(), 'save-czech');
    await sheet.locator('#dnd-tab-tools').click();
    await sheet.getByRole('combobox', { name: 'Sheet layout', exact: true }).selectOption('classic');
    await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload();
    await page.locator('#character-view-addons').click();
    await sheet.locator('.dse-item-notes summary').first().click();
    await page.waitForFunction(() => !document.querySelector('.addon-dnd-character')?.hasAttribute('aria-busy'));
    assert.equal(await sheet.getAttribute('data-layout'), 'classic');
    await invalidCurrency(page, 'Zachované jméno');
    await status.getByRole('button', { name: 'Zkusit znovu', exact: true }).waitFor();
    assert.match(await status.innerText(), /Vaše změny jsou stále na této stránce/);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(() => (document.querySelector('.campaign-sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await status.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(fixture().output, 'autosave-rejected-phone-cs-classic.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const reload = status.getByRole('button', { name: 'Načíst uloženou postavu', exact: true });
    page.once('dialog', dialog => { assert.match(dialog.message(), /Zahodit neuložené změny postavy/); return dialog.dismiss(); });
    await reload.focus(); await reload.press('Enter');
    assert.equal(await sheet.getByLabel('Název', { exact: true }).first().inputValue(), 'Zachované jméno');
    assert.equal(await unloadBlocked(page), true);
    await sheet.getByLabel('GP', { exact: true }).fill('0');
    await status.filter({ hasText: /^Uloženo$/ }).waitFor();
    assert.equal((await read()).state.inputs.play.inventory[0].name, 'Zachované jméno');
    assert.equal(await unloadBlocked(page), false);
  });

  for (const newer of [false, true]) test('lost autosave reply retries the exact request' + (newer ? ' before saving newer edits' : ' without a duplicate write'), { skip: !enabled, timeout: 60000 }, async t => {
    const { page, sheet, name, status, initial, read } = await openCharacter(t, fixture(), newer ? 'save-lost-newer' : 'save-lost');
    const held = latch(), committed = latch(), requests: unknown[] = []; let lose = true;
    t.after(() => held.release());
    await page.route('**/services/call', async route => {
      const body = route.request().postDataJSON();
      if (body?.method !== 'save') { await route.continue(); return; }
      requests.push(body.params);
      if (lose) { lose = false; await route.fetch(); committed.release(); await held.promise; await route.abort('failed'); }
      else await route.continue();
    });
    await name.fill('Committed before lost reply'); await committed.promise;
    assert.equal((await read()).revision, initial.revision + 1);
    if (newer) await name.fill('Typed while outcome unknown');
    held.release();
    await status.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(await unloadBlocked(page), true);
    await status.getByRole('button', { name: 'Retry', exact: true }).click();
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    assert.deepEqual(requests[1], requests[0], 'Uncertain operations keep their ID, revision and exact inputs');
    assert.equal(requests.length, newer ? 3 : 2);
    const saved = await read(); assert.equal(saved.revision, initial.revision + (newer ? 2 : 1));
    assert.equal(saved.state.inputs.play.inventory[0].name, newer ? 'Typed while outcome unknown' : 'Committed before lost reply');
    await page.waitForFunction(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return !event.defaultPrevented;
    });
    if (!newer) {
      // A deduplicated acknowledgment omits evaluation; the UI must restore
      // current guidance with a read, without a second save.
      await sheet.locator('#dnd-tab-builder').click();
      await sheet.getByLabel('STR', { exact: true }).waitFor();
      assert.equal(await sheet.locator('.character-stepper').count(), 6);
    }
  });

  test('an invalid in-flight autosave does not discard or block a newer correction', { skip: !enabled, timeout: 60000 }, async t => {
    const { page, sheet, name, status, initial, read } = await openCharacter(t, fixture(), 'save-corrected');
    const held = latch(), rejected = latch(); let hold = true; t.after(() => held.release());
    await page.route('**/services/call', async route => {
      if (hold && route.request().postDataJSON()?.method === 'save') {
        hold = false; const response = await route.fetch();
        assert.equal((await response.json()).result.status, 'invalid'); rejected.release(); await held.promise; await route.fulfill({ response });
      } else await route.continue();
    });
    await invalidCurrency(page, 'Rejected older version'); await rejected.promise;
    await sheet.getByLabel('GP', { exact: true }).fill('0'); await name.fill('Valid latest version'); held.release();
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    const saved = await read(); assert.equal(saved.revision, initial.revision + 1);
    assert.equal(saved.state.inputs.play.currency.gp, 0); assert.equal(saved.state.inputs.play.inventory[0].name, 'Valid latest version');
    assert.equal(await name.inputValue(), 'Valid latest version'); assert.equal(await unloadBlocked(page), false);
  });

  test('independent character edits rebase while preserving pending item text', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'save-disjoint', { page, name, status, initial, read } = await openCharacter(t, f, key);
    const held = latch(), entered = latch(); let hold = true; t.after(() => held.release());
    await page.route('**/services/call', async route => {
      if (hold && route.request().postDataJSON()?.method === 'save') { hold = false; entered.release(); await held.promise; }
      await route.continue();
    });
    await name.fill('Local item name'); await entered.promise;
    const remote = await read(); remote.state.inputs.play.currency.gp = 12;
    assert.equal((await f.call('save', { key, operation: 'build', operationId: key + '-other', summary: 'Independent coins',
      expectedRevision: remote.revision, inputs: remote.state.inputs })).status, 'ready');
    held.release(); await status.filter({ hasText: /^Saved$/ }).waitFor();
    const saved = await read(); assert.equal(saved.revision, initial.revision + 2);
    assert.equal(saved.state.inputs.play.inventory[0].name, 'Local item name'); assert.equal(saved.state.inputs.play.currency.gp, 12);
    assert.equal(await name.inputValue(), 'Local item name'); assert.equal(await name.evaluate(node => node === document.activeElement), true);
    assert.equal(await unloadBlocked(page), false);
  });

  test('depleting equipped inventory saves an empty carried item and rejects forged empty equipment', { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = 'save-empty-item', { sheet, status, initial, read } = await openCharacter(t, f, key, true);
    await sheet.getByLabel('Travel dagger quantity', { exact: true }).fill('0');
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    const saved = await read(), item = saved.state.inputs.play.inventory[0];
    assert.equal(saved.revision, initial.revision + 1); assert.equal(item.quantity, 0);
    assert.equal(item.location, 'carried'); assert.equal(item.attuned, false);
    item.location = 'equipped';
    const invalid = await f.call('save', { key, operation: 'build', operationId: key + '-forged', summary: 'Empty equipped item',
      expectedRevision: saved.revision, inputs: saved.state.inputs });
    assert.equal(invalid.status, 'invalid'); assert.equal(invalid.evaluation.guidance.canSave, false);
    assert.ok(invalid.evaluation.guidance.saveIssues.some((issue: { id: string }) => issue.id === 'equipped-empty:keepsake'));
    assert.equal((await read()).revision, saved.revision);
  });
}
