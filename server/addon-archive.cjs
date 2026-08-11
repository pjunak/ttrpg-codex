'use strict';

// Streaming ZIP extraction for untrusted addon packages. The archive is
// scanned from its central directory before any entry is opened or written,
// then each accepted file is decompressed directly to disk through byte
// limiters. No expanded entry is ever materialized as a Buffer.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  createByteLimiter,
  openEntryStream,
  walkZipEntries,
} = require('./zip-reader.cjs');

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 30 * 1024 * 1024,
  maxEntries: 10_000,
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

function _isSafeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}

function isAgentMetadataPath(relpath) {
  if (typeof relpath !== 'string' || !relpath) return false;
  const parts = relpath.replace(/\\/g, '/').split('/').filter(Boolean);
  const basename = (parts.at(-1) || '').toLowerCase();
  if (['agents.md', 'agents.override.md', 'claude.md', 'claude.local.md'].includes(basename)) {
    return true;
  }
  return parts.some((part) => ['.agents', '.claude', '.codex'].includes(part.toLowerCase()));
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
  await walkZipEntries(buffer, {
    onEntry(entry) {
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
    },
    onOpen(zipfile) {
      if (zipfile.entryCount > limits.maxEntries) {
        throw new Error(`too many entries in archive (> ${limits.maxEntries})`);
      }
    },
  }, { validateEntrySizes: true });

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
  const ignoredFileNames = new Set();
  const files = raw.flatMap((item) => {
    const relpath = prefix ? item.fileName.slice(prefix.length) : item.fileName;
    if (!_isSafeRelative(relpath)) throw new Error(`unsafe archive path: ${item.fileName}`);
    if (seen.has(relpath)) throw new Error(`duplicate archive path: ${relpath}`);
    seen.add(relpath);
    if (isAgentMetadataPath(relpath)) {
      ignoredFileNames.add(item.fileName);
      return [];
    }
    return [{ ...item, relpath }];
  });
  return { files, ignoredFileNames, declaredTotal, compressedTotal, limits };
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

async function extractAddonZip(buffer, targetDir, limitOverrides) {
  const scan = await scanAddonZip(buffer, limitOverrides);
  const byName = new Map(scan.files.map(file => [file.fileName, file]));
  let actualTotal = 0;
  const written = [];
  await fsp.mkdir(targetDir, { recursive: true });

  await walkZipEntries(buffer, {
    async onEntry(entry, zipfile) {
      if (/\/$/.test(entry.fileName)) return;
      const meta = byName.get(entry.fileName);
      if (!meta && scan.ignoredFileNames.has(entry.fileName)) return;
      if (!meta) throw new Error(`archive changed between scan and extraction: ${entry.fileName}`);
      const dest = _target(targetDir, meta.relpath);
      if (!dest) throw new Error(`unsafe archive path: ${entry.fileName}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const source = await openEntryStream(zipfile, entry);
      const limiter = createByteLimiter({
        maxBytes: scan.limits.maxEntryBytes,
        errorFactory: () => new Error(`archive entry exceeded extraction limits: ${entry.fileName}`),
        onChunk({ bytesRead, chunkBytes }) {
          actualTotal += chunkBytes;
          const ratioLimit = meta.compressed * scan.limits.maxCompressionRatio;
          if (actualTotal > scan.limits.maxTotalBytes
              || bytesRead > meta.uncompressed
              || (meta.uncompressed && bytesRead > ratioLimit)) {
            throw new Error(`archive entry exceeded extraction limits: ${entry.fileName}`);
          }
        },
      });
      await pipeline(source, limiter.stream, fs.createWriteStream(dest, { flags: 'wx' }));
      if (limiter.bytesRead !== meta.uncompressed) {
        throw new Error(`archive entry size mismatch: ${entry.fileName}`);
      }
      written.push(meta.relpath);
    },
  }, { validateEntrySizes: true });

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
  isAgentMetadataPath,
  _isSafeRelative,
};
