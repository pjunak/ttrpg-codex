import { required, fixtureCollection, fixtureRecord } from './fixture-types.mts';
import type { Browser, Page } from 'playwright';
import type { TestContext } from 'node:test';
import type { PreviewServer } from 'vite';
import type { AddressInfo } from 'node:net';
import type { FixtureCampaign, FixtureMutation, FixtureTransaction } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { visualCampaign, visualFixturePlugin } from './visual-fixture.mts';

let server: PreviewServer, browser: Browser, origin: string, campaign: FixtureCampaign, sequence = 0;
const streams = new Set<import("node:http").ServerResponse>();
const output = fileURLToPath(new URL('../../test-results/party-settings/', import.meta.url));
before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error',
    plugins: [visualFixturePlugin({ getCampaign: () => campaign, onStream(response) {
      streams.add(response); response.on('close', () => streams.delete(response));
    } })], preview: { host: '127.0.0.1', port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
const collection = (name: string) => fixtureCollection(campaign, name);
const party = () => fixtureRecord(collection('settings'), 'playerParty');
const panel = (page: Page) => page.locator('codex-party-settings');

async function fixture(t: TestContext, { mobile = false, role = 'dm', reject = false, locale = 'en-US', absent = false, malformed = false } = {}) {
  campaign = structuredClone(visualCampaign);
  if (!absent) collection('settings').records.push({ key: 'playerParty', revision: 3, value: malformed ? [] : {
    name: 'Ember Company', icon: '🦊', badge: '⚔', color: '#dd8833', textColor: '#102030', extension: { keep: true },
  } });
  collection('characters').records.push({ key: 'guard', revision: 1, value: { id: 'guard', name: 'Town Guard', faction: 'neutral' } });
  const context = await browser.newContext({ locale, reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, extraHTTPHeaders: { 'x-fixture-role': role } });
  t.after(() => context.close());
  await context.addInitScript(language => localStorage.setItem('codex_lang', language), locale.startsWith('cs') ? 'cs' : 'en');
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const errors: string[] = [], writes: FixtureMutation[][] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser errors'));
  await page.route('**/api/campaign/transactions', async route => {
    const body: FixtureTransaction = route.request().postDataJSON();
    assert.equal(route.request().headers()['x-codex-csrf'], 'x'.repeat(32));
    assert.equal(body.contractVersion, 'campaign-mutation.v1');
    writes.push(body.mutations);
    assert.equal(body.mutations.length, 1);
    const mutation = body.mutations[0];
    assert.equal(mutation.collection, 'settings'); assert.equal(mutation.key, 'playerParty'); assert.equal(mutation.operation, 'put');
    if (reject || mutation.expectedRevision !== (collection('settings').records.find(record => record.key === 'playerParty')?.revision ?? 0)) return route.fulfill({ status: 409, json: { error: 'conflict' } });
    const next = { key: 'playerParty', revision: mutation.expectedRevision + 1, value: mutation.value };
    const index = collection('settings').records.findIndex(record => record.key === 'playerParty');
    if (index < 0) collection('settings').records.push(next); else collection('settings').records[index] = next;
    collection('settings').revision++;
    await route.fulfill({ json: { contractVersion: 'campaign-commit.v1', commitId: writes.length, occurredAt: '2026-09-05T12:00:00Z',
      results: [{ collection: 'settings', key: 'playerParty', beforeRevision: mutation.expectedRevision, afterRevision: next.revision, deleted: false }],
      collectionRevisions: { settings: collection('settings').revision } } });
  });
  await page.goto(`${origin}/#/settings`);
  await page.locator('.settings-page').waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.live-connected'));
  if (role === 'dm') await page.locator('[data-category="playerParty"]').click();
  return { page, writes };
}

async function publish(page: Page, name: string, change: () => void) {
  change(); collection(name).revision++;
  const revision = collection(name).revision;
  const payload = { sequence: ++sequence, topic: 'campaign-data-changed', resourceId: name, revision: String(revision),
    occurredAt: '2026-09-05T12:00:00Z', metadata: { commitId: sequence, records: 1 } };
  for (const response of streams) response.write(`id: ${sequence}\nevent: campaign-data-changed\ndata: ${JSON.stringify(payload)}\n\n`);
  await page.waitForFunction(({ name, revision }) => document.querySelector('codex-settings')?.campaign.collections.find(item => item.name === name)!.revision === revision, { name, revision });
}

for (const mobile of [false, true]) test(`party settings save and reach their readers (${mobile ? 'phone' : 'desktop'})`, async t => {
  const { page, writes } = await fixture(t, { mobile });
  assert.equal(await panel(page).getByLabel('Name', { exact: true }).inputValue(), 'Ember Company');
  assert.equal(await panel(page).getByRole('link').count(), 4);
  assert.equal(await panel(page).getByText('Town Guard', { exact: true }).count(), 0);
  await panel(page).getByLabel('Name', { exact: true }).fill('Night Owls');
  await panel(page).getByLabel('Icon / emoji', { exact: true }).fill('🦉');
  await panel(page).getByLabel('Color (glow / chip)', { exact: true }).fill('#99ccff');
  await panel(page).getByLabel('Text color', { exact: true }).fill('#203040');
  await publish(page, 'characters', () => { fixtureRecord(collection('characters'), 'ryn').value.name = 'Ryn II'; });
  await panel(page).getByRole('link', { name: /Ryn II/ }).waitFor();
  assert.equal(await panel(page).getByLabel('Name', { exact: true }).inputValue(), 'Night Owls');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('codex-party-settings')?.campaign.collections.find(item => item.name === 'settings')!.records.find(item => item.key === 'playerParty')!.revision === 4);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].expectedRevision, 3);
  assert.deepEqual(party().value, { name: 'Night Owls', icon: '🦉', badge: '🦉', color: '#99ccff', textColor: '#203040', extension: { keep: true } });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const fields = await panel(page).locator('.settings-party-fields input').evaluateAll(inputs => inputs.map(input => ({ x: input.getBoundingClientRect().x, y: input.getBoundingClientRect().y })));
  assert.equal(new Set(fields.map(field => mobile ? field.x : field.y)).size, 1, 'original fields share a desktop row or phone column');
  await page.screenshot({ path: `${output}/party-${mobile ? 'phone' : 'desktop'}.png`, fullPage: true });
  await panel(page).getByRole('link', { name: /Ryn II/ }).click();
  await page.locator('#record-title').waitFor();
  const badge = page.locator('.party-identity-badge');
  assert.equal(await badge.textContent().then(required), '🦉 Night Owls');
  assert.deepEqual(await badge.evaluate(element => { const style = getComputedStyle(element); return [style.backgroundColor, style.color]; }), ['rgb(153, 204, 255)', 'rgb(32, 48, 64)']);
  await page.getByLabel('More actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit all fields', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page.locator('[name="faction"]').waitFor();
  assert.equal(await page.locator('[name="faction"] option[value="party"]').textContent().then(required), '🦉 Night Owls');
  await page.goto(`${origin}/#/party`);
  await page.locator('#party-heading').waitFor();
  assert.match(await page.locator('#party-heading').textContent().then(required), /🦉 Night Owls/);
  assert.equal(await page.locator('.party-member .portrait-fallback').first().textContent().then(required), '🦉');
  assert.match(await page.locator('.party-member .party-portrait').first().getAttribute('style').then(required), /153,\s*204,\s*255/);
});

