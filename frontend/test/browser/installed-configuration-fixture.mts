import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { InstalledFixture } from './fixture-types.mts';
import { zip, installReviewedPackage, jsonResponse } from './installed-graph-fixture.mts';

function configurationPackage(id: string, consumer = false, unsupported = false): Buffer {
  const manifest: Record<string, unknown> = { packageFormat: 1, id, name: id, version: '1.0.0', compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, capabilities: { required: [], optional: [] }, permissions: [] };
  const files: Record<string, string> = {};
  if (consumer) {
    manifest.services = { consumes: [{ contract: 'example.sources', range: '^1.0.0', cardinality: 'one', selection: 'operator', required: false }] };
  } else {
    manifest.rules = { supports: unsupported ? ['another-system'] : ['fixture-system'], ...(id === 'source-base' ? { defines: { id: 'fixture-system', name: 'Fixture rules', contract: 'example.sources', contentSet: 'rules', recordKind: 'ruleset', recordId: 'fixture-system' } } : {}) };
    manifest.services = { provides: [{ contract: 'example.sources', version: '1.0.0', transport: 'content', schema: 'contracts/service.json' }] };
    manifest.content = [{ id: 'rules', root: 'data', schema: 'contracts/record.json', revision: '1', groups: { field: 'book', additionalField: 'availableIn', catalogKind: 'book', label: 'Books' } }];
    files['contracts/record.json'] = JSON.stringify({ type: 'object', required: ['kind', 'id', 'name'], properties: { kind: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' } } });
    files['contracts/any.json'] = '{"type":"object"}';
    files['contracts/service.json'] = JSON.stringify({ contract: 'example.sources', version: '1.0.0', allowsExclusive: false, methods: Object.fromEntries(['catalog', 'query', 'get'].map(method => [method, { requestSchema: 'contracts/any.json', responseSchema: 'contracts/any.json', maxDeadlineMs: 2000, idempotency: 'none', errors: [] }])) });
    const records = id === 'source-base' ? [
      { kind: 'ruleset', id: 'fixture-system', name: 'Fixture rules', book: 'core' },
      { kind: 'book', id: 'core', name: 'Core rules' },
    ] : [
      { kind: 'book', id: 'extra', name: 'Extra adventures' },
      { kind: 'spell', id: 'extra-spell', name: 'Extra spell', book: 'extra' },
    ];
    for (const record of records) files[`data/${record.id}.json`] = JSON.stringify(record);
  }
  files['addon.json'] = JSON.stringify(manifest);
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files);
}

export async function exerciseConfiguration({ t, open, admin, csrf, output, mobile }: InstalledFixture): Promise<void> {
  const headers = { 'X-Codex-CSRF': csrf }, consumer = `source-reader-${mobile ? 'phone' : 'desktop'}`;
  await installReviewedPackage(admin, csrf, 'source-base', configurationPackage('source-base'), []);
  const extra = await installReviewedPackage(admin, csrf, 'source-extra', configurationPackage('source-extra'), []);
  await installReviewedPackage(admin, csrf, consumer, configurationPackage(consumer, true), []);
  const initial = await jsonResponse(await admin.get('/api/admin/rules-policy'));
  await jsonResponse(await admin.post('/api/admin/rules-policy', { headers, data: { expectedRevision: initial.revision, expectedGraphRevision: initial.graphRevision, enabled: [{ addonId: 'source-base', setId: 'rules', id: 'core' }] } }));
  const contentURL = `/api/addons/source-extra/generations/${extra.state.activeGenerationId}/content/records?set=rules&kind=spell&id=extra-spell`;
  assert.equal((await admin.get(contentURL)).status(), 404);
  const pendingSource = `source-pending-${mobile ? 'phone' : 'desktop'}`;
  await installReviewedPackage(admin, csrf, pendingSource, configurationPackage(pendingSource), []);
  t.after(async () => {
    const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${pendingSource}`));
    await jsonResponse(await admin.post(`/api/admin/addons/${pendingSource}/disable`, { headers, data: { expectedStateRevision: snapshot.state.revision } }));
  });
  const page = await open(t, 'dm', mobile);
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  let rejectDiscovery = true;
  await page.route('**/api/admin/rules-policy', async route => {
    if (rejectDiscovery && route.request().method() === 'GET') return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    await route.continue();
  });
  await page.goto('/#/settings'); await page.locator('[data-category="addons"]').click();
  await page.locator('.addon-manager').getByRole('alert').filter({ hasText: /^The server is unavailable\. Try again shortly\.$/u }).waitFor();
  rejectDiscovery = false;
  await page.getByRole('button', { name: 'Refresh configuration', exact: true }).click();
  const config = page.locator('codex-addon-configuration');
  const management = page.getByRole('tab', { name: 'Management', exact: true });
  assert.equal(await management.getAttribute('aria-selected'), 'true');
  assert.equal(await config.isVisible(), false);
  await page.getByRole('tab', { name: 'source-base', exact: true }).click();
  await config.getByText('Fixture rules', { exact: true }).waitFor().catch(async () => assert.fail(await config.innerText()));
  assert.equal(await config.getByRole('checkbox', { name: /Core rules/u }).isDisabled(), true);
  assert.equal(await config.getByRole('checkbox', { name: 'Extra adventures', exact: true }).count(), 0);
  assert.equal(await config.locator('.configuration-service').count(), 0);
  await page.getByRole('tab', { name: 'source-extra', exact: true }).click();
  const book = config.getByRole('checkbox', { name: 'Extra adventures', exact: true });
  await book.check();
  await page.getByRole('tab', { name: consumer, exact: true }).click();
  assert.equal(await config.getByRole('checkbox', { name: /Core rules/u }).count(), 0);
  await config.getByLabel('Provider', { exact: true }).selectOption('source-extra');
  await management.click();
  assert.equal(await config.isVisible(), false);
  await page.getByRole('tab', { name: 'source-extra', exact: true }).click();
  assert.equal(await book.isChecked(), true);
  await config.getByRole('button', { name: 'Review sourcebook choices' }).click();
  const review = config.getByRole('region', { name: 'Review changes' });
  await review.getByText('Enable: Extra adventures · source-extra', { exact: true }).waitFor();
  await review.getByText(`Disable: Extra adventures · ${pendingSource}`, { exact: true }).waitFor();
  assert.equal((await admin.get(contentURL)).status(), 404);
  // A second operator changes configuration after this review was opened.
  const services = await jsonResponse(await admin.get('/api/admin/service-selections'));
  const row = services.services.find((row: { requirement: { consumerAddonId: string } }) => row.requirement.consumerAddonId === consumer);
  await jsonResponse(await admin.post('/api/admin/service-selections', { headers, data: { expectedRevision: services.revision, expectedGraphRevision: services.graphRevision, consumerAddonId: consumer, generationId: row.generationId, contract: 'example.sources', expectedBindingRevision: 0, automatic: false, providerAddonIds: ['source-base'] } }));
  await review.getByRole('button', { name: 'Apply changes' }).click();
  await config.getByRole('alert').filter({ hasText: /Your draft has been kept/u }).waitFor();
  assert.equal(await book.isChecked(), true);
  await config.getByRole('button', { name: 'Refresh configuration' }).click();
  await config.locator('[aria-busy="false"]').waitFor();
  assert.equal(await book.isChecked(), true);
  await config.getByRole('button', { name: 'Review sourcebook choices' }).click();
  await config.getByRole('button', { name: 'Apply changes' }).click();
  await config.getByRole('status').filter({ hasText: 'Configuration applied.' }).waitFor();
  const accepted = await jsonResponse(await admin.get('/api/admin/rules-policy'));
  assert.equal(accepted.sources.find((source: { addonId: string }) => source.addonId === pendingSource).pending, false);
  const record = await jsonResponse(await admin.get(contentURL)); assert.equal(record.record.id, 'extra-spell');
  await page.getByRole('tab', { name: consumer, exact: true }).click();
  assert.equal(await config.getByLabel('Provider', { exact: true }).inputValue(), 'source-extra', 'provider draft survives another tab applying its reviewed changes');
  const provider = config.locator('.configuration-service').filter({ has: page.locator('legend', { hasText: consumer }) });
  await provider.getByLabel('Provider', { exact: true }).selectOption('source-extra').catch(async () => assert.fail(await config.innerText()));
  await provider.getByRole('button', { name: 'Review provider choice' }).click();
  await config.getByRole('button', { name: 'Apply changes' }).click();
  await provider.getByText('Currently connected: source-extra', { exact: true }).waitFor();
  await provider.getByLabel('Provider', { exact: true }).selectOption('');
  await provider.getByRole('button', { name: 'Review provider choice' }).click();
  await config.getByRole('button', { name: 'Apply changes' }).click();
  await provider.getByText('Several providers are available. Choose one to connect this service.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await config.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, `configuration-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  await page.goto(`/#/settings/addons/${consumer}`); await page.reload();
  await provider.getByLabel('Provider', { exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: consumer, exact: true }).getAttribute('aria-selected'), 'true');
  const player = await open(t, 'player');
  for (const endpoint of ['rules-policy', 'service-selections']) {
    assert.equal((await player.context().request.get(`/api/admin/${endpoint}`)).status(), 403);
    assert.equal((await admin.post(`/api/admin/${endpoint}`, { data: {} })).status(), 403);
  }
  const staged = await jsonResponse(await admin.post('/api/admin/addons/generations', { headers: { ...headers, 'Content-Type': 'application/zip' }, data: configurationPackage('wrong-rules', false, true) }));
  const blocked = await jsonResponse(await admin.post('/api/admin/addons/wrong-rules/activation-reviews', { headers, data: { generationId: staged.generationId } }));
  assert.ok(blocked.proposal.blockers.some((blocker: { code: string }) => blocker.code === 'RULESET'));
}
