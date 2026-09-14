import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { InstalledFixture } from './fixture-types.mts';
import { installReviewedPackage, jsonResponse, zip } from './installed-graph-fixture.mts';

function archive(id: string, version: string): Buffer {
  const files: Record<string, string> = { 'addon.json': JSON.stringify({ packageFormat: 1, id, name: 'Cleanup fixture', version, compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, capabilities: { required: [], optional: [] }, permissions: [] }) };
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files);
}
export async function exercisePackageCleanup({ t, open, admin, csrf, output, mobile }: InstalledFixture): Promise<void> {
  const id = `cleanup-${mobile ? 'phone' : 'desktop'}`, headers = { 'X-Codex-CSRF': csrf };
  const first = await installReviewedPackage(admin, csrf, id, archive(id, '1.0.0'), []);
  await jsonResponse(await admin.post('/api/recovery', { headers, data: {} }));
  const second = await installReviewedPackage(admin, csrf, id, archive(id, '2.0.0'), []);
  const third = await installReviewedPackage(admin, csrf, id, archive(id, '3.0.0'), []);
  const one = first.state.activeGenerationId, two = second.state.activeGenerationId;
  const page = await open(t, 'dm', mobile); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto('/#/settings'); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), row = manager.locator(`[data-addon-id="${id}"]`), review = manager.locator('.addon-cleanup-review');
  await row.getByText('Saved packages', { exact: true }).click();
  const remove = (generation: string) => row.locator(`[data-generation="${generation}"]`).getByRole('button', { name: 'Remove saved package', exact: true });
  await remove(one).click(); await review.getByText(/Keep: required by recovery points/u).waitFor();
  assert.equal(await review.getByRole('button', { name: 'Remove reviewed packages', exact: true }).isDisabled(), true);
  await review.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await manager.getByRole('button', { name: 'Clean up saved packages', exact: true }).click();
  await review.getByRole('combobox').selectOption('1');
  await review.locator(`[data-cleanup-generation="${two}"]`).getByText('Keep: selected retention count', { exact: true }).waitFor();
  await review.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await remove(two).click(); await review.getByRole('heading', { name: 'Review saved package cleanup', exact: true }).waitFor();
  await review.screenshot({ path: resolve(output, `package-cleanup-${mobile ? 'phone' : 'desktop'}.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await jsonResponse(await admin.post(`/api/admin/addons/${id}/activation-reviews`, { headers, data: { generationId: two } }));
  await review.getByRole('button', { name: 'Remove reviewed packages', exact: true }).click(); await manager.getByRole('alert').waitFor(); assert.equal(await review.count(), 0);
  assert.equal((await admin.get(`/api/admin/addons/${id}`)).status(), 200);
  await remove(two).click(); await review.getByRole('heading').waitFor();
  const pattern = '**/api/admin/addon-package-cleanup/apply'; let receipt: unknown;
  await page.route(pattern, async route => { receipt = route.request().postDataJSON() as unknown; await route.fetch(); await route.abort('failed'); });
  await review.getByRole('button', { name: 'Remove reviewed packages', exact: true }).click(); await manager.getByRole('alert').waitFor(); await page.unroute(pattern);
  const retry = await jsonResponse(await admin.post('/api/admin/addon-package-cleanup/apply', { headers, data: receipt })); assert.equal(retry.complete, true);
  await manager.getByRole('button', { name: 'Check for updates', exact: true }).click(); await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  assert.equal(await row.locator(`[data-generation="${two}"]`).count(), 0);
  const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`)); assert.equal(snapshot.state.activeGenerationId, third.state.activeGenerationId); assert.equal(snapshot.generations.length, 2);
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload(); await page.locator('[data-category="addons"]').click();
  await manager.getByRole('button', { name: 'Vyčistit uložené balíčky', exact: true }).click(); await review.getByRole('heading', { name: 'Kontrola vyčištění uložených balíčků', exact: true }).waitFor();
  await review.locator(`[data-cleanup-generation="${one}"]`).getByText(/Zachovat: vyžadují body obnovy/u).waitFor();
  const player = await open(t, 'player');
  for (const operation of ['review', 'apply', 'retry']) {
    const path = `/api/admin/addon-package-cleanup/${operation}`;
    assert.equal((await player.context().request.post(path, { data: {} })).status(), 403);
    assert.equal((await admin.post(path, { data: {} })).status(), 403);
  }
}
