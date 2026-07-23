'use strict';

// Streaming ZIP extraction for untrusted addon packages. The archive is
// scanned from its central directory before any entry is opened or written,
// then each accepted file is decompressed directly to disk through byte
// limiters. No expanded entry is ever materialized as a Buffer.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 30 * 1024 * 1024,
  maxEntries: 2000,
  maxEntryBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxCompressionRatio: 100,
});

function _limits(overrides = {}) {
  const out = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(out)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid archive limit ${key}`);
  }
  return out;
}

function _open(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err) reject(err); else resolve(zipfile);
    });
  });
}

async function _walk(buffer, onEntry, onOpen) {
  const zipfile = await _open(buffer);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch (_) {}
      reject(error);
    };
    zipfile.on('error', fail);
    zipfile.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on('entry', (entry) => {
      Promise.resolve()
        .then(() => onEntry(entry, zipfile))
        .then(() => { if (!settled) zipfile.readEntry(); })
        .catch(fail);
    });
    try { if (onOpen) onOpen(zipfile); } catch (error) { return fail(error); }
    zipfile.readEntry();
  });
}

function _isSafeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}

function _ratio(uncompressed, compressed) {
  if (!uncompressed) return 0;
  if (!compressed) return Infinity;
  return uncompressed / compressed;
}

async function scanAddonZip(buffer, limitOverrides) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('archive must be a Buffer');
  const limits = _limits(limitOverrides);
  if (buffer.length > limits.maxArchiveBytes) {
    throw new Error(`archive download too large (> ${limits.maxArchiveBytes} bytes)`);
  }

  const raw = [];
  let declaredTotal = 0;
  let compressedTotal = 0;
  await _walk(buffer, (entry) => {
    if (/\/$/.test(entry.fileName)) return;
    const uncompressed = Number(entry.uncompressedSize) || 0;
    const compressed = Number(entry.compressedSize) || 0;
    if (uncompressed > limits.maxEntryBytes) {
      throw new Error(`archive entry too large: ${entry.fileName}`);
    }
    if (_ratio(uncompressed, compressed) > limits.maxCompressionRatio) {
      throw new Error(`archive entry compression ratio too high: ${entry.fileName}`);
    }
    declaredTotal += uncompressed;
    compressedTotal += compressed;
    if (declaredTotal > limits.maxTotalBytes) {
      throw new Error('archive too large when uncompressed');
    }
    raw.push({ fileName: entry.fileName, uncompressed, compressed });
    if (raw.length > limits.maxEntries) {
      throw new Error(`too many files in archive (> ${limits.maxEntries})`);
    }
  }, (zipfile) => {
    if (zipfile.entryCount > limits.maxEntries) {
      throw new Error(`too many entries in archive (> ${limits.maxEntries})`);
    }
  });

  if (_ratio(declaredTotal, compressedTotal) > limits.maxCompressionRatio) {
    throw new Error('archive compression ratio too high');
  }

  // GitHub zipballs have one common wrapper directory. A flat archive has an
  // empty common prefix and remains untouched.
  let prefix = null;
  for (const item of raw) {
    const slash = item.fileName.indexOf('/');
    const candidate = slash === -1 ? '' : item.fileName.slice(0, slash + 1);
    if (prefix === null) prefix = candidate;
    else if (prefix !== candidate) { prefix = ''; break; }
  }

  const seen = new Set();
  const files = raw.map((item) => {
    const relpath = prefix ? item.fileName.slice(prefix.length) : item.fileName;
    if (!_isSafeRelative(relpath)) throw new Error(`unsafe archive path: ${item.fileName}`);
    if (seen.has(relpath)) throw new Error(`duplicate archive path: ${relpath}`);
    seen.add(relpath);
    return { ...item, relpath };
  });
  return { files, declaredTotal, compressedTotal, limits };
}

function _target(root, relpath) {
  if (!_isSafeRelative(relpath)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relpath.split('/'));
  const relative = path.relative(resolvedRoot, resolved);
  return relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    ? resolved
    : null;
}

function _openReadStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

async function extractAddonZip(buffer, targetDir, limitOverrides) {
  const scan = await scanAddonZip(buffer, limitOverrides);
  const byName = new Map(scan.files.map(file => [file.fileName, file]));
  let actualTotal = 0;
  const written = [];
  await fsp.mkdir(targetDir, { recursive: true });

  await _walk(buffer, async (entry, zipfile) => {
    if (/\/$/.test(entry.fileName)) return;
    const meta = byName.get(entry.fileName);
    if (!meta) throw new Error(`archive changed between scan and extraction: ${entry.fileName}`);
    const dest = _target(targetDir, meta.relpath);
    if (!dest) throw new Error(`unsafe archive path: ${entry.fileName}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const source = await _openReadStream(zipfile, entry);
    let entryBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        entryBytes += chunk.length;
        actualTotal += chunk.length;
        const ratioLimit = meta.compressed * scan.limits.maxCompressionRatio;
        if (entryBytes > scan.limits.maxEntryBytes
            || actualTotal > scan.limits.maxTotalBytes
            || entryBytes > meta.uncompressed
            || (meta.uncompressed && entryBytes > ratioLimit)) {
          return callback(new Error(`archive entry exceeded extraction limits: ${entry.fileName}`));
        }
        callback(null, chunk);
      },
    });
    await pipeline(source, limiter, fs.createWriteStream(dest, { flags: 'wx' }));
    if (entryBytes !== meta.uncompressed) {
      throw new Error(`archive entry size mismatch: ${entry.fileName}`);
    }
    written.push(meta.relpath);
  });

  if (written.length !== scan.files.length) throw new Error('archive extraction was incomplete');
  return { files: written, totalBytes: actualTotal };
}

async function contentHashDirectory(root, relpaths, crypto) {
  const hash = crypto.createHash('sha256');
  const sorted = [...relpaths].sort();
  for (const relpath of sorted) {
    const file = _target(root, relpath);
    if (!file) throw new Error(`unsafe hash path: ${relpath}`);
    hash.update(relpath);
    hash.update('\0');
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) hash.update(chunk);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = {
  DEFAULT_LIMITS,
  scanAddonZip,
  extractAddonZip,
  contentHashDirectory,
  _isSafeRelative,
};
