import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { FixtureRecord, InstalledFixture } from './fixture-types.mts';
import { required } from './fixture-types.mts';
import { jsonResponse, installReviewedPackage } from './installed-graph-fixture.mts';
import { dmToolsPermissions } from './installed-dm-fixture.mts';
import { replacementImportPackage } from './installed-import-fixture.mts';
import { closePlannerEditor, editPlannerCard, plannerTab } from './installed-planner-dialog-fixture.mts';

type Fixture = Pick<InstalledFixture, 't' | 'open' | 'admin' | 'csrf' | 'output'> & { archive: Buffer };
const recoveryKey = JSON.stringify(['dm-tools-planner-drafts.v1', 'dm-tools', 'dm']);
const writePattern = '**/api/addons/dm-tools/generations/*/data/transactions';
const queryPattern = '**/api/addons/dm-tools/generations/*/data/query';
const item = (id: string, kind = 'event') => ({ id, schemaVersion: 3, kind, parentId: null, title: id,
  summary: '', objective: '', body: '', setup: '', resolution: '', tags: [], updatedAt: 1, ...(kind === 'event' ? { eventType: 'story' } : {}) });
const put = (dataId: string, value: Record<string, unknown>, expectedRevision = 0) => ({ operation: 'put', kind: 'collection', dataId, key: value.id, expectedRevision, value });

