'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {
  durableCopy,
  durableUnlink,
  durableWrite,
  fsyncDirectory,
} = require('./durable-files.cjs');

const RESTORE_ID_RE = /^restore-[0-9a-f]{32}$/;
const STATES = new Set(['prepared', 'publishing', 'rolling-back', 'rolled-back', 'committed']);

class CampaignRestoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CampaignRestoreError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\')
      || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new CampaignRestoreError('RESTORE_JOURNAL_INVALID', 'Invalid restore path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..'
      || normalized.startsWith('../') || normalized.split('/').includes('')) {
    throw new CampaignRestoreError('RESTORE_JOURNAL_INVALID', 'Invalid restore path');
  }
  return normalized;
}

function joinInside(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CampaignRestoreError('RESTORE_JOURNAL_INVALID', 'Restore path escapes its root');
  }
  return target;
}

function validatePaths(paths, maxEntries) {
  if (!Array.isArray(paths) || !paths.length || paths.length > maxEntries) {
    throw new CampaignRestoreError('RESTORE_INVALID', 'Restore candidate has an invalid file count');
  }
  const seen = new Set();
  return paths.map(normalizeRelativePath).sort().map(relativePath => {
    if (seen.has(relativePath)) {
      throw new CampaignRestoreError('RESTORE_INVALID', `Duplicate restore path: ${relativePath}`);
    }
    seen.add(relativePath);
    return relativePath;
  });
}

function validateJournal(journal, { runtimeDir, dataDir, maxEntries }) {
  if (!isPlainObject(journal) || journal.version !== 1 || !RESTORE_ID_RE.test(journal.id || '')
      || !STATES.has(journal.state) || !Array.isArray(journal.entries)
      || !journal.entries.length || journal.entries.length > maxEntries) {
    throw new CampaignRestoreError('RESTORE_JOURNAL_INVALID', 'Invalid restore journal');
  }
  const restoreDir = path.join(runtimeDir, journal.id);
  const seen = new Set();
  const entries = journal.entries.map(entry => {
    if (!isPlainObject(entry) || typeof entry.originalExists !== 'boolean') {
      throw new CampaignRestoreError('RESTORE_JOURNAL_INVALID', 'Invalid restore journal entry');
    }
    const relativePath = normalizeRelativePath(entry.path);
    if (seen.has(relativePath)) {
      throw new CampaignRestoreError('RESTORE_JOURNAL_INVALID', 'Duplicate restore journal path');
    }
    seen.add(relativePath);
    return {
      relativePath,
      originalExists: entry.originalExists,
      target: joinInside(dataDir, relativePath),
      original: joinInside(path.join(restoreDir, 'original'), relativePath),
      next: joinInside(path.join(restoreDir, 'next'), relativePath),
    };
  });
  return { restoreDir, entries };
}