test('live changes protect the draft; cancel reloads and the next save uses the reviewed revision', async t => {
  const { page, writes } = await fixture(t);
  const name = panel(page).getByLabel('Name', { exact: true });
  await name.fill('My draft');
  await publish(page, 'settings', () => { party().revision++; party().value.name = 'Remote name'; });
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await name.inputValue(), 'My draft'); assert.equal(writes.length, 0);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-category="appearance"]').click();
  assert.equal(await name.inputValue(), 'My draft');
  page.once('dialog', dialog => dialog.dismiss());
  await panel(page).getByRole('link', { name: /Ryn/ }).click();
  await page.waitForURL(/#\/settings$/);
  page.once('dialog', dialog => dialog.accept());
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await name.inputValue(), 'Remote name');
  await name.fill('Reviewed name');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('codex-party-settings')?.campaign.collections.find(item => item.name === 'settings')!.records.find(item => item.key === 'playerParty')!.revision === 5);
  assert.equal(writes[0][0].expectedRevision, 4);
});

test('clean forms follow live refresh, while a deleted party setting cannot consume an old draft', async t => {
  const { page, writes } = await fixture(t);
  const name = panel(page).getByLabel('Name', { exact: true });
  await publish(page, 'settings', () => { party().revision++; party().value.name = 'Remote name'; });
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[name="partyName"]')?.value === 'Remote name');
  await name.fill('Kept draft');
  await publish(page, 'settings', () => { collection('settings').records = []; });
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await name.inputValue(), 'Kept draft'); assert.equal(writes.length, 0);
});

test('server conflicts keep the mobile draft, and discarding a category clears its navigation guard', async t => {
  const { page, writes } = await fixture(t, { mobile: true, reject: true });
  const name = panel(page).getByLabel('Name', { exact: true });
  await name.fill('Phone draft');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await name.inputValue(), 'Phone draft'); assert.equal(writes.length, 1);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-category="language"]').click();
  await page.locator('[data-category="playerParty"]').click();
  assert.equal(await name.inputValue(), 'Ember Company');
  await panel(page).getByRole('link', { name: /Ryn/ }).click();
  await page.locator('#record-title').waitFor();
});

test('Czech party settings create the missing record and keep singular member wording', async t => {
  const { page, writes } = await fixture(t, { locale: 'cs-CZ', absent: true });
  await publish(page, 'characters', () => { collection('characters').records = collection('characters').records.slice(0, 1); });
  await panel(page).getByRole('heading', { name: '1 člen družiny', exact: true }).waitFor();
  await panel(page).getByLabel('Název', { exact: true }).fill('Noční sovy');
  await panel(page).getByRole('button', { name: 'Uložit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('codex-party-settings')?.campaign.collections.find(item => item.name === 'settings')!.records.some(item => item.key === 'playerParty'));
  assert.equal(writes[0][0].expectedRevision, 0); assert.equal(party().value.name, 'Noční sovy');
});

test('malformed saved party settings are visible and cannot be replaced through a default form', async t => {
  const { page, writes } = await fixture(t, { malformed: true });
  await panel(page).getByRole('alert').waitFor();
  assert.equal(await panel(page).getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.equal(writes.length, 0);
});

for (const role of ['', 'player']) test(`${role || 'anonymous'} readers see shared party identity without settings write controls`, async t => {
  const { page, writes } = await fixture(t, { role });
  assert.equal(await page.locator('[data-category="playerParty"]').count(), 0);
  await page.goto(`${origin}/#/party`);
  await page.locator('#party-heading').waitFor();
  assert.match(await page.locator('#party-heading').textContent().then(required), /⚔ Ember Company/);
  assert.equal(writes.length, 0);
});