async function fixtureData({ admin, csrf }: Fixture, prefix: string) {
  const headers = { 'X-Codex-CSRF': csrf };
  const base = async () => `/api/addons/dm-tools/generations/${(await jsonResponse(await admin.get('/api/admin/addons/dm-tools'))).state.activeGenerationId}/data`;
  const transact = async (mutations: unknown[]) => jsonResponse(await admin.post(`${await base()}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations } }));
  const records = async (dataId: string): Promise<FixtureRecord[]> => (await jsonResponse(await admin.post(`${await base()}/query`, { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId, limit: 200, where: [] } }))).documents;
  const a = prefix + '-a', b = prefix + '-b', c = prefix + '-c', parent = prefix + '-parent';
  const flow = prefix + '-flow', reference = prefix + '-reference', consequence = prefix + '-consequence', note = prefix + '-note';
  await transact([
    ...[a, b, c].map(id => put('planning_items', item(id))), put('planning_items', item(parent, 'quest')),
    put('planning_flow_links', { id: flow, schemaVersion: 3, sourceId: a, targetId: b, kind: 'continues', label: 'Saved flow', updatedAt: 1 }),
    put('planning_references', { id: reference, schemaVersion: 3, itemId: a, name: 'Saved reference', relation: 'related', target: { scope: 'planning', itemId: b }, quantity: 1, notes: 'Saved reference prose', updatedAt: 1 }),
    put('planning_consequences', { id: consequence, schemaVersion: 3, anchor: { scope: 'item', itemId: a }, kind: 'world', title: 'Saved consequence', body: 'Saved consequence prose', updatedAt: 1 }),
    put('dm_notes', { id: note, schemaVersion: 3, title: 'Saved note', body: 'Saved note prose', anchorIds: [a, b], updatedAt: 1 }),
  ]);
  return { a, b, c, parent, flow, reference, consequence, note, transact, records };
}
async function choose(root: Page | Locator, name: string, value: string) {
  const select = root.getByLabel(name, { exact: true }).and(root.locator('select'));
  if (await select.isVisible()) { await select.selectOption(value); return; }
  const target = await select.evaluate((node, value) => {
    const options = [...(node as HTMLSelectElement).options], option = options.find(option => option.value === value);
    if (!option) throw new Error('Missing fixture choice: ' + value);
    return { label: option.label, duplicate: options.filter(candidate => candidate.label === option.label).indexOf(option) };
  }, value);
  await root.getByRole('combobox', { name, exact: true }).fill(target.label);
  await root.getByRole('option', { name: target.label, exact: true }).nth(target.duplicate).click();
}
async function edit(page: Page, id: string) {
  await page.goto(`/#/addons/dm-tools/planner?item=${id}`);
  await page.getByRole('button', { name: 'Edit item', exact: true }).click();
  await page.getByRole('form', { name: 'Planning item details', exact: true }).waitFor();
}
async function replace(fixture: Fixture, page: Page) {
  const previous = await page.locator('.dm-tools-planner').evaluate(node => node.localName);
  await installReviewedPackage(fixture.admin, fixture.csrf, 'dm-tools', replacementImportPackage(fixture.archive), dmToolsPermissions);
  await page.waitForFunction(previous => {
    const node = document.querySelector('.dm-tools-planner'); return node && node.localName !== previous;
  }, previous);
}
async function reload(page: Page) {
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
}
async function copiedDrafts(page: Page, output: string, name: string): Promise<string> {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download drafts', exact: true }).click();
  const file = resolve(output, name + '.txt'); await (await downloaded).saveAs(file);
  return readFile(file, 'utf8');
}

export async function exercisePlannerRecovery(fixture: Fixture & { mobile: boolean }) {
  const { t, open, output, mobile } = fixture, data = await fixtureData(fixture, 'recover-' + (mobile ? 'phone' : 'desktop'));
  // Exercise the real searchable parent control even when this case runs alone.
  if (mobile) await data.transact(Array.from({ length: 12 }, (_, index) => put('planning_items', item(`recover-phone-choice-${index}`, 'quest'))));
  const page = await open(t, 'dm', mobile); await edit(page, data.a);
  let writes = 0; page.on('request', request => { if (request.url().endsWith('/data/transactions')) writes++; });
  await page.getByLabel('Body', { exact: true }).fill('Retained item prose');
  await plannerTab(page, 'Links');
  await page.getByText('Edit flow', { exact: true }).click();
  const flow = page.getByRole('form', { name: 'Edit story flow', exact: true });
  await flow.getByLabel('Flow label', { exact: true }).fill('Retained flow label');
  const reference = page.locator(`[data-reference-id="${data.reference}"]`);
  await reference.getByLabel('Notes', { exact: true }).fill('Retained reference prose');
  const consequence = page.locator(`[data-consequence-id="${data.consequence}"]`);
  await consequence.getByLabel('Details', { exact: true }).fill('Retained consequence prose');
  const createFlow = page.getByRole('form', { name: 'Create story flow', exact: true });
  await choose(createFlow, 'Flow target', data.c);
  await createFlow.getByLabel('Flow label', { exact: true }).fill('Retained new flow');
  await plannerTab(page, 'Notes');
  const note = page.locator(`[data-note-id="${data.note}"]`);
  await note.getByLabel('Private details', { exact: true }).fill('Retained note prose');
  await closePlannerEditor(page);
  await page.getByRole('button', { name: '+ Quest', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Retained provisional quest');
  if (mobile) await page.getByRole('combobox', { name: 'Parent', exact: true }).locator('xpath=self::input').waitFor();
  await choose(page, 'Parent', data.parent);
  const before = JSON.parse(required(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)));
  const provisionalId = before.provisional.id;
  await replace(fixture, page);
  await page.getByRole('button', { name: 'Resume drafts', exact: true }).waitFor();
  assert.equal(writes, 0);
  const recoveryRoute = new URL(page.url()).hash;
  await page.evaluate(() => { location.hash = '#/timeline'; }); await page.locator('.tl-shell').waitFor();
  await page.evaluate(hash => { location.hash = hash; }, recoveryRoute);
  await page.getByRole('button', { name: 'Resume drafts', exact: true }).waitFor();
  const copy = await copiedDrafts(page, output, 'planner-recovery-' + (mobile ? 'phone' : 'desktop'));
  for (const text of ['Retained item prose', 'Retained flow label', 'Retained reference prose', 'Retained consequence prose', 'Retained note prose', 'Retained new flow', 'Retained provisional quest']) assert.ok(copy.includes(text), text);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'planner-recovery-' + (mobile ? 'phone' : 'desktop') + '.png'), fullPage: false });
  if (mobile) {
    await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload();
    await page.getByRole('button', { name: 'Pokračovat v rozepsaných úpravách', exact: true }).waitFor();
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.equal(await page.getByRole('button', { name: 'Stáhnout rozepsané úpravy', exact: true }).evaluate(node => getComputedStyle(node).fontSize), '32px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, 'planner-recovery-phone-cs-enlarged.png'), fullPage: false });
    await page.evaluate(() => localStorage.setItem('codex_lang', 'en')); await page.reload();
  }
  const resume = page.getByRole('button', { name: 'Resume drafts', exact: true }); await resume.focus(); await resume.press('Enter');
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Retained provisional quest');
  assert.equal(await page.locator('select[name="parentId"]').inputValue(), data.parent);
  assert.equal(writes, 0); assert.equal((await data.records('planning_items')).some(record => record.key === provisionalId), false);
  await page.getByRole('button', { name: 'Cancel creation', exact: true }).click();
  await editPlannerCard(page, page.locator(`[data-item-id="${data.a}"]`));
  assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), 'Retained item prose');
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await page.getByText('Details saved.', { exact: true }).waitFor();
  assert.equal(writes, 1);
  assert.equal((await data.records('planning_items')).find(record => record.key === data.a)?.value['body'], 'Retained item prose');
  await plannerTab(page, 'Links');
  assert.equal(await flow.getByLabel('Flow label', { exact: true }).inputValue(), 'Retained flow label');
  assert.equal(await reference.getByLabel('Notes', { exact: true }).inputValue(), 'Retained reference prose');
  assert.equal(await consequence.getByLabel('Details', { exact: true }).inputValue(), 'Retained consequence prose');
  assert.equal(await createFlow.getByLabel('Flow label', { exact: true }).inputValue(), 'Retained new flow');
  assert.equal((await data.records('planning_flow_links')).find(record => record.key === data.flow)?.value['label'], 'Saved flow');
  await plannerTab(page, 'Notes'); assert.equal(await note.getByLabel('Private details', { exact: true }).inputValue(), 'Retained note prose');
  await reload(page); await page.getByRole('button', { name: 'Resume drafts', exact: true }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard recovery copy', exact: true }).click();
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey), null);
  assert.equal(await page.getByRole('button', { name: 'Resume drafts', exact: true }).count(), 0);
}

