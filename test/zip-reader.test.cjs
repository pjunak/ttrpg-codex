'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createZip } = require('./helpers/zip.cjs');
const {
  createByteLimiter,
  openEntryStream,
  walkZipEntries,
} = require('../server/zip-reader.cjs');

test('shared ZIP walker handles buffers and file paths with sequential entry streams', async () => {
  const zip = await createZip({
    'one.txt': 'one',
    'two.txt': 'two',
  });
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zip-reader-'));
  const zipPath = path.join(root, 'archive.zip');
  await fsp.writeFile(zipPath, zip);

  try {
    for (const source of [zip, zipPath]) {
      const seen = [];
      let declaredEntries = 0;
      await walkZipEntries(source, {
        onOpen(zipfile) {
          declaredEntries = zipfile.entryCount;
        },
        async onEntry(entry, zipfile) {
          if (/\/$/.test(entry.fileName)) return;
          const stream = await openEntryStream(zipfile, entry);
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          seen.push([entry.fileName, Buffer.concat(chunks).toString('utf8')]);
        },
      }, { validateEntrySizes: true });
      assert.equal(declaredEntries, 2);
      assert.deepEqual(seen, [
        ['one.txt', 'one'],
        ['two.txt', 'two'],
      ]);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('shared byte limiter reports progress and rejects overflow', async () => {
  const progress = [];
  const accepted = createByteLimiter({
    maxBytes: 4,
    onChunk: state => progress.push(state),
  });
  await pipeline(
    Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
    accepted.stream,
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
  );
  assert.equal(accepted.bytesRead, 4);
  assert.deepEqual(progress, [
    { bytesRead: 2, chunkBytes: 2 },
    { bytesRead: 4, chunkBytes: 2 },
  ]);

  const rejected = createByteLimiter({
    maxBytes: 3,
    errorFactory: bytes => new Error(`too large: ${bytes}`),
  });
  await assert.rejects(
    () => pipeline(
      Readable.from([Buffer.from('abcd')]),
      rejected.stream,
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    ),
    /too large: 4/,
  );
});
