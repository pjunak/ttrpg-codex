import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { jsonResponse } from './installed-graph-fixture.mjs';
import { closePlannerEditor } from './installed-planner-dialog-fixture.mjs';
import { unloadBlocked } from './installed-planner-navigation-fixture.mjs';

async function campaign(admin, csrf) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  return {
    records: async dataId => (await jsonResponse(await admin.post(`${base}/query`, { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents,
    transact: async mutations => jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations } })),
  };
}
const put = (dataId, value) => ({ operation: 'put', kind: 'collection', dataId, key: value.id, expectedRevision: 0, value });
const item = (id, kind, parentId = null) => ({ id, title: id, kind, parentId, schemaVersion: 3, summary: '', objective: '', body: '', setup: '', resolution: '', tags: [], updatedAt: 1, ...(kind === 'event' ? { eventType: 'story' } : {}), ...(kind === 'branch' ? { branchType: 'decision' } : {}) });

export async function exercisePlannerActions({ t, open, admin, csrf, output, mobile }) {
  const { records, transact } = await campaign(admin, csrf), suffix = mobile ? 'phone' : 'desktop', scope = `actions-${suffix}`, a = `${scope}-a`, b = `${scope}-b`, c = `${scope}-c`;
  await transact([
    put('planning_items', item(scope, 'quest')), put('planning_items', item(a, 'quest', scope)), put('planning_items', item(b, 'event', scope)), put('planning_items', item(c, 'branch', scope)),
    put('planning_views', { id: `scope-${scope}`, schemaVersion: 3, scopeId: scope, positions: { [a]: { x: 120, y: 96 }, [b]: { x: 420, y: 96 }, [c]: { x: 120, y: 300 } }, updatedAt: 1 }),
    put('planning_views', { id: `scope-${a}`, schemaVersion: 3, scopeId: a, positions: {}, updatedAt: 1 }),
  ]);
  const page = await open(t, 'dm', mobile); await page.goto(`/#/addons/dm-tools/planner?item=${scope}`);
  const ready = () => page.locator('.dm-planner-shell[aria-busy="false"]').waitFor(), viewport = page.locator('.dm-planner-viewport');
  const card = id => page.locator(`[data-item-id="${id}"]`), port = id => page.locator(`[data-flow-port="${id}"]`);
  const writes = []; page.on('request', request => { if (request.url().endsWith('/data/transactions')) writes.push(request.postDataJSON()); });
  await ready(); const before = await records('planning_items');
  await page.getByRole('button', { name: '+ Event', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit planning item', exact: true }), title = dialog.getByLabel('Title', { exact: true });
  assert.equal(await unloadBlocked(page), true); assert.equal(await dialog.getByRole('tab', { name: 'Links', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('tab', { name: 'Notes', exact: true }).isDisabled(), true);
  await title.fill('Cancel this new event'); await page.screenshot({ path: resolve(output, `planner-create-${suffix}.png`) });
  await dialog.getByRole('button', { name: 'Cancel creation', exact: true }).click();
  assert.equal(await unloadBlocked(page), false); assert.deepEqual(await records('planning_items'), before); assert.equal(writes.length, 0);
  await page.getByRole('button', { name: '+ Branch', exact: true }).click(); await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0); assert.deepEqual(await records('planning_items'), before);
  await page.getByRole('button', { name: '+ Event', exact: true }).click(); await title.fill(`Created ${suffix}`);
  await dialog.getByRole('button', { name: 'Save item', exact: true }).click(); await page.getByText('Details saved.', { exact: true }).waitFor();
  const created = (await records('planning_items')).filter(record => record.value.title === `Created ${suffix}`); assert.equal(created.length, 1); assert.equal(created[0].value.parentId, scope);
  assert.equal(writes.length, 1); assert.equal(writes[0].mutations[0].expectedRevision, 0); assert.equal(await unloadBlocked(page), false);
  await closePlannerEditor(page);

  await card(a).click(); await viewport.focus(); await page.keyboard.press('Enter'); await dialog.waitFor(); assert.equal(await title.inputValue(), a);
  await closePlannerEditor(page); await viewport.focus(); await page.keyboard.press('Shift+Enter'); await page.locator(`.dm-planner-viewport[data-scope="${a}"]`).waitFor();
  await page.getByRole('button', { name: scope, exact: true }).click(); await page.locator(`.dm-planner-viewport[data-scope="${scope}"]`).waitFor(); await ready();
  await viewport.focus(); await page.keyboard.press('?'); const help = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }); await help.waitFor();
  await page.keyboard.press('Shift+Tab'); assert.equal(await help.evaluate(element => element.contains(document.activeElement)), true, await help.evaluate(element => JSON.stringify({ active: document.activeElement?.outerHTML.slice(0, 1000), open: element.open, dialogs: [...document.querySelectorAll('dialog')].map(value => value.outerHTML.slice(0, 350)) })));
  await page.screenshot({ path: resolve(output, `planner-shortcuts-${suffix}.png`) }); await page.keyboard.press('Escape'); assert.equal(await help.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).evaluate(element => element === document.activeElement), true);

  // Click ports support touch/keyboard; the active connection prevents live replacement.
  await port(a).click(); await page.locator('.dm-connection-notice:not([hidden])').waitFor();
  await transact([put('planning_items', item(`${scope}-remote`, 'event', scope))]);
  await page.waitForTimeout(350); assert.equal(await card(`${scope}-remote`).count(), 0);
  await viewport.focus(); await page.keyboard.press('Escape'); await card(`${scope}-remote`).waitFor();
  const beforeConnections = writes.length;
  await port(a).click(); await card(a).click(); assert.equal(writes.length, beforeConnections);
  await port(a).click(); await card(b).click(); await page.getByText('Flow created.', { exact: true }).waitFor();
  assert.ok((await records('planning_flow_links')).some(record => record.value.sourceId === a && record.value.targetId === b && record.value.kind === 'continues'));
  // A reverse link would create a cycle and must not reach the host.
  await port(b).click(); await card(a).click(); await page.getByText(/Flow cycle reaches/u).waitFor(); assert.equal(writes.length, beforeConnections + 1);
  await card(c).click(); await viewport.focus(); await page.keyboard.press('c');
  await card(b).focus(); await page.keyboard.press('Enter'); await page.getByText('Flow created.', { exact: true }).waitFor();
  assert.ok((await records('planning_flow_links')).some(record => record.value.sourceId === c && record.value.targetId === b && record.value.kind === 'option'));

  const layouts = await records('planning_views');
  page.once('dialog', prompt => prompt.dismiss()); await page.getByRole('button', { name: 'Reset layout', exact: true }).click(); assert.deepEqual(await records('planning_views'), layouts);
  page.once('dialog', prompt => prompt.accept()); await page.getByRole('button', { name: 'Reset layout', exact: true }).click(); await page.getByText('Layout reset.', { exact: true }).waitFor();
  const reset = (await records('planning_views')).find(record => record.key === `scope-${scope}`); assert.deepEqual(reset.value.positions, {});
  assert.deepEqual((await records('planning_views')).find(record => record.key === `scope-${a}`), layouts.find(record => record.key === `scope-${a}`));
  await card(a).click(); await viewport.focus(); await page.keyboard.press('ArrowRight'); await page.getByText('Position saved.', { exact: true }).waitFor();
  assert.equal(writes.at(-1).mutations[0].expectedRevision, reset.revision); assert.equal(writes.at(-1).mutations[0].dataId, 'planning_views');

  if (!mobile) {
    // Drag at 200% uses the same logical SVG coordinates as the saved canvas.
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).textContent(), '200%');
    await viewport.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
    await port(c).scrollIntoViewIfNeeded(); const start = await port(c).boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y - 30, { steps: 4 });
    await page.screenshot({ path: resolve(output, 'planner-connection-desktop.png') });
    await viewport.dispatchEvent('pointercancel', { pointerId: 1 }); const beforeCancel = writes.length; await page.mouse.up(); assert.equal(writes.length, beforeCancel);
    assert.equal(await page.locator('.dm-connection-notice:not([hidden])').count(), 0);
    // Return to fit so both endpoints remain reachable in the same pointer drag.
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const from = await port(a).boundingBox(), to = await card(c).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + 30, to.y + 30, { steps: 6 }); await page.mouse.up(); await page.getByText('Flow created.', { exact: true }).waitFor();
    assert.ok((await records('planning_flow_links')).some(record => record.value.sourceId === a && record.value.targetId === c));
  }
}

