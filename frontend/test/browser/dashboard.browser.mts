import { fixtureCollection, fixtureRecord } from './fixture-types.mts';
import type { Browser, Page } from 'playwright';
import type { TestContext } from 'node:test';
import type { PreviewServer } from 'vite';
import type { AddressInfo } from 'node:net';
import type { FixtureCampaign, FixtureMutation } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { visualCampaign, visualFixturePlugin } from './visual-fixture.mts';

let server: PreviewServer, browser: Browser, origin: string, campaign: FixtureCampaign;
const streams = new Set<import("node:http").ServerResponse>();
before(async () => {
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) {
      streams.add(response);
      response.on('close', () => streams.delete(response));
    } })], preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

const collection = (name: string) => fixtureCollection(campaign, name);
const identity = () => fixtureRecord(collection('campaign'), 'main');

async function fixture(t: TestContext, { role = 'dm', mobile = false, reject = false, statuses = true } = {}) {
  campaign = structuredClone(visualCampaign);
  identity().value.extension = { keep: true };
  if (statuses) collection('settings').records.push({ key: 'characterStatuses', revision: 1,
    value: [{ id: 'alive', label: 'Alive' }, { id: 'dead', label: 'Dead' }] });
  const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    extraHTTPHeaders: { 'x-fixture-role': role } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors: string[] = [], writes: FixtureMutation[][] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser errors'));
  // Exercise the production client and receipt parser against synthetic optimistic writes.
  await page.route('**/api/campaign/transactions', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    assert.equal(request.method(), 'POST');
    assert.equal(request.headers()['x-codex-csrf'], 'x'.repeat(32));
    assert.equal(body.contractVersion, 'campaign-mutation.v1');
    writes.push(body.mutations);
    if (reject || body.mutations.some((mutation: FixtureMutation) => mutation.expectedRevision !==
      (collection(mutation.collection).records.find(record => record.key === mutation.key)?.revision ?? 0))) {
      return route.fulfill({ status: 409, json: { error: 'conflict' } });
    }
    const results = [], revisions: Record<string, number> = {};
    for (const mutation of body.mutations) {
      assert.equal(mutation.operation, 'put');
      const target = collection(mutation.collection);
      const index = target.records.findIndex(record => record.key === mutation.key);
      const updated = { key: mutation.key, revision: mutation.expectedRevision + 1, value: mutation.value };
      if (index < 0) target.records.push(updated); else target.records[index] = updated;
      revisions[mutation.collection] = ++target.revision;
      results.push({ collection: mutation.collection, key: mutation.key, beforeRevision: mutation.expectedRevision,
        afterRevision: updated.revision, deleted: false });
    }
    await route.fulfill({ json: { contractVersion: 'campaign-commit.v1', commitId: writes.length,
      occurredAt: '2026-09-05T12:00:00Z', results, collectionRevisions: revisions } });
  });
  await page.goto(origin);
  await page.locator('#campaign-title').waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.live-connected'));
  return { page, writes };
}

async function publish(page: Page, name: string, change: () => void) {
  change();
  const refreshed = page.waitForResponse(response => response.url() === `${origin}/api/campaign`);
  const payload = { sequence: 1, topic: 'campaign-data-changed', resourceId: name,
    revision: String(collection(name).revision), occurredAt: '2026-09-05T12:00:00Z', metadata: { commitId: 1, records: 1 } };
  for (const response of streams) response.write(`id: 1\nevent: campaign-data-changed\ndata: ${JSON.stringify(payload)}\n\n`);
  await refreshed;
}

test('stream hello reconciles campaign changes before initial connection and reconnection', async t => {
  campaign = structuredClone(visualCampaign);
  collection('events').records = [{ key: 'hello-race', revision: 1, value: {
    id: 'hello-race', name: 'Visibility changed during connection', visibility: 'dm', sitting: 1, order: 1,
  } }];
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-role': 'dm' } });
  t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  await page.route('**/api/events', async route => { await gate; await route.continue(); });
  await page.goto(origin + '/#/dm');
  const hidden = page.locator('[data-dm-collection="events"] .dm-count-numbers strong');
  await hidden.filter({ hasText: /^1$/ }).waitFor();
  // This write precedes the stream's cursor and therefore has no live publication.
  fixtureRecord(collection('events'), 'hello-race').value.visibility = 'public';
  collection('events').revision++;
  release();
  await hidden.filter({ hasText: /^0$/ }).waitFor();
  fixtureRecord(collection('events'), 'hello-race').value.visibility = 'dm';
  collection('events').revision++;
  for (const response of [...streams]) response.end();
  await hidden.filter({ hasText: /^1$/ }).waitFor();
});

