'use strict';

// Test-only ZIP fixtures/readback. Production addon extraction is exercised
// through server/addon-archive.cjs; these helpers use archiver only as a writer
// and yauzl as a bounded reader, so tests never reintroduce adm-zip.

const { PassThrough } = require('node:stream');
const archiver = require('archiver');
const yauzl = require('yauzl');

function _writer(options) {
  return (typeof archiver === 'function')
    ? archiver('zip', options)
    : new archiver.ZipArchive(options);
}

function createZip(entries, { level = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const archive = _writer({ zlib: { level } });
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', chunk => chunks.push(chunk));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    archive.on('error', reject);
    archive.pipe(sink);
    for (const [name, value] of Object.entries(entries)) {
      const content = Buffer.isBuffer(value)
        ? value
        : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      archive.append(content, { name });
    }
    Promise.resolve(archive.finalize()).catch(reject);
  });
}

function _open(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zipfile) => {
      if (error) reject(error); else resolve(zipfile);
    });
  });
}

function _stream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
  });
}

async function readZip(buffer, { maxEntries = 50000, maxEntryBytes = 20 * 1024 * 1024 } = {}) {
  const zipfile = await _open(buffer);
  if (zipfile.entryCount > maxEntries) {
    try { zipfile.close(); } catch (_) {}
    throw new Error(`test ZIP has too many entries (> ${maxEntries})`);
  }
  return new Promise((resolve, reject) => {
    const entries = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch (_) {}
      reject(error);
    };
    zipfile.on('error', fail);
    zipfile.on('end', () => {
      if (!settled) { settled = true; resolve(entries); }
    });
    zipfile.on('entry', (entry) => {
      Promise.resolve().then(async () => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (/\/$/.test(name)) {
          entries.push({ entryName: name, data: Buffer.alloc(0) });
          return;
        }
        if (entry.uncompressedSize > maxEntryBytes) throw new Error(`test ZIP entry too large: ${name}`);
        const stream = await _stream(zipfile, entry);
        const chunks = [];
        let total = 0;
        for await (const chunk of stream) {
          total += chunk.length;
          if (total > maxEntryBytes) throw new Error(`test ZIP entry exceeded limit: ${name}`);
          chunks.push(chunk);
        }
        entries.push({ entryName: name, data: Buffer.concat(chunks, total) });
      }).then(() => { if (!settled) zipfile.readEntry(); }).catch(fail);
    });
    zipfile.readEntry();
  });
}

module.exports = { createZip, readZip };
