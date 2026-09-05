import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { jsonResponse } from './installed-graph-fixture.mjs';

export async function exercisePlannerFlows({ t, open, admin, csrf, output }) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`;
  const headers = { 'X-Codex-CSRF': csrf };
  const records = async dataId => (await jsonResponse(await admin.post(`${base}/query`, { headers,
    data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents;
  const transact = async mutations => jsonResponse(await admin.post(`${base}/transactions`, { headers,
    data: { contractVersion: 'addon-data-transaction.v1', mutations } }));
  const put = (dataId, value, expectedRevision = 0) => ({ operation: 'put', kind: 'collection', dataId, key: value.id, expectedRevision, value });
  const item = (id, title, kind, parentId = null) => ({ id, title, kind, parentId, schemaVersion: 3, summary: '', objective: '', body: '', setup: '', resolution: '', tags: [], updatedAt: 1,
    ...(kind === 'branch' ? { branchType: 'decision' } : {}), ...(kind === 'event' ? { eventType: 'story' } : {}) });
  await transact([
    put('planning_items', item('flow-branch', 'Gate choice', 'branch')),
    put('planning_items', item('flow-event', 'Passage', 'event')),
    put('planning_items', item('flow-quest', 'Distant quest', 'quest')),
    put('planning_items', item('flow-child', 'Nested event', 'event', 'flow-quest')),
    put('planning_consequences', { id: 'flow-whole-item', schemaVersion: 3, anchor: { scope: 'item', itemId: 'flow-event' }, kind: 'information', title: 'Whole-item knowledge', body: 'Keep this when removing a flow.', updatedAt: 1 }),
    put('planning_references', { id: 'flow-incoming-ref', schemaVersion: 3, itemId: 'flow-quest', name: 'Passage reference', relation: 'related', target: { scope: 'planning', itemId: 'flow-event' }, quantity: 1, notes: '', updatedAt: 1 }),
    put('dm_notes', { id: 'flow-shared-note', schemaVersion: 3, title: 'Shared marginalia', body: 'Keep with the distant quest.', anchorIds: ['flow-event', 'flow-quest'], updatedAt: 1 }),
  ]);
  const page = await open(t); await page.goto('/#/addons/dm-tools/planner?item=flow-branch');
  const create = page.getByRole('form', { name: 'Create story flow', exact: true });
  await create.waitFor();
  assert.equal(await create.getByLabel('Flow target').locator('option[value="flow-child"]').count(), 0);
  assert.equal(await create.getByLabel('Flow type').inputValue(), 'option');
  await create.getByLabel('Flow target').selectOption('flow-event');
  await create.getByLabel('Flow label').fill('If the gate opens');
  await create.getByRole('button', { name: 'Create flow', exact: true }).click();
  await page.getByText('Flow created.', { exact: true }).waitFor();
  const storedFlow = (await records('planning_flow_links')).find(record => record.value.sourceId === 'flow-branch');
  assert.equal(storedFlow.value.kind, 'option');
  const flowId = storedFlow.key;
  const flowEntry = page.locator(`.dm-planner-flow-entry[data-flow-id="${flowId}"]`);
  const edit = flowEntry.getByRole('form', { name: 'Edit story flow', exact: true });
  const card = id => page.locator(`.dm-plan-card[data-item-id="${id}"]`);

  // Editing an incoming flow still uses its actual branch source for allowed kinds.
  await card('flow-event').click(); await flowEntry.getByText('Edit flow', { exact: true }).click();
  assert.equal(await edit.getByLabel('Flow type').locator('option[value="option"]').count(), 1);
  await edit.getByLabel('Flow type').selectOption('continues'); await edit.getByLabel('Flow label').fill('Enter <carefully>');
  await edit.getByRole('button', { name: 'Save flow', exact: true }).click(); await page.getByText('Flow saved.', { exact: true }).waitFor();
  assert.equal((await records('planning_flow_links')).find(record => record.key === flowId).value.kind, 'continues');
  const label = page.locator('.dm-planner-flow-label').filter({ hasText: 'Enter <carefully>' }); await label.waitFor();
  assert.equal(await label.textContent(), 'Enter <carefully>'); assert.equal(await label.locator('*').count(), 0);

  await flowEntry.getByText('Edit flow', { exact: true }).click();
  await edit.getByLabel('Flow label').fill('Draft flow label');
  await page.getByRole('button', { name: 'Add consequence', exact: true }).click(); await page.getByText('Consequence added.', { exact: true }).waitFor();
  assert.equal(await edit.getByLabel('Flow label').inputValue(), 'Draft flow label');
  const consequence = (await records('planning_consequences')).find(record => record.value.title === 'Planned consequence');
  const annotation = page.locator(`form[data-consequence-id="${consequence.key}"]`);
  await annotation.getByLabel('Consequence applies to').selectOption(`flow:${flowId}`);
  await annotation.getByLabel('Consequence', { exact: true }).fill('Grant passage');
  await annotation.getByLabel('Details', { exact: true }).fill('Only when taking this path.');
  await annotation.getByRole('button', { name: 'Save consequence', exact: true }).click(); await page.getByText('Consequence saved.', { exact: true }).waitFor();
  assert.deepEqual((await records('planning_consequences')).find(record => record.key === consequence.key).value.anchor, { scope: 'flow', flowId });
  await card('flow-branch').click(); await annotation.waitFor();
  assert.equal(await annotation.getByLabel('Consequence applies to').inputValue(), `flow:${flowId}`);
  assert.equal(await edit.getByLabel('Flow label').inputValue(), 'Draft flow label');

  // A concurrent flow edit cannot lend its newer revision to the retained draft.
  let currentFlow = (await records('planning_flow_links')).find(record => record.key === flowId);
  await transact([put('planning_flow_links', { ...currentFlow.value, label: 'Remote flow label', updatedAt: 2 }, currentFlow.revision)]);
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click();
  await edit.getByText(/This record changed since editing began/u).waitFor();
  const conflict = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await edit.getByRole('button', { name: 'Save flow', exact: true }).click(); assert.equal((await conflict).status(), 409);
  await page.getByText(/Reload the planner before making another change/u).waitFor();
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  await edit.getByRole('button', { name: 'Discard edits', exact: true }).click();
  assert.equal((await records('planning_flow_links')).find(record => record.key === flowId).value.label, 'Remote flow label');

  // Cycle validation happens before a write and leaves the new-flow draft intact.
  await card('flow-event').click();
  await create.getByLabel('Flow target').selectOption('flow-branch'); await create.getByLabel('Flow label').fill('Invalid return');
  const beforeCycle = await records('planning_flow_links');
  await create.getByRole('button', { name: 'Create flow', exact: true }).click(); await page.getByText(/Flow cycle reaches/u).waitFor();
  assert.deepEqual(await records('planning_flow_links'), beforeCycle);
  assert.equal(await create.getByLabel('Flow label').inputValue(), 'Invalid return');
  await create.getByRole('button', { name: 'Discard edits', exact: true }).click();

  // Cancel leaves both records intact; a stale consequence rejects the whole deletion.
  page.once('dialog', dialog => dialog.dismiss()); await flowEntry.getByRole('button', { name: 'Remove flow', exact: true }).click();
  assert.ok((await records('planning_flow_links')).some(record => record.key === flowId));
  const currentConsequence = (await records('planning_consequences')).find(record => record.key === consequence.key);
  await transact([put('planning_consequences', { ...currentConsequence.value, body: 'Changed concurrently.', updatedAt: 3 }, currentConsequence.revision)]);
  page.once('dialog', dialog => dialog.accept());
  const rejectedDeletion = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await flowEntry.getByRole('button', { name: 'Remove flow', exact: true }).click(); assert.equal((await rejectedDeletion).status(), 409);
  await page.getByText(/Reload the planner before making another change/u).waitFor();
  assert.ok((await records('planning_flow_links')).some(record => record.key === flowId));
  assert.equal((await records('planning_consequences')).find(record => record.key === consequence.key).value.body, 'Changed concurrently.');
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();

  for (const mobile of [false, true]) {
    const view = mobile ? await open(t, 'dm', true) : page;
    if (mobile) await view.goto('/#/addons/dm-tools/planner?item=flow-event');
    await view.locator(`form[data-consequence-id="${consequence.key}"]`).waitFor();
    const entry = view.locator(`.dm-planner-flow-entry[data-flow-id="${flowId}"]`);
    await entry.getByText('Edit flow', { exact: true }).click();
    assert.equal(await entry.getByLabel('Flow label').inputValue(), 'Remote flow label');
    assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await entry.scrollIntoViewIfNeeded();
    await view.screenshot({ path: resolve(output, mobile ? 'planner-flow-phone.png' : 'planner-flow-desktop.png'), fullPage: false });
  }
  page.once('dialog', dialog => dialog.accept());
  const deleted = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await flowEntry.getByRole('button', { name: 'Remove flow', exact: true }).click();
  const response = await deleted; assert.equal(response.ok(), true);
  assert.deepEqual(response.request().postDataJSON().mutations.map(mutation => [mutation.dataId, mutation.key]), [['planning_flow_links', flowId], ['planning_consequences', consequence.key]]);
  await page.getByText('Flow removed.', { exact: true }).waitFor();
  assert.equal((await records('planning_consequences')).some(record => record.key === consequence.key), false);
  assert.ok((await records('planning_consequences')).some(record => record.key === 'flow-whole-item'));
  assert.ok((await records('planning_items')).some(record => record.key === 'flow-event'));

  // Deleting the endpoint clears incoming references and only its shared-note anchor.
  const rootView = (await records('planning_views')).find(record => record.key === 'scope-root');
  await transact([put('planning_views', { id: 'scope-root', schemaVersion: 3, scopeId: null, positions: { ...(rootView?.value.positions ?? {}), 'flow-event': { x: 48, y: 48 }, 'flow-quest': { x: 384, y: 48 } }, updatedAt: 4 }, rootView?.revision ?? 0)]);
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Delete item and subtree', exact: true }).click();
  await page.getByText('Planning subtree deleted.', { exact: true }).waitFor();
  assert.equal((await records('planning_references')).some(record => record.key === 'flow-incoming-ref'), false);
  assert.deepEqual((await records('dm_notes')).find(record => record.key === 'flow-shared-note').value.anchorIds, ['flow-quest']);
  const positions = (await records('planning_views')).find(record => record.key === 'scope-root').value.positions;
  assert.equal(Object.hasOwn(positions, 'flow-event'), false); assert.deepEqual(positions['flow-quest'], { x: 384, y: 48 });
}
