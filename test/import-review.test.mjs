import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocationAdjustments,
  buildStoryReview,
  locateChangeSource,
  locatePlanningDocument,
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

test('story review renders schema-v2 ownership, flow, decisions, and named references', () => {
  const itemChange = (id, kind, title, parentId = null, details = {}) => ({
    collection: 'dm-tools:planning_items',
    id,
    after: { kind, title, parentId, ...details },
  });
  const review = buildStoryReview([
    itemChange('plotline-winter', 'plotline', 'Winter in Radov'),
    itemChange('event-arrival', 'event', 'Arrival', 'plotline-winter', { eventType: 'story' }),
    itemChange('branch-verdict', 'branch', 'Choose a verdict', 'plotline-winter', {
      branchType: 'decision',
    }),
    itemChange('event-trial', 'event', 'Public trial', 'plotline-winter', {
      eventType: 'encounter',
    }),
    {
      collection: 'dm-tools:planning_flow_links',
      id: 'flow-arrival-choice',
      after: {
        sourceId: 'event-arrival',
        targetId: 'branch-verdict',
        kind: 'continues',
        label: 'The evidence is assembled',
      },
    },
    {
      collection: 'dm-tools:planning_flow_links',
      id: 'flow-choice-trial',
      after: {
        sourceId: 'branch-verdict',
        targetId: 'event-trial',
        kind: 'option',
        label: 'Expose the conspiracy',
      },
    },
    {
      collection: 'dm-tools:planning_references',
      id: 'reference-magistrate',
      after: {
        itemId: 'event-trial',
        name: 'Presides over the trial',
        relation: 'involves',
        target: { scope: 'core', collection: 'characters', id: 'magistrate' },
      },
    },
  ], {
    coreLabel: (_collection, id) => id === 'magistrate' ? 'Magistrate Anežka' : id,
  });

  assert.deepEqual(review.roots.map(item => item.id), ['plotline-winter']);
  assert.deepEqual(review.flowEdges.map(edge => edge.type), ['continues', 'option']);
  assert.equal(review.flowEdges.some(edge => edge.label === 'Presides over the trial'), false);
  assert.ok(review.edges.some(edge => edge.label === 'Presides over the trial'));
  const arrival = review.flowNodes.find(node => node.recordId === 'event-arrival');
  assert.equal(arrival.parentLabel, 'Winter in Radov');
  assert.equal(arrival.eventType, 'story');
  const decision = review.flowNodes.find(node => node.recordId === 'branch-verdict');
  assert.equal(decision.branchType, 'decision');
  assert.equal(decision.decision, true);
});

test('the uploaded schema-v2 planning document drives the diagram before materialization', () => {
  const source = {
    addonImports: [{
      addonId: 'dm-tools',
      contributorId: 'planning',
      document: {
        format: 'dm-tools-planning',
        schemaVersion: 2,
        items: [
          { id: 'plotline', kind: 'plotline', parentId: null, title: 'Winter in Radov' },
          { id: 'arrival', kind: 'event', parentId: 'plotline', title: 'Arrival' },
          {
            id: 'choice',
            kind: 'branch',
            branchType: 'decision',
            parentId: 'plotline',
            title: 'Choose a side',
          },
        ],
        flowLinks: [{
          id: 'arrival-choice',
          sourceId: 'arrival',
          targetId: 'choice',
          kind: 'continues',
          label: 'The mayor makes an offer',
        }],
        references: [],
        consequences: [],
        notes: [],
      },
    }],
  };
  const located = locatePlanningDocument(source);
  const review = buildStoryReview([], { planningDocument: located.document });

  assert.deepEqual(located.path, ['addonImports', 0, 'document']);
  assert.equal(review.items.length, 3);
  assert.equal(review.flowNodes.length, 2);
  assert.equal(review.flowEdges[0].label, 'The mayor makes an offer');
  assert.equal(review.flowNodes.find(node => node.recordId === 'choice').decision, true);
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
        references: [{
          id: 'quest-one',
          operation: 'create',
          itemId: 'first',
          name: 'Same id, other current collection',
        }],
        flowLinks: [{
          id: 'quest-one',
          operation: 'create',
          sourceId: 'first',
          targetId: 'second',
        }],
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
  const flow = locateChangeSource(source, {
    collection: 'dm-tools:planning_flow_links',
    id: 'quest-one',
    contributor: { addonId: 'dm-tools', id: 'planning' },
  });

  assert.deepEqual(core.path, ['records', 'locations', 0, 'record']);
  assert.deepEqual(addon.path, ['addonImports', 0, 'document', 'items', 0]);
  assert.deepEqual(flow.path, ['addonImports', 0, 'document', 'flowLinks', 0]);
  setValueAtPath(source, [...addon.path, 'title'], 'Rewritten quest');
  assert.equal(source.addonImports[0].document.items[0].title, 'Rewritten quest');
  assert.equal(
    source.addonImports[0].document.references[0].name,
    'Same id, other current collection',
  );
});
