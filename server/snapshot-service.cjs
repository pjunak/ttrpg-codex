'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

const DEFAULT_COALESCE_MS = 60 * 1000;
const DEFAULT_RECENT_KEEP = 50;
const DEFAULT_DAILY_DAYS = 14;

function sanitizeSnapshotId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
}

function createSnapshotService({
  snapshotsDir,
  dataDir,
  atomicWrite,
  trackedDataFiles,
  dataHash,
  pickKeptSnapshots,
  safeJoinIn,
  reconcileAddons,
  invalidateDataHash,
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
    const file = path.join(snapshotsDir, safe);
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
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
      const snapshot = JSON.parse(raw);
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
    const contents = {};
    for (const { key, abs } of await trackedDataFiles()) {
      try {
        contents[key] = JSON.parse(await fsp.readFile(abs, 'utf8'));
      } catch {
        // Unreadable campaign files are excluded from the recovery point.
      }
    }
    const snapshot = {
      id: `snapshot-${createdAt.replace(/[:.]/g, '-')}.json`,
      createdAt,
      dataHash: await dataHash(),
      reason,
      access: access === 'dm' ? 'dm' : 'public',
      ...extra,
      files: contents,
    };
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
      try {
        const raw = await fsp.readFile(path.join(snapshotsDir, filename), 'utf8');
        if (JSON.parse(raw).transactionCommitId === commitId) return true;
      } catch {
        // A corrupt snapshot does not invalidate the rest of the history.
      }
    }
    return false;
  }

  async function restore(id) {
    const snapshot = await read(id);
    if (!snapshot?.files) return { ok: false, error: 'Snapshot nenalezen' };

    await create('pre-restore');
    for (const [key, content] of Object.entries(snapshot.files)) {
      const isAddon = key.startsWith('addon-data/');
      if (!isAddon && !/^[a-z0-9_]+\.json$/i.test(key)) continue;
      const target = safeJoinIn(dataDir, key);
      if (!target) continue;
      if (isAddon) await fsp.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, JSON.stringify(content, null, 2));
    }
    for (const { key, abs } of await trackedDataFiles()) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.files, key)) {
        try {
          await fsp.unlink(abs);
        } catch {
          // Missing files already match the snapshot.
        }
      }
    }
    await reconcileAddons();
    invalidateDataHash();
    return { ok: true };
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
    restore,
    remove,
  });
}

module.exports = {
  createSnapshotService,
  sanitizeSnapshotId,
};
