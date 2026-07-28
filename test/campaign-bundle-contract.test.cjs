'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FORMAT,
  buildImportInventory,
  planCampaignBundle,
} = require('../server/campaign-bundle-contract.cjs');

function snapshot(overrides = {}) {
  return {
    'core:characters': [],
    'core:locations': [
      {
        id: 'radov_existing',
        name: 'Radov',
        localMap: '/maps/local/radov_existing/map.png',
        connections: [],
        visibility: 'public',
      },
    ],
    'core:relationships': [],
    'core:factions': {},
    'core:settings': {
      pinTypes: [
        { id: 'market' },
        { id: 'custom' },
      ],
      characterStatuses: [{ id: 'alive' }],
      relationshipTypes: [
        { id: 'ally', target: 'character' },
        { id: 'mission', target: 'location' },
      ],
    },
    'core:events': [],
    'core:mysteries': [],
    'core:pantheon': [],
    'core:artifacts': [],
    'core:historicalEvents': [],
    ...overrides,
  };
}

function bundle(overrides = {}) {
  return {
    format: FORMAT,
    schemaVersion: 1,
    generatedAt: 1_785_200_000_000,
    records: {
      characters: [],
      locations: [],
      relationships: [],
    },
    addonImports: [],
    ...overrides,
  };
}

function idGenerator() {
  let sequence = 0;
  return label => `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++sequence}`;
}

test('campaign bundle reserves stable ids and expands connection symmetry', () => {
  const source = bundle({
    records: {
      characters: [
        {
          ref: 'npc.tom',
          operation: 'create',
          record: {
            name: 'Tom',
            faction: 'neutral',
            status: 'alive',
            location: { $id: { collection: 'locations', id: 'radov_existing' } },
            visibility: 'dm',
          },
        },
        {
          ref: 'npc.anezka',
          operation: 'create',
          record: {
            name: 'Anezka',
            faction: 'neutral',
            status: 'alive',
            location: { $ref: 'place.square' },
            visibility: 'public',
          },
        },
      ],
      locations: [
        {
          ref: 'place.square',
          operation: 'create',
          record: {
            name: 'Town Square',
            parentId: { $id: { collection: 'locations', id: 'radov_existing' } },
            connections: [
              { $id: { collection: 'locations', id: 'radov_existing' } },
            ],
            x: 0.5,
            y: 0.25,
            pinType: 'market',
            visibility: 'public',
          },
        },
      ],
      relationships: [
        {
          ref: 'relation.tom-anezka',
          operation: 'create',
          record: {
            source: { $ref: 'npc.tom' },
            target: { $ref: 'npc.anezka' },
            type: 'ally',
            label: 'Knows',
            visibility: 'dm',
          },
        },
      ],
    },
  });
  const original = structuredClone(source);
  const plan = planCampaignBundle(source, {
    snapshot: snapshot(),
    createId: idGenerator(),
  });

  assert.deepEqual(source, original);
  assert.equal(plan.diagnostics.filter(item => item.severity === 'error').length, 0);
  assert.equal(plan.review.logicalRecordCount, 4);
  assert.equal(plan.review.references.length, 4);
  assert.equal(plan.review.materializedWriteCount, 5);

  const square = plan.review.references.find(item => item.ref === 'place.square');
  const tom = plan.review.references.find(item => item.ref === 'npc.tom');
  const anezka = plan.review.references.find(item => item.ref === 'npc.anezka');
  assert.ok(square.id);
  assert.ok(tom.id);
  assert.ok(anezka.id);

  const characterOperation = plan.operations.find(operation => operation.id === anezka.id);
  assert.equal(characterOperation.value.location, square.id);
  const relationshipOperation = plan.operations.find(operation =>
    operation.target.collection === 'relationships');
  assert.equal(relationshipOperation.value.source, tom.id);
  assert.equal(relationshipOperation.value.target, anezka.id);

  const reverse = plan.operations.find(operation =>
    operation.target.collection === 'locations'
    && operation.id === 'radov_existing');
  assert.equal(reverse.meta.derived, true);
  assert.deepEqual(reverse.value.connections, [square.id]);
});

