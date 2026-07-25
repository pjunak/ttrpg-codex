'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs').promises;
const path = require('path');
const { startServer } = require('./helpers/server-process.cjs');
const { writeRevision } = require('../server/write-revision.cjs');

async function loginAsDm(server) {
  const response = await server.fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'dm-pass' }),
  });
  assert.equal(response.status, 200);
}

async function patch(server, type, action, payload, baseRevision) {
  return server.fetch('/api/data', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, action, payload, baseRevision }),
  });
}

test('stale writes conflict per record without blocking unrelated records', async () => {
  const server = await startServer({
    seedData: {
      'characters.json': [
        { id: 'one', name: 'Original', visibility: 'public' },
        { id: 'two', name: 'Independent', visibility: 'public' },
      ],
    },
  });

  try {
    await loginAsDm(server);
    const datasetResponse = await server.fetch('/api/data');
    assert.equal(datasetResponse.status, 200);
    const dataset = await datasetResponse.json();
    const originalOne = dataset.characters.find(item => item.id === 'one');
    const originalTwo = dataset.characters.find(item => item.id === 'two');
    const oneRevision = writeRevision(originalOne);
    const twoRevision = writeRevision(originalTwo);

    const accepted = await patch(
      server,
      'characters',
      'save',
      { ...originalOne, name: 'First accepted edit' },
      oneRevision,
    );
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.match(acceptedBody.revision, /^[0-9a-f]{16}$/);

    const conflict = await patch(
      server,
      'characters',
      'save',
      { ...originalOne, name: 'Stale overwrite' },
      oneRevision,
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: 'The record changed after it was loaded',
      code: 'WRITE_CONFLICT',
      currentRevision: acceptedBody.revision,
    });

    const unrelated = await patch(
      server,
      'characters',
      'save',
      { ...originalTwo, name: 'Independent edit' },
      twoRevision,
    );
    assert.equal(unrelated.status, 200);

    const stored = JSON.parse(
      await fsp.readFile(path.join(server.dataDir, 'characters.json'), 'utf8'),
    );
    assert.equal(
      stored.find(item => item.id === 'one').name,
      'First accepted edit',
    );
    assert.equal(
      stored.find(item => item.id === 'two').name,
      'Independent edit',
    );
  } finally {
    await server.kill();
  }
});

test('concurrent creates bind to the absence of the target record', async () => {
  const server = await startServer();
  try {
    await loginAsDm(server);
    const absentRevision = writeRevision(null);

    const first = await patch(
      server,
      'characters',
      'save',
      { id: 'new-character', name: 'First create', visibility: 'public' },
      absentRevision,
    );
    assert.equal(first.status, 200);

    const duplicate = await patch(
      server,
      'characters',
      'save',
      { id: 'new-character', name: 'Stale create', visibility: 'public' },
      absentRevision,
    );
    assert.equal(duplicate.status, 409);

    const stored = JSON.parse(
      await fsp.readFile(path.join(server.dataDir, 'characters.json'), 'utf8'),
    );
    assert.equal(
      stored.find(item => item.id === 'new-character').name,
      'First create',
    );
  } finally {
    await server.kill();
  }
});

test('enum mutations conflict against the loaded category', async () => {
  const server = await startServer({
    seedData: {
      'settings.json': {
        genders: [
          { id: 'first', label: 'First' },
          { id: 'second', label: 'Second' },
        ],
      },
    },
  });

  try {
    await loginAsDm(server);
    const datasetResponse = await server.fetch('/api/data');
    const dataset = await datasetResponse.json();
    const baseRevision = writeRevision(dataset.settings.genders);

    const removeFirst = await server.fetch('/api/campaign/enums/genders/first', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision }),
    });
    assert.equal(removeFirst.status, 200);

    const staleRemoval = await server.fetch(
      '/api/campaign/enums/genders/second',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision }),
      },
    );
    assert.equal(staleRemoval.status, 409);
    assert.equal((await staleRemoval.json()).code, 'WRITE_CONFLICT');

    const settings = JSON.parse(
      await fsp.readFile(path.join(server.dataDir, 'settings.json'), 'utf8'),
    );
    assert.deepEqual(
      settings.genders.map(item => item.id),
      ['second'],
    );
  } finally {
    await server.kill();
  }
});
