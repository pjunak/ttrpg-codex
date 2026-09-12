import type { InstalledFixture } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { graphPackage, jsonResponse } from './installed-graph-fixture.mts';

export async function exerciseAddonManager({ t, open, admin, csrf, output, mobile }: Pick<InstalledFixture, 't' | 'open' | 'admin' | 'csrf' | 'output' | 'mobile'>) {
  const page = await open(t, 'dm', mobile), id = `settings-${mobile ? 'phone' : 'desktop'}`;
  await page.goto('/#/settings'); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), review = manager.locator('.addon-review'), row = manager.locator(`[data-addon-id="${id}"]`);
  await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  const openUpload = async () => {
    await manager.getByRole('button', { name: 'Add add-on', exact: true }).click();
    await manager.getByRole('dialog').getByRole('button', { name: 'ZIP file Upload', exact: false }).click();
  };
  const upload = async (version: string) => {
    await openUpload();
    await manager.locator('input[type="file"]').setInputFiles({ name: `${id}.zip`, mimeType: 'application/zip', buffer: graphPackage({ id, mode: 'integrated', version }) });
    await manager.getByRole('button', { name: 'Inspect ZIP', exact: true }).click();
    await review.getByRole('heading', { name: 'Review activation: Graph test', exact: true }).waitFor();
  };
  const approve = async () => {
    assert.equal(await review.getByRole('button', { name: 'Approve and activate', exact: true }).isDisabled(), true);
    await review.getByRole('checkbox', { name: /core.data.read/u }).check();
    await review.getByRole('button', { name: 'Approve and activate', exact: true }).click();
    await manager.getByText('Add-on state updated.', { exact: true }).waitFor();
  };
  await upload('1.0.0');
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).state.activeGenerationId, undefined);
  await review.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await row.getByRole('button', { name: 'Review activation', exact: true }).click(); await approve();
  let snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`)); const original = snapshot.state.activeGenerationId;
  await row.getByRole('button', { name: 'Reload', exact: true }).click(); await manager.getByText('Add-on state updated.', { exact: true }).waitFor();
  await upload('1.1.0'); await approve();
  snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`)); assert.notEqual(snapshot.state.activeGenerationId, original);
  await row.getByText('Installed versions', { exact: true }).click();
  await row.locator(`[data-generation="${original}"]`).getByRole('button', { name: 'Review rollback', exact: true }).click(); await approve();
  snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`)); assert.equal(snapshot.state.activeGenerationId, original);
  page.once('dialog', dialog => dialog.accept()); await row.getByRole('button', { name: 'Disable', exact: true }).click();
  await row.getByText('Disabled or awaiting activation', { exact: true }).waitFor();
  await page.reload(); await page.locator('[data-category="addons"]').click(); await row.waitFor();
  assert.equal(await row.locator('[data-generation]').count(), 2);
  // A concurrent state change invalidates the exact reviewed proposal.
  await row.locator(`[data-generation="${original}"]`).getByRole('button', { name: 'Review activation', exact: true }).click();
  await review.getByRole('heading', { name: 'Review activation: Graph test', exact: true }).waitFor();
  const concurrent = await jsonResponse(await admin.post(`/api/admin/addons/${id}/activation-reviews`, { headers: { 'X-Codex-CSRF': csrf }, data: { generationId: original } }));
  await jsonResponse(await admin.post(`/api/admin/addon-activation-reviews/${concurrent.reviewId}/approval`, { headers: { 'X-Codex-CSRF': csrf }, data: { grantedPermissionIds: ['core.data.read'] } }));
  await jsonResponse(await admin.post(`/api/admin/addon-activation-reviews/${concurrent.reviewId}/activation`, { headers: { 'X-Codex-CSRF': csrf } }));
  await review.getByRole('checkbox', { name: /core.data.read/u }).check(); await review.getByRole('button', { name: 'Approve and activate', exact: true }).click();
  await manager.getByRole('alert').filter({ hasText: /could not be confirmed/u }).waitFor();
  await manager.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await manager.getByRole('button', { name: 'Check for updates', exact: true }).click(); await row.getByRole('button', { name: 'Disable', exact: true }).waitFor();
  // Retained generation data and status survive a lost response; refresh reads the result.
  const pattern = `**/api/admin/addons/${id}/disable`;
  await page.route(pattern, async route => { await route.fetch(); await route.abort('failed'); });
  page.once('dialog', dialog => dialog.accept()); await row.getByRole('button', { name: 'Disable', exact: true }).click();
  await manager.getByRole('alert').filter({ hasText: /could not be confirmed/u }).waitFor(); await page.unroute(pattern);
  await manager.getByRole('button', { name: 'Check for updates', exact: true }).click(); await row.getByText('Disabled or awaiting activation', { exact: true }).waitFor();
  await openUpload();
  await manager.locator('input[type="file"]').setInputFiles({ name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('not a package') });
  await manager.getByRole('button', { name: 'Inspect ZIP', exact: true }).click(); await manager.getByRole('alert').waitFor();
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).generations.length, 2);
  await manager.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await manager.getByRole('button', { name: 'Check for updates', exact: true }).click(); await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, `addon-manager-${mobile ? 'phone' : 'desktop'}.png`) });
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('[data-category="addons"]').click();
  await manager.getByRole('button', { name: 'Přidat doplněk', exact: true }).waitFor();
  const player = await open(t, 'player'); await player.goto('/#/settings'); assert.equal(await player.locator('[data-category="addons"]').count(), 0);
  assert.equal((await player.context().request.get('/api/admin/addons')).status(), 403);
}