test('DM edits either hero field through an optimistic save and preserves the rest', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: 'Edit campaign name', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit campaign name', exact: true }).fill('Asurai II');
  await publish(page, 'characters', () => { collection('characters').revision++; });
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Asurai II', exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].expectedRevision, 1);
  assert.deepEqual(identity().value, { name: 'Asurai II', tagline: 'Beyond the northern mountains', extension: { keep: true } });
  await page.getByRole('button', { name: 'Edit campaign tagline', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit campaign tagline', exact: true }).fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.campaign-identity-form').waitFor({ state: 'detached' });
  assert.equal(identity().value.name, 'Asurai II');
  assert.equal(identity().value.tagline, '');
  assert.equal(writes[1][0].expectedRevision, 2);
  assert.equal(await page.locator('.application-alert').count(), 0);
});

test('live identity changes retain the original draft and block stale writes', async t => {
  const { page, writes } = await fixture(t);
  await page.getByRole('button', { name: 'Edit campaign name', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit campaign name', exact: true });
  await input.fill('My campaign draft');
  await publish(page, 'campaign', () => { identity().revision++; identity().value.name = 'Remote title'; collection('campaign').revision++; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await input.inputValue(), 'My campaign draft');
  assert.equal(writes.length, 0);
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Quick search' }).waitFor();
  await page.keyboard.press('Escape');
  assert.ok([origin + '/', origin + '/#/'].includes(page.url()));
  assert.equal(await input.inputValue(), 'My campaign draft');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('heading', { name: 'Remote title', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit campaign name', exact: true }).click();
  await input.fill('Reviewed title');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Reviewed title', exact: true }).waitFor();
  assert.equal(writes[0][0].expectedRevision, 2);
});

test('a server-side save conflict keeps the inline editor usable on a phone', async t => {
  const { page, writes } = await fixture(t, { mobile: true, reject: true });
  await page.getByRole('button', { name: 'Edit campaign tagline', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit campaign tagline', exact: true });
  await input.fill('A mobile draft');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').waitFor();
  assert.equal(writes.length, 1);
  assert.equal(await input.inputValue(), 'A mobile draft');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  page.once('dialog', dialog => dialog.accept());
  await input.press('Escape');
  await page.locator('.campaign-identity-form').waitFor({ state: 'detached' });
});

test('party creation uses the original defaults, survives live refresh, and saves once', async t => {
  const { page, writes } = await fixture(t, { role: 'player' });
  assert.equal(await page.getByRole('button', { name: 'Edit campaign name', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '＋ Add', exact: true }).click();
  await page.locator('.record-editor').waitFor();
  assert.equal(await page.locator('[name="faction"]').inputValue(), 'party');
  assert.equal(await page.locator('[name="knowledge"]').inputValue(), '4');
  assert.equal(await page.locator('[name="status"]').inputValue(), 'alive');
  assert.equal(await page.locator('[name="visibility"]').count(), 0);
  await page.getByLabel('Name', { exact: true }).fill('New companion');
  await publish(page, 'characters', () => { collection('characters').revision++; });
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'New companion');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await page.waitForURL(/#\/characters\/new-companion-/).catch(async error => {
    t.diagnostic(JSON.stringify({ url: page.url(), writes, alert: await page.locator('.application-alert').allTextContents(),
      invalid: await page.locator('.record-editor :invalid').evaluateAll(elements => elements.map(element => ({ name: (element as HTMLInputElement).name, error: (element as HTMLInputElement).validationMessage }))) }));
    throw error;
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].expectedRevision, 0);
  assert.deepEqual(Object.fromEntries(['name','faction','knowledge','status'].map(key => [key, writes[0][0].value[key]])), {
    name: 'New companion', faction: 'party', knowledge: 4, status: 'alive',
  });
  await page.goto(`${origin}/#/party`);
  await page.locator(`.party-member[href="#/characters/${writes[0][0].key}"]`).waitFor();
});

test('party creation cancellation protects notes and returns to the roster without writing', async t => {
  const { page, writes } = await fixture(t);
  await page.goto(`${origin}/#/party/new`);
  await page.getByLabel('Name', { exact: true }).fill('Unsaved member');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved member');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForURL(/#\/party$/);
  await page.getByRole('heading', { name: 'The party', exact: true }).waitFor();
  assert.equal(writes.length, 0);
});

test('party creation remains saveable without an alive status definition', async t => {
  const { page, writes } = await fixture(t, { statuses: false });
  await page.getByRole('button', { name: '＋ Add', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('First member');
  assert.equal(await page.locator('[name="status"]').inputValue(), '');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await page.waitForURL(/#\/characters\/first-member-/);
  assert.equal(writes[0][0].value.faction, 'party');
  assert.equal(writes[0][0].value.status, '');
});

for (const mobile of [false, true]) {
  test(`anonymous dashboard actions open a focused sign-in form (${mobile ? 'phone' : 'desktop'})`, async t => {
    const { page, writes } = await fixture(t, { role: '', mobile });
    await page.getByRole('button', { name: 'Edit campaign name', exact: true }).click();
    assert.equal(await page.locator('input[name="password"]').evaluate(input => input === document.activeElement), true);
    assert.equal(await page.locator('.campaign-identity-form').count(), 0);
    if (mobile) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '＋ Add', exact: true }).click();
    assert.equal(await page.locator('input[name="password"]').evaluate(input => input === document.activeElement), true);
    assert.equal(writes.length, 0);
  });
}
