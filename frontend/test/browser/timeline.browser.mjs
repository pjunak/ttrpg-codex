import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { visualCampaign, visualFixturePlugin } from './visual-fixture.mjs';

let server, browser, origin, campaign, sequence = 0;
const streams = new Set(), output = fileURLToPath(new URL('../../test-results/timeline/', import.meta.url));
const collection = name => campaign.collections.find(item => item.name === name);
const event = key => collection('events').records.find(item => item.key === key);
const card = (page, key) => page.locator(`.tl-card[data-key="${key}"]`);
const column = (page, sitting) => page.locator(`.tl-col[data-sitting="${sitting}"]`);
const ids = (page, sitting) => column(page, sitting).locator('.tl-card').evaluateAll(cards => cards.map(card => card.dataset.key));
before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) { streams.add(response); response.on('close', () => streams.delete(response)); } })],
    preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(t, { role = 'player', mobile = false, locale = 'en-US' } = {}) {
  campaign = structuredClone(visualCampaign); sequence = 0;
  collection('events').records = [
    ...Array.from({ length: 5 }, (_, index) => ({ key: `event-${index}`, revision: 3, value: { id: `event-${index}`, name: `Event ${index}`,
      sitting: index === 0 ? 0 : 1, order: index + 1, short: 'An expedition through the northern mountains.', characters: ['ryn', 'mira'], locations: ['gate'],
      description: '## The old road\nKeep this text.', mapX: .2, mapY: .3, extension: { keep: true }, visibility: 'public' } })),
    { key: 'later', revision: 1, value: { id: 'later', name: 'A later arrival', sitting: 3, order: 1, visibility: 'public' } },
  ];
  const context = await browser.newContext({ locale, reducedMotion: 'reduce', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    extraHTTPHeaders: { 'x-fixture-role': role } });
  t.after(() => context.close());
  if (locale.startsWith('cs')) await context.addInitScript(() => localStorage.setItem('codex_lang', 'cs'));
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const errors = [], writes = [], requests = []; let failure;
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.route('**/api/campaign/transactions', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    assert.equal(route.request().headers()['x-codex-csrf'], 'x'.repeat(32)); assert.equal(body.contractVersion, 'campaign-mutation.v1');
    if (failure) { const status = failure; failure = undefined; return route.fulfill({ status, json: { error: 'Synthetic failure' } }); }
    // Verify the whole request before applying any row, like the host transaction.
    for (const mutation of body.mutations) assert.equal(mutation.expectedRevision, event(mutation.key)?.revision ?? 0);
    const results = [];
    for (const mutation of body.mutations) {
      const record = event(mutation.key);
      if (mutation.operation === 'delete') collection('events').records = collection('events').records.filter(item => item.key !== mutation.key);
      else if (record) { record.value = mutation.value; record.revision++; }
      else collection('events').records.push({ key: mutation.key, revision: 1, value: mutation.value });
      results.push({ collection: 'events', key: mutation.key, beforeRevision: mutation.expectedRevision, afterRevision: mutation.expectedRevision + 1, deleted: mutation.operation === 'delete' });
    }
    writes.push(body.mutations); collection('events').revision++;
    await route.fulfill({ json: { contractVersion: 'campaign-commit.v1', commitId: writes.length, occurredAt: '2026-09-05T12:00:00Z', results,
      collectionRevisions: { events: collection('events').revision } } });
  });
  await page.goto(`${origin}/#/timeline`); await page.locator('.tl-board').waitFor();
  await page.waitForFunction(() => document.querySelector('.live-connected'));
  return { page, writes, requests, failNext: status => { failure = status; } };
}
async function publish(page, change) {
  change(); const revision = ++collection('events').revision;
  const payload = { sequence: ++sequence, topic: 'campaign-data-changed', resourceId: 'events', revision: String(revision), occurredAt: '2026-09-05T12:00:00Z', metadata: { commitId: sequence, records: 1 } };
  for (const response of streams) response.write(`id: ${sequence}\nevent: campaign-data-changed\ndata: ${JSON.stringify(payload)}\n\n`);
  await page.waitForFunction(revision => document.querySelector('codex-timeline')?.campaign.collections.find(item => item.name === 'events').revision === revision, revision);
}
async function saveOrder(page) {
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.waitForFunction(() => { const board = document.querySelector('codex-timeline'); return board && !board.saving && !board.draft; });
}

