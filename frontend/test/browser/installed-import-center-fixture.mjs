import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importPackageFiles, planningImport, importQuest } from './installed-import-fixture.mjs';
import { installReviewedPackage, jsonResponse, zip } from './installed-graph-fixture.mjs';
import { dmToolsPermissions } from './installed-dm-fixture.mjs';

let workerBytes;
async function providerPackage({ id, root, output, archive }) {
  if (!workerBytes) {
    const path = resolve(output, process.platform === 'win32' ? 'import-provider.exe' : 'import-provider');
    await promisify(execFile)('go', ['build', '-o', path, './frontend/test/fixtures/import-provider'], { cwd: root, windowsHide: true, timeout: 120_000 });
    workerBytes = await readFile(path);
  }
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const entrypoint = process.platform === 'win32' ? 'worker/provider.exe' : 'worker/provider';
  const manifest = { packageFormat: 1, id, name: 'Import provider fixture', version: '1.0.0', compatibility: { host: '^2.0.0', addonApi: '^3.0.0', workerProtocol: '^1.0.0' },
    capabilities: { required: ['data.transactions', 'worker.native'], optional: [] }, permissions: [],
    runtime: { worker: { type: 'native', protocol: '^1.0.0', entrypoints: { [platform]: entrypoint } } },
    collections: [{ id: 'notes', keyed: true, visibility: 'dm', schema: 'contracts/fixture-note.json', schemaVersion: '1.0.0' }],
    services: { provides: [{ contract: 'codex.import-adapter', version: '2.0.0', transport: 'worker', schema: 'contracts/import-adapter.service.json' }] } };
  const files = Object.fromEntries(Object.entries(importPackageFiles(archive)).filter(([name]) => name.startsWith('contracts/')));
  files['addon.json'] = JSON.stringify(manifest); files[entrypoint] = workerBytes;
  files['contracts/fixture-note.json'] = JSON.stringify({ type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } });
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')])) });
  return zip(files);
}

