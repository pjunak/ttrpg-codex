import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocationAdjustments,
  buildStoryReview,
} from '../web/js/import-review.js';

test('location adjustments produce a new campaign bundle with bounded coordinates', () => {
  const source = {
    records: {
      locations: [{
        ref: 'place.square',
        operation: 'create',
        record: { name: 'Square', x: 0.1, y: 0.2 },
      }],
    },
  };
  const result = applyLocationAdjustments(source, new Map([
    ['place.square', { x: 0.333333333, y: 0.75 }],
  ]));

  assert.notEqual(result, source);
  assert.deepEqual(source.records.locations[0].record, { name: 'Square', x: 0.1, y: 0.2 });
  assert.deepEqual(result.records.locations[0].record, {
    name: 'Square',
    x: 0.333333,
    y: 0.75,
  });
  assert.throws(
    () => applyLocationAdjustments(source, { 'place.square': { x: 1.1, y: 0.2 } }),
    /coordinates/,
  );
  assert.throws(
    () => applyLocationAdjustments(source, { missing: { x: 0.1, y: 0.2 } }),
    /unavailable/,
  );
});

test('story review uses only explicit planning links and core relationships', () => {
  const review = buildStoryReview([
    {
      collection: 'dm-tools:planning_items',
      id: 'quest-one',
      after: {
        title: 'Quest One',
        kind: 'quest',
        summary: 'Find the truth.',
        sections: [{ id: 'clue', title: 'The clue', body: 'A marked key.' }],
      },
    },
    {
      collection: 'dm-tools:planning_links',
      id: 'link-one',
      after: {
        name: 'Starts the investigation',
        type: 'reveals',
        source: { scope: 'core', collection: 'characters', id: 'npc-one' },
        target: { scope: 'planning', itemId: 'quest-one', sectionId: 'clue' },
      },
    },
    {
      collection: 'relationships',
      id: 'relationship-one',
      after: {
        source: 'npc-one',
        target: 'place-one',
        type: 'guards',
        label: 'Guards the gate',
      },
    },
  ], {
    coreLabel: (collection, id) => `${collection}:${id}`,
    relationshipTarget: type => type === 'guards' ? 'locations' : 'characters',
  });

  assert.equal(review.items.length, 1);
  assert.deepEqual(review.edges.map(edge => edge.label), [
    'Starts the investigation',
    'Guards the gate',
  ]);
  assert.equal(review.edges[0].targetSectionId, 'clue');
  assert.ok(review.nodes.some(node => node.id === 'planning:quest-one'));
  assert.ok(review.nodes.some(node => node.id === 'core:locations:place-one'));
  assert.equal(review.edges.some(edge => edge.label === 'Find the truth.'), false);
});
