const { test } = require('node:test');
const assert    = require('node:assert/strict');

const {
  filterForRole,
  filterDatasetForRole,
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

// -- Dataset graph closure -------------------------------------------------

function graphFixture() {
  return {
    characters: [
      { id: 'char_public', faction: 'faction_hidden', location: 'loc_hidden', visibility: 'public',
        locationRoles: [{ locationId: 'loc_public', role: 'guest' }, { locationId: 'loc_hidden', role: 'spy' }],
        lastChange: { fields: [{ key: 'faction', from: 'faction_hidden', to: 'neutral' }] } },
      { id: 'char_hidden', faction: 'faction_hidden', visibility: 'dm' },
    ],
    factions: {
      faction_public: { id: 'faction_public', visibility: 'public' },
      faction_hidden: { id: 'faction_hidden', visibility: 'dm' },
    },
    locations: [
      { id: 'loc_public', parentId: 'loc_hidden', connections: ['loc_public', 'loc_hidden'],
        characters: ['char_public', 'char_hidden'], visibility: 'public' },
      { id: 'loc_hidden', visibility: 'dm' },
    ],
    events: [
      { id: 'event_public', characters: ['char_public', 'char_hidden'],
        locations: ['loc_public', 'loc_hidden'], mapParentId: 'loc_hidden', visibility: 'public' },
      { id: 'event_hidden', visibility: 'dm' },
    ],
    mysteries: [
      { id: 'mystery_public', characters: ['char_public', 'char_hidden'],
        locations: ['loc_public', 'loc_hidden'], visibility: 'public' },
      { id: 'mystery_hidden', visibility: 'dm' },
    ],
    relationships: [
      { id: 'kept-character', source: 'char_public', target: 'char_public', type: 'ally', visibility: 'public' },
      { id: 'hidden-source', source: 'char_hidden', target: 'char_public', type: 'ally', visibility: 'public' },
      { id: 'hidden-target', source: 'char_public', target: 'char_hidden', type: 'ally', visibility: 'public' },
      { id: 'kept-location', source: 'char_public', target: 'loc_public', type: 'mission', visibility: 'public' },
      { id: 'hidden-location', source: 'char_public', target: 'loc_hidden', type: 'mission', visibility: 'public' },
    ],
    artifacts: [
      { id: 'artifact_public', ownerCharacterId: 'char_hidden', locationId: 'loc_hidden', visibility: 'public' },
    ],
    historicalEvents: [
      { id: 'history_public', characters: ['char_public', 'char_hidden'],
        locations: ['loc_public', 'loc_hidden'], visibility: 'public' },
    ],
    pets: [
      { id: 'pet_char', ownerType: 'character', ownerId: 'char_hidden' },
      { id: 'pet_faction', ownerType: 'faction', ownerId: 'faction_hidden' },
    ],
    settings: {
      relationshipTypes: [{ id: 'mission', target: 'location' }],
      mapViews: [
        { id: 'world-view', parentId: null },
        { id: 'public-view', parentId: 'loc_public' },
        { id: 'hidden-view', parentId: 'loc_hidden' },
      ],
      mapConfigs: {
        world: { zoomScaleRatio: 0 },
        'local-loc_public': { zoomScaleRatio: 0.5 },
        'local-loc_hidden': { zoomScaleRatio: 1 },
      },
    },
    'addon:notes:notes': [{ id: 'public-addon-record', body: 'Public addon data' }],
  };
}

test('filterDatasetForRole: DM receives the complete payload by identity', () => {
  const dataset = graphFixture();
  assert.equal(filterDatasetForRole(dataset, 'dm'), dataset);
});

test('filterDatasetForRole: closes documented references over surviving entity ids', () => {
  const dataset = graphFixture();
  const snapshot = structuredClone(dataset);
  const out = filterDatasetForRole(dataset, 'player');

  assert.deepEqual(out.characters.map(x => x.id), ['char_public']);
  assert.equal(Object.hasOwn(out.characters[0], 'faction'), false);
  assert.equal(Object.hasOwn(out.characters[0], 'location'), false);
  assert.deepEqual(out.characters[0].locationRoles, [{ locationId: 'loc_public', role: 'guest' }]);
  assert.deepEqual(out.characters[0].lastChange.fields, []);
  assert.deepEqual(Object.keys(out.factions), ['faction_public']);

  assert.deepEqual(out.locations.map(x => x.id), ['loc_public']);
  assert.equal(Object.hasOwn(out.locations[0], 'parentId'), false);
  assert.deepEqual(out.locations[0].connections, ['loc_public']);
  assert.deepEqual(out.locations[0].characters, ['char_public']);

  assert.deepEqual(out.events, [{
    id: 'event_public', characters: ['char_public'], locations: ['loc_public'], visibility: 'public',
  }]);
  assert.deepEqual(out.mysteries, [{
    id: 'mystery_public', characters: ['char_public'], locations: ['loc_public'], visibility: 'public',
  }]);
  assert.deepEqual(out.relationships.map(x => x.id), ['kept-character', 'kept-location']);
  assert.equal(Object.hasOwn(out.artifacts[0], 'ownerCharacterId'), false);
  assert.equal(Object.hasOwn(out.artifacts[0], 'locationId'), false);
  assert.deepEqual(out.historicalEvents[0].characters, ['char_public']);
  assert.deepEqual(out.historicalEvents[0].locations, ['loc_public']);
  assert.deepEqual(out.pets.map(p => [p.ownerType, p.ownerId]), [['none', ''], ['none', '']]);
  assert.deepEqual(out.settings.mapViews.map(v => v.id), ['world-view', 'public-view']);
  assert.deepEqual(Object.keys(out.settings.mapConfigs), ['world', 'local-loc_public']);
  assert.equal(out['addon:notes:notes'], dataset['addon:notes:notes'],
    'API v1 addon collections are public and schema-opaque');
  assert.deepEqual(dataset, snapshot, 'player filtering must not mutate the DM/source payload');
});

test('filterDatasetForRole: reserved neutral and party faction ids survive without faction records', () => {
  const out = filterDatasetForRole({
    characters: [
      { id: 'npc', faction: 'neutral', visibility: 'public' },
      { id: 'pc', faction: 'party', visibility: 'public' },
      { id: 'orphan', faction: 'deleted-faction', visibility: 'public' },
    ],
    factions: {},
  }, 'player');
  assert.equal(out.characters[0].faction, 'neutral');
  assert.equal(out.characters[1].faction, 'party');
  assert.equal(Object.hasOwn(out.characters[2], 'faction'), false);
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