export async function exerciseImportCenter({ t, root, output, open, admin, csrf, disable, mobile }) {
  const archive = await readFile(resolve(process.env.CODEX_DM_TOOLS_ZIP));
  const installed = new Set(); let consumer = false;
  t.after(async () => { if (consumer) await disable('dm-tools'); for (const id of [...installed].reverse()) await disable(id); });
  const installProvider = async id => { await installReviewedPackage(admin, csrf, id, await providerPackage({ id, root, output, archive }), []); installed.add(id); };
  await installProvider('external-importer'); await installProvider('broken-importer');
  await installReviewedPackage(admin, csrf, 'dm-tools', archive, dmToolsPermissions); consumer = true;
  const page = await open(t, 'dm', mobile); await page.goto('/#/addons/dm-tools/imports');
  const file = page.locator('.dm-tools-import input[type="file"]');
  const choose = (value, name = 'notes.json') => file.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
  await page.getByRole('heading', { name: 'External notes', exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'broken-importer' }).waitFor();
  await page.getByRole('button', { name: 'Refresh available formats', exact: true }).click(); await page.locator('.dm-import-shell[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('.dm-import-adapter').count(), 2);
  assert.equal(await page.locator('.dm-import-dropzone').evaluate(e => getComputedStyle(e).minHeight), '256px');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, `import-chooser-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  const sent = []; page.on('request', request => { if (request.url().endsWith('/services/call')) sent.push(request.postDataJSON()); });
  for (const [source, error] of [['invalid', 'not valid JSON'], ['[]', 'top-level'], [{ format: 'unsupported' }, 'No enabled importer']]) {
    await choose(source); await page.getByRole('alert').filter({ hasText: error }).waitFor();
  }
  await file.setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) }); await page.getByRole('alert').filter({ hasText: '2 MiB' }).waitFor();
  assert.equal(sent.filter(call => call.method === 'preview').length, 0);

  await page.route('**/services/call', route => route.request().postDataJSON().method === 'describe'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.getByRole('button', { name: 'Refresh available formats', exact: true }).click();
  await page.getByRole('heading', { name: 'No import adapters are available', exact: true }).waitFor(); assert.equal(await file.isDisabled(), true);
  await page.unroute('**/services/call'); await page.getByRole('button', { name: 'Refresh available formats', exact: true }).click();
  await page.getByRole('heading', { name: 'External notes', exact: true }).waitFor();

  await page.route('**/services/call', async route => {
    if (route.request().postDataJSON().method !== 'preview') return route.continue();
    const response = await route.fetch(), body = await response.json(); body.result.format = 'different-format';
    await route.fulfill({ response, json: body });
  });
  await choose({ format: 'fixture-notes', id: 'invalid-review', text: 'Must not commit' });
  await page.getByRole('alert').filter({ hasText: 'invalid review' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Commit reviewed import', exact: true }).count(), 0); await page.unroute('**/services/call');

  const id = mobile ? 'external-phone' : 'external-desktop', text = `<img src=x onerror=alert(1)> ${'n'.repeat(140)}`;
  await page.locator('.dm-import-dropzone').evaluate((element, document) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([JSON.stringify(document)], 'dropped-notes.json', { type: 'application/json' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { format: 'fixture-notes', id, text });
  await page.getByText('Preview ready. No campaign data has changed.', { exact: true }).waitFor();
  assert.equal(sent.filter(call => call.method === 'preview').at(-1).providerAddonId, 'external-importer');
  await page.getByRole('region', { name: 'Document routing' }).getByText('dropped-notes.json', { exact: true }).waitFor();
  assert.equal(await page.locator('.dm-import-preview img').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.dm-import-change summary').click(); await page.getByText(`Collection: notes · Record: ${id}`, { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, `import-review-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });

  const provider = (await jsonResponse(await admin.get('/api/admin/addons/external-importer'))).state.activeGenerationId;
  const records = async () => (await jsonResponse(await admin.post(`/api/addons/external-importer/generations/${provider}/data/query`, { headers: { 'X-Codex-CSRF': csrf }, data: { contractVersion: 'addon-data-query.v1', kind: 'collection', dataId: 'notes', limit: 200, where: [] } }))).documents;
  assert.equal((await records()).some(record => record.key === id), false);
  let release, started; const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { started = resolve; }); t.after(() => release());
  await page.route('**/services/call', async route => { if (route.request().postDataJSON().method !== 'commit') return route.continue(); started(); await held; await route.continue(); });
  await page.getByRole('button', { name: 'Commit reviewed import', exact: true }).click(); await pending;
  await page.evaluate(() => { location.hash = '#/dm'; }); await page.getByText('Committing the exact reviewed plan…', { exact: true }).waitFor();
  assert.match(page.url(), /\/imports$/u);
  release(); await page.unrouteAll({ behavior: 'wait' }); await page.getByText('Import committed: 1 writes and 0 deletions.', { exact: true }).waitFor();
  assert.equal((await records()).find(record => record.key === id).value.text, text);
  await page.getByRole('button', { name: 'Choose another document', exact: true }).click();
  assert.equal(await page.getByText('Preview cancelled. No campaign data has changed.', { exact: true }).count(), 0);

  // Abort an in-flight preview, then ensure its late response cannot restore a review.
  let releasePreview, previewStarted; const heldPreview = new Promise(resolve => { releasePreview = resolve; }), pendingPreview = new Promise(resolve => { previewStarted = resolve; }); t.after(() => releasePreview());
  await page.route('**/services/call', async route => { if (route.request().postDataJSON().method !== 'preview') return route.continue(); const response = await route.fetch(); previewStarted(); await heldPreview; await route.fulfill({ response }).catch(() => {}); });
  await choose({ format: 'fixture-notes', id: `${id}-cancel`, text: 'Cancelled' }); await pendingPreview;
  await page.getByRole('button', { name: 'Cancel preview', exact: true }).click(); releasePreview(); await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await page.locator('.dm-import-preview').count(), 0); assert.equal((await records()).some(record => record.key.endsWith('-cancel')), false);

  await installProvider('duplicate-importer'); await page.reload(); await page.locator('.dm-import-adapter').filter({ hasText: 'External notes' }).nth(1).waitFor();
  const before = sent.filter(call => call.method === 'preview').length;
  await choose({ format: 'fixture-notes', id, text }); await page.getByRole('alert').filter({ hasText: 'More than one importer' }).waitFor();
  assert.equal(sent.filter(call => call.method === 'preview').length, before);
  // An ambiguous external format must not prevent the independently owned planning format.
  await choose(planningImport([importQuest(`center-${id}`)])); await page.getByText('Preview ready. No campaign data has changed.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('codex_lang', 'cs')); await page.reload();
  await page.getByRole('heading', { name: 'Centrum importu', exact: true }).waitFor(); await page.locator('.dm-import-shell[aria-busy="false"]').waitFor();
  await choose(planningImport([importQuest(`center-cs-${id}`)])); await page.getByText('Náhled je připraven. Data kampaně se nezměnila.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Uložit zkontrolovaný import', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, `import-review-cs-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
  await page.getByRole('button', { name: 'Zrušit náhled', exact: true }).click();
}
