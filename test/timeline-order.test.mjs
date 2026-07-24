import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planTimelineReorder,
  timelineSittingColumn,
} from '../web/js/timeline-order.js';

test('timeline reorder: missing, null, and legacy-zero sittings display in column one', () => {
  assert.equal(timelineSittingColumn(undefined), 1);
  assert.equal(timelineSittingColumn(null), 1);
  assert.equal(timelineSittingColumn(0), 1);
  assert.equal(timelineSittingColumn(4), 4);
});

test('timeline reorder: ordering within column one does not normalize sitting as a side effect', () => {
  const events = new Map([
    ['missing', { id: 'missing', order: 2, note: 'keep' }],
    ['null', { id: 'null', sitting: null, order: 1, note: 'keep' }],
    ['legacy', { id: 'legacy', sitting: 0, order: 3, note: 'keep' }],
  ]);
  const writes = planTimelineReorder(
    [{ sitting: 1, ids: ['legacy', 'missing', 'null'] }],
    id => events.get(id),
  );

  assert.deepEqual(writes, [
    { id: 'legacy', sitting: 0, order: 1, note: 'keep' },
    { id: 'null', sitting: null, order: 3, note: 'keep' },
  ]);
  assert.equal(Object.hasOwn(writes[0], 'sitting'), true);
  assert.equal(writes[0].sitting, 0);
  assert.equal(writes[1].sitting, null);
});

test('timeline reorder: moving to another sitting writes the new positive sitting', () => {
  const event = { id: 'event', sitting: null, order: 1, note: 'keep' };
  assert.deepEqual(
    planTimelineReorder(
      [{ sitting: 3, ids: ['event'] }],
      () => event,
    ),
    [{ id: 'event', sitting: 3, order: 1, note: 'keep' }],
  );
});
