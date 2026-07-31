import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocationAdjustments,
  buildStoryReview,
  locateChangeSource,
  setValueAtPath,
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

test('story review separates explicit chronology and decision branches from semantic links', () => {
  const itemChange = (id, title, sections = []) => ({
    collection: 'dm-tools:planning_items',
    id,
    after: { kind: 'scenario', title, sections },
  });
  const linkChange = (id, type, name, source, target) => ({
    collection: 'dm-tools:planning_links',
    id,
    after: { type, name, source, target },
  });
  const review = buildStoryReview([
    itemChange('arrival', 'Arrival'),
    itemChange('choice', 'The choice', [{ id: 'refuse', title: 'Refuse', body: '' }]),
    itemChange('outcome', 'Outcome'),
    linkChange(
      'ordered',
      'precedes',
      'Then the offer is made',
      { scope: 'planning', itemId: 'arrival' },
      { scope: 'planning', itemId: 'choice' },
    ),
    linkChange(
      'branch',
      'branches',
      'Refuse the offer',
      { scope: 'planning', itemId: 'choice', sectionId: 'refuse' },
      { scope: 'planning', itemId: 'outcome' },
    ),
    linkChange(
      'context',
      'reveals',
      'Explains the motive',
      { scope: 'planning', itemId: 'arrival' },
      { scope: 'planning', itemId: 'outcome' },
    ),
  ]);

  assert.deepEqual(review.flowEdges.map(edge => edge.type), ['precedes', 'branches']);
  assert.equal(review.flowEdges.some(edge => edge.label === 'Explains the motive'), false);
  const decision = review.flowNodes.find(node => node.sectionId === 'refuse');
  assert.equal(decision.label, 'Refuse');
  assert.equal(decision.parentLabel, 'The choice');
  assert.equal(decision.decision, true);
});

test('review changes locate and update their exact source records', () => {
  const source = {
    records: {
      locations: [{
        ref: 'place.square',
        operation: 'create',
        record: { name: 'Square' },
      }],
    },
    addonImports: [{
      addonId: 'dm-tools',
      contributorId: 'planning',
      document: {
        items: [{ id: 'quest-one', operation: 'create', title: 'Quest One' }],
        links: [{ id: 'quest-one', operation: 'create', name: 'Same id, other collection' }],
      },
    }],
  };
  const core = locateChangeSource(source, {
    collection: 'locations',
    sourceRef: 'place.square',
  });
  const addon = locateChangeSource(source, {
    collection: 'dm-tools:planning_items',
    id: 'quest-one',
    contributor: { addonId: 'dm-tools', id: 'planning' },
  });

  assert.deepEqual(core.path, ['records', 'locations', 0, 'record']);
  assert.deepEqual(addon.path, ['addonImports', 0, 'document', 'items', 0]);
  setValueAtPath(source, [...addon.path, 'title'], 'Rewritten quest');
  assert.equal(source.addonImports[0].document.items[0].title, 'Rewritten quest');
  assert.equal(source.addonImports[0].document.links[0].name, 'Same id, other collection');
});