async function cleanupRestoreDir(runtimeDir, restoreDir, restoreId) {
  const cleanupDir = path.join(
    runtimeDir,
    `.cleanup-${restoreId}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    await fsp.rename(restoreDir, cleanupDir);
    await fsyncDirectory(runtimeDir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await fsp.rm(cleanupDir, { recursive: true, force: true });
  await fsyncDirectory(runtimeDir);
}

class CampaignRestoreManager {
  constructor({
    dataDir,
    runtimeDir,
    publicationBarrier,
    maxEntries = 50_000,
    onCommit = async () => {},
    onRecoveredCommit = async () => {},
    onFatal = () => {},
    fault = async () => {},
    now = () => Date.now(),
  }) {
    this.dataDir = dataDir;
    this.runtimeDir = runtimeDir;
    this.publicationBarrier = publicationBarrier;
    this.maxEntries = maxEntries;
    this.onCommit = onCommit;
    this.onRecoveredCommit = onRecoveredCommit;
    this.onFatal = onFatal;
    this.fault = fault;
    this.now = now;
  }

  async #rollback(journal, validated, journalPath) {
    journal = { ...journal, state: 'rolling-back' };
    await durableWrite(journalPath, JSON.stringify(journal, null, 2));
    await this.publicationBarrier.publish(async () => {
      for (let index = 0; index < validated.entries.length; index++) {
        const entry = validated.entries[index];
        await this.fault(`rollback:${index}:before`);
        if (entry.originalExists) await durableCopy(entry.original, entry.target);
        else await durableUnlink(entry.target);
        await this.fault(`rollback:${index}:after`);
      }
    });
    journal = { ...journal, state: 'rolled-back' };
    await durableWrite(journalPath, JSON.stringify(journal, null, 2));
    return journal;
  }

  async #applyEffects(journal, journalPath, effect) {
    try {
      await effect({ restoreId: journal.id, paths: journal.entries.map(entry => entry.path) });
      journal = { ...journal, effectsApplied: true };
      await durableWrite(journalPath, JSON.stringify(journal, null, 2));
      return { journal, applied: true };
    } catch (error) {
      console.error(`[restore ${journal.id}] post-commit effects deferred:`, error);
      return { journal, applied: false };
    }
  }

  async commit({ candidateDir, paths }) {
    const relativePaths = validatePaths(paths, this.maxEntries);
    const restoreId = `restore-${crypto.randomBytes(16).toString('hex')}`;
    const restoreDir = path.join(this.runtimeDir, restoreId);
    const journalPath = path.join(restoreDir, 'journal.json');
    await fsp.mkdir(restoreDir, { recursive: true });

    let journal = null;
    try {
      const entries = [];
      for (let index = 0; index < relativePaths.length; index++) {
        const relativePath = relativePaths[index];
        const source = joinInside(candidateDir, relativePath);
        const sourceStat = await fsp.lstat(source);
        if (!sourceStat.isFile()) {
          throw new CampaignRestoreError('RESTORE_INVALID', `Restore candidate is not a file: ${relativePath}`);
        }
        const target = joinInside(this.dataDir, relativePath);
        const originalExists = await fsp.lstat(target).then(stat => {
          if (!stat.isFile()) {
            throw new CampaignRestoreError('RESTORE_INVALID', `Restore target is not a file: ${relativePath}`);
          }
          return true;
        }, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        await this.fault(`stage:${index}:before`);
        await durableCopy(source, joinInside(path.join(restoreDir, 'next'), relativePath));
        if (originalExists) {
          await durableCopy(target, joinInside(path.join(restoreDir, 'original'), relativePath));
        }
        await this.fault(`stage:${index}:after`);
        entries.push({ path: relativePath, originalExists });
      }

      journal = {
        version: 1,
        id: restoreId,
        state: 'prepared',
        createdAt: new Date(this.now()).toISOString(),
        entries,
      };
      await this.fault('journal:prepared:before');
      await durableWrite(journalPath, JSON.stringify(journal, null, 2));
      await this.fault('journal:prepared:after');

      const validated = validateJournal(journal, this);
      let committedDurably = false;
      try {
        await this.publicationBarrier.publish(async () => {
          journal = { ...journal, state: 'publishing' };
          await this.fault('journal:publishing:before');
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          await this.fault('journal:publishing:after');
          for (let index = 0; index < validated.entries.length; index++) {
            await this.fault(`publish:${index}:before`);
            await durableCopy(validated.entries[index].next, validated.entries[index].target);
            await this.fault(`publish:${index}:after`);
          }
          journal = { ...journal, state: 'committed' };
          await this.fault('journal:committed:before');
          await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          committedDurably = true;
          await this.fault('journal:committed:after');
        });
      } catch (error) {
        if (!committedDurably) {
          try {
            journal = await this.#rollback(journal, validated, journalPath);
          } catch (rollbackError) {
            error.rollbackError = rollbackError;
            const fatal = new CampaignRestoreError(
              'RESTORE_ROLLBACK_FAILED',
              `Restore ${restoreId} rollback failed; startup recovery required`,
              rollbackError,
            );
            this.publicationBarrier.poison(fatal);
            this.onFatal(fatal);
          }
          throw error;
        }
      }

      const effects = await this.#applyEffects(journal, journalPath, this.onCommit);
      journal = effects.journal;
      if (effects.applied) {
        await cleanupRestoreDir(this.runtimeDir, restoreDir, restoreId).catch(error => {
          console.warn(`[restore ${restoreId}] journal cleanup deferred:`, error.message);
        });
      }
      return { ok: true, restoreId, paths: relativePaths };
    } catch (error) {
      let stored = null;
      try {
        stored = JSON.parse(await fsp.readFile(journalPath, 'utf8'));
      } catch (readError) {
        if (readError.code !== 'ENOENT') {
          const fatal = new CampaignRestoreError(
            'RESTORE_JOURNAL_INVALID',
            `Restore ${restoreId} journal became unreadable; startup recovery required`,
            readError,
          );
          error.rollbackError ||= fatal;
          this.publicationBarrier.poison(fatal);
          this.onFatal(fatal);
        }
      }
      if (error.rollbackError) throw error;
      if (!stored) {
        await fsp.rm(restoreDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const validated = validateJournal(stored, this);
      if (stored.state === 'committed') {
        const effects = await this.#applyEffects(stored, journalPath, this.onCommit);
        if (effects.applied) {
          await cleanupRestoreDir(this.runtimeDir, restoreDir, restoreId).catch(() => {});
        }
        return { ok: true, restoreId, paths: relativePaths };
      }
      if (stored.state !== 'rolled-back') {
        try {
          stored = await this.#rollback(stored, validated, journalPath);
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
          const fatal = new CampaignRestoreError(
            'RESTORE_ROLLBACK_FAILED',
            `Restore ${restoreId} rollback failed; startup recovery required`,
            rollbackError,
          );
          this.publicationBarrier.poison(fatal);
          this.onFatal(fatal);
          throw error;
        }
      }
      await cleanupRestoreDir(this.runtimeDir, restoreDir, restoreId).catch(() => {});
      throw error;
    }
  }

  async recover() {
    await fsp.mkdir(this.runtimeDir, { recursive: true });
    const names = await fsp.readdir(this.runtimeDir);
    const result = { committed: [], rolledBack: [], cleaned: [] };
    for (const name of names) {
      if (/^\.cleanup-restore-[0-9a-f]{32}-[0-9a-f]{12}$/.test(name)) {
        await fsp.rm(path.join(this.runtimeDir, name), { recursive: true, force: true });
        result.cleaned.push(name);
      }
    }
    for (const name of names) {
      if (!RESTORE_ID_RE.test(name)) continue;
      const restoreDir = path.join(this.runtimeDir, name);
      const journalPath = path.join(restoreDir, 'journal.json');
      let journal;
      try {
        journal = JSON.parse(await fsp.readFile(journalPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          await fsp.rm(restoreDir, { recursive: true, force: true });
          result.cleaned.push(name);
          continue;
        }
        throw new CampaignRestoreError(
          'RESTORE_JOURNAL_INVALID',
          `Unsafe restore journal ${name}: ${error.message}`,
          error,
        );
      }

      let validated;
      try {
        validated = validateJournal(journal, this);
      } catch (error) {
        error.message = `Unsafe restore journal ${name}: ${error.message}`;
        throw error;
      }

      if (journal.state === 'rolling-back') {
        journal = await this.#rollback(journal, validated, journalPath);
        result.rolledBack.push(name);
      } else if (journal.state === 'rolled-back') {
        result.rolledBack.push(name);
      } else {
        if (journal.state !== 'committed') {
          await this.publicationBarrier.publish(async () => {
            for (const entry of validated.entries) await durableCopy(entry.next, entry.target);
            journal = { ...journal, state: 'committed' };
            await durableWrite(journalPath, JSON.stringify(journal, null, 2));
          });
        }
        if (journal.effectsApplied !== true) {
          const effects = await this.#applyEffects(journal, journalPath, this.onRecoveredCommit);
          journal = effects.journal;
          if (!effects.applied) continue;
        }
        result.committed.push(name);
      }
      await cleanupRestoreDir(this.runtimeDir, restoreDir, name);
    }
    await fsyncDirectory(this.runtimeDir);
    return result;
  }
}

module.exports = {
  CampaignRestoreError,
  CampaignRestoreManager,
  normalizeRelativePath,
  validateJournal,
};
