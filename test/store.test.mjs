// Smoke tests for the client-side Store. Avoids load()/save paths
// (those need a fetch + DOM polyfill). Covers the deterministic
// helpers a future refactor most easily breaks: id generation,
// search, default snapshot shape.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Store's IIFE doesn't call browser APIs at import time, but
// `_sync` and the dispatch helpers do. Provide harmless globals so
// any *accidental* save path won't crash the test runner.
globalThis.window = globalThis.window || {
  addEventListener: () => {},
  dispatchEvent:    () => {},
};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.document = globalThis.document || { createElement: () => ({}) };

const { Store } = await import('../web/js/store.js');

test('generateId: slug + 6-char base36 suffix', () => {
  const a = Store.generateId('Frulam Mondath');
  assert.match(a, /^frulam_mondath_[a-z0-9]{6}$/);
});

test('generateId: distinct ids for the same name', () => {
  const a = Store.generateId('Same Name');
  const b = Store.generateId('Same Name');
  assert.notEqual(a, b);   // suffix prevents silent overwrite
  assert.match(a, /^same_name_[a-z0-9]{6}$/);
  assert.match(b, /^same_name_[a-z0-9]{6}$/);
});

test('generateId: handles diacritics + falls back to "e_xxxxxx" for empty', () => {
  assert.match(Store.generateId('Křesadlo'), /^kresadlo_[a-z0-9]{6}$/);
  assert.match(Store.generateId(''),         /^e_[a-z0-9]{6}$/);
});

test('init via getCharacters returns the default array', () => {
  // Defaults come from data.js (CHARACTERS = []).
  const cs = Store.getCharacters();
  assert.equal(Array.isArray(cs), true);
});

test('searchAll: returns the expected collection keys on empty data', () => {
  const out = Store.searchAll('');
  for (const k of [
    'characters', 'locations', 'events', 'mysteries',
    'pantheon', 'artifacts', 'historicalEvents',
  ]) {
    assert.equal(Array.isArray(out[k]), true, `searchAll missing array for ${k}`);
  }
});

test('getStatusMap: falls back to SETTINGS_DEFAULTS when settings unset', () => {
  // The default map must always include these three character statuses.
  const map = Store.getStatusMap();
  for (const id of ['alive', 'dead', 'unknown']) {
    assert.ok(map[id], `status ${id} missing from default map`);
    assert.ok(map[id].label,                'status entry has a label');
  }
});

test('getCampaign: returns name + tagline defaults', () => {
  const c = Store.getCampaign();
  assert.equal(typeof c.name,    'string');
  assert.equal(typeof c.tagline, 'string');
  assert.ok(c.name.length > 0);
});

test('getEnum: returns array for known categories, [] for unknown', () => {
  // 'attitudes' is one of the seeded categories; presence depends on
  // _mergeDefaults (only run inside load()), so we accept either an
  // empty array or the seeded one — both are valid for this smoke test.
  assert.equal(Array.isArray(Store.getEnum('attitudes')),     true);
  assert.deepEqual(Store.getEnum('not_a_real_category'),      []);
});

test('exportJSON: round-trips through JSON.parse', () => {
  const json   = Store.exportJSON();
  const parsed = JSON.parse(json);
  assert.equal(typeof parsed, 'object');
  assert.equal(typeof parsed._exported, 'string');
  // Top-level collections are present (factions might be {} if empty).
  for (const k of ['characters', 'locations', 'events', 'mysteries', 'factions']) {
    assert.ok(k in parsed, `exportJSON missing ${k}`);
  }
});
