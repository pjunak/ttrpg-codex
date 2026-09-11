import { required } from './fixture-types.mts';
import type { FixtureRecord, InstalledFixture } from './fixture-types.mts';
import { closePlannerEditor, editPlannerCard } from './installed-planner-dialog-fixture.mts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { jsonResponse } from './installed-graph-fixture.mts';

export async function exercisePlannerCanvas({ t, open, admin, csrf, output, mobile }: Pick<InstalledFixture, 't' | 'open' | 'admin' | 'csrf' | 'output' | 'mobile'>) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  const suffix = mobile ? 'phone' : 'desktop', quest = `canvas-${suffix}`, event = `${quest}-event`, peer = `${quest}-peer`;
  const item = (id: string, kind: string, parentId: string | null) => ({ id, schemaVersion: 3, kind, parentId, title: id, summary: 'Canvas navigation retains the original authored content.', body: '', objective: '', setup: '', resolution: '', tags: [], updatedAt: 1, ...(kind === 'event' ? { eventType: 'story' } : {}) });
  const put = (dataId: string, value: Record<string, unknown>) => ({ operation: 'put', kind: 'collection', dataId, key: value.id, expectedRevision: 0, value });
  await jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations: [
    put('planning_items', item(quest, 'quest', null)), put('planning_items', item(event, 'event', quest)), put('planning_items', item(peer, 'event', quest)),
    put('planning_views', { id: `scope-${quest}`, schemaVersion: 3, scopeId: quest, positions: { [event]: { x: 72, y: 72 }, [peer]: { x: 1500, y: 850 } }, updatedAt: 1 }),
  ] } }));
  const page = await open(t, 'dm', mobile); await page.goto(`/#/addons/dm-tools/planner?item=${quest}`);
  const viewport = page.getByLabel('Story canvas', { exact: true }), controls = page.getByRole('group', { name: 'Canvas controls', exact: true });
  const first = page.locator(`[data-item-id="${event}"]`), zoom = page.locator('button[aria-label="Reset zoom to 100%"]');
  await first.waitFor(); assert.equal(await zoom.textContent().then(required), '100%');
  await controls.getByRole('button', { name: 'Zoom out', exact: true }).click(); assert.equal(await zoom.textContent().then(required), '90%');
  await controls.getByRole('button', { name: 'Zoom in', exact: true }).click(); assert.equal(await zoom.textContent().then(required), '100%');
  await controls.getByRole('button', { name: 'Fit', exact: true }).click(); assert.ok(Number((await zoom.textContent().then(required)).replace('%', '')) < 100);
  assert.equal(await first.evaluate(element => getComputedStyle(element).transform), 'none');
  await zoom.click(); await editPlannerCard(page, first);
  const details = page.getByRole('form', { name: 'Planning item details' }); await details.getByLabel('Summary', { exact: true }).fill('Retain the draft while navigating the canvas.');
  await viewport.evaluate(element => { element.scrollLeft = 220; element.scrollTop = 160; });
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  assert.equal(await viewport.evaluate(element => element.scrollLeft), 220); assert.equal(await viewport.evaluate(element => element.scrollTop), 160);
  assert.equal(await details.getByLabel('Summary', { exact: true }).inputValue(), 'Retain the draft while navigating the canvas.');
  await closePlannerEditor(page); await controls.getByRole('button', { name: 'Focus selected', exact: true }).click();
  const before = await viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
  await viewport.focus(); await page.keyboard.press('Control+ArrowRight');
  assert.equal(await viewport.evaluate(element => element.scrollLeft), before.x + 48);
  await page.keyboard.press('-'); assert.equal(await zoom.textContent().then(required), '90%'); await page.keyboard.press('0'); assert.equal(await zoom.textContent().then(required), '100%');
  await controls.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await page.locator('.dm-planner-expanded').waitFor();
  assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), true);
  await controls.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await page.locator('.dm-planner-expanded').waitFor({ state: 'detached' });
  await controls.getByRole('button', { name: 'Fit', exact: true }).click(); const fitted = await zoom.textContent().then(required);
  await page.getByRole('button', { name: 'Campaign', exact: true }).click(); await page.locator('.dm-planner-viewport[data-scope=""]').waitFor(); assert.equal(await zoom.textContent().then(required), '100%');
  await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  await page.goto(`/#/addons/dm-tools/planner?item=${event}`); await page.locator(`.dm-planner-viewport[data-scope="${quest}"]`).waitFor(); assert.equal(await zoom.textContent().then(required), fitted);
  await page.getByRole('button', { name: 'Edit item', exact: true }).click();
  assert.equal(await details.getByLabel('Summary', { exact: true }).inputValue(), 'Retain the draft while navigating the canvas.');
  await details.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await closePlannerEditor(page); await controls.getByRole('button', { name: 'Zoom in', exact: true }).click();
  // Use 200% to verify pointer coordinates are converted back to stored coordinates.
  for (let i = 0; i < 15; i++) await controls.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.equal(await zoom.textContent().then(required), '200%');
  await closePlannerEditor(page); await controls.getByRole('button', { name: 'Focus selected', exact: true }).click();
  const box = await first.boundingBox().then(required); assert.ok(box);
  const canvas = await viewport.boundingBox().then(required); assert.ok(canvas);
  const start = { x: Math.max(box.x, canvas.x) + 24, y: Math.max(box.y, canvas.y) + 24 };
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 96, start.y + 48, { steps: 6 }); await page.mouse.up();
  await page.getByText('Position saved.', { exact: true }).waitFor();
  const documents = (await jsonResponse(await admin.post(`${base}/query`, { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId: 'planning_views', limit: 200, where: [] } }))).documents;
  const saved = documents.find((record: FixtureRecord) => record.value.scopeId === quest);
  assert.deepEqual(saved.value.positions[event], { x: 120, y: 96 }); assert.deepEqual(saved.value.positions[peer], { x: 1500, y: 850 });
  await zoom.click(); await controls.getByRole('button', { name: 'Focus selected', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await viewport.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, `planner-canvas-${suffix}.png`) });
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor(); await closePlannerEditor(page, 'cs');
  await page.getByRole('button', { name: 'Přizpůsobit', exact: true }).waitFor();
}
