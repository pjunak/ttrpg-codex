'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PublicationBarrier } = require('../server/publication-barrier.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

test('publication barrier permits concurrent readers and blocks publication until they finish', async () => {
  const barrier = new PublicationBarrier();
  const releaseReaders = deferred();
  const entered = [];
  const first = barrier.read(async () => {
    entered.push('read-1');
    await releaseReaders.promise;
  });
  const second = barrier.read(async () => {
    entered.push('read-2');
    await releaseReaders.promise;
  });
  const publication = barrier.publish(() => { entered.push('publish'); });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(entered, ['read-1', 'read-2']);
  releaseReaders.resolve();
  await Promise.all([first, second, publication]);
  assert.deepEqual(entered, ['read-1', 'read-2', 'publish']);
});

test('a queued publication prevents later readers from overtaking it', async () => {
  const barrier = new PublicationBarrier();
  const releaseFirst = deferred();
  const entered = [];
  const first = barrier.read(async () => {
    entered.push('first-read');
    await releaseFirst.promise;
  });
  const publication = barrier.publish(() => { entered.push('publish'); });
  const later = barrier.read(() => { entered.push('later-read'); });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(entered, ['first-read']);
  releaseFirst.resolve();
  await Promise.all([first, publication, later]);
  assert.deepEqual(entered, ['first-read', 'publish', 'later-read']);
});

test('poison rejects queued and future readers after an unrecoverable publication state', async () => {
  const barrier = new PublicationBarrier();
  const release = deferred();
  const publication = barrier.publish(() => release.promise);
  const queuedRead = barrier.read(() => 'unsafe');
  await Promise.resolve();
  const fatal = new Error('recovery required');
  barrier.poison(fatal);
  await assert.rejects(queuedRead, error => error === fatal);
  await assert.rejects(barrier.read(() => 'unsafe'), error => error === fatal);
  release.resolve();
  await publication;
});
