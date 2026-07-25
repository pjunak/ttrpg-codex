'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const fsp = fs.promises;

test('tiler publishes immutable generations and preserves the last manifest on failure', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tiler-'));
  const previousDataDir = process.env.CODEX_DATA_DIR;
  process.env.CODEX_DATA_DIR = root;
  const modulePath = require.resolve('../tiler.js');
  delete require.cache[modulePath];
  const tiler = require('../tiler.js');
  t.after(async () => {
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.CODEX_DATA_DIR;
    else process.env.CODEX_DATA_DIR = previousDataDir;
    await fsp.rm(root, { recursive: true, force: true });
  });

  const source = path.join(root, 'world.png');
  await sharp({
    create: {
      width: 300,
      height: 180,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  }).png().toFile(source);

  const first = await tiler.buildFor('world', source);
  assert.match(first.generation, /^g-[0-9a-f]{16}$/);
  const mapDir = path.join(root, 'maps', 'tiles', 'world');
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(mapDir, 'tiles.json'), 'utf8')),
    first,
  );
  assert.ok((await fsp.stat(path.join(
    mapDir,
    first.generation,
    '0',
    '0',
    '0.jpg',
  ))).isFile());

  await fsp.writeFile(source, 'not an image');
  await assert.rejects(tiler.buildFor('world', source));
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(mapDir, 'tiles.json'), 'utf8')),
    first,
  );
  assert.ok((await fsp.stat(path.join(mapDir, first.generation))).isDirectory());
  assert.equal(
    (await fsp.readdir(path.join(root, 'maps', 'tiles')))
      .some(name => name.startsWith('.incoming-')),
    false,
  );
});

test('tiler cleanup removes only abandoned incoming build directories', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-tiler-clean-'));
  const previousDataDir = process.env.CODEX_DATA_DIR;
  process.env.CODEX_DATA_DIR = root;
  const modulePath = require.resolve('../tiler.js');
  delete require.cache[modulePath];
  const tiler = require('../tiler.js');
  t.after(async () => {
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.CODEX_DATA_DIR;
    else process.env.CODEX_DATA_DIR = previousDataDir;
    await fsp.rm(root, { recursive: true, force: true });
  });

  const tilesDir = path.join(root, 'maps', 'tiles');
  await fsp.mkdir(path.join(tilesDir, '.incoming-world-stale'), { recursive: true });
  await fsp.mkdir(path.join(tilesDir, 'world'), { recursive: true });
  await tiler.cleanupStaging();
  await assert.rejects(
    fsp.stat(path.join(tilesDir, '.incoming-world-stale')),
    { code: 'ENOENT' },
  );
  assert.ok((await fsp.stat(path.join(tilesDir, 'world'))).isDirectory());
});
