'use strict';

// ═══════════════════════════════════════════════════════════════
//  MIGRATIONS — idempotent startup passes that backfill new fields
//  on existing JSON data files. Runs once per server boot from the
//  app.listen callback.
//
//  Pattern: read each data file, walk records, mutate only when a
//  required field is missing, write back. Returns a summary the
//  caller can use to decide whether to take a snapshot and fire a
//  broadcast. Re-running the same migration on already-migrated
//  data is a no-op.
//
//  Pure side-effect functions (touch the filesystem) but no module-
//  level state — easy to call from server.js or from a future
//  one-shot migration script.
// ═══════════════════════════════════════════════════════════════

const fsp  = require('fs').promises;
const path = require('path');
const { VISIBILITY_BEARING, KEYED_OBJ_VISIBILITY } = require('./visibility.cjs');

// Add `visibility: 'public'` + `secrets: {}` to every record that
// doesn't have those fields. Returns `{ changed, byCollection }` so
// the caller knows whether to snapshot/broadcast.
async function runVisibilityMigration(dataDir, opts = {}) {
  const atomicWrite = opts.atomicWrite || _defaultAtomicWrite;
  const result = { changed: 0, byCollection: {} };

  for (const collection of VISIBILITY_BEARING) {
    const file = path.join(dataDir, `${collection}.json`);
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue; // collection not yet on disk
      throw e;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      console.warn(`[migration] ${collection}.json is not valid JSON, skipping`);
      continue;
    }
    let touched = 0;
    if (Array.isArray(parsed)) {
      for (const entity of parsed) {
        if (!entity || typeof entity !== 'object') continue;
        if (_stampDefaults(entity)) touched++;
      }
    } else if (KEYED_OBJ_VISIBILITY.has(collection) && parsed && typeof parsed === 'object') {
      for (const entity of Object.values(parsed)) {
        if (!entity || typeof entity !== 'object') continue;
        if (_stampDefaults(entity)) touched++;
      }
    }
    if (touched > 0) {
      await atomicWrite(file, JSON.stringify(parsed, null, 2));
      result.byCollection[collection] = touched;
      result.changed += touched;
    }
  }
  return result;
}

// Stamp `visibility: 'public'` + `secrets: {}` if missing. Returns
// true if the entity was mutated (so the caller knows to write).
// Idempotent: an entity already carrying the canonical fields is a
// no-op.
function _stampDefaults(entity) {
  let mutated = false;
  if (entity.visibility === undefined) {
    entity.visibility = 'public';
    mutated = true;
  }
  if (entity.secrets === undefined) {
    entity.secrets = {};
    mutated = true;
  }
  return mutated;
}

// Fallback writer used when the caller doesn't pass one. Plain
// write — no atomicity guarantee, no snapshot. Server.js injects
// its own _atomicWrite via the opts.atomicWrite hook so production
// uses the same code path as every other on-disk mutation.
async function _defaultAtomicWrite(file, content) {
  await fsp.writeFile(file, content, 'utf8');
}

module.exports = {
  runVisibilityMigration,
};
