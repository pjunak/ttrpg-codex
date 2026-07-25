'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

const DEFAULT_COALESCE_MS = 60 * 1000;
const DEFAULT_RECENT_KEEP = 50;
const DEFAULT_DAILY_DAYS = 14;
const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_FILES = 50_000;
const CORE_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,79}\.json$/i;
const ADDON_FILE_RE = /^addon-data\/[a-z0-9][a-z0-9-]{1,38}\/[a-z0-9][a-z0-9_]{0,39}\.json$/;
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ADDON_HASH_RE = /^[0-9a-f]{16}$/;
const EXCLUDED_CORE_FILES = new Set(['auth.json', 'secrets.json']);

class SnapshotError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSnapshotFileKey(key) {
  if (typeof key !== 'string' || EXCLUDED_CORE_FILES.has(key)) return false;
  return CORE_FILE_RE.test(key) || ADDON_FILE_RE.test(key);
}

function digestValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateSnapshot(snapshot, expectedId) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.files)
      || typeof snapshot.id !== 'string'
      || (expectedId && snapshot.id !== expectedId)
      || typeof snapshot.createdAt !== 'string'
      || !Number.isFinite(Date.parse(snapshot.createdAt))) {
    throw new SnapshotError('SNAPSHOT_INVALID', 'Invalid snapshot metadata');
  }
  let normalized = snapshot;
  if (snapshot.version === undefined) {
    normalized = {
      ...snapshot,
      reason: typeof snapshot.reason === 'string' ? snapshot.reason : 'save',
      access: snapshot.access === 'dm' ? 'dm' : 'public',
    };
  } else if (typeof snapshot.reason !== 'string'
      || !['public', 'dm'].includes(snapshot.access)) {
    throw new SnapshotError('SNAPSHOT_INVALID', 'Invalid snapshot metadata');
  }

  const entries = Object.entries(normalized.files);
  if (entries.length > MAX_SNAPSHOT_FILES) {
    throw new SnapshotError('SNAPSHOT_INVALID', 'Snapshot contains too many files');
  }
  for (const [key, value] of entries) {
    if (!isSnapshotFileKey(key) || !value || typeof value !== 'object') {
      throw new SnapshotError('SNAPSHOT_INVALID', `Invalid snapshot file: ${key}`);
    }
  }

  if (normalized.version === undefined) return normalized;
  if (normalized.version !== SNAPSHOT_VERSION || !isPlainObject(normalized.fileDigests)) {
    throw new SnapshotError('SNAPSHOT_INVALID', 'Unsupported snapshot format');
  }
  const digestKeys = Object.keys(normalized.fileDigests);
  if (digestKeys.length !== entries.length) {
    throw new SnapshotError('SNAPSHOT_INVALID', 'Snapshot file inventory mismatch');
  }
  for (const [key, value] of entries) {
    const digest = normalized.fileDigests[key];
    if (!/^[0-9a-f]{64}$/.test(digest || '') || digest !== digestValue(value)) {
      throw new SnapshotError('SNAPSHOT_INVALID', `Snapshot digest mismatch: ${key}`);
    }
  }
  return normalized;
}

function sanitizeSnapshotId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
}