export async function exercisePlannerRecoveryConflicts(fixture: Fixture) {
  const { t, open, admin, csrf, archive } = fixture, data = await fixtureData(fixture, 'recover-conflict');
  const page = await open(t); await edit(page, data.c); await plannerTab(page, 'Links');
  const newFlow = page.getByRole('form', { name: 'Create story flow', exact: true });
  await choose(newFlow, 'Flow target', data.a);
  await newFlow.getByLabel('Flow label', { exact: true }).fill('Orphaned new flow text');
  await editPlannerCard(page, page.locator(`[data-item-id="${data.a}"]`));
  await page.getByLabel('Body', { exact: true }).fill('Older unsent draft');
  await plannerTab(page, 'Notes');
  await page.locator(`[data-note-id="${data.note}"]`).getByLabel('Private details', { exact: true }).fill('Deleted note text remains recoverable');
  const saved = required((await data.records('planning_items')).find(record => record.key === data.a));
  await data.transact([put('planning_items', { ...saved.value, body: 'Newer campaign prose', updatedAt: 2 }, saved.revision),
    { operation: 'delete', kind: 'collection', dataId: 'dm_notes', key: data.note, expectedRevision: 1 },
    { operation: 'delete', kind: 'collection', dataId: 'planning_items', key: data.c, expectedRevision: 1 }]);
  await replace(fixture, page); await page.getByRole('button', { name: 'Resume drafts', exact: true }).click();
  assert.match((await page.locator('.dm-planner-removed-draft').allTextContents()).join('\n'), /Unsaved edits to a removed record/);
  const removed = (await page.locator('.dm-planner-removed-draft pre').allTextContents()).join('\n');
  assert.match(removed, /Deleted note text remains recoverable/); assert.match(removed, /Orphaned new flow text/);
  await plannerTab(page, 'Details');
  assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), 'Older unsent draft');
  await page.getByText(/This record changed since editing began/).waitFor();
  const rejected = page.waitForResponse(response => response.url().endsWith('/data/transactions'));
  await page.getByRole('button', { name: 'Save item', exact: true }).click(); assert.equal((await rejected).status(), 409);
  assert.equal((await data.records('planning_items')).find(record => record.key === data.a)?.value['body'], 'Newer campaign prose');
  const current = await jsonResponse(await admin.get('/api/admin/addons/dm-tools'));
  await jsonResponse(await admin.post('/api/admin/addons/dm-tools/disable', { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: current.state.revision } }));
  await page.locator('.dm-tools-planner').waitFor({ state: 'detached' });
  await installReviewedPackage(admin, csrf, 'dm-tools', archive, dmToolsPermissions);
  await page.getByRole('button', { name: 'Resume drafts', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Resume drafts', exact: true }).click();
  assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), 'Older unsent draft');
  assert.equal(await page.getByRole('button', { name: 'Save item', exact: true }).isDisabled(), true);
  await page.getByRole('form', { name: 'Planning item details', exact: true }).getByRole('button', { name: 'Discard edits', exact: true }).click();
  assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), 'Newer campaign prose');
}

