import { editPlannerCard } from './installed-planner-dialog-fixture.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { jsonResponse } from './installed-graph-fixture.mjs';

export async function exercisePlannerStructure({ t, open, admin, csrf, output }) {
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`, headers = { 'X-Codex-CSRF': csrf };
  const records = async dataId => (await jsonResponse(await admin.post(`${base}/query`, { headers,
    data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents;
  const transact = async mutations => jsonResponse(await admin.post(`${base}/transactions`, { headers,
    data: { contractVersion: 'addon-data-transaction.v1', mutations } }));
  const put = (dataId, value, expectedRevision = 0) => ({ operation: 'put', kind: 'collection', dataId, key: value.id, expectedRevision, value });
  for (const mobile of [false, true]) {
    const prefix = mobile ? 'structure-phone-' : 'structure-desktop-', id = name => prefix + name;
    const item = (name, kind = 'quest', parent = null) => ({ id: id(name), schemaVersion: 3, kind, parentId: parent ? id(parent) : null,
      title: name, summary: '', body: 'Saved body', objective: '', setup: '', resolution: '', tags: [], updatedAt: 1,
      ...(kind === 'event' ? { eventType: 'puzzle' } : {}), ...(kind === 'branch' ? { branchType: 'decision' } : {}) });
    const seed = [item('home'), item('destination', 'plotline'), item('box', 'quest', 'home'), item('nested', 'quest', 'box'),
      item('child-a', 'event', 'box'), item('child-b', 'event', 'box'), item('free', 'event', 'home'),
      item('branch', 'branch', 'home'), item('endpoint', 'event', 'home'), item('empty'), item('vanishing')];
    await transact([
      ...seed.map(value => put('planning_items', value)),
      put('planning_flow_links', { id: id('inside-flow'), schemaVersion: 3, sourceId: id('child-a'), targetId: id('child-b'), kind: 'continues', label: 'Keep internal flow', updatedAt: 1 }),
      put('planning_flow_links', { id: id('option'), schemaVersion: 3, sourceId: id('branch'), targetId: id('endpoint'), kind: 'option', label: 'Keep option', updatedAt: 1 }),
      put('planning_references', { id: id('reference'), schemaVersion: 3, itemId: id('destination'), name: 'Keep reference', relation: 'related', target: { scope: 'planning', itemId: id('box') }, quantity: 1, notes: 'Keep notes', updatedAt: 1 }),
      put('planning_consequences', { id: id('effect'), schemaVersion: 3, anchor: { scope: 'item', itemId: id('box') }, kind: 'information', title: 'Keep effect', body: 'Keep meaning', updatedAt: 1 }),
      put('dm_notes', { id: id('note'), schemaVersion: 3, title: 'Keep note', body: 'Keep text', anchorIds: [id('box'), id('destination')], updatedAt: 1 }),
      ...['home', 'box'].map(scope => put('planning_views', { id: `scope-${id(scope)}`, schemaVersion: 3, scopeId: id(scope),
        positions: { [id(scope === 'home' ? 'box' : 'child-a')]: { x: 72, y: 72 } }, updatedAt: 1 })),
    ]);
    const page = await open(t, 'dm', mobile), details = page.getByRole('form', { name: 'Planning item details' });
    const card = name => page.locator(`.dm-plan-card[data-item-id="${id(name)}"]`);
    const scope = async name => { await page.goto(`/#/addons/dm-tools/planner${name ? `?item=${id(name)}` : ''}`); };
    const save = async () => { await details.getByRole('button', { name: 'Save details', exact: true }).click(); await page.getByText('Details saved.', { exact: true }).waitFor(); };
    const discard = async () => details.getByRole('button', { name: 'Discard edits', exact: true }).click();
    const stored = async name => (await records('planning_items')).find(record => record.key === id(name));
    let writes = 0; page.on('request', request => { if (request.url().endsWith('/data/transactions')) writes++; });

    await scope('home'); await editPlannerCard(page, card('free')); await details.getByLabel('Body', { exact: true }).fill('Keep the other item draft');
    await editPlannerCard(page, card('box'));
    for (const excluded of ['box', 'nested', 'child-a', 'free']) assert.equal(await details.getByLabel('Parent', { exact: true }).locator(`option[value="${id(excluded)}"]`).count(), 0);
    const preserved = {};
    for (const collection of ['planning_flow_links', 'planning_references', 'planning_consequences', 'dm_notes', 'planning_views']) preserved[collection] = await records(collection);
    await details.getByLabel('Kind', { exact: true }).selectOption('plotline');
    await details.getByLabel('Parent', { exact: true }).selectOption(id('destination'));
    await details.getByLabel('Body', { exact: true }).fill('Moved with all its children'); await save();
    await page.waitForURL(`**/#/addons/dm-tools/planner?item=${id('destination')}`);
    await card('box').waitFor(); assert.equal(await details.getByLabel('Parent', { exact: true }).inputValue(), id('destination'));
    assert.equal((await stored('box')).value.kind, 'plotline');
    for (const child of ['nested', 'child-a', 'child-b']) assert.deepEqual((await stored(child)).value, seed.find(value => value.id === id(child)));
    for (const [collection, previous] of Object.entries(preserved)) assert.deepEqual(await records(collection), previous);
    await details.getByLabel('Kind', { exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, `planner-structure-${mobile ? 'phone' : 'desktop'}.png`), fullPage: false });
    let previousWrites = writes;
    await details.getByLabel('Kind', { exact: true }).selectOption('event');
    await details.getByRole('button', { name: 'Save details', exact: true }).click();
    await page.getByText(/Move this item's children first/u).waitFor(); assert.equal(writes, previousWrites); await discard();

    await scope('home'); await editPlannerCard(page, card('free'));
    assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep the other item draft');
    await details.getByLabel('Kind', { exact: true }).selectOption('branch'); await details.getByLabel('Branch type').selectOption('random');
    await details.getByLabel('Kind', { exact: true }).selectOption('quest'); await details.getByLabel('Kind', { exact: true }).selectOption('branch');
    assert.equal(await details.getByLabel('Branch type').inputValue(), 'random');
    await editPlannerCard(page, card('branch')); await editPlannerCard(page, card('free'));
    assert.equal(await details.getByLabel('Kind', { exact: true }).inputValue(), 'branch');
    assert.equal(await details.getByLabel('Branch type').inputValue(), 'random');
    await details.getByLabel('Parent', { exact: true }).selectOption(id('destination')); await save();
    await card('free').waitFor(); assert.equal((await stored('free')).value.eventType, undefined);
    assert.equal((await stored('free')).value.branchType, 'random');
    await page.reload(); await details.getByLabel('Branch type').waitFor();
    assert.equal(await details.getByLabel('Body', { exact: true }).inputValue(), 'Keep the other item draft');
    await details.getByLabel('Kind', { exact: true }).selectOption('event'); await details.getByLabel('Event type').selectOption('encounter'); await save();
    assert.equal((await stored('free')).value.branchType, undefined); assert.equal((await stored('free')).value.eventType, 'encounter');

    await scope('home'); await editPlannerCard(page, card('branch')); previousWrites = writes;
    await details.getByLabel('Parent', { exact: true }).selectOption(id('destination'));
    await details.getByRole('button', { name: 'Save details', exact: true }).click();
    await page.getByText(/This item has story flows on its current canvas/u).waitFor(); assert.equal(writes, previousWrites); await discard();
    await details.getByLabel('Kind', { exact: true }).selectOption('event');
    await details.getByRole('button', { name: 'Save details', exact: true }).click();
    await page.getByText(/Option flows must start at a branch/u).waitFor(); assert.equal(writes, previousWrites); await discard();
    assert.ok((await records('planning_flow_links')).some(record => record.key === id('option')));

    // A deleted destination remains an unavailable draft choice, never Campaign.
    await scope('free'); await details.getByLabel('Parent', { exact: true }).selectOption(id('vanishing'));
    await details.getByLabel('Body', { exact: true }).fill('Keep the missing-parent draft');
    const vanishing = await stored('vanishing');
    await transact([{ operation: 'delete', kind: 'collection', dataId: 'planning_items', key: vanishing.key, expectedRevision: vanishing.revision }]);
    await page.getByRole('button', { name: 'Reload planner', exact: true }).click();
    await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
    assert.equal(await details.getByLabel('Parent', { exact: true }).inputValue(), id('vanishing'));
    assert.match(await details.getByLabel('Parent', { exact: true }).locator('option:checked').textContent(), /Unavailable/u);
    previousWrites = writes;
    await details.getByRole('button', { name: 'Save details', exact: true }).click(); await page.getByText(/has a missing parent/u).waitFor();
    assert.equal(writes, previousWrites); assert.equal((await stored('free')).value.parentId, id('destination'));
    await details.getByLabel('Parent', { exact: true }).selectOption(id('home')); await save();
    assert.equal((await stored('free')).value.body, 'Keep the missing-parent draft');

    // A concurrently added child must prevent converting its parent to a leaf.
    await scope(); await editPlannerCard(page, card('empty')); await details.getByLabel('Kind', { exact: true }).selectOption('event');
    await transact([put('planning_items', item('late-child', 'event', 'empty'))]);
    await details.getByRole('button', { name: 'Save details', exact: true }).click();
    await page.getByText(/Reload the planner before making another change/u).waitFor();
    assert.equal((await stored('empty')).value.kind, 'quest'); assert.ok(await stored('late-child'));
    await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
    assert.equal(await details.getByLabel('Kind', { exact: true }).inputValue(), 'event');
    previousWrites = writes;
    await details.getByRole('button', { name: 'Save details', exact: true }).click(); await page.getByText(/Move this item's children first/u).waitFor();
    assert.equal(writes, previousWrites); await discard();

    if (!mobile) {
      // A confirmed move with a failed follow-up read is recovered without resubmitting.
      await scope('free'); await details.getByLabel('Parent', { exact: true }).selectOption(id('destination'));
      const queryPattern = '**/api/addons/dm-tools/generations/*/data/query';
      await page.route(queryPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await details.getByRole('button', { name: 'Save details', exact: true }).click();
      await page.getByText(/Reload the planner before making another change/u).waitFor();
      const moved = await stored('free'); assert.equal(moved.value.parentId, id('destination'));
      previousWrites = writes; await page.unroute(queryPattern);
      await page.getByRole('button', { name: 'Reload planner', exact: true }).click(); await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
      await card('free').waitFor(); await page.locator('.dm-planner-breadcrumbs .active').filter({ hasText: /^destination$/u }).waitFor();
      assert.equal(await details.getByLabel('Parent', { exact: true }).inputValue(), id('destination'));
      assert.equal(writes, previousWrites); assert.equal((await stored('free')).revision, moved.revision);
    }
  }
}
