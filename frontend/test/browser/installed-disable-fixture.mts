import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { InstalledFixture } from './fixture-types.mts';
import { installDmPackage } from './installed-dm-fixture.mts';
import { installReviewedPackage, jsonResponse } from './installed-graph-fixture.mts';
import { dependentPackage } from './installed-uninstall-fixture.mts';

export async function exerciseDisable({ t, open, admin, csrf, output, mobile }: InstalledFixture): Promise<void> {
  const id = 'disable-' + (mobile ? 'phone' : 'desktop'), required = id + '-required', transitive = id + '-transitive', optional = id + '-optional';
  const headers = { 'X-Codex-CSRF': csrf };
  const installed = await installDmPackage(admin, csrf, { id, live: true }), generation = installed.state.activeGenerationId;
  const data = '/api/addons/' + id + '/generations/' + generation + '/data';
  await jsonResponse(await admin.post(data + '/transactions', { headers, data: { contractVersion: 'addon-data-transaction.v1', mutations: [{ operation: 'put', kind: 'collection', dataId: 'notes', key: 'retained', expectedRevision: 0, value: { text: 'Authored work survives disable' } }] } }));
  for (const [addon, provider, mandatory] of [[required, id, true], [transitive, required, true], [optional, id, false]] as const) {
    await installReviewedPackage(admin, csrf, addon, dependentPackage(addon, provider, mandatory), []);
  }
  t.after(async () => {
    for (const addon of [optional, transitive, required, id]) {
      const snapshot = await jsonResponse(await admin.get('/api/admin/addons/' + addon));
      if (snapshot.state.activeGenerationId) await jsonResponse(await admin.post('/api/admin/addons/' + addon + '/disable', { headers, data: { expectedStateRevision: snapshot.state.revision } }));
    }
  });
  const page = await open(t, 'dm', mobile); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.evaluate(cs => localStorage.setItem('codex_lang', cs ? 'cs' : 'en'), mobile);
  await page.goto('/#/settings'); await page.reload(); await page.locator('[data-category="addons"]').click();
  const manager = page.locator('codex-addon-manager'), row = manager.locator('[data-addon-id="' + id + '"]'), review = manager.locator('.addon-disable-review');
  const disable = row.getByRole('button', { name: mobile ? 'Vypnout' : 'Disable', exact: true });
  const confirm = () => review.getByRole('button', { name: mobile ? 'Vypnout posouzené doplňky' : 'Disable reviewed add-ons', exact: true }).click();
  await disable.click(); await review.getByRole('heading', { name: mobile ? 'Kontrola vypnutí: DM panel fixture' : 'Review disable: DM panel fixture' }).waitFor();
  assert.equal(await review.locator('h3').evaluate(node => node === document.activeElement), true);
  await review.getByRole('heading', { name: mobile ? 'Vypnou se i tyto povinně závislé doplňky' : 'Required dependents will also be disabled' }).waitFor();
  await review.getByRole('heading', { name: mobile ? 'Tyto dotčené doplňky mohou zůstat zapnuté' : 'These affected add-ons can remain enabled' }).waitFor();
  for (const addon of [required, transitive, optional]) assert.equal(await review.locator('li').filter({ hasText: addon }).count() >= 1, true);
  await review.getByRole('button', { name: mobile ? 'Zrušit kontrolu' : 'Cancel review', exact: true }).click();
  await review.waitFor({ state: 'detached' });
  assert.equal(await disable.evaluate(node => node === document.activeElement), true);
  assert.equal((await jsonResponse(await admin.get('/api/admin/addons/' + id))).state.activeGenerationId, generation, 'cancel has no lifecycle effect');
  await disable.click(); await review.waitFor();
  const snapshot = await jsonResponse(await admin.get('/api/admin/addons/' + required));
  await jsonResponse(await admin.post('/api/admin/addons/' + required + '/reload', { headers, data: { expectedStateRevision: snapshot.state.revision } }));
  await confirm();
  await manager.getByRole('alert').filter({ hasText: mobile ? 'znovu posuďte' : 'review disabling again' }).waitFor();
  assert.equal(await review.count(), 0, 'stale confirmation is discarded');
  assert.equal((await jsonResponse(await admin.get('/api/admin/addons/' + id))).state.activeGenerationId, generation);
  await disable.click(); await review.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await review.screenshot({ path: resolve(output, 'disable-review-' + (mobile ? 'phone-cs' : 'desktop-en') + '.png') });
  const pattern = '**/api/admin/addons/' + id + '/disable-reviewed';
  let submissions = 0;
  if (mobile) await page.route(pattern, async route => { submissions++; await route.fetch(); await route.abort('failed'); });
  await confirm();
  if (mobile) {
    await manager.getByRole('alert').filter({ hasText: 'Před dalším pokusem obnovte seznam' }).waitFor();
    assert.equal(submissions, 1, 'uncertain confirmation is not replayed');
    await page.unroute(pattern);
  } else await manager.getByText('Reviewed add-ons disabled. Packages and campaign data were kept.', { exact: true }).waitFor();
  await manager.getByRole('button', { name: mobile ? 'Zkontrolovat aktualizace' : 'Check for updates', exact: true }).click();
  await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
  for (const addon of [id, required, transitive]) {
    const result = await jsonResponse(await admin.get('/api/admin/addons/' + addon));
    assert.equal(result.state.activeGenerationId, undefined); assert.equal(result.generations.length, 1);
  }
  assert.ok((await jsonResponse(await admin.get('/api/admin/addons/' + optional))).state.activeGenerationId);
  assert.equal((await admin.get('/api/addons/' + id + '/generations/' + generation + '/assets/web/index.js')).status(), 404);
  await page.reload(); await page.locator('[data-category="addons"]').click();
  await row.getByText(mobile ? 'Vypnuto nebo čeká na aktivaci' : 'Disabled or awaiting activation', { exact: true }).waitFor();
  await installDmPackage(admin, csrf, { id, live: true });
  const retained = await jsonResponse(await admin.post(data + '/query', { headers, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId: 'notes', where: [], limit: 10 } }));
  assert.equal(retained.documents[0].value.text, 'Authored work survives disable');
  assert.equal((await jsonResponse(await admin.get('/api/admin/addons/' + required))).state.activeGenerationId, undefined, 're-enabling the provider does not silently re-enable dependents');
  const player = await open(t, 'player');
  for (const action of ['disable-review', 'disable-reviewed']) {
    assert.equal((await player.context().request.post('/api/admin/addons/' + id + '/' + action, { data: {} })).status(), 403);
    assert.equal((await admin.post('/api/admin/addons/' + id + '/' + action, { data: {} })).status(), 403);
  }
}
