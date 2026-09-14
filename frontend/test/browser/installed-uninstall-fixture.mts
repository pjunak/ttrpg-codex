import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { InstalledFixture } from './fixture-types.mts';
import { installDmPackage } from './installed-dm-fixture.mts';
import { installReviewedPackage, jsonResponse, zip } from './installed-graph-fixture.mts';

function dependentPackage(id: string, provider: string, required: boolean, incompatibleData = false): Buffer {
  const files: Record<string, string> = { 'addon.json': JSON.stringify({ packageFormat: 1, id, name: id, version: '1.0.0',
    compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, capabilities: { required: [], optional: [] }, permissions: [],
    ...(incompatibleData ? { collections: [{ id: 'notes', keyed: true, visibility: 'dm', schema: 'contracts/notes.json', schemaVersion: '2.0.0' }] } : { dependencies: [{ id: provider, range: '^1.0.0', required }] }) }) };
  if (incompatibleData) files['contracts/notes.json'] = JSON.stringify({ type: 'object', required: ['text'], properties: { text: { type: 'number' } }, additionalProperties: false });
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files);
}

export async function exerciseUninstall({ t, open, admin, csrf, output, mobile }: InstalledFixture): Promise<void> {
  const id = `remove-${mobile ? 'phone' : 'desktop'}`, required = `${id}-required`, optional = `${id}-optional`, headers = { 'X-Codex-CSRF': csrf };
  const installed = await installDmPackage(admin, csrf, { id, live: true }), generation = installed.state.activeGenerationId;
  const asset = `/api/addons/${id}/generations/${generation}/assets/web/index.js`;
  assert.equal((await admin.get(asset)).status(), 200);
  const data = `/api/addons/${id}/generations/${generation}/data`;
  await jsonResponse(await admin.post(`${data}/transactions`, { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations: [{ operation: 'put', kind: 'collection', dataId: 'notes', key: 'retained', expectedRevision: 0, value: { text: 'Authored work survives uninstall' } }] } }));
  await installReviewedPackage(admin, csrf, required, dependentPackage(required, id, true), []);
  await installReviewedPackage(admin, csrf, optional, dependentPackage(optional, id, false), []);
  const page = await open(t, 'dm', mobile); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto('/#/settings'); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), row = manager.locator(`[data-addon-id="${id}"]`), review = manager.locator('.addon-uninstall-review');
  await row.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await review.getByRole('heading', { name: 'Review uninstall: DM panel fixture', exact: true }).waitFor();
  assert.match(await review.innerText(), /Records: 1/u);
  assert.match(await review.innerText(), new RegExp(required, 'u'));
  assert.match(await review.innerText(), new RegExp(optional, 'u'));
  await review.getByRole('button', { name: 'Cancel review', exact: true }).click();
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).state.activeGenerationId, generation);
  await row.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await review.waitFor();
  const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  await jsonResponse(await admin.post(`/api/admin/addons/${id}/reload`, { headers, data: { expectedStateRevision: snapshot.state.revision } }));
  await review.getByRole('button', { name: 'Uninstall and keep data', exact: true }).click();
  await manager.getByRole('alert').filter({ hasText: 'Review uninstall again' }).waitFor();
  await row.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await review.getByRole('heading').first().waitFor();
  await review.screenshot({ path: resolve(output, `uninstall-review-${mobile ? 'phone' : 'desktop'}.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await review.getByRole('button', { name: 'Uninstall and keep data', exact: true }).click();
  await manager.getByText('Add-on uninstalled. Campaign data and recovery archives were kept.', { exact: true }).waitFor();
  await row.waitFor({state:'detached'});
  assert.equal(await row.count(), 0);
  assert.equal((await admin.get(`/api/admin/addons/${id}`)).status(), 404);
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${required}`))).state.activeGenerationId, undefined);
  assert.ok((await jsonResponse(await admin.get(`/api/admin/addons/${optional}`))).state.activeGenerationId);
  assert.equal((await admin.get(asset)).status(), 404);
  assert.equal((await admin.post(`${data}/query`, { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId: 'notes', where: [], limit: 10 } })).ok(), false);
  await page.reload(); await page.locator('[data-category="addons"]').click(); await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  assert.equal(await row.count(), 0);
  // Reinstallation validates and exposes retained records through the real data owner.
  const incompatible = await jsonResponse(await admin.post('/api/admin/addons/generations', { headers: { ...headers, 'Content-Type': 'application/zip' }, data: dependentPackage(id, '', false, true) }));
  const blocked = await jsonResponse(await admin.post(`/api/admin/addons/${id}/activation-reviews`, { headers, data: { generationId: incompatible.generationId } }));
  assert.ok(blocked.proposal.blockers.length > 0, 'incompatible retained records must block activation');
  assert.equal((await admin.post(`/api/admin/addon-activation-reviews/${blocked.reviewId}/approval`, { headers, data: { grantedPermissionIds: [] } })).ok(), false);
  await manager.getByRole('button', { name: 'Check for updates', exact: true }).click();
  const activation = manager.locator('.addon-review');
  for (const language of ['en', 'cs']) {
    if (language === 'cs') {
      await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('[data-category="addons"]').click();
    }
    await row.locator(`[data-generation="${incompatible.generationId}"]`).getByRole('button', { name: language === 'en' ? 'Review activation' : 'Zkontrolovat aktivaci', exact: true }).click();
    await activation.getByText(language === 'en'
      ? "Saved data uses a different format. Follow the add-on's documented upgrade procedure before activating. Uninstalling and reinstalling keeps this data."
      : 'Uložená data používají jiný formát. Před aktivací postupujte podle dokumentovaného postupu aktualizace doplňku. Odinstalace a opětovná instalace tato data zachová.').waitFor();
    await activation.getByText(language === 'en'
      ? "A saved record does not match this package's data format. Review the affected record in the technical details and follow the add-on's upgrade instructions."
      : 'Uložený záznam neodpovídá datovému formátu tohoto balíčku. Zkontrolujte dotčený záznam v technických podrobnostech a postupujte podle pokynů k aktualizaci doplňku.').waitFor();
    assert.equal(await activation.getByRole('button', { name: language === 'en' ? 'Approve and activate' : 'Schválit a aktivovat', exact: true }).isDisabled(), true);
    await activation.getByRole('button', { name: language === 'en' ? 'Cancel review' : 'Zrušit kontrolu', exact: true }).click();
  }
  await page.evaluate(() => localStorage.setItem('codex_lang', 'en')); await page.reload(); await page.locator('[data-category="addons"]').click();
  await installDmPackage(admin, csrf, { id, live: true });
  const retained = await jsonResponse(await admin.post(`${data}/query`, { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId: 'notes', where: [], limit: 10 } }));
  assert.equal(retained.documents[0].value.text, 'Authored work survives uninstall');
  await manager.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('[data-category="addons"]').click();
  await row.getByRole('button', { name: 'Odinstalovat', exact: true }).click();
  await review.getByRole('heading', { name: 'Kontrola odinstalace: DM panel fixture', exact: true }).waitFor();
  const pattern = `**/api/admin/addons/${id}/uninstall`;
  let fingerprint = '';
  await page.route(pattern, async route => { fingerprint = (route.request().postDataJSON() as { reviewSha256: string }).reviewSha256; await route.fetch(); await route.abort('failed'); });
  await review.getByRole('button', { name: 'Odinstalovat a zachovat data', exact: true }).click();
  await manager.getByRole('alert').waitFor(); await page.unroute(pattern);
  const retry = await jsonResponse(await admin.post(`/api/admin/addons/${id}/uninstall`, { headers, data: { reviewSha256: fingerprint } }));
  assert.equal(retry.alreadyRemoved, true);
  await manager.getByRole('button', { name: 'Zkontrolovat aktualizace', exact: true }).click(); await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  assert.equal(await row.count(), 0);
  const player = await open(t, 'player');
  for (const action of ['uninstall-review', 'uninstall']) {
    assert.equal((await player.context().request.post(`/api/admin/addons/${optional}/${action}`, { data: {} })).status(), 403);
    assert.equal((await admin.post(`/api/admin/addons/${optional}/${action}`, { data: {} })).status(), 403);
  }
  assert.equal((await admin.post(`/api/admin/addons/${optional}/uninstall`, { headers, data: { reviewSha256: 'invalid' } })).status(), 400);
  // Staged-only packages have the same removal path and never run code.
  const stagedID = `${id}-staged`;
  await jsonResponse(await admin.post('/api/admin/addons/generations', { headers: { ...headers, 'Content-Type': 'application/zip' }, data: dependentPackage(stagedID, id, true) }));
  const stagedReview = await jsonResponse(await admin.post(`/api/admin/addons/${stagedID}/uninstall-review`, { headers, data: {} }));
  await jsonResponse(await admin.post(`/api/admin/addons/${stagedID}/uninstall`, { headers, data: { reviewSha256: stagedReview.reviewSha256 } }));
  assert.equal((await admin.get(`/api/admin/addons/${stagedID}`)).status(), 404);
}
