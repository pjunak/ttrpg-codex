import { plannerTab } from './installed-planner-dialog-fixture.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { jsonResponse } from './installed-graph-fixture.mjs';

export async function exercisePlannerAnnotations({ t, open, admin, csrf, output, mobile }) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  const records = async dataId => (await jsonResponse(await admin.post(`${base}/query`, { headers,
    data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents;
  const write = async (dataId, value, expectedRevision = 0) => jsonResponse(await admin.post(`${base}/transactions`, { headers,
    data: { contractVersion: 'addon-data-transaction.v1', mutations: [{ operation: 'put', kind: 'collection', dataId, key: value.id, value, expectedRevision }] } }));
  const suffix = mobile ? 'phone' : 'desktop', id = `annotation-${suffix}`, peer = `${id}-peer`;
  for (const key of [id, peer]) await write('planning_items', { id: key, schemaVersion: 3, kind: 'event', eventType: 'story', parentId: null,
    title: key, summary: '', body: '', objective: '', setup: '', resolution: '', tags: [], updatedAt: 1 });
  const page = await open(t, 'dm', mobile); await page.goto(`/#/addons/dm-tools/planner?item=${id}`);
  await page.getByRole('form', { name: 'Planning item details' }).waitFor();
  const reload = async () => { await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor(); };
  await plannerTab(page, 'Links'); await page.locator('summary').filter({ hasText: /^Add reference$/u }).click();
  const create = page.getByRole('form', { name: 'Create reference' });
  await create.getByLabel('Target type', { exact: true }).selectOption('core');
  await create.getByLabel('Campaign target', { exact: true }).selectOption('["events","arrival"]');
  await create.getByLabel('Reference name (optional)', { exact: true }).fill('Gate encounter');
  await reload();
  assert.equal(await create.getByLabel('Campaign target', { exact: true }).inputValue(), '["events","arrival"]');
  await create.getByRole('button', { name: 'Add reference', exact: true }).click(); await page.getByText('Reference added.', { exact: true }).waitFor();
  let reference = (await records('planning_references')).find(record => record.value.itemId === id);
  assert.deepEqual(reference.value.target, { scope: 'core', collection: 'events', id: 'arrival' });
  const form = page.locator(`[data-reference-id="${reference.key}"]`);
  assert.equal(await form.getByRole('link').getAttribute('href'), '#/events/arrival');
  await form.getByLabel('Quantity', { exact: true }).fill('4');
  await form.getByLabel('Relation', { exact: true }).selectOption('involves');
  await form.getByLabel('Target type', { exact: true }).selectOption('external');
  for (const [label, value] of [['Add-on ID', 'rules-addon'], ['Record kind', 'monster'], ['Record ID', 'wolf'], ['Target label', 'Wolf']]) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole('button', { name: 'Save reference', exact: true }).click(); await page.getByText('Reference saved.', { exact: true }).waitFor();
  reference = (await records('planning_references')).find(record => record.key === reference.key);
  assert.equal(reference.value.quantity, 4); assert.equal(reference.value.relation, 'involves');
  assert.deepEqual(reference.value.target, { scope: 'external', addonId: 'rules-addon', kind: 'monster', id: 'wolf', label: 'Wolf' });
  await form.getByLabel('Target type', { exact: true }).selectOption('planning'); await form.getByLabel('Planning target', { exact: true }).selectOption(peer);
  await form.getByRole('button', { name: 'Save reference', exact: true }).click(); await page.getByText('Reference saved.', { exact: true }).waitFor();
  reference = (await records('planning_references')).find(record => record.key === reference.key);
  assert.deepEqual(reference.value.target, { scope: 'planning', itemId: peer });

  // An unavailable saved core target survives an unrelated edit.
  await write('planning_references', { ...reference.value, target: { scope: 'core', collection: 'characters', id: 'missing-character' } }, reference.revision);
  await reload(); await form.getByLabel('Notes', { exact: true }).fill('Retain the unavailable target.');
  await form.getByRole('button', { name: 'Save reference', exact: true }).click(); await page.getByText('Reference saved.', { exact: true }).waitFor();
  reference = (await records('planning_references')).find(record => record.key === reference.key);
  assert.deepEqual(reference.value.target, { scope: 'core', collection: 'characters', id: 'missing-character' });

  await page.getByRole('button', { name: 'Add consequence', exact: true }).click(); await page.getByText('Consequence added.', { exact: true }).waitFor();
  const consequence = page.locator('[data-consequence-id]');
  await consequence.getByLabel('Target type', { exact: true }).selectOption('core'); await consequence.getByLabel('Campaign target', { exact: true }).selectOption('["events","arrival"]');
  await consequence.getByRole('button', { name: 'Save consequence', exact: true }).click(); await page.getByText('Consequence saved.', { exact: true }).waitFor();
  let savedConsequence = (await records('planning_consequences')).find(record => record.value.anchor.itemId === id);
  assert.deepEqual(savedConsequence.value.target, { scope: 'core', collection: 'events', id: 'arrival' });
  await consequence.getByLabel('Target type', { exact: true }).selectOption('none');
  await consequence.getByRole('button', { name: 'Save consequence', exact: true }).click(); await page.getByText('Consequence saved.', { exact: true }).waitFor();
  savedConsequence = (await records('planning_consequences')).find(record => record.key === savedConsequence.key);
  assert.equal(Object.hasOwn(savedConsequence.value, 'target'), false);

  await plannerTab(page, 'Notes'); await page.getByRole('button', { name: 'Add DM note', exact: true }).click(); await page.getByText('DM note added.', { exact: true }).waitFor();
  const note = page.locator('[data-note-id]');
  await note.getByRole('checkbox', { name: peer, exact: true }).check();
  await note.getByLabel('Private details', { exact: true }).fill('Shared scene details'); await reload();
  assert.equal(await note.getByRole('checkbox', { name: peer, exact: true }).isChecked(), true);
  const pattern = '**/api/addons/dm-tools/generations/*/data/transactions';
  await page.route(pattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await note.getByRole('button', { name: 'Save note', exact: true }).click(); await page.getByText(/Reload the planner before making another change/u).waitFor();
  assert.equal(await note.getByRole('checkbox', { name: peer, exact: true }).isChecked(), true);
  await page.unroute(pattern); await reload();
  await note.getByRole('button', { name: 'Save note', exact: true }).click(); await page.getByText('DM note saved.', { exact: true }).waitFor();
  let savedNote = (await records('dm_notes')).find(record => record.value.anchorIds.includes(id));
  assert.deepEqual(savedNote.value.anchorIds, [id, peer]); assert.equal(savedNote.value.body, 'Shared scene details');
  await note.getByRole('checkbox', { name: id, exact: true }).uncheck(); await note.getByRole('checkbox', { name: peer, exact: true }).uncheck();
  await note.getByRole('button', { name: 'Save note', exact: true }).click(); await page.getByText('Unanchored note — link it to a planning item below.', { exact: true }).waitFor();
  await note.getByRole('checkbox', { name: peer, exact: true }).check();
  await note.getByRole('button', { name: 'Save note', exact: true }).click(); await page.getByText('DM note saved.', { exact: true }).waitFor();
  assert.equal(await note.count(), 0);
  await page.goto(`/#/addons/dm-tools/planner?item=${peer}`); await plannerTab(page, 'Notes'); await note.waitFor();
  assert.equal(await note.getByLabel('Private details', { exact: true }).inputValue(), 'Shared scene details');
  savedNote = (await records('dm_notes')).find(record => record.key === savedNote.key); assert.deepEqual(savedNote.value.anchorIds, [peer]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await note.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, `planner-annotations-${suffix}.png`) });
}
