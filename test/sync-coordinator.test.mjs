import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSyncCoordinator } from '../web/js/sync-coordinator.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('coalesces a burst and rejects the superseded response before commit or render', async () => {
  const loads = [];
  const commits = [];
  let renders = 0;
  const sync = createSyncCoordinator({
    load: ({ shouldCommit }) => {
      const gate = deferred();
      loads.push({ gate, shouldCommit });
      return gate.promise.then(value => {
        if (!shouldCommit()) return false;
        commits.push(value);
        return true;
      });
    },
    render: () => { renders += 1; },
  });

  sync.request('h1');
  sync.request('h2');
  sync.request('h3');
  assert.equal(loads.length, 1);
  loads[0].gate.resolve('old');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loads.length, 2);
  assert.deepEqual(commits, []);
  assert.equal(renders, 0);

  loads[1].gate.resolve('new');
  await sync.whenIdle();
  assert.deepEqual(commits, ['new']);
  assert.equal(renders, 1);
  assert.equal(sync.getAcceptedHash(), 'h3');
});

test('deduplicates active, pending, and already-accepted hashes', async () => {
  const gates = [];
  let renders = 0;
  const sync = createSyncCoordinator({
    load: ({ shouldCommit }) => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise.then(() => shouldCommit());
    },
    render: () => { renders += 1; },
  });

  assert.equal(sync.request('same'), true);
  assert.equal(sync.request('same'), false);
  gates[0].resolve();
  await sync.whenIdle();
  assert.equal(sync.request('same'), false);
  assert.equal(gates.length, 1);
  assert.equal(renders, 1);
});

test('a failed load is not accepted and a later event recovers normally', async () => {
  const outcomes = [false, true];
  let loads = 0;
  let renders = 0;
  const sync = createSyncCoordinator({
    load: async () => outcomes[loads++],
    render: () => { renders += 1; },
  });

  sync.request('retry');
  await sync.whenIdle();
  assert.equal(sync.getAcceptedHash(), null);
  assert.equal(renders, 0);

  sync.request('retry');
  await sync.whenIdle();
  assert.equal(sync.getAcceptedHash(), 'retry');
  assert.equal(renders, 1);
});
