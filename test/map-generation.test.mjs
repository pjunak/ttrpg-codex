import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMapGenerationController } from '../web/js/map-generation.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runAll() {
      while (pending.size) {
        const batch = [...pending.entries()];
        pending.clear();
        for (const [, fn] of batch) fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

test('map generation: navigation away while initialization is pending blocks publication', async () => {
  const controller = createMapGenerationController();
  const container = {};
  const token = controller.begin(container);
  const init = deferred();
  let activeMap = null;

  const completion = init.promise.then(map => {
    if (controller.isCurrent(token, container)) activeMap = map;
  });
  controller.invalidate();
  init.resolve({ id: 'stale' });
  await completion;

  assert.equal(activeMap, null);
});

test('map generation: a second initialization supersedes and cleans the first', () => {
  const controller = createMapGenerationController();
  const firstContainer = {};
  const secondContainer = {};
  const first = controller.begin(firstContainer);
  let firstCleanups = 0;
  controller.track(first, () => { firstCleanups++; });

  const second = controller.begin(secondContainer);

  assert.equal(firstCleanups, 1);
  assert.equal(controller.isCurrent(first, firstContainer), false);
  assert.equal(controller.isCurrent(second, secondContainer), true);
  assert.equal(controller.isCurrent(second, firstContainer), false);
});

test('map generation: an SSE-style rerender cannot let stale completion overwrite the current map', async () => {
  const controller = createMapGenerationController();
  const firstContainer = {};
  const secondContainer = {};
  const first = controller.begin(firstContainer);
  const staleInit = deferred();
  let activeMap = null;

  const staleCompletion = staleInit.promise.then(map => {
    if (controller.isCurrent(first, firstContainer)) activeMap = map;
  });

  const second = controller.begin(secondContainer);
  const currentMap = { id: 'current' };
  if (controller.isCurrent(second, secondContainer)) activeMap = currentMap;
  staleInit.resolve({ id: 'stale' });
  await staleCompletion;

  assert.equal(activeMap, currentMap);
});

test('map generation: stale zoom polling is cancelled after container replacement', () => {
  const timers = fakeTimers();
  const controller = createMapGenerationController(timers);
  const first = controller.begin({});
  let polls = 0;
  controller.schedule(first, () => { polls++; }, 80);
  assert.equal(timers.size, 1);

  controller.begin({});
  assert.equal(timers.size, 0);
  timers.runAll();

  assert.equal(polls, 0);
});

test('map generation: repeated teardown is safe and cleans each resource once', () => {
  const controller = createMapGenerationController();
  const token = controller.begin({});
  let cleanups = 0;
  controller.track(token, () => { cleanups++; });

  controller.invalidate();
  controller.invalidate();

  assert.equal(cleanups, 1);
});

test('map generation: the current generation initializes and polls normally', () => {
  const timers = fakeTimers();
  const controller = createMapGenerationController(timers);
  const container = {};
  const token = controller.begin(container);
  let initialized = false;
  let zoomed = false;

  if (controller.isCurrent(token, container)) initialized = true;
  controller.schedule(token, () => { zoomed = true; }, 80);
  timers.runAll();

  assert.equal(initialized, true);
  assert.equal(zoomed, true);
});

test('map generation: a resource registered after supersession is cleaned immediately', () => {
  const controller = createMapGenerationController();
  const stale = controller.begin({});
  controller.begin({});
  let cleaned = 0;

  const accepted = controller.track(stale, () => { cleaned++; });

  assert.equal(accepted, false);
  assert.equal(cleaned, 1);
});
