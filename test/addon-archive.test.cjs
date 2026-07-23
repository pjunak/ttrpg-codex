'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { createZip } = require('./helpers/zip.cjs');

const { contentHash } = require('../server/addons.cjs');
const {
  scanAddonZip,
  extractAddonZip,
  contentHashDirectory,
} = require('../server/addon-archive.cjs');

async function tempTarget() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'addon-archive-'));
  return { root, target: path.join(root, 'out') };
}

async function cleanup(root) {
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}

test('streaming extraction strips the GitHub wrapper and preserves content hashing', async () => {
  const entries = {
    'owner-repo-sha/addon.json': '{"id":"safe-addon"}',
    'owner-repo-sha/entry.js': 'export default()=>{}',
    'owner-repo-sha/sub/a.css': '.a{}',
  };
  const zip = await createZip(entries);
  const { root, target } = await tempTarget();
  try {
    const result = await extractAddonZip(zip, target);
    assert.deepEqual([...result.files].sort(), ['addon.json', 'entry.js', 'sub/a.css']);
    assert.equal(await fsp.readFile(path.join(target, 'entry.js'), 'utf8'), entries['owner-repo-sha/entry.js']);
    const expected = contentHash([
      { relpath: 'addon.json', buffer: Buffer.from(entries['owner-repo-sha/addon.json']) },
      { relpath: 'entry.js', buffer: Buffer.from(entries['owner-repo-sha/entry.js']) },
      { relpath: 'sub/a.css', buffer: Buffer.from(entries['owner-repo-sha/sub/a.css']) },
    ], crypto);
    assert.equal(await contentHashDirectory(target, result.files, crypto), expected);
  } finally { await cleanup(root); }
});

test('entry-count, per-entry, and total expanded-size limits reject before writing', async () => {
  const zip = await createZip({
    'wrap/a.txt': 'a'.repeat(80),
    'wrap/b.txt': 'b'.repeat(80),
  }, { level: 0 });
  const cases = [
    [{ maxEntries: 1, maxEntryBytes: 1000, maxTotalBytes: 1000 }, /too many/],
    [{ maxEntries: 10, maxEntryBytes: 50, maxTotalBytes: 1000 }, /entry too large/],
    [{ maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 100 }, /too large when uncompressed/],
  ];
  for (const [limits, pattern] of cases) {
    const { root, target } = await tempTarget();
    try {
      await assert.rejects(() => extractAddonZip(zip, target, limits), pattern);
      await assert.rejects(() => fsp.access(target), { code: 'ENOENT' });
    } finally { await cleanup(root); }
  }
});

test('compression-ratio limit rejects a highly compressed entry before writing', async () => {
  const zip = await createZip({ 'wrap/bomb.txt': '0'.repeat(200_000) }, { level: 9 });
  const { root, target } = await tempTarget();
  try {
    await assert.rejects(
      () => extractAddonZip(zip, target, { maxCompressionRatio: 20 }),
      /compression ratio too high/,
    );
    await assert.rejects(() => fsp.access(target), { code: 'ENOENT' });
  } finally { await cleanup(root); }
});

test('unsafe traversal archive is rejected and cannot create a file', async () => {
  const safe = await createZip({ 'aa/evil.txt': 'owned' }, { level: 0 });
  const zip = Buffer.from(safe);
  const from = Buffer.from('aa/evil.txt');
  const to = Buffer.from('../evil.txt');
  let replacements = 0;
  for (let offset = 0; (offset = zip.indexOf(from, offset)) !== -1; offset += to.length) {
    to.copy(zip, offset);
    replacements += 1;
  }
  assert.ok(replacements >= 2, 'test fixture must patch local and central names');
  const { root, target } = await tempTarget();
  try {
    await assert.rejects(() => extractAddonZip(zip, target), /invalid relative path|unsafe archive path/i);
    await assert.rejects(() => fsp.access(path.join(root, 'evil.txt')), { code: 'ENOENT' });
    await assert.rejects(() => fsp.access(target), { code: 'ENOENT' });
  } finally { await cleanup(root); }
});

test('compressed download size is checked before ZIP parsing', async () => {
  await assert.rejects(
    () => scanAddonZip(Buffer.alloc(101), { maxArchiveBytes: 100 }),
    /download too large/,
  );
});