export async function exercisePlannerRecoveryWrites(fixture: Fixture) {
  const { t, open } = fixture, data = await fixtureData(fixture, 'recover-writes');
  const page = await open(t); await edit(page, data.a);
  await page.getByLabel('Body', { exact: true }).fill('Confirmed before read failure');
  let failRead = false;
  await page.route(queryPattern, route => failRead ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.route(writePattern, async route => { const response = await route.fetch(); failRead = true; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await page.getByText(/Reload the planner before making another change/).waitFor();
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey), null, 'confirmed writes leave no stale recovery copy');
  failRead = false; await page.unroute(queryPattern); await page.unroute(writePattern);
  await replace(fixture, page);
  await page.getByRole('button', { name: 'Edit item', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Resume drafts', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), 'Confirmed before read failure');
  await plannerTab(page, 'Links'); await page.getByText('Add reference', { exact: true }).first().click();
  const create = page.getByRole('form', { name: 'Create reference', exact: true });
  await choose(create, 'Target type', 'core');
  await choose(create, 'Campaign target', '["events","arrival"]');
  await create.getByLabel('Reference name (optional)', { exact: true }).fill('Uncertain reference');
  const { promise: held, resolve: release } = Promise.withResolvers<void>(), { promise: written, resolve: arrived } = Promise.withResolvers<void>();
  t.after(() => release());
  await page.route(writePattern, async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }).catch(() => undefined); });
  await create.getByRole('button', { name: 'Add reference', exact: true }).click(); await written;
  // Return to the original archive: the pending browser reply still belongs to the replaced generation.
  await installReviewedPackage(fixture.admin, fixture.csrf, 'dm-tools', fixture.archive, dmToolsPermissions);
  await page.getByRole('button', { name: 'Resume drafts', exact: true }).waitFor();
  release(); await page.unroute(writePattern, undefined);
  await page.getByRole('button', { name: 'Resume drafts', exact: true }).click();
  assert.equal(await create.getByLabel('Reference name (optional)', { exact: true }).inputValue(), 'Uncertain reference');
  assert.equal(await create.getByRole('button', { name: 'Add reference', exact: true }).isDisabled(), true);
  await create.getByText(/This draft has an unconfirmed save/).waitFor();
  assert.equal((await data.records('planning_references')).filter(record => record.value['name'] === 'Uncertain reference').length, 1);
  await create.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^Add reference$/u }).click();
  assert.equal(await create.getByRole('button', { name: 'Add reference', exact: true }).isDisabled(), false);
}

export async function exercisePlannerRecoveryStorage(fixture: Fixture) {
  const { t, open, output } = fixture, data = await fixtureData(fixture, 'recover-storage');
  const page = await open(t); await edit(page, data.a);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) { if (this === sessionStorage && name === key) throw new DOMException('Fixture quota', 'QuotaExceededError'); original.call(this, name, value); };
  }, recoveryKey);
  await page.getByLabel('Body', { exact: true }).fill('Private draft available for download');
  await page.getByText(/The latest planner edits could not be kept/).waitFor();
  assert.match(await copiedDrafts(page, output, 'planner-recovery-storage-blocked'), /Private draft available for download/);
  const other = await page.context().newPage(); await other.goto(page.url());
  await other.getByRole('button', { name: 'Edit item', exact: true }).waitFor();
  assert.equal(await other.getByRole('button', { name: 'Resume drafts', exact: true }).count(), 0); await other.close();
  // A reload restores the native Storage prototype; seed malformed bytes through an init script.
  await page.addInitScript(key => { sessionStorage.setItem(key, '{"format":"unrecognized-recovery"}'); }, recoveryKey);
  await reload(page);
  await page.getByText(/This recovery copy cannot be opened/).waitFor();
  assert.equal(await copiedDrafts(page, output, 'planner-recovery-invalid'), '{"format":"unrecognized-recovery"}');
  await page.addInitScript(key => {
    const nativeGet = Storage.prototype.getItem;
    Object.defineProperty(window, 'fixtureRecoveryValue', { value: () => nativeGet.call(sessionStorage, key) });
    Storage.prototype.getItem = function(name) { if (this === sessionStorage && name === key) throw new DOMException('Fixture read blocked', 'SecurityError'); return nativeGet.call(this, name); };
  }, recoveryKey);
  await page.reload(); await page.getByRole('button', { name: 'Edit item', exact: true }).click();
  await page.getByLabel('Body', { exact: true }).fill('Read failure keeps the existing recovery copy');
  assert.equal(await page.evaluate(() => Reflect.get(window, 'fixtureRecoveryValue')()), '{"format":"unrecognized-recovery"}');
  assert.match(await copiedDrafts(page, output, 'planner-recovery-read-blocked'), /Read failure keeps the existing recovery copy/);
  const player = await page.context().request.post('/api/login', { data: { password: 'local-graph-fixture-player' } }); assert.equal(player.ok(), true);
  await reload(page); await page.locator('codex-app').waitFor();
  await page.waitForFunction(() => document.body.textContent?.includes('Sign out') || document.querySelector('.campaign-shell') !== null);
  assert.equal(await page.locator('.dm-tools-planner').count(), 0); assert.equal(await page.locator('[data-planner-recovery]').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /Private draft available for download/);
}
