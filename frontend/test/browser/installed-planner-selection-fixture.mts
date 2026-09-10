import { required } from './fixture-types.mts';
import type { Locator } from 'playwright';
import type { FixtureRecord, InstalledFixture, FixtureTransaction } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { jsonResponse } from './installed-graph-fixture.mts';
import { closePlannerEditor, plannerTab, editPlannerCard } from './installed-planner-dialog-fixture.mts';
import { unloadBlocked } from './installed-planner-navigation-fixture.mts';

export async function exercisePlannerSelection({ t, open, admin, csrf, output }: Pick<InstalledFixture, 't' | 'open' | 'admin' | 'csrf' | 'output'>) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  const records = async (dataId: string) => (await jsonResponse(await admin.post(`${base}/query`, { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents;
  const put = (dataId: string, value: Record<string, unknown>) => ({ operation: 'put', kind: 'collection', dataId, key: value.id, expectedRevision: 0, value });
  const transact = async (mutations: unknown[]) => jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations } }));
  const item = (id: string, kind = 'event', parentId: string | null = 'selection-scope') => ({ id, title: id, kind, parentId, schemaVersion: 3, summary: '', objective: '', body: '', setup: '', resolution: '', tags: [], updatedAt: 1, ...(kind === 'event' ? { eventType: 'story' } : {}) });
  await transact([
    put('planning_items', item('selection-scope', 'quest', null)), put('planning_items', item('selection-a', 'quest')), put('planning_items', item('selection-b')), put('planning_items', item('selection-c')),
    put('planning_items', item('selection-child', 'event', 'selection-a')),
    put('planning_flow_links', { id: 'selection-flow', schemaVersion: 3, sourceId: 'selection-a', targetId: 'selection-b', kind: 'continues', label: 'Follow the trail', updatedAt: 1 }),
    put('planning_consequences', { id: 'selection-effect', schemaVersion: 3, anchor: { scope: 'flow', flowId: 'selection-flow' }, kind: 'world', title: 'Attached consequence', body: '', updatedAt: 1 }),
    put('planning_references', { id: 'selection-reference', schemaVersion: 3, itemId: 'selection-c', name: 'Child reference', relation: 'related', target: { scope: 'planning', itemId: 'selection-child' }, quantity: 1, notes: '', updatedAt: 1 }),
    put('dm_notes', { id: 'selection-note', schemaVersion: 3, title: 'Keep the other anchor', body: '', anchorIds: ['selection-child', 'selection-c'], updatedAt: 1 }),
    put('planning_views', { id: 'scope-selection-a', schemaVersion: 3, scopeId: 'selection-a', positions: { 'selection-child': { x: 96, y: 144 } }, updatedAt: 1 }),
    put('planning_views', { id: 'scope-selection-scope', schemaVersion: 3, scopeId: 'selection-scope', positions: { 'selection-a': { x: 72, y: 72 }, 'selection-b': { x: 372, y: 72 }, 'selection-c': { x: 72, y: 312 } }, updatedAt: 1 }),
  ]);
  const page = await open(t); await page.goto('/#/addons/dm-tools/planner?item=selection-scope');
  const card = (id: string) => page.locator(`[data-item-id="selection-${id}"]`), viewport = page.locator('.dm-planner-viewport');
  const actions = page.getByRole('group', { name: 'Selection actions', exact: true });
  let writes: FixtureTransaction[] = []; page.on('request', request => { if (request.url().endsWith('/data/transactions')) writes.push(request.postDataJSON()); });
  await card('a').click(); assert.equal(await page.getByRole('dialog').count(), 0);
  await card('b').click({ modifiers: ['Shift'] }); assert.equal(await page.locator('.dm-plan-card.selected').count(), 2);
  const drag = async (locator: Locator, dx: number, dy: number, cancel = false) => {
    const box = await locator.boundingBox().then(required); assert.ok(box);
    await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 30 + dx, box.y + 30 + dy, { steps: 5 });
    if (cancel) await locator.dispatchEvent('pointercancel', { pointerId: 1 });
    await page.mouse.up();
  };
  await drag(card('a'), 48, 24); await page.getByText('Position saved.', { exact: true }).waitFor();
  assert.equal(writes.length, 1); assert.equal(writes[0].mutations.length, 1); assert.equal(writes[0].expectedDataSets.length, 6);
  let positions = (await records('planning_views')).find((record: FixtureRecord) => record.key === 'scope-selection-scope').value.positions;
  assert.deepEqual(positions['selection-a'], { x: 120, y: 96 }); assert.deepEqual(positions['selection-b'], { x: 420, y: 96 }); assert.deepEqual(positions['selection-c'], { x: 72, y: 312 });
  assert.equal(await page.locator('.dm-plan-card.selected').count(), 2);
  await viewport.focus(); const keyboardWrite = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await page.keyboard.press('Shift+ArrowDown'); assert.equal((await keyboardWrite).ok(), true); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  positions = (await records('planning_views')).find((record: FixtureRecord) => record.key === 'scope-selection-scope').value.positions;
  assert.equal(positions['selection-a'].y, 192); assert.equal(positions['selection-b'].y, 192);
  const beforeCancel = await records('planning_views'), writeCount = writes.length;
  await drag(card('b'), 72, 48, true); assert.deepEqual(await records('planning_views'), beforeCancel); assert.equal(writes.length, writeCount);
  await viewport.focus(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.dm-plan-card.selected').count(), 0);
  const stage = await page.locator('.dm-planner-stage').boundingBox().then(required);
  await page.mouse.move(stage.x + 100, stage.y + 175); await page.mouse.down(); await page.mouse.move(stage.x + 675, stage.y + 290, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.locator('.dm-plan-card.selected').count(), 2); assert.equal(writes.length, writeCount);
  await actions.getByRole('button', { name: 'Connect selected', exact: true }).click();
  const connect = page.getByRole('form', { name: 'Create story flow', exact: true });
  assert.equal(await connect.getByLabel('Flow target').inputValue(), 'selection-b');
  await connect.getByRole('button', { name: 'Discard edits', exact: true }).click(); await closePlannerEditor(page);
  await viewport.focus(); await page.keyboard.press('Control+a'); assert.equal(await page.locator('.dm-plan-card.selected').count(), 3);
  await page.keyboard.press('Escape'); await card('a').click();
  await actions.getByRole('button', { name: 'Edit selected', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit planning item', exact: true }), title = dialog.getByLabel('Title', { exact: true });
  assert.equal(await title.evaluate(input => input === document.activeElement), true, await dialog.evaluate(element => document.activeElement?.outerHTML ?? 'No focused element'));
  await title.fill('Keep the dialog draft'); await plannerTab(page, 'Links');
  await page.keyboard.press('ArrowRight'); assert.equal(await dialog.getByRole('tab', { name: 'Notes', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home'); assert.equal(await dialog.getByRole('tab', { name: 'Details', exact: true }).getAttribute('aria-selected'), 'true');
  await dialog.getByRole('button', { name: 'Delete item and subtree', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
  await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0); assert.equal(await unloadBlocked(page), true);
  assert.equal(await card('a').evaluate(element => element === document.activeElement), true);
  await editPlannerCard(page, card('a')); assert.equal(await title.inputValue(), 'Keep the dialog draft');
  await closePlannerEditor(page);
  const flow = page.locator('path[data-flow-id="selection-flow"]');
  const point = await flow.evaluate(path => { const p = (path as SVGPathElement).getPointAtLength((path as SVGPathElement).getTotalLength() / 2).matrixTransform((path as SVGPathElement).getScreenCTM()!); return { x: p.x, y: p.y }; });
  await page.keyboard.down('Shift'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Shift');
  assert.equal(await flow.getAttribute('class'), 'continues selected');
  assert.equal(await page.evaluate(() => getSelection()?.toString()), '');
  await page.screenshot({ path: resolve(output, 'planner-selection-desktop.png') });
  await page.mouse.click(point.x, point.y);
  await actions.getByRole('button', { name: 'Edit selected flow', exact: true }).click();
  assert.equal(await page.getByRole('form', { name: 'Edit story flow', exact: true }).getByLabel('Flow label').inputValue(), 'Follow the trail');
  await closePlannerEditor(page);
  const hit = page.locator('[data-select-flow="selection-flow"]'); await hit.focus(); await page.keyboard.press('Shift+Space');
  assert.equal(await hit.getAttribute('aria-pressed'), 'true');
  page.once('dialog', prompt => prompt.dismiss()); await actions.getByRole('button', { name: 'Delete selection', exact: true }).click();
  assert.equal(writes.length, writeCount);
  // The retained dialog draft defers live refresh, exposing a real stale selection.
  await transact([put('planning_items', item('selection-unseen', 'event', 'selection-a'))]);
  const conflict = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  page.once('dialog', prompt => prompt.accept()); await actions.getByRole('button', { name: 'Delete selection', exact: true }).click(); assert.equal((await conflict).status(), 409);
  assert.ok((await records('planning_items')).some((record: FixtureRecord) => record.key === 'selection-child'));
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  page.once('dialog', prompt => prompt.accept()); await actions.getByRole('button', { name: 'Delete selection', exact: true }).click(); await page.getByText('Selection deleted.', { exact: true }).waitFor();
  assert.ok(!(await records('planning_items')).some((record: FixtureRecord) => ['selection-a', 'selection-child', 'selection-unseen'].includes(record.key)));
  assert.ok((await records('planning_items')).some((record: FixtureRecord) => record.key === 'selection-b'));
  assert.deepEqual((await records('dm_notes')).find((record: FixtureRecord) => record.key === 'selection-note').value.anchorIds, ['selection-c']);
  assert.ok(!(await records('planning_consequences')).some((record: FixtureRecord) => record.key === 'selection-effect'));
  const deleted = writes.at(-1)!.mutations;
  await viewport.focus(); await page.keyboard.press('Control+z'); await page.getByText('Deletion undone.', { exact: true }).waitFor();
  const restored = writes.at(-1)!.mutations;
  assert.equal(restored.length, deleted.length);
  for (const mutation of restored) {
    const original = deleted.find(value => value.dataId === mutation.dataId && value.key === mutation.key);
    assert.equal(mutation.operation, 'put'); assert.equal(mutation.expectedRevision, required(original).expectedRevision + 1);
  }
  assert.ok((await records('planning_items')).some((record: FixtureRecord) => record.key === 'selection-unseen'));
  assert.ok((await records('planning_flow_links')).some((record: FixtureRecord) => record.key === 'selection-flow'));
  assert.ok((await records('planning_consequences')).some((record: FixtureRecord) => record.key === 'selection-effect'));
  assert.ok((await records('planning_references')).some((record: FixtureRecord) => record.key === 'selection-reference'));
  assert.deepEqual((await records('dm_notes')).find((record: FixtureRecord) => record.key === 'selection-note').value.anchorIds, ['selection-child', 'selection-c']);
  assert.deepEqual((await records('planning_views')).find((record: FixtureRecord) => record.key === 'scope-selection-a').value.positions, { 'selection-child': { x: 96, y: 144 } });
  assert.equal(await page.getByRole('button', { name: 'Undo last deletion', exact: true }).count(), 0);
  // A later edit of an affected shared note must not be overwritten by undo.
  await card('a').click(); page.once('dialog', prompt => prompt.accept()); await actions.getByRole('button', { name: 'Delete selection', exact: true }).click();
  await page.getByText('Selection deleted.', { exact: true }).waitFor();
  const note = (await records('dm_notes')).find((record: FixtureRecord) => record.key === 'selection-note');
  await transact([{ ...put('dm_notes', { ...note.value, body: 'A newer shared note', updatedAt: Date.now() }), expectedRevision: note.revision }]);
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  const countBeforeConflict = writes.length; await page.getByRole('button', { name: 'Undo last deletion', exact: true }).click();
  await page.getByText(/An affected record changed after deletion/u).waitFor(); assert.equal(writes.length, countBeforeConflict);
  assert.equal((await records('dm_notes')).find((record: FixtureRecord) => record.key === 'selection-note').value.body, 'A newer shared note');
  assert.ok(!(await records('planning_items')).some((record: FixtureRecord) => record.key === 'selection-a'));
}