for (const mobile of [false, true]) {
  test(`timeline keeps original session columns, stacked cards and scrolling (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { mobile });
    assert.deepEqual(await ids(page, 1), ['event-0', 'event-1', 'event-2', 'event-3', 'event-4']);
    assert.equal(await column(page, 2).locator('.tl-col-empty').textContent(), 'No events in this session yet.');
    assert.match(await column(page, 1).getAttribute('class'), /tl-col-stacked/);
    assert.match(await card(page, 'event-0').textContent(), /Ryn, Mira/);
    assert.match(await card(page, 'event-0').textContent(), /Northern Gate/);
    const shell = await page.locator('.tl-shell').boundingBox(), col = await column(page, 1).boundingBox();
    assert.equal(Math.round(shell.x), mobile ? 0 : 240); assert.equal(Math.round(col.width), 260);
    assert.equal(Math.round(shell.height), mobile ? 784 : 1000);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.mouse.move(mobile ? 385 : 1400, 5);
    await page.screenshot({ path: `${output}${mobile ? 'phone' : 'desktop'}-timeline.png`, animations: 'disabled' });
    if (mobile) {
      const slider = page.getByRole('slider', { name: 'Scroll through sessions' }); await slider.fill(await slider.getAttribute('max'));
      assert.ok(await page.locator('.tl-board-viewport').evaluate(node => node.scrollLeft > 0));
      await slider.fill('0');
    }
    await card(page, 'event-0').locator('.tl-card-open').focus(); await page.keyboard.press('Enter');
    await page.waitForURL(/#\/events\/event-0$/); await page.getByRole('link', { name: /Back to timeline/ }).click();
    await page.locator('.tl-board').waitFor(); assert.equal(writes.length, 0);
  });
  test(`timeline move controls save atomically and survive reload (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { mobile });
    await page.getByRole('button', { name: 'Edit timeline' }).click();
    const moveDown = page.getByRole('button', { name: 'Move Event 0 down', exact: true });
    if (mobile) await moveDown.click(); else { await moveDown.focus(); await page.keyboard.press('Enter'); }
    assert.equal(writes.length, 0); assert.deepEqual(await ids(page, 1), ['event-1', 'event-0', 'event-2', 'event-3', 'event-4']);
    await page.getByRole('combobox', { name: 'Move Event 0 to session', exact: true }).selectOption('4');
    assert.deepEqual(await ids(page, 4), ['event-0']);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}${mobile ? 'phone' : 'desktop'}-timeline-edit.png`, animations: 'disabled' });
    await saveOrder(page);
    assert.equal(writes.length, 1); assert.equal(event('event-0').value.sitting, 4); assert.equal(event('event-0').value.order, 1);
    assert.equal(event('event-0').value.mapX, .2); assert.deepEqual(event('event-0').value.extension, { keep: true });
    assert.equal(event('later').revision, 1, 'unrelated session was not normalized');
    await page.reload(); await column(page, 4).waitFor(); assert.deepEqual(await ids(page, 4), ['event-0']);
  });
}

test('native drag creates a draft and rejects a revision changed after dragstart', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: 'Edit timeline' }).click();
  await card(page, 'later').locator('.tl-card-name').dragTo(column(page, 2).locator('.tl-col-body'));
  await column(page, 2).locator('.tl-card[data-key="later"]').waitFor();
  assert.deepEqual(await ids(page, 2), ['later']); assert.equal(writes.length, 0);
  await saveOrder(page); assert.equal(event('later').value.sitting, 2);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card(page, 'event-0').dispatchEvent('dragstart', { dataTransfer });
  await publish(page, () => { event('event-0').revision++; event('event-0').value.name = 'Remote name'; });
  await column(page, 2).dispatchEvent('drop', { dataTransfer, clientY: 500 });
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.locator('.tl-message').filter({ hasText: 'Your order is kept' }).waitFor();
  assert.equal(writes.length, 1); assert.match(await card(page, 'event-0').textContent(), /Event 0/);
  await dataTransfer.dispose();
});

test('live changes and failed saves keep the draft and navigation guard', async t => {
  const { page, writes, requests, failNext } = await fixture(t);
  await page.getByRole('button', { name: 'Edit timeline' }).click();
  await page.getByRole('button', { name: 'Move Event 0 down', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss()); await card(page, 'event-1').locator('.tl-card-open').click();
  await page.waitForURL(/#\/timeline$/);
  assert.match(page.url(), /#\/timeline$/);
  failNext(503); await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.locator('.tl-message').filter({ hasText: 'could not be saved' }).waitFor();
  assert.equal(writes.length, 0);
  failNext(409); await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.locator('.tl-message').filter({ hasText: 'Your order is kept' }).waitFor();
  assert.equal(writes.length, 0); await saveOrder(page); assert.equal(writes.length, 1); assert.equal(requests.length, 3);
  await page.getByRole('button', { name: 'Move Event 0 up', exact: true }).click();
  await publish(page, () => { collection('events').records = collection('events').records.filter(record => record.key !== 'event-4'); });
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.locator('.tl-message').filter({ hasText: 'Your order is kept' }).waitFor(); assert.equal(requests.length, 3);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card(page, 'event-4').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.tl-message').count(), 0);
});

test('timeline creates, edits and deletes events with the common revision-protected form', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: 'Edit timeline' }).click();
  await column(page, 2).getByRole('link', { name: 'New event', exact: false }).click();
  const form = page.locator('.record-editor'); await form.waitFor();
  assert.equal(await form.locator('[name="sitting"]').inputValue(), '2');
  await form.locator('[name="name"]').fill('New encounter');
  await form.getByRole('button', { name: 'Save entry', exact: true }).click(); await form.waitFor({ state: 'detached' });
  const created = writes[0][0].key; assert.equal(event(created).value.sitting, 2);
  await page.getByRole('link', { name: /Back to timeline/ }).click();
  await page.getByRole('button', { name: 'Edit timeline' }).click();
  await card(page, 'event-0').getByRole('link', { name: 'Edit event', exact: true }).click();
  await form.locator('[name="short"]').fill('Changed summary');
  await form.getByRole('button', { name: 'Save entry', exact: true }).click(); await form.waitFor({ state: 'detached' });
  assert.equal(event('event-0').value.order, 1); assert.equal(event('event-0').value.mapX, .2);
  assert.equal(event('event-0').value.short, 'Changed summary'); assert.deepEqual(event('event-0').value.extension, { keep: true });
  await page.locator('.record-article').getByRole('button', { name: 'Edit', exact: true }).click();
  page.once('dialog', dialog => dialog.accept()); await form.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForURL(/#\/timeline$/); await page.locator('.tl-board').waitFor();
  assert.equal(event('event-0'), undefined); assert.equal(writes.at(-1)[0].expectedRevision, 4);
});

test('DM timeline displays the reciprocal twin once and reorders only that visible event', async t => {
  const { page, writes } = await fixture(t, { role: 'dm' });
  event('event-0').value.linkedTwinId = 'dm-event';
  collection('events').records.push({ key: 'dm-event', revision: 5, value: { id: 'dm-event', name: 'The hidden expedition',
    sitting: 1, order: 1, visibility: 'dm', linkedTwinId: 'event-0', secretNotes: 'Retain the DM notes.' } });
  await page.reload(); await card(page, 'dm-event').waitFor(); assert.equal(await card(page, 'event-0').count(), 0);
  await page.getByRole('button', { name: 'Edit timeline' }).click();
  await page.getByRole('combobox', { name: 'Move The hidden expedition to session', exact: true }).selectOption('2');
  await saveOrder(page);
  assert.equal(writes.length, 1); assert.ok(writes[0].every(mutation => mutation.key !== 'event-0'));
  assert.equal(event('dm-event').value.sitting, 2); assert.equal(event('dm-event').value.linkedTwinId, 'event-0');
  assert.equal(event('dm-event').value.secretNotes, 'Retain the DM notes.'); assert.equal(event('event-0').revision, 3);
});

test('empty timelines keep an initial session and a way to create the first event', async t => {
  const { page, writes } = await fixture(t);
  await publish(page, () => { collection('events').records = []; });
  await column(page, 1).locator('.tl-col-empty').waitFor(); assert.equal(await page.locator('.tl-card').count(), 0);
  assert.equal(await page.locator('.tl-col').count(), 1);
  await page.getByRole('button', { name: 'Edit timeline' }).click();
  await column(page, 1).getByRole('link', { name: 'New event', exact: false }).click();
  await page.locator('.record-editor').waitFor(); assert.equal(await page.locator('[name="sitting"]').inputValue(), '1');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.waitForURL(/#\/timeline$/);
  assert.equal(writes.length, 0);
});

test('anonymous timeline and preserved routes remain read-only; clean data refreshes', async t => {
  const { page, writes } = await fixture(t, { role: '' });
  assert.equal(await page.getByRole('button', { name: 'Edit timeline' }).count(), 0);
  assert.equal(await page.locator('.tl-card[draggable="true"]').count(), 0);
  await publish(page, () => { event('later').value.name = 'A changed arrival'; event('later').revision++; });
  await card(page, 'later').getByText('A changed arrival', { exact: true }).waitFor();
  for (const hash of ['#/casova-osa', '#/mapa/casova-osa']) { await page.goto(`${origin}/${hash}`); await page.locator('.tl-board').waitFor(); }
  assert.equal(writes.length, 0);
});

test('Czech timeline labels and old sidebar preferences reach the restored board', async t => {
  const { page } = await fixture(t, { locale: 'cs-CZ', role: 'dm' });
  collection('settings').records.push({ key: 'sidebarLayout', revision: 1, value: { sections: [{ id: 'kampan', label: 'Campaign', pages: ['/casova-osa'] }], hidden: [] } });
  await page.reload();
  await page.locator('.core-navigation').getByRole('link', { name: 'Časová osa', exact: false }).waitFor();
  await page.getByRole('button', { name: 'Upravit osu', exact: false }).click();
  await page.getByRole('button', { name: 'Přesunout Event 0 níž', exact: true }).click();
  await page.getByRole('button', { name: 'Uložit pořadí', exact: true }).waitFor();
});