export async function exercisePlannerCreationFailures({ t, open, admin, csrf }) {
  const { records, transact } = await campaign(admin, csrf), scope = 'creation-failures';
  await transact([put('planning_items', item(scope, 'quest'))]);
  const page = await open(t); await page.goto(`/#/addons/dm-tools/planner?item=${scope}`);
  const ready = () => page.locator('.dm-planner-shell[aria-busy="false"]').waitFor(), dialog = page.getByRole('dialog', { name: 'Edit planning item', exact: true });
  const title = dialog.getByLabel('Title', { exact: true }), save = () => dialog.getByRole('button', { name: 'Save item', exact: true }).click();
  const reload = async () => { await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await ready(); };
  const writePattern = '**/api/addons/dm-tools/generations/*/data/transactions', queryPattern = '**/api/addons/dm-tools/generations/*/data/query';
  let writes = 0; page.on('request', request => { if (request.url().endsWith('/data/transactions')) writes++; });
  await ready(); await page.getByRole('button', { name: '+ Event', exact: true }).click(); await title.fill('Lost creation response');
  await page.route(writePattern, async route => { assert.equal((await route.fetch()).ok(), true); await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); });
  await save(); await page.getByText(/Reload the planner before making another change/u).waitFor();
  await page.unroute(writePattern); await reload(); await page.getByText(/This record changed since editing began/u).waitFor();
  assert.equal(await title.inputValue(), 'Lost creation response'); assert.equal(writes, 1);
  assert.equal((await records('planning_items')).filter(record => record.value.title === 'Lost creation response').length, 1);
  await dialog.getByRole('button', { name: 'Discard edits', exact: true }).click(); assert.equal(await unloadBlocked(page), false); await closePlannerEditor(page);

  await page.getByRole('button', { name: '+ Event', exact: true }).click(); await title.fill('Creation with failed confirming read');
  let release, received; const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { received = resolve; }); t.after(() => release());
  await page.route(writePattern, async route => { const response = await route.fetch(); received(); await held; await route.fulfill({ response }); });
  await save(); await pending;
  assert.equal(await dialog.getByRole('button', { name: 'Cancel creation', exact: true }).isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1);
  await page.route(queryPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })); release();
  await page.getByText(/Reload the planner before making another change/u).waitFor(); assert.equal(await title.isEditable(), false);
  await page.unroute(writePattern); await page.unroute(queryPattern); await reload(); assert.equal(writes, 2); assert.equal(await unloadBlocked(page), false);
  assert.equal((await records('planning_items')).filter(record => record.value.title === 'Creation with failed confirming read').length, 1); await closePlannerEditor(page);

  await page.getByRole('button', { name: '+ Event', exact: true }).click(); await title.fill('Retain across scope navigation');
  await page.evaluate(() => { location.hash = '#/addons/dm-tools/planner'; }); await page.getByRole('button', { name: 'Resume new item', exact: true }).click();
  assert.equal(await title.inputValue(), 'Retain across scope navigation'); assert.equal(await title.isEditable(), true);
  await dialog.getByRole('button', { name: 'Cancel creation', exact: true }).click(); assert.equal(writes, 2); assert.equal(await unloadBlocked(page), false);
}
