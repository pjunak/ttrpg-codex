'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CoreWriteLock, WriteLockTimeoutError } = require('../server/core-write-lock.cjs');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('queued acquisition times out and the cancelled callback never executes later', async () => {
  const lock = new CoreWriteLock({ timeoutMs: 25 });
  const holder = deferred();
  let ghostRan = false;

  const active = lock.run(() => holder.promise);
  await assert.rejects(
    lock.run(() => { ghostRan = true; }),
    err => err instanceof WriteLockTimeoutError
      && err.code === 'WRITE_LOCK_TIMEOUT'
      && err.timeoutMs === 25,
  );

  holder.resolve();
  await active;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ghostRan, false);
});

test('timeout never releases the active holder and writes remain serialized', async () => {
  const lock = new CoreWriteLock({ timeoutMs: 25 });
  const holder = deferred();
  let activeCount = 0;
  let maxActive = 0;

  const first = lock.run(async () => {
    activeCount++;
    maxActive = Math.max(maxActive, activeCount);
    await holder.promise;
    activeCount--;
  });
  await assert.rejects(lock.run(() => assert.fail('timed-out waiter executed')));

  const third = lock.run(async () => {
    activeCount++;
    maxActive = Math.max(maxActive, activeCount);
    activeCount--;
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(activeCount, 1, 'the original holder still owns the lock');

  holder.resolve();
  await Promise.all([first, third]);
  assert.equal(maxActive, 1);
});

test('queue recovers after ordinary success and rejection', async () => {
  const lock = new CoreWriteLock({ timeoutMs: 100 });
  const order = [];

  await lock.run(() => { order.push('success'); });
  await assert.rejects(lock.run(() => {
    order.push('reject');
    throw new Error('ordinary failure');
  }), /ordinary failure/);
  await lock.run(() => { order.push('recovered'); });

  assert.deepEqual(order, ['success', 'reject', 'recovered']);
});
