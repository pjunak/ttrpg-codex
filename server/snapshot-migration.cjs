'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const {
  durableCopy,
  durableUnlink,
  renameWithRetry,
} = require('./durable-files.cjs');

const SNAPSHOT_FILE_RE = /^snapshot-.*\.json$/;

async function pathExists(filePath, fsApi = fsp) {
  try {
    await fsApi.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function moveSnapshotFile(source, target, {
  rename = renameWithRetry,
  copy = durableCopy,
  unlink = durableUnlink,
} = {}) {
  try {
    await rename(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copy(source, target);
    await unlink(source);
  }
}

async function migrateLegacySnapshots({
  legacyDir,
  snapshotsDir,
  fsApi = fsp,
  moveFile = moveSnapshotFile,
  unlink = durableUnlink,
  logger = console,
}) {
  let entries;
  try {
    entries = await fsApi.readdir(legacyDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { found: false, moved: 0, duplicates: 0, failed: 0 };
    logger.warn(`[snapshot migrate] ${error.message}`);
    return { found: true, moved: 0, duplicates: 0, failed: 1 };
  }

  await fsApi.mkdir(snapshotsDir, { recursive: true });
  let moved = 0;
  let duplicates = 0;
  let failed = 0;

  for (const file of entries) {
    if (!SNAPSHOT_FILE_RE.test(file)) continue;
    const source = path.join(legacyDir, file);
    const target = path.join(snapshotsDir, file);
    try {
      if (await pathExists(target, fsApi)) {
        await unlink(source);
        duplicates++;
      } else {
        await moveFile(source, target);
        moved++;
      }
    } catch (error) {
      failed++;
      logger.warn(`[snapshot migrate] ${file}: ${error.message}`);
    }
  }

  try {
    await fsApi.rmdir(legacyDir);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) {
      logger.warn(`[snapshot migrate] ${error.message}`);
    }
  }

  if (failed === 0) {
    logger.log('[snapshot] migrated legacy data/snapshots → data-snapshots');
  } else {
    logger.warn(`[snapshot migrate] incomplete: ${failed} snapshot(s) remain in data/snapshots`);
  }
  return { found: true, moved, duplicates, failed };
}

module.exports = {
  migrateLegacySnapshots,
  moveSnapshotFile,
};
