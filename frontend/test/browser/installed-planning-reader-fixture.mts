import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { InstalledFixture } from './fixture-types.mts';
import { jsonResponse } from './installed-graph-fixture.mts';

export async function exercisePlanningReader({ t, open, admin, csrf, output, mobile }: InstalledFixture): Promise<void> {
  const id = mobile ? 'reader-phone' : 'reader-desktop', location = `${id}-harbor`, headers = { 'X-Codex-CSRF': csrf };
  const generation = (await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`;
  const put = (dataId: string, key: string, value: unknown) => ({ operation: 'put', kind: 'collection', dataId, key, expectedRevision: 0, value });
  const record = { id, schemaVersion: 3, kind: 'event', eventType: mobile ? 'encounter' : 'puzzle', parentId: null, title: `Reader ${id}`, summary: 'At the harbor', objective: '**Find the key**',
    body: '## The door\n\nA *silver* lock.\n\n<script>window.readerInjected=true</script>\n\n[Unsafe](javascript:alert(1))', setup: '- First clue\n- Second clue', resolution: 'Turn the **moon dial**.', tags: ['harbor'], updatedAt: 1 };
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers, data: { contractVersion: 'campaign-mutation.v1', mutations: [{ operation: 'put', collection: 'locations', key: location, expectedRevision: 0, value: { id: location, name: 'Reader harbor', visibility: 'public', parentId: null, x: .2, y: .2 } }] } }));
  await jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations: [
    put('planning_items', id, record),
    put('planning_references', `${id}-ref`, { id: `${id}-ref`, schemaVersion: 3, itemId: id, name: 'Meeting place', relation: 'located-at', target: { scope: 'core', collection: 'locations', id: location }, quantity: 1, notes: '**Low tide** only.', updatedAt: 1 }),
    put('planning_consequences', `${id}-result`, { id: `${id}-result`, schemaVersion: 3, anchor: { scope: 'item', itemId: id }, kind: 'information', title: 'The secret', body: 'Learn the **password**.', updatedAt: 1 }),
    put('dm_notes', `${id}-note`, { id: `${id}-note`, schemaVersion: 3, title: 'Private reminder', body: 'Remember the **raven**.', anchorIds: [id], updatedAt: 1 }),
  ] } }));
  const page = await open(t, 'dm', mobile); page.setDefaultTimeout(10000);
  await page.goto(`/#/map/world/location/${location}/show`);
  await page.locator('.dm-map-planning a').waitFor();
  await page.locator('.sc-panel').screenshot({ path: resolve(output, `reader-map-${mobile ? 'phone' : 'desktop'}.png`) });
  await page.locator('.dm-map-planning').getByRole('link', { name: record.title, exact: true }).click();
  const reader = page.locator(`dialog[data-reader-item="${id}"]`); await reader.waitFor();
  assert.equal(await reader.locator('form,input,textarea').count(), 0);
  await reader.locator('strong').getByText('Find the key', { exact: true }).waitFor();
  await reader.getByRole('heading', { name: mobile ? 'Environment and setup' : 'Clues and setup' }).waitFor();
  await reader.locator('strong').getByText('moon dial', { exact: true }).waitFor();
  await reader.getByRole('link', { name: 'Reader harbor', exact: true }).waitFor();
  await reader.locator('strong').getByText('password', { exact: true }).waitFor();
  await reader.locator('strong').getByText('raven', { exact: true }).waitFor();
  assert.equal(await reader.locator('script, a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => 'readerInjected' in window), false);
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H2');
  await reader.getByRole('button', { name: 'Expand reader', exact: true }).click();
  assert.equal(await reader.getByRole('button', { name: 'Reduce reader', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await reader.screenshot({ path: resolve(output, `reader-${mobile ? 'phone' : 'desktop'}.png`) });
  await reader.getByRole('button', { name: 'Edit item', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit planning item', exact: true });
  await editor.getByLabel('Body', { exact: true }).fill('Saved **new detail**.');
  await editor.getByRole('button', { name: 'Save details', exact: true }).click(); await editor.getByText('Details saved.', { exact: true }).waitFor();
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
  await reader.locator('strong').getByText('new detail', { exact: true }).waitFor();
  await reader.getByRole('button', { name: 'Edit item', exact: true }).click();
  await editor.getByLabel('Body', { exact: true }).fill('Unsaved reader draft');
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
  await reader.getByText('Showing saved content. Unsaved planner edits remain in the editor.', { exact: true }).waitFor();
  await reader.locator('strong').getByText('new detail', { exact: true }).waitFor();
  await reader.getByRole('button', { name: 'Edit item', exact: true }).click();
  assert.equal(await editor.getByLabel('Body', { exact: true }).inputValue(), 'Unsaved reader draft');
  await editor.getByRole('form', { name: 'Planning item details' }).getByRole('button', { name: 'Discard edits', exact: true }).click();
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
  await jsonResponse(await admin.post(`${base}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations: [
    { ...put('dm_notes', `${id}-note`, { id: `${id}-note`, schemaVersion: 3, title: 'Private reminder', body: 'Updated **reminder**.', anchorIds: [id], updatedAt: 2 }), expectedRevision: 1 },
  ] } }));
  await reader.locator('[data-live-refresh]').waitFor();
  await reader.locator('strong').getByText('raven', { exact: true }).waitFor();
  await reader.getByRole('button', { name: 'Reload planner', exact: true }).click();
  await reader.locator('strong').getByText('reminder', { exact: true }).waitFor();
  await page.keyboard.press('Escape'); await reader.waitFor({ state: 'detached' });
  assert.equal(await page.locator(`.dm-plan-card[data-item-id="${id}"]`).evaluate(element => element === document.activeElement), true);
  const viewport = page.locator('.dm-planner-viewport'); await viewport.evaluate(element => { element.scrollLeft = 175; element.scrollTop = 95; });
  const before = await viewport.evaluate(element => [element.scrollLeft, element.scrollTop]);
  await page.getByRole('button', { name: 'Read selected', exact: true }).click(); await reader.waitFor(); await page.keyboard.press('Escape');
  assert.deepEqual(await viewport.evaluate(element => [element.scrollLeft, element.scrollTop]), before);
  await page.reload(); await reader.waitFor(); await reader.locator('strong').getByText('new detail', { exact: true }).waitFor();
  const player = await open(t, 'player', mobile); await player.goto(`/#/map/world/location/${location}/show`); await player.locator('.sc-panel').waitFor();
  assert.equal(await player.locator('.dm-map-planning').count(), 0);
}
