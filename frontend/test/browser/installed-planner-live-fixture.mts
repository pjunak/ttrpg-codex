import { required } from './fixture-types.mts';
import type { FixtureRecord, InstalledFixture } from './fixture-types.mts';
import { closePlannerEditor, editPlannerCard } from './installed-planner-dialog-fixture.mts';
import assert from 'node:assert/strict';
import { jsonResponse } from './installed-graph-fixture.mts';

export async function exercisePlannerLive({ t, open, admin, csrf }: Pick<InstalledFixture, 't' | 'open' | 'admin' | 'csrf'>) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  const transact = async (mutations: unknown[]) => jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations } }));
  const records = async () => (await jsonResponse(await admin.post(`${base}/query`, { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId: 'planning_items', limit: 200, where: [] } }))).documents;
  const item = { id: 'live-quest', schemaVersion: 3, kind: 'event', eventType: 'story', parentId: null, title: 'Live quest', summary: '', objective: '', body: '', setup: '', resolution: '', tags: [], updatedAt: 1 };
  await transact([{ operation: 'put', kind: 'collection', dataId: 'planning_items', key: item.id, expectedRevision: 0, value: item }]);
  const overview = await open(t), page = await open(t);
  await page.goto('/#/addons/dm-tools/planner?item=live-quest');
  await page.getByRole('button', { name: 'Edit item', exact: true }).click();
  const details = page.getByRole('form', { name: 'Planning item details', exact: true }), title = details.getByLabel('Title', { exact: true });
  await title.waitFor(); await closePlannerEditor(page); await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  const viewport = page.locator('.dm-planner-viewport');
  await viewport.evaluate(e => { e.scrollLeft = 120; e.scrollTop = 80; });
  const zoom = page.locator('button[aria-label="Reset zoom to 100%"]');
  const zoomBefore = await zoom.textContent().then(required); assert.equal(zoomBefore, '90%');

  await editPlannerCard(page, page.locator('.dm-plan-card[data-item-id="live-quest"]'));
  const canvasBefore = await viewport.evaluate(e => ({ scope: e.dataset.scope, left: e.scrollLeft, top: e.scrollTop }));
  let queries = 0; page.on('request', request => { if (request.url().endsWith('/data/query')) queries++; });
  const update = async (text: string) => { const current = (await records()).find((record: FixtureRecord) => record.key === item.id); await transact([{ operation: 'put', kind: 'collection', dataId: 'planning_items', key: item.id, expectedRevision: current.revision, value: { ...current.value, title: text, updatedAt: current.value.updatedAt + 1 } }]); };
  await update('Updated in another tab');
  await overview.locator('.dm-dashboard-recent a strong').filter({ hasText: /^Updated in another tab$/u }).waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('form[aria-label="Planning item details"] input[name="title"]')?.value === 'Updated in another tab');
  assert.ok(queries >= 6 && queries <= 12, `expected coalesced authoritative reads, got ${queries}`);
  assert.deepEqual(await viewport.evaluate(e => ({ scope: e.dataset.scope, left: e.scrollLeft, top: e.scrollTop })), canvasBefore);
  assert.equal(await zoom.textContent().then(required), zoomBefore);

  await title.fill('Keep my unfinished title'); await title.evaluate(input => (input as HTMLInputElement).setSelectionRange(5, 9));
  await update('Another remote title'); await page.locator('[data-live-refresh]').waitFor();
  assert.equal(await title.inputValue(), 'Keep my unfinished title');
  assert.deepEqual(await title.evaluate(input => [document.activeElement === input, (input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd]), [true, 5, 9]);
  const conflict = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await details.getByRole('button', { name: 'Save details', exact: true }).click(); assert.equal((await conflict).status(), 409);
  await page.getByText(/Reload the planner before making another change/u).waitFor();
  assert.equal(await title.inputValue(), 'Keep my unfinished title');
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  const stillStale = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await details.getByRole('button', { name: 'Save details', exact: true }).click(); assert.equal((await stillStale).status(), 409);
  assert.equal((await records()).find((record: FixtureRecord) => record.key === item.id).value.title, 'Another remote title');

  // A fresh view may begin typing after its automatic read has already started.
  const typing = await open(t); await typing.goto('/#/addons/dm-tools/planner?item=live-quest');
  await typing.getByRole('button', { name: 'Edit item', exact: true }).click();
  const typingTitle = typing.getByRole('form', { name: 'Planning item details' }).getByLabel('Title', { exact: true }); await typingTitle.waitFor();
  await typing.getByRole('button', { name: 'Save item', exact: true }).focus();

 const { promise: held, resolve: release } = Promise.withResolvers<void>(), { promise: reading, resolve: started } = Promise.withResolvers<void>();
  await typing.route('**/data/query', async route => { started(); await held; await route.continue(); });
  await update('Read pending title'); await reading; await typingTitle.fill('Typed during the refresh'); release(); await typing.unrouteAll({ behavior: 'wait' });
  await typing.locator('[data-live-refresh]').waitFor(); assert.equal(await typingTitle.inputValue(), 'Typed during the refresh');

  const failing = await open(t); await failing.goto('/#/addons/dm-tools/planner?item=live-quest'); await failing.locator('.dm-plan-card').first().waitFor();
  await failing.getByRole('button', { name: 'Edit item', exact: true }).click();
  await failing.getByRole('button', { name: 'Save item', exact: true }).focus();
  await failing.route('**/data/query', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await update('Refresh retry title'); await failing.getByText(/Reload the planner before making another change/u).waitFor();
  await failing.unroute('**/data/query'); await failing.getByRole('button', { name: 'Reload planner', exact: true }).click();
  await failing.waitForFunction(() => document.querySelector<HTMLInputElement>('form[aria-label="Planning item details"] input[name="title"]')?.value === 'Refresh retry title');
  await closePlannerEditor(failing);
  const card = failing.locator('.dm-plan-card[data-item-id="live-quest"]'); await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox().then(required); await failing.mouse.move(box.x + 30, box.y + 35); await failing.mouse.down();
  await card.evaluate(element => { window.heldCard = element; });
  await update('Changed during a drag'); await failing.waitForTimeout(250);
  assert.equal(await card.evaluate(element => element === window.heldCard), true);
  assert.deepEqual(await card.boundingBox().then(required), box);
  await failing.mouse.up(); await card.filter({ hasText: 'Changed during a drag' }).waitFor();
}
