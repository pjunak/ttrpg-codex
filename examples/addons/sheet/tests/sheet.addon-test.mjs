// Tier-B CLIENT self-test for the sheet addon (Phase 8), written against the
// published host test harness — the reference for how an addon ships tests.
// Declared in addon.json as `tests.client`. Run standalone:
//   node --test examples/addons/sheet/tests/sheet.addon-test.mjs
// (It lives outside test/, so the project's `npm test` does NOT auto-run it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dryRunRegister, smokeRegistrations } from '../../../../web/js/addon-test-harness.mjs';
import register from '../entry.js';

const META = {
  id: 'demo-sheet',
  permissions: [
    'ui:article-section:characters', 'ui:editor-fields:characters',
    'ui:action', 'ui:settings-tab', 'data:read:characters', 'data:write:characters.addonData',
  ],
};

test('sheet: register is clean + wires the expected surface', () => {
  const { ok, rec, error } = dryRunRegister(register, META);
  assert.ok(ok, error);
  assert.ok(rec.articleSections.some(s => s.kind === 'characters'), 'an article section on characters');
  assert.ok(rec.editorFields.some(e => e.kind === 'characters'),    'editor fields on characters');
  assert.ok(rec.actions.some(a => a.name === 'hp'),                 'the hp action');
});

test('sheet: renderers survive the smoke pass', () => {
  const { rec } = dryRunRegister(register, META);
  const smoke = smokeRegistrations(rec);
  assert.ok(smoke.ok, JSON.stringify(smoke.failures));
});
