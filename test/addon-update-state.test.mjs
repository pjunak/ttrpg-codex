import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  indexAddonUpdates,
  withoutAddonUpdate,
} from '../web/js/addon-update-state.js';

test('indexAddonUpdates keeps valid results keyed by addon id', () => {
  const first = { id: 'first', hasUpdate: true };
  const second = { id: 'second', hasUpdate: false };

  assert.deepEqual(indexAddonUpdates([first, null, {}, second]), {
    first,
    second,
  });
  assert.deepEqual(indexAddonUpdates(null), {});
});

test('withoutAddonUpdate removes only the changed addon result', () => {
  const updates = indexAddonUpdates([
    { id: 'first', hasUpdate: true },
    { id: 'second', hasUpdate: true },
    { id: 'third', status: 'error' },
  ]);

  assert.deepEqual(withoutAddonUpdate(updates, 'second'), {
    first: { id: 'first', hasUpdate: true },
    third: { id: 'third', status: 'error' },
  });
  assert.equal(Object.hasOwn(updates, 'second'), true);
});