function createSnapshotService({
  snapshotsDir,
  atomicWrite,
  trackedDataFiles,
  dataHash,
  pickKeptSnapshots,
  publishRestore,
  coalesceMs = DEFAULT_COALESCE_MS,
  recentKeep = DEFAULT_RECENT_KEEP,
  dailyDays = DEFAULT_DAILY_DAYS,
  now = Date.now,
  logger = console,
}) {
  async function files() {
    try {
      const list = await fsp.readdir(snapshotsDir);
      return list.filter(file => /^snapshot-.*\.json$/.test(file)).sort();
    } catch {
      return [];
    }
  }

  async function read(id) {
    const safe = sanitizeSnapshotId(id);
    if (!safe || safe !== String(id)) return null;
    const file = path.join(snapshotsDir, safe);
    try {
      const snapshot = JSON.parse(await fsp.readFile(file, 'utf8'));
      return validateSnapshot(snapshot, safe);
    } catch {
      return null;
    }
  }

  async function metadata(filename) {
    const file = path.join(snapshotsDir, filename);
    try {
      const [stat, raw] = await Promise.all([
        fsp.stat(file),
        fsp.readFile(file, 'utf8'),
      ]);
      const snapshot = validateSnapshot(JSON.parse(raw), filename);
      return {
        id: filename,
        createdAt: snapshot.createdAt,
        dataHash: snapshot.dataHash,
        reason: snapshot.reason || 'save',
        access: snapshot.access === 'dm' ? 'dm' : 'public',
        size: stat.size,
      };
    } catch {
      return null;
    }
  }

  async function lastSnapshotTime() {
    const names = await files();
    if (!names.length) return 0;
    const last = names[names.length - 1];
    const meta = await metadata(last);
    if (meta?.createdAt) {
      const parsed = Date.parse(meta.createdAt);
      if (!Number.isNaN(parsed)) return parsed;
    }
    try {
      const stat = await fsp.stat(path.join(snapshotsDir, last));
      return stat.mtimeMs || 0;
    } catch {
      return 0;
    }
  }

  async function prune() {
    const names = await files();
    if (names.length <= recentKeep) return;

    const entries = (await Promise.all(names.map(metadata))).filter(Boolean);
    const keep = pickKeptSnapshots(entries, { recentKeep, dailyDays });
    await Promise.all(entries.map(entry => (
      keep.has(entry.id)
        ? null
        : fsp.unlink(path.join(snapshotsDir, entry.id)).catch(() => {})
    )));
  }

  async function create(reason = 'save', access = 'public', extra = {}) {
    const createdAt = new Date(now()).toISOString();
    const contents = Object.create(null);
    const fileDigests = Object.create(null);
    const tracked = [...await trackedDataFiles()].sort((a, b) => a.key.localeCompare(b.key));
    const seen = new Set();
    for (const { key, abs } of tracked) {
      if (!isSnapshotFileKey(key) || seen.has(key)) {
        throw new SnapshotError('SNAPSHOT_SOURCE_INVALID', `Invalid tracked campaign path: ${key}`);
      }
      seen.add(key);
      let value;
      try {
        value = JSON.parse(await fsp.readFile(abs, 'utf8'));
      } catch (error) {
        throw new SnapshotError(
          'SNAPSHOT_SOURCE_INVALID',
          `Cannot capture campaign file: ${key}`,
          error,
        );
      }
      if (!value || typeof value !== 'object') {
        throw new SnapshotError(
          'SNAPSHOT_SOURCE_INVALID',
          `Campaign file has an invalid container: ${key}`,
        );
      }
      contents[key] = value;
      fileDigests[key] = digestValue(value);
    }
    const snapshot = {
      version: SNAPSHOT_VERSION,
      id: `snapshot-${createdAt.replace(/[:.]/g, '-')}.json`,
      createdAt,
      dataHash: await dataHash(),
      reason,
      access: access === 'dm' ? 'dm' : 'public',
      files: contents,
      fileDigests,
    };
    if (typeof extra.transactionCommitId === 'string' && extra.transactionCommitId) {
      snapshot.transactionCommitId = extra.transactionCommitId;
    }
    validateSnapshot(snapshot, snapshot.id);
    await atomicWrite(
      path.join(snapshotsDir, snapshot.id),
      JSON.stringify(snapshot),
    );
    await prune();
    return snapshot.id;
  }

  async function maybeCreate(reason = 'save', access = 'public', extra = {}) {
    const last = await lastSnapshotTime();
    if (last && now() - last < coalesceMs) return null;
    try {
      return await create(reason, access, extra);
    } catch (error) {
      logger.warn('[snapshot] create failed:', error.message);
      return null;
    }
  }

  async function hasTransaction(commitId) {
    if (typeof commitId !== 'string' || !commitId) return false;
    for (const filename of await files()) {
      const snapshot = await read(filename);
      if (snapshot?.transactionCommitId === commitId) return true;
    }
    return false;
  }

  async function referencedAddonHashes() {
    const references = new Map();
    for (const filename of await files()) {
      const snapshot = await read(filename);
      const addons = snapshot?.files?.['addons.json']?.addons;
      if (!Array.isArray(addons)) continue;
      for (const addon of addons) {
        if (!isPlainObject(addon) || !ADDON_ID_RE.test(addon.id || '')) continue;
        const hashes = references.get(addon.id) || new Set();
        if (ADDON_HASH_RE.test(addon.activeHash || '')) hashes.add(addon.activeHash);
        if (Array.isArray(addon.versions)) {
          for (const version of addon.versions) {
            if (isPlainObject(version) && ADDON_HASH_RE.test(version.contentHash || '')) {
              hashes.add(version.contentHash);
            }
          }
        }
        if (hashes.size) references.set(addon.id, hashes);
      }
    }
    return references;
  }

  async function restore(id) {
    const snapshot = await read(id);
    if (!snapshot?.files) return { ok: false, error: 'Snapshot nenalezen' };

    await create('pre-restore');
    const result = await publishRestore(snapshot.files);
    return { ok: true, restoreId: result?.restoreId };
  }

  async function remove(id) {
    const safe = sanitizeSnapshotId(id);
    if (!safe) return { ok: false, invalid: true };
    try {
      await fsp.unlink(path.join(snapshotsDir, safe));
      return { ok: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, missing: true };
      throw error;
    }
  }

  return Object.freeze({
    files,
    read,
    metadata,
    create,
    maybeCreate,
    hasTransaction,
    referencedAddonHashes,
    restore,
    remove,
  });
}

module.exports = {
  SNAPSHOT_VERSION,
  SnapshotError,
  createSnapshotService,
  isSnapshotFileKey,
  sanitizeSnapshotId,
  validateSnapshot,
};
