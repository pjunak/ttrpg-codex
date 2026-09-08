import { closePlannerEditor, editPlannerCard } from './installed-planner-dialog-fixture.mjs';
import assert from 'node:assert/strict';
import { jsonResponse } from './installed-graph-fixture.mjs';

export async function unloadBlocked(page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  });
}

export async function attemptHash(page, hash, accept = false) {
  const dialogSeen = page.waitForEvent('dialog', { timeout: 5000 });
  page.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
  await page.evaluate(hash => { location.hash = hash; }, hash);
  assert.match((await dialogSeen).message(), /Discard the unsaved changes/u);
}

export async function exercisePlannerNavigation({ t, open, admin, csrf }) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  const item = id => ({ id, schemaVersion: 3, kind: 'event', eventType: 'story', parentId: null, title: id,
    summary: '', body: 'Saved body', objective: '', setup: '', resolution: '', tags: [], updatedAt: 1 });
  await jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations:
    ['nav-desktop', 'nav-phone'].map(id => ({ operation: 'put', kind: 'collection', dataId: 'planning_items', key: id, expectedRevision: 0, value: item(id) })) } }));
  for (const mobile of [false, true]) {
    const id = mobile ? 'nav-phone' : 'nav-desktop', hash = `#/addons/dm-tools/planner?item=${id}`;
    const page = await open(t, 'dm', mobile); await page.goto(`/${hash}`);
    const details = page.getByRole('form', { name: 'Planning item details' });
    await details.getByLabel('Body', { exact: true }).fill('Keep my unsaved body');
    assert.equal(await unloadBlocked(page), true);
    if (!mobile) {
      const backPrompt = page.waitForEvent('dialog', { timeout: 5000 });
      page.once('dialog', dialog => dialog.dismiss());
      await page.goBack(); assert.match((await backPrompt).message(), /Discard the unsaved changes/u);
      await page.waitForURL(`**/${hash}`);
      assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');
    }
    // Query navigation keeps the same view and its hidden drafts.
    await page.evaluate(() => { location.hash = '#/addons/dm-tools/planner'; });
    await page.waitForURL('**/#/addons/dm-tools/planner');
    await editPlannerCard(page, page.locator(`.dm-plan-card[data-item-id="${id}"]`));
    assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');
    await page.evaluate(() => { location.hash = '#/addons/dm-tools/planner?unexpected=value'; });
    await page.getByRole('alert').filter({ hasText: /planner|parameter|target/iu }).waitFor();
    assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await page.waitForURL(`**/${hash}`);
    await attemptHash(page, '#/timeline');
    await page.waitForURL(`**/${hash}`);
    assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');

    if (!mobile) {
      assert.equal(await unloadBlocked(page), true, 'draft remains guarded before sign-out');
      const beforeLogout = await jsonResponse(await page.context().request.get('/api/auth'));
      await closePlannerEditor(page); await page.locator('.account-menu > summary').click();
      const logoutPrompt = page.waitForEvent('dialog', { timeout: 5000 });
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await logoutPrompt; await editPlannerCard(page, page.locator(`.dm-plan-card[data-item-id="${id}"]`));
      assert.deepEqual(await jsonResponse(await page.context().request.get('/api/auth')), beforeLogout);
      assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');
      const reloadPrompt = page.waitForEvent('dialog', { timeout: 5000 });
      page.once('dialog', dialog => dialog.dismiss());
      // A canceled reload never reaches Playwright's navigation-complete wait.
      await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
      assert.equal((await reloadPrompt).type(), 'beforeunload');
      assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');
    }

    // A save in flight cannot be left even if a confirmation would be accepted.
    const pattern = '**/data/transactions'; let release, received;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { received = resolve; });
    t.after(() => release());
    await page.route(pattern, async route => { received(); await held; await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); });
    await details.getByRole('button', { name: 'Save details', exact: true }).click(); await pending;
    await page.evaluate(() => { location.hash = '#/timeline'; });
    await page.getByText('Wait for the add-on save to finish before leaving this view.', { exact: true }).waitFor();
    await page.waitForURL(`**/${hash}`);
    await page.evaluate(() => { location.hash = '#/addons/dm-tools/planner'; });
    await page.waitForURL(`**/${hash}`);
    if (!mobile) {
      const beforeLogout = await jsonResponse(await page.context().request.get('/api/auth'));
      await page.locator('.account-menu button').filter({ hasText: /^Sign out$/u }).evaluate(button => button.click());
      assert.deepEqual(await jsonResponse(await page.context().request.get('/api/auth')), beforeLogout);
    }
    assert.equal(await unloadBlocked(page), true);
    release();
    await page.getByText(/Reload the planner before making another change/u).waitFor(); await page.unroute(pattern);
    await attemptHash(page, '#/timeline');
    assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');
    await page.getByRole('button', { name: 'Reload planner', exact: true }).click();
    await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
    await details.getByRole('button', { name: 'Save details', exact: true }).click();
    await page.getByText('Details saved.', { exact: true }).waitFor();
    assert.equal(await unloadBlocked(page), false);
    await details.getByLabel('Body', { exact: true }).fill('Discard this draft');
    await attemptHash(page, '#/timeline', true); await page.locator('.tl-shell').waitFor();
    assert.equal(await unloadBlocked(page), false);
    await page.goto(`/${hash}`);
    assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep my unsaved body');
    // Reverting to the baseline or explicitly discarding removes the guard.
    await details.getByLabel('Body', { exact: true }).fill('Temporary');
    await details.getByLabel('Body', { exact: true }).fill('Keep my unsaved body');
    assert.equal(await unloadBlocked(page), false);
    await details.getByLabel('Body', { exact: true }).fill('Temporary');
    await details.getByRole('button', { name: 'Discard edits', exact: true }).click();
    assert.equal(await unloadBlocked(page), false);
  }
}
