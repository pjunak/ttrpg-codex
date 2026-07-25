'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { durableWrite } = require('../server/durable-files.cjs');

test('durableWrite creates parents, replaces content, and removes sidecars', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-durable-write-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const file = path.join(root, 'nested', 'state.json');
  await durableWrite(file, '{"value":1}');
  await durableWrite(file, '{"value":2}');

  assert.equal(await fsp.readFile(file, 'utf8'), '{"value":2}');
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['state.json']);
});

test('durableWrite preserves binary input', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-durable-buffer-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const file = path.join(root, 'payload.bin');
  const payload = Buffer.from([0, 1, 2, 255]);
  await durableWrite(file, payload);

  assert.deepEqual(await fsp.readFile(file), payload);
});
