const { test } = require('node:test');
const assert    = require('node:assert/strict');

const {
  filterForRole,
  stripEntityForRole,
  VISIBILITY_BEARING,
  KEYED_OBJ_VISIBILITY,
} = require('../server/visibility.cjs');

// ── stripEntityForRole ────────────────────────────────────────────

test('stripEntityForRole: DM gets the entity unchanged (identity)', () => {
  const e = { id: 'x', name: 'X', linkedTwinId: 'dm_x', visibility: 'public' };
  const out = stripEntityForRole(e, 'characters', 'dm');
  assert.equal(out, e); // identity reference
});

test('stripEntityForRole: non-DM viewer never sees linkedTwinId', () => {
  // The presence of linkedTwinId would leak "this entity has a DM
  // twin with hidden lore" — strip it from non-DM payloads.
  const e = { id: 'x', name: 'X', linkedTwinId: 'dm_x', visibility: 'public' };
  const out = stripEntityForRole(e, 'characters', 'player');
  assert.equal(out.name, 'X');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'linkedTwinId'), false);
});

test('stripEntityForRole: entities without linkedTwinId are unchanged for non-DM', () => {
  const e = { id: 'x', name: 'X', visibility: 'public' };
  const out = stripEntityForRole(e, 'characters', 'player');
  assert.deepEqual(out, e);
  assert.notEqual(out, e); // but cloned, not identity
});

test('stripEntityForRole: non-object input is passed through', () => {
  assert.equal(stripEntityForRole(null,      'characters', 'player'), null);
  assert.equal(stripEntityForRole(undefined, 'characters', 'player'), undefined);
  assert.equal(stripEntityForRole(42,        'characters', 'player'), 42);
});

// ── filterForRole ─────────────────────────────────────────────────

test('filterForRole: DM filter is identity', () => {
  const arr = [{ id: 'a', visibility: 'dm' }, { id: 'b', visibility: 'public' }];
  assert.equal(filterForRole('characters', arr, 'dm'), arr);
});

test('filterForRole: drops DM-only entities from list-shape', () => {
  const arr = [
    { id: 'a', visibility: 'dm',     description: 'a' },
    { id: 'b', visibility: 'public', description: 'b' },
    { id: 'c',                       description: 'c' }, // missing visibility = public
  ];
  const out = filterForRole('characters', arr, 'player');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(x => x.id).sort(), ['b', 'c']);
});

test('filterForRole: drops DM-only entities from keyed-object shape (factions)', () => {
  const obj = {
    cult:    { name: 'Kult',    visibility: 'dm' },
    council: { name: 'Council', visibility: 'public' },
  };
  const out = filterForRole('factions', obj, 'player');
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out.council.name, 'Council');
  assert.equal(out.cult, undefined);
});

test('filterForRole: strips linkedTwinId from every surviving entity in non-DM payload', () => {
  const arr = [
    { id: 'a', visibility: 'public', linkedTwinId: 'dm_a' },
    { id: 'b', visibility: 'public' },  // no twin
  ];
  const out = filterForRole('characters', arr, 'player');
  assert.equal(out.length, 2);
  for (const e of out) {
    assert.equal(Object.prototype.hasOwnProperty.call(e, 'linkedTwinId'), false);
  }
});

test('filterForRole: non-visibility-bearing collections pass through unchanged', () => {
  assert.equal(VISIBILITY_BEARING.has('settings'),        false);
  assert.equal(VISIBILITY_BEARING.has('deletedDefaults'), false);
  assert.equal(VISIBILITY_BEARING.has('campaign'),        false);
  const settings = { foo: [1, 2, 3] };
  assert.equal(filterForRole('settings', settings, 'player'), settings);
});

test('filterForRole: list with no entities returns empty list', () => {
  const out = filterForRole('characters', [], 'player');
  assert.deepEqual(out, []);
});

test('filterForRole: does not mutate the input container or its entities', () => {
  const original = [
    { id: 'a', visibility: 'public', linkedTwinId: 'dm_a' },
  ];
  const snapshot = JSON.parse(JSON.stringify(original));
  filterForRole('characters', original, 'player');
  assert.deepEqual(original, snapshot, 'source container should be unchanged');
});

// ── Schema completeness ───────────────────────────────────────────

test('VISIBILITY_BEARING: covers every collection that has DM-relevant content', () => {
  const expected = [
    'characters', 'relationships', 'locations', 'events',
    'mysteries', 'factions', 'pantheon', 'artifacts',
    'historicalEvents',
  ];
  for (const c of expected) {
    assert.equal(VISIBILITY_BEARING.has(c), true, `${c} must be in VISIBILITY_BEARING`);
  }
});

test('KEYED_OBJ_VISIBILITY: factions is the only keyed-object visibility-bearing collection today', () => {
  assert.equal(KEYED_OBJ_VISIBILITY.has('factions'), true);
});
