'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  migrateCampaignShape,
} = require('../server/campaign-shape-migration.cjs');

test('campaign shape migration applies every legacy transformation once', () => {
  const dataset = {
    characters: [
      {
        id: 'pc',
        faction: 'party',
        status: 'captured',
        attitudes: ['enemy', { id: 'enemy', strength: 0.4 }, 'party'],
        unknown: ['Where?', { text: 'Why?', answer: 'Because' }, { text: 'Who?' }, null],
      },
      {
        id: 'npc',
        faction: 'guild',
        attitude: 'ally',
        circumstances: 'Preserve me',
      },
      {
        id: 'canonical',
        faction: 'guild',
        status: 'alive',
        attitudes: [{ id: 'ally' }],
        unknown: [{ text: 'Done', answer: '' }],
      },
    ],
    locations: [
      {
        id: 'keep',
        mapStatus: 'visited',
        status: 'occupied',
        priority: 1,
        attitudes: [{ id: 'neutral', strength: 0.2 }, 'party'],
      },
      {
        id: 'fog',
        mapStatus: 'fog',
        priority: 9,
      },
    ],
    factions: {
      party: {
        name: 'The Heroes',
        badge: '⚔',
        color: '#123456',
        textColor: '#abcdef',
      },
      guild: {
        name: 'Guild',
        attitudes: ['ally', 'ally', 'unknown', 'party'],
      },
    },
    mysteries: [
      {
        id: 'mystery',
        questions: ['What?', { text: 'How?' }, { text: 'Solved', answer: 'Yes' }, 3],
      },
    ],
    artifacts: [
      { id: 'relic', state: 'lost', name: 'Relic' },
    ],
    settings: {
      mapStatuses: [{ id: 'visited' }],
      locationStatuses: [{ id: 'occupied' }],
      artifactStates: [{ id: 'lost' }],
      attitudes: [
        { id: 'unknown', label: 'Unknown' },
        { id: 'party', label: 'Party' },
        { id: 'enemy', label: 'Enemy' },
        { id: 'ally', label: 'Ally', strength: 0.5 },
      ],
      pinTypes: [
        {
          id: 'city',
          priority: 2,
          iconConfig: {
            strategy: 'state',
            files: [
              { url: '/one.svg', stateId: 'occupied' },
              { url: '/two.svg' },
            ],
          },
        },
        { id: 'custom' },
      ],
    },
    deletedDefaults: { existing: true },
  };

  const first = migrateCampaignShape(dataset);
  assert.ok(first.changed > 0);
  assert.deepEqual(dataset.characters, [
    {
      id: 'pc',
      faction: 'party',
      status: 'alive',
      circumstances: 'Zajat/a',
      attitudes: [],
      unknown: [
        { text: 'Where?', answer: '' },
        { text: 'Why?', answer: 'Because' },
        { text: 'Who?', answer: '' },
        { text: '', answer: '' },
      ],
    },
    {
      id: 'npc',
      faction: 'guild',
      circumstances: 'Preserve me',
      attitudes: [{ id: 'ally' }],
    },
    {
      id: 'canonical',
      faction: 'guild',
      status: 'alive',
      attitudes: [{ id: 'ally' }],
      unknown: [{ text: 'Done', answer: '' }],
    },
  ]);
  assert.deepEqual(dataset.locations, [
    {
      id: 'keep',
      size: 36,
      attitudes: [{ id: 'neutral' }, { id: 'ally' }],
    },
    {
      id: 'fog',
      attitudes: [],
    },
  ]);
  assert.deepEqual(dataset.factions, {
    guild: {
      name: 'Guild',
      attitudes: [{ id: 'ally' }],
    },
  });
  assert.deepEqual(dataset.mysteries[0].questions, [
    { text: 'What?', answer: '' },
    { text: 'How?', answer: '' },
    { text: 'Solved', answer: 'Yes' },
    { text: '', answer: '' },
  ]);
  assert.deepEqual(dataset.artifacts, [{ id: 'relic', name: 'Relic' }]);
  assert.deepEqual(dataset.settings, {
    attitudes: [
      { id: 'enemy', label: 'Enemy', strength: 1 },
      { id: 'ally', label: 'Ally', strength: 0.5 },
    ],
    pinTypes: [
      {
        id: 'city',
        size: 30,
        iconConfig: {
          strategy: 'single',
          files: [
            { url: '/one.svg' },
            { url: '/two.svg' },
          ],
        },
      },
      { id: 'custom', size: 28 },
    ],
    playerParty: {
      name: 'The Heroes',
      icon: '⚔',
      badge: '⚔',
      color: '#123456',
      textColor: '#abcdef',
    },
  });
  assert.deepEqual(dataset.deletedDefaults, {
    existing: true,
    'settings:attitudes:unknown': true,
    'settings:attitudes:party': true,
    'factions:party': true,
  });

  const afterFirst = structuredClone(dataset);
  const second = migrateCampaignShape(dataset);
  assert.equal(second.changed, 0);
  assert.deepEqual(dataset, afterFirst);
});

test('campaign shape migration leaves an empty dataset sparse', () => {
  const dataset = {};
  assert.deepEqual(migrateCampaignShape(dataset), {
    changed: 0,
    byCollection: {},
    changedCollections: [],
  });
  assert.deepEqual(dataset, {});
});

test('campaign shape migration persists legacy tombstone arrays as keyed objects', () => {
  const dataset = {
    deletedDefaults: ['character-id', 'settings:attitudes:retired'],
  };
  assert.equal(migrateCampaignShape(dataset).changed, 1);
  assert.deepEqual(dataset.deletedDefaults, {
    'character-id': true,
    'settings:attitudes:retired': true,
  });
  assert.equal(migrateCampaignShape(dataset).changed, 0);
});

test('campaign shape migration does not replace malformed cross-collection storage', () => {
  const dataset = {
    factions: {
      party: { name: 'Keep until settings can be repaired' },
    },
    settings: null,
  };
  const result = migrateCampaignShape(dataset);
  assert.equal(result.changed, 1);
  assert.deepEqual(dataset.factions, {
    party: {
      name: 'Keep until settings can be repaired',
      attitudes: [],
    },
  });
  assert.equal(dataset.settings, null);
  assert.equal(dataset.deletedDefaults, undefined);
});
