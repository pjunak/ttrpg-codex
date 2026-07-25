import { createRequire } from 'node:module';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { writeRevision as browserRevision } from '../web/js/write-revision.js';

const require = createRequire(import.meta.url);
const { writeRevision: serverRevision } = require('../server/write-revision.cjs');

test('browser and server write revisions share deterministic JSON vectors', () => {
  const vectors = [
    null,
    [],
    {},
    { id: 'character', name: 'Žluťoučký kůň', tags: ['a', 'b'] },
    { nested: { enabled: true, count: 3 }, empty: '' },
  ];
  for (const value of vectors) {
    assert.equal(browserRevision(value), serverRevision(value));
    assert.match(browserRevision(value), /^[0-9a-f]{16}$/);
  }
  assert.notEqual(browserRevision({ id: 'a' }), browserRevision({ id: 'b' }));
});