test('campaign bundle rejects unresolved, wrong-kind, and unsafe visibility references', () => {
  const plan = planCampaignBundle(bundle({
    records: {
      characters: [
        {
          ref: 'npc.public',
          operation: 'create',
          record: {
            name: 'Public',
            faction: 'neutral',
            status: 'alive',
            location: { $ref: 'place.secret' },
            visibility: 'public',
          },
        },
      ],
      locations: [
        {
          ref: 'place.secret',
          operation: 'create',
          record: {
            name: 'Secret',
            visibility: 'dm',
          },
        },
      ],
      relationships: [
        {
          ref: 'relation.bad',
          operation: 'create',
          record: {
            source: { $ref: 'place.secret' },
            target: { $ref: 'npc.missing' },
            type: 'ally',
            visibility: 'public',
          },
        },
      ],
    },
  }), {
    snapshot: snapshot(),
    createId: idGenerator(),
  });
  const codes = new Set(plan.diagnostics.map(item => item.code));

  assert.ok(codes.has('BUNDLE_REFERENCE_KIND'));
  assert.ok(codes.has('BUNDLE_REFERENCE_MISSING'));
  assert.ok(codes.has('BUNDLE_VISIBILITY_REFERENCE'));
});

test('campaign bundle validates map placement and relationship tuple identity', () => {
  const plan = planCampaignBundle(bundle({
    records: {
      characters: [
        {
          ref: 'npc.one',
          operation: 'create',
          record: {
            name: 'One',
            faction: 'neutral',
            status: 'alive',
            visibility: 'dm',
          },
        },
        {
          ref: 'npc.two',
          operation: 'create',
          record: {
            name: 'Two',
            faction: 'neutral',
            status: 'alive',
            visibility: 'dm',
          },
        },
      ],
      locations: [
        {
          ref: 'place.bad',
          operation: 'create',
          record: {
            name: 'Bad Pin',
            x: 1.5,
            pinType: 'missing',
            visibility: 'public',
          },
        },
      ],
      relationships: [
        {
          ref: 'relation.one',
          operation: 'create',
          record: {
            source: { $ref: 'npc.one' },
            target: { $ref: 'npc.two' },
            type: 'ally',
            visibility: 'dm',
          },
        },
        {
          ref: 'relation.two',
          operation: 'create',
          record: {
            source: { $ref: 'npc.one' },
            target: { $ref: 'npc.two' },
            type: 'ally',
            label: 'Duplicate',
            visibility: 'dm',
          },
        },
      ],
    },
  }), {
    snapshot: snapshot(),
    createId: idGenerator(),
  });
  const codes = new Set(plan.diagnostics.map(item => item.code));

  assert.ok(codes.has('BUNDLE_FIELD_INVALID'));
  assert.ok(codes.has('BUNDLE_PIN_TYPE_INVALID'));
  assert.ok(codes.has('BUNDLE_RELATIONSHIP_DUPLICATE'));
});

test('campaign bundle detects a tuple duplicate against an id-less stored relationship', () => {
  const plan = planCampaignBundle(bundle({
    records: {
      characters: [],
      locations: [],
      relationships: [
        {
          ref: 'relation.duplicate',
          operation: 'create',
          record: {
            source: { $id: { collection: 'characters', id: 'one' } },
            target: { $id: { collection: 'characters', id: 'two' } },
            type: 'ally',
            visibility: 'dm',
          },
        },
      ],
    },
  }), {
    snapshot: snapshot({
      'core:characters': [
        { id: 'one', name: 'One', visibility: 'dm' },
        { id: 'two', name: 'Two', visibility: 'dm' },
      ],
      'core:relationships': [
        { source: 'one', target: 'two', type: 'ally', visibility: 'dm' },
      ],
    }),
    createId: idGenerator(),
  });

  assert.ok(plan.diagnostics.some(item => item.code === 'BUNDLE_RELATIONSHIP_DUPLICATE'));
});

test('import inventory exposes exact revisions without bodies by default', () => {
  const records = {
    characters: [
      {
        id: 'hero',
        name: 'Hero',
        visibility: 'public',
        updatedAt: 42,
        description: 'Body',
      },
    ],
    locations: [
      {
        id: 'town',
        name: 'Town',
        visibility: 'public',
        x: 0.2,
        y: 0.3,
        localMap: '/maps/local/town/map.png',
      },
    ],
    relationships: [],
  };
  const inventory = buildImportInventory(records, {
    campaignRevision: 'campaign-revision',
    collectionRevisions: {
      characters: 'characters-revision',
      locations: 'locations-revision',
    },
  });

  assert.equal(inventory.format, 'ttrpg-codex-import-inventory');
  assert.equal(inventory.campaignRevision, 'campaign-revision');
  assert.equal(inventory.records.characters[0].label, 'Hero');
  assert.equal(inventory.records.characters[0].record, undefined);
  assert.match(inventory.records.characters[0].revision, /^[0-9a-f]{16}$/);
  assert.deepEqual(inventory.records.locations[0].placement, { x: 0.2, y: 0.3 });
  assert.equal(inventory.records.locations[0].hasLocalMap, true);

  const withBodies = buildImportInventory(records, { includeBodies: true });
  assert.equal(withBodies.records.characters[0].record.description, 'Body');
});
