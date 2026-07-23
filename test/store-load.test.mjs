import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.document = { createElement: () => ({}) };
globalThis.CustomEvent = globalThis.CustomEvent || class {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const { Store } = await import('../web/js/store.js?store-load-tests');

function response(payload, { ok = true, jsonError = null } = {}) {
  return {
    ok,
    json: async () => {
      if (jsonError) throw jsonError;
      return payload;
    },
  };
}

test('load accepts a sparse object without characters and normalizes collections', async () => {
  globalThis.fetch = async () => response({
    locations: [{ id: 'sparse-location', name: 'Sparse' }],
  });

  assert.equal(await Store.load(), true);
  assert.deepEqual(Store.getCharacters(), []);
  assert.equal(Store.getLocation('sparse-location').name, 'Sparse');
  assert.deepEqual(Store.getRelationships(), []);
  assert.equal(typeof Store.getFactions(), 'object');
});

test('invalid, failed, and superseded loads preserve the last valid state', async () => {
  globalThis.fetch = async () => response({
    characters: [{ id: 'kept', name: 'Kept', faction: 'neutral' }],
  });
  assert.equal(await Store.load(), true);

  for (const next of [
    () => response(null),
    () => response([]),
    () => response(null, { ok: false }),
    () => response(null, { jsonError: new SyntaxError('bad json') }),
  ]) {
    globalThis.fetch = async () => next();
    assert.equal(await Store.load(), false);
    assert.equal(Store.getCharacter('kept').name, 'Kept');
  }

  globalThis.fetch = async () => response({
    characters: [{ id: 'stale', name: 'Stale', faction: 'neutral' }],
  });
  assert.equal(await Store.load({ shouldCommit: () => false }), false);
  assert.equal(Store.getCharacter('kept').name, 'Kept');
  assert.equal(Store.getCharacter('stale'), null);
});
