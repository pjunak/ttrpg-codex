'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { startServer } = require('./helpers/server-process.cjs');

test('GET /api/health is independent of campaign parsing and hashing', async () => {
  const srv = await startServer({
    seedFiles: {
      'characters.json': '{ malformed campaign data',
    },
  });
  try {
    const res = await srv.fetch('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await srv.kill();
  }
});
