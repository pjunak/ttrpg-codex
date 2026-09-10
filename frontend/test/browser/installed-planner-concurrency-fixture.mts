import type { FixtureRecord, InstalledFixture } from './fixture-types.mts';
import { plannerTab, editPlannerCard } from './installed-planner-dialog-fixture.mts';
import assert from 'node:assert/strict';
import { jsonResponse } from './installed-graph-fixture.mts';

export async function exercisePlannerConcurrency({ t, open, admin, csrf }: Pick<InstalledFixture, 't' | 'open' | 'admin' | 'csrf'>) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  const records = async (dataId: string) => (await jsonResponse(await admin.post(`${base}/query`, { headers,
    data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents;
  const put = (dataId: string, value: Record<string, unknown>) => ({ operation: 'put', kind: 'collection', dataId, key: value.id, expectedRevision: 0, value });
  const transact = async (mutations: unknown[]) => jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations } }));
  const item = (id: string, parentId: string | null = null, kind = 'event') => ({ id, title: id, kind, parentId, schemaVersion: 3, summary: '', objective: '', body: '', setup: '', resolution: '', tags: [], updatedAt: 1, ...(kind === 'event' ? { eventType: 'story' } : {}) });
  const flow = (id: string, sourceId: string, targetId: string) => ({ id, schemaVersion: 3, sourceId, targetId, kind: 'continues', label: id, updatedAt: 1 });
  await transact([
    put('planning_items', item('race-parent', null, 'quest')),
    ...['race-a', 'race-b', 'race-c', 'race-d'].map(id => put('planning_items', item(id))),
    put('planning_flow_links', flow('race-bc', 'race-b', 'race-c')),
    put('planning_flow_links', flow('race-da', 'race-d', 'race-a')),
  ]);
  const page = await open(t); await page.goto('/#/addons/dm-tools/planner');
  await editPlannerCard(page, page.locator('.dm-plan-card[data-item-id="race-parent"]'));
  const remove = page.getByRole('button', { name: 'Delete item and subtree', exact: true }); await remove.waitFor();
  // Adding a child does not change the parent's document revision.
  await transact([put('planning_items', item('race-unseen-child', 'race-parent'))]);
  page.once('dialog', dialog => dialog.accept());
  const conflict = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await remove.click(); assert.equal((await conflict).status(), 409);
  assert.ok((await records('planning_items')).some((record: FixtureRecord) => record.key === 'race-parent'));
  assert.ok((await records('planning_items')).some((record: FixtureRecord) => record.key === 'race-unseen-child'));
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click();
  await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  page.once('dialog', dialog => dialog.accept()); await remove.click();
  await page.getByText('Planning subtree deleted.', { exact: true }).waitFor();
  assert.equal((await records('planning_items')).some((record: FixtureRecord) => ['race-parent', 'race-unseen-child'].includes(record.key)), false);

  await page.goto('/#/addons/dm-tools/planner?item=race-b');
  await plannerTab(page, 'Links');
  const removeFlow = page.locator('[data-flow-id="race-bc"]').getByRole('button', { name: 'Remove flow', exact: true }); await removeFlow.waitFor();
  await transact([put('planning_consequences', { id: 'race-unseen-consequence', schemaVersion: 3, anchor: { scope: 'flow', flowId: 'race-bc' }, kind: 'world', title: 'New consequence', body: '', updatedAt: 1 })]);
  page.once('dialog', dialog => dialog.accept());
  const flowConflict = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await removeFlow.click(); assert.equal((await flowConflict).status(), 409);
  assert.ok((await records('planning_flow_links')).some((record: FixtureRecord) => record.key === 'race-bc'));
  assert.ok((await records('planning_consequences')).some((record: FixtureRecord) => record.key === 'race-unseen-consequence'));

  // These two new edges are individually valid but together close a cycle.
  const left = await open(t), right = await open(t);
  await left.goto('/#/addons/dm-tools/planner?item=race-a');
  await right.goto('/#/addons/dm-tools/planner?item=race-c');
  await plannerTab(left, 'Links'); await plannerTab(right, 'Links');
  const createLeft = left.getByRole('form', { name: 'Create story flow', exact: true });
  const createRight = right.getByRole('form', { name: 'Create story flow', exact: true });
  await createLeft.getByLabel('Flow target').selectOption('race-b');
  await createRight.getByLabel('Flow target').selectOption('race-d');
  await createRight.getByLabel('Flow label').fill('Keep this draft');
  await createLeft.getByRole('button', { name: 'Create flow', exact: true }).click();
  await left.getByText('Flow created.', { exact: true }).waitFor();
  const cycleConflict = right.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await createRight.getByRole('button', { name: 'Create flow', exact: true }).click(); assert.equal((await cycleConflict).status(), 409);
  await right.getByText(/Reload the planner before making another change/u).waitFor();
  assert.equal(await createRight.getByLabel('Flow label').inputValue(), 'Keep this draft');
  assert.equal((await records('planning_flow_links')).some((record: FixtureRecord) => record.value.sourceId === 'race-c'), false);
  await right.getByRole('button', { name: 'Reload planner', exact: true }).click();
  await right.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  await createRight.getByRole('button', { name: 'Create flow', exact: true }).click();
  await right.getByText(/Flow cycle reaches/u).waitFor();
  assert.equal(await createRight.getByLabel('Flow label').inputValue(), 'Keep this draft');
}
