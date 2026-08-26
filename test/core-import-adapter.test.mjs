import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CoreImportAdapter } from '../web/js/core-import-adapter.js';

test('core campaign imports declare their routed JSON format', () => {
  const descriptor = CoreImportAdapter.service.descriptor();
  assert.equal(CoreImportAdapter.service.apiVersion, 1);
  assert.deepEqual(descriptor.formats, ['ttrpg-codex-campaign-bundle']);
  assert.equal(typeof CoreImportAdapter.service.open, 'function');
  assert.equal(typeof CoreImportAdapter.service.render, 'function');
  assert.equal(typeof CoreImportAdapter.service.leave, 'function');
});

test('the app publishes the routed import-adapter contract version', async () => {
  const source = await readFile(new URL('../web/js/app.js', import.meta.url), 'utf8');
  assert.match(source, /registerBuiltInService\('codex\.import-adapter', '1\.1\.0'/);
});
