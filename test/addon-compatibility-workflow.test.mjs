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
  const sheetCheckout = workflow.indexOf('repository: pjunak/addon-dnd-character-sheets');
  const sheetTest = workflow.indexOf('working-directory: addon-dnd-character-sheets', engineTest);

  assert.ok(engineCheckout >= 0, 'engine repository checkout is required');
  assert.ok(enginePath > engineCheckout, 'engine must use the sibling path expected by addon tests');
  assert.ok(engineTest > enginePath, 'engine suite must run against the current host revision');
  assert.ok(sheetCheckout > engineCheckout, 'the addon-prefixed sheets repository must be checked out');
  assert.ok(sheetTest > engineTest, 'sheet integration tests must run after the engine checkout');
});

test('private compendium CI checks out its validator dependency at the expected sibling path', () => {
  const privateJob = workflow.indexOf('private-compendium:');
  const compendiumCheckout = workflow.indexOf('repository: pjunak/addon-dnd-2024-compendium', privateJob);
  const engineCheckout = workflow.indexOf('repository: pjunak/addon-dnd-engine', compendiumCheckout);
  const enginePath = workflow.indexOf('path: addon-dnd-engine', engineCheckout);
  const compendiumTest = workflow.indexOf('working-directory: addon-dnd-2024-compendium', enginePath);

  assert.ok(compendiumCheckout > privateJob, 'the renamed private compendium must be checked out');
  assert.ok(engineCheckout > compendiumCheckout, 'the engine validator checkout is required');
  assert.ok(enginePath > engineCheckout, 'the engine must use the sibling path imported by integrity tests');
  assert.ok(compendiumTest > enginePath, 'the compendium suite must run after validator checkout');
  assert.doesNotMatch(workflow, /pjunak\/(?:dnd-character-sheets|dnd55e-compendium)/);
});
