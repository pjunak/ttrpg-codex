// Unit: Store.patchAddonData — read-modify-write of ONE addon namespace on a
// core entity (Phase 5). No server/DOM needed: the mutation is local, and
// _sync no-ops because _serverAvailable starts false in tests.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = globalThis.window || { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = globalThis.document || { createElement: () => ({}) };

const { Store } = await import('../web/js/store.js');

test('patchAddonData: creates a namespace on a character', () => {
  Store.saveCharacter({ id: 'pad_a', name: 'Pad A', faction: 'neutral' });
  const saved = Store.patchAddonData('characters', 'pad_a', 'demo-sheet', s => ({ ...s, hp: 7, maxHp: 10 }));
  assert.ok(saved);
  const ad = Store.getCharacter('pad_a').addonData['demo-sheet'];
  assert.equal(ad.hp, 7);
  assert.equal(ad.maxHp, 10);
});

test('patchAddonData: only touches its own namespace', () => {
  Store.saveCharacter({ id: 'pad_b', name: 'Pad B', faction: 'neutral', addonData: { other: { keep: 1 } } });
  Store.patchAddonData('characters', 'pad_b', 'mine', s => ({ ...s, x: 2 }));
  const ad = Store.getCharacter('pad_b').addonData;
  assert.equal(ad.other.keep, 1, 'a different addon namespace is left untouched');
  assert.equal(ad.mine.x, 2);
});

test('patchAddonData: patchFn receives the current namespace', () => {
  Store.saveCharacter({ id: 'pad_c', name: 'Pad C', faction: 'neutral', addonData: { mine: { hp: 3 } } });
  let seen = null;
  Store.patchAddonData('characters', 'pad_c', 'mine', s => { seen = s; return { ...s, hp: s.hp + 1 }; });
  assert.equal(seen.hp, 3);
  assert.equal(Store.getCharacter('pad_c').addonData.mine.hp, 4);
});

test('patchAddonData: tolerates a patchFn that mutates + returns nothing', () => {
  Store.saveCharacter({ id: 'pad_d', name: 'Pad D', faction: 'neutral' });
  Store.patchAddonData('characters', 'pad_d', 'mine', s => { s.flag = true; });
  assert.equal(Store.getCharacter('pad_d').addonData.mine.flag, true);
});

test('patchAddonData: returns null for unknown collection / missing entity', () => {
  assert.equal(Store.patchAddonData('not_a_collection', 'x', 'a', s => s), null);
  assert.equal(Store.patchAddonData('characters', 'no_such_id', 'a', s => s), null);
});
