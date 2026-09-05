import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { jsonResponse } from './installed-graph-fixture.mjs';

export async function exercisePlannerEditing({ t, open, admin, csrf, output }) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`;
  const headers = { 'X-Codex-CSRF': csrf };
  const records = async dataId => (await jsonResponse(await admin.post(`${base}/query`, { headers,
    data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents;
  const transaction = async mutation => jsonResponse(await admin.post(`${base}/transactions`, { headers,
    data: { contractVersion: 'addon-data-transaction.v1', mutations: [mutation] } }));
  const page = await open(t);
  await page.goto('/#/addons/dm-tools/planner');
  const details = page.getByRole('form', { name: 'Planning item details' });
  const save = () => page.getByRole('button', { name: 'Save details', exact: true }).click();
  const saved = () => page.getByText('Details saved.', { exact: true }).waitFor();
  const reload = async () => {
    await page.getByRole('button', { name: 'Reload planner', exact: true }).click();
    await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  };
  await page.getByRole('button', { name: '+ Event', exact: true }).click();
  await details.getByLabel('Title', { exact: true }).fill('Editor encounter');
  await details.getByLabel('Event type', { exact: true }).selectOption('encounter');
  const textFields = { Summary: 'At the pass', Objective: 'Win passage', Body: 'Negotiate with the watch.', Setup: 'A warning bell rings.', Resolution: 'The gate opens.' };
  for (const [label, value] of Object.entries(textFields)) await details.getByLabel(label, { exact: true }).fill(value);
  await details.getByLabel('Tags', { exact: true }).fill('pass, watch, pass');
  await save(); await saved();
  let event = (await records('planning_items')).find(record => record.value.title === 'Editor encounter');
  assert.ok(event);
  for (const [label, value] of Object.entries(textFields)) assert.equal(event.value[label.toLowerCase()], value);
  assert.equal(event.value.eventType, 'encounter'); assert.deepEqual(event.value.tags, ['pass', 'watch']);
  const eventId = event.key;
  const eventCard = page.locator(`.dm-plan-card[data-item-id="${eventId}"]`);

  await page.getByRole('button', { name: 'Add DM note', exact: true }).click();
  await page.getByText('DM note added.', { exact: true }).waitFor();
  await page.getByLabel('Private details', { exact: true }).fill('Keep this note draft.');
  await details.getByLabel('Title', { exact: true }).fill('   '); await save();
  await page.getByText('A title is required.', { exact: true }).waitFor();
  assert.equal(await details.getByLabel('Title', { exact: true }).inputValue(), '   ');
  assert.equal(await page.getByLabel('Private details', { exact: true }).inputValue(), 'Keep this note draft.');
  await details.getByLabel('Title', { exact: true }).fill('Editor encounter');
  await details.getByLabel('Tags', { exact: true }).fill('x'.repeat(61)); await save();
  await page.getByText('Use up to 40 tags, with at most 60 characters each.', { exact: true }).waitFor();
  assert.equal(await details.getByLabel('Tags', { exact: true }).inputValue(), 'x'.repeat(61));
  await details.getByLabel('Tags', { exact: true }).fill('pass, watch');
  await details.getByLabel('Objective', { exact: true }).fill('Get everyone through.'); await save(); await saved();
  assert.equal(await page.getByLabel('Private details', { exact: true }).inputValue(), 'Keep this note draft.');
  await details.getByLabel('Setup', { exact: true }).fill('Retain the item draft too.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByText('DM note saved.', { exact: true }).waitFor();
  assert.equal(await details.getByLabel('Setup', { exact: true }).inputValue(), 'Retain the item draft too.');

  await page.getByRole('button', { name: '+ Branch', exact: true }).click();
  await details.getByLabel('Title', { exact: true }).fill('Editor choice');
  await details.getByLabel('Branch type', { exact: true }).selectOption('condition'); await save(); await saved();
  const branch = (await records('planning_items')).find(record => record.value.title === 'Editor choice');
  assert.equal(branch.value.branchType, 'condition'); assert.equal(Object.hasOwn(branch.value, 'eventType'), false);
  await eventCard.click();
  assert.equal(await details.getByLabel('Setup', { exact: true }).inputValue(), 'Retain the item draft too.');
  await page.getByRole('button', { name: '+ Quest', exact: true }).click();
  await page.getByRole('button', { name: 'Enter this canvas', exact: true }).click();
  await page.getByText('This canvas is empty. Add a planning item from the Atlas.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Campaign', exact: true }).click(); await eventCard.click();
  assert.equal(await details.getByLabel('Setup', { exact: true }).inputValue(), 'Retain the item draft too.');

  const writePattern = '**/api/addons/dm-tools/generations/*/data/transactions';
  const queryPattern = '**/api/addons/dm-tools/generations/*/data/query';
  await page.route(writePattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await save(); await page.getByText(/Reload the planner before making another change/u).waitFor();
  assert.equal(await details.getByLabel('Setup', { exact: true }).inputValue(), 'Retain the item draft too.');
  assert.equal(await page.getByRole('button', { name: 'Save details', exact: true }).isDisabled(), true);
  await page.unroute(writePattern); await reload(); await save(); await saved();

  // A held write locks the old form; a failed follow-up read cannot offer a second write.
  let releaseWrite, writeReceived;
  const held = new Promise(resolve => { releaseWrite = resolve; });
  const received = new Promise(resolve => { writeReceived = resolve; });
  t.after(() => releaseWrite());
  await page.route(writePattern, async route => {
    const response = await route.fetch(); writeReceived(); await held; await route.fulfill({ response });
  });
  await details.getByLabel('Resolution', { exact: true }).fill('Confirmed before refresh failed.');
  await save(); await received;
  assert.equal(await details.getByLabel('Title', { exact: true }).isDisabled(), true);
  await page.route(queryPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  releaseWrite(); await page.getByText(/Reload the planner before making another change/u).waitFor();
  assert.equal(await details.getByLabel('Resolution', { exact: true }).isEditable(), false);
  await page.unroute(writePattern); await page.unroute(queryPattern); await reload();
  assert.equal(await details.getByLabel('Resolution', { exact: true }).inputValue(), 'Confirmed before refresh failed.');
  assert.equal(await details.getByRole('button', { name: 'Discard edits', exact: true }).isVisible(), false);

  // A refreshed snapshot must not lend a new revision to an older draft.
  await details.getByLabel('Title', { exact: true }).fill('Local conflict draft');
  event = (await records('planning_items')).find(record => record.key === eventId);
  await transaction({ operation: 'put', kind: 'collection', dataId: 'planning_items', key: eventId, expectedRevision: event.revision,
    value: { ...event.value, title: 'Remote saved title', updatedAt: Date.now() } });
  await reload();
  await details.getByText(/This record changed since editing began/u).waitFor();
  assert.equal(await details.getByLabel('Title', { exact: true }).inputValue(), 'Local conflict draft');
  const conflict = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await save(); assert.equal((await conflict).status(), 409);
  await page.getByText(/Reload the planner before making another change/u).waitFor();
  assert.equal((await records('planning_items')).find(record => record.key === eventId).value.title, 'Remote saved title');
  await reload(); await details.getByRole('button', { name: 'Discard edits', exact: true }).click();
  assert.equal(await details.getByLabel('Title', { exact: true }).inputValue(), 'Remote saved title');

  // A lost success response also retains the opening revision until explicit discard.
  await details.getByLabel('Title', { exact: true }).fill('Saved despite a lost response');
  await page.route(writePattern, async route => {
    assert.equal((await route.fetch()).ok(), true);
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await save(); await page.getByText(/Reload the planner before making another change/u).waitFor();
  await page.unroute(writePattern); await reload();
  await details.getByText(/This record changed since editing began/u).waitFor();
  await details.getByRole('button', { name: 'Discard edits', exact: true }).click();
  assert.equal(await details.getByLabel('Title', { exact: true }).inputValue(), 'Saved despite a lost response');

  await page.getByLabel('Private details', { exact: true }).fill('Copy this removed note draft.');
  const note = (await records('dm_notes')).find(record => record.value.anchorIds.includes(eventId));
  await transaction({ operation: 'delete', kind: 'collection', dataId: 'dm_notes', key: note.key, expectedRevision: note.revision });
  await reload(); await page.locator('.dm-planner-removed-draft summary').click();
  await page.getByText(/body: Copy this removed note draft/u).waitFor();
  await page.getByRole('button', { name: 'Discard removed record edits', exact: true }).click();

  const beforePositions = await records('planning_views');
  await eventCard.scrollIntoViewIfNeeded(); const position = await eventCard.boundingBox();
  const original = await eventCard.evaluate(card => ({ left: card.style.left, top: card.style.top }));
  await page.mouse.move(position.x + 30, position.y + 30); await page.mouse.down();
  await page.mouse.move(position.x + 78, position.y + 54);
  await eventCard.dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
  assert.deepEqual(await eventCard.evaluate(card => ({ left: card.style.left, top: card.style.top })), original);
  assert.deepEqual(await records('planning_views'), beforePositions);

  for (const mobile of [false, true]) {
    const view = mobile ? await open(t, 'dm', true) : page;
    if (mobile) await view.goto(`/#/addons/dm-tools/planner?item=${eventId}`);
    await view.getByRole('form', { name: 'Planning item details' }).waitFor();
    const style = await view.locator('.dm-planner-shell h1').evaluate(element => ({ color: getComputedStyle(element).color, font: getComputedStyle(element).fontFamily }));
    assert.equal(style.color, 'rgb(200, 160, 64)'); assert.match(style.font, /Cinzel/u);
    assert.equal(await view.locator('.dm-planner-viewport').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(20, 16, 8)');
    assert.equal(await view.locator('.dm-plan-card').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(36, 28, 13)');
    assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await view.screenshot({ path: resolve(output, mobile ? 'planner-editor-phone.png' : 'planner-editor-desktop.png'), fullPage: false });
  }
}
