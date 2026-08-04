import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(
  new URL('../.github/workflows/addon-compatibility.yml', import.meta.url),
  'utf8',
);

test('public addon CI checks out and tests the engine required by sheet integration tests', () => {
  const engineCheckout = workflow.indexOf('repository: pjunak/addon-dnd-engine');
  const enginePath = workflow.indexOf('path: addon-dnd-engine', engineCheckout);
  const engineTest = workflow.indexOf('working-directory: addon-dnd-engine', enginePath);
  const sheetTest = workflow.indexOf('working-directory: dnd-character-sheets', engineTest);

  assert.ok(engineCheckout >= 0, 'engine repository checkout is required');
  assert.ok(enginePath > engineCheckout, 'engine must use the sibling path expected by addon tests');
  assert.ok(engineTest > enginePath, 'engine suite must run against the current host revision');
  assert.ok(sheetTest > engineTest, 'sheet integration tests must run after the engine checkout');
});
