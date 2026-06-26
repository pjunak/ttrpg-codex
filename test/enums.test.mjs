// Unit tests for the user-editable enum (settings) management: the
// usage scan + the three delete paths (refuse-when-used / force /
// replace-with) that gate every Settings category deletion. This is
// central, refactor-fragile logic with no coverage today. Saves no-op
// on `_sync` (server unavailable) and mutate the in-memory `_data`.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = globalThis.window || { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = globalThis.document || { createElement: () => ({}) };

const { Store } = await import('../web/js/store.js');

test('getEnumValue: returns the item when present, a synthetic _orphan otherwise', () => {
  Store.saveEnumItem('characterStatuses', { id: 'wounded', label: 'Wounded', color: '#a33' });
  const found = Store.getEnumValue('characterStatuses', 'wounded');
  assert.equal(found.label, 'Wounded');
  assert.notEqual(found._orphan, true);

  const orphan = Store.getEnumValue('characterStatuses', 'ghost-id');
  assert.equal(orphan._orphan, true);
  assert.equal(orphan.id, 'ghost-id');
});

test('saveEnumItem: upserts by id and stamps updatedAt', () => {
  Store.saveEnumItem('characterStatuses', { id: 'w2', label: 'Wounded' });
  Store.saveEnumItem('characterStatuses', { id: 'w2', label: 'Badly Wounded' });
  const items = Store.getEnum('characterStatuses').filter(x => x.id === 'w2');
  assert.equal(items.length, 1, 'upsert, not duplicate');
  assert.equal(items[0].label, 'Badly Wounded');
  assert.ok(items[0].updatedAt > 0);
});

test('findEnumUsages: detects scalar (status) and object-array (attitudes) references', () => {
  Store.saveEnumItem('characterStatuses', { id: 'wounded', label: 'Wounded' });
  Store.saveCharacter({ id: 'u1', name: 'U1', faction: 'neutral', status: 'wounded', knowledge: 4 });
  const scalar = Store.findEnumUsages('characterStatuses', 'wounded');
  assert.ok(scalar.some(u => u.collection === 'characters' && u.field === 'status' && u.id === 'u1'),
    'scalar status reference found');

  Store.saveCharacter({ id: 'u2', name: 'U2', faction: 'neutral', status: 'alive', knowledge: 4, attitudes: [{ id: 'ally' }] });
  const arr = Store.findEnumUsages('attitudes', 'ally');
  assert.ok(arr.some(u => u.collection === 'characters' && u.field === 'attitudes' && u.id === 'u2'),
    'object-array attitude reference found');

  Store.deleteCharacter('u1');
  Store.deleteCharacter('u2');
});

test('deleteEnumItem: refuses an in-use item without force/replaceWith', () => {
  Store.saveEnumItem('characterStatuses', { id: 'wounded', label: 'Wounded' });
  Store.saveCharacter({ id: 'using', name: 'U', faction: 'neutral', status: 'wounded', knowledge: 4 });

  const res = Store.deleteEnumItem('characterStatuses', 'wounded');
  assert.equal(res.ok, false);
  assert.ok(res.usages.length >= 1, 'usages reported back to the caller');
  assert.ok(Store.getEnum('characterStatuses').some(x => x.id === 'wounded'), 'item NOT deleted');

  Store.deleteCharacter('using');
});

test('deleteEnumItem: force deletes the item and leaves the reference orphaned', () => {
  Store.saveEnumItem('characterStatuses', { id: 'wounded', label: 'Wounded' });
  Store.saveCharacter({ id: 'orph', name: 'O', faction: 'neutral', status: 'wounded', knowledge: 4 });

  const res = Store.deleteEnumItem('characterStatuses', 'wounded', { force: true });
  assert.equal(res.ok, true);
  assert.equal(Store.getEnum('characterStatuses').some(x => x.id === 'wounded'), false, 'item removed');
  // The referencing entity is untouched → its id now resolves as an orphan.
  assert.equal(Store.getCharacter('orph').status, 'wounded');
  assert.equal(Store.getEnumValue('characterStatuses', 'wounded')._orphan, true);

  Store.deleteCharacter('orph');
});

test('deleteEnumItem: replaceWith remaps every usage to the new id, then deletes', () => {
  Store.saveEnumItem('characterStatuses', { id: 'wounded', label: 'Wounded' });
  Store.saveEnumItem('characterStatuses', { id: 'hurt',    label: 'Hurt' });
  Store.saveCharacter({ id: 'remap', name: 'R', faction: 'neutral', status: 'wounded', knowledge: 4 });

  const res = Store.deleteEnumItem('characterStatuses', 'wounded', { replaceWith: 'hurt' });
  assert.equal(res.ok, true);
  assert.equal(Store.getCharacter('remap').status, 'hurt', 'usage remapped to the replacement');
  assert.equal(Store.getEnum('characterStatuses').some(x => x.id === 'wounded'), false, 'old item removed');

  Store.deleteCharacter('remap');
});
