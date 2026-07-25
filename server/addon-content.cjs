'use strict';
// ═══════════════════════════════════════════════════════════════
//  addon-content.cjs — host-served declarative addon content.
//
//  An addon whose manifest declares `contentDir` (e.g. "data") ships a
//  per-record JSON tree (data/<dir>/<id>.json) that the HOST reads and serves
//  under the addon's namespaced prefix — /api/addon/<id>/content,
//  /content/:kind, /item/:kind/:id, /kinds — with NO addon server code and
//  therefore NO `server:code` grant. This is the "static rulebook" seam: the
//  files are already individually reachable through the same-origin static
//  mount (/addons/<id>/<hash>/…); this adds only the enumerated aggregate.
//
//  True dynamic discovery is preserved: kinds are keyed by each record's own
//  `kind` field (the sub-directory name is the fallback), so dropping a JSON
//  file into the tree makes it live on the next (re)load — and because the
//  host rebuilds on every registry mutation, an install/update/enable needs
//  no server restart at all (unlike server-code addons).
//
//  Pure + injectable: no server.js state. server.js owns the cache map, the
//  rebuild triggers, and the dispatcher wiring.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

class AddonContentError extends Error {
  constructor(diagnostics) {
    const count = diagnostics.length;
    const first = diagnostics[0];
    const firstPath = [...String(first?.path || '.')]
      .map(character => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 ? '?' : character;
      })
      .join('')
      .slice(0, 240);
    const detail = first ? `: ${firstPath}: ${first.message}` : '';
    super(`Invalid addon content (${count} ${count === 1 ? 'issue' : 'issues'})${detail}`);
    this.name = 'AddonContentError';
    this.code = 'ADDON_CONTENT_INVALID';
    this.diagnostics = Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic })));
  }
}

function relativePath(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath).replace(/\\/g, '/');
  return relative || '.';
}

function buildTree(content) {
  const index = Object.create(null);
  let count = 0;
  for (const kind of Object.keys(content)) {
    const byId = Object.create(null);
    index[kind] = byId;
    for (const record of content[kind]) {
      if (Object.hasOwn(byId, record.id)) {
        throw new AddonContentError([{
          code: 'CONTENT_DUPLICATE_ID',
          path: kind,
          message: 'Duplicate record id within one kind',
        }]);
      }
      byId[record.id] = record;
      count++;
    }
  }
  return { content, index, kinds: Object.keys(content).sort(), count };
}

/**
 * Recursively read every `*.json` under `rootDir`'s child directories and
 * group records by their `kind` field (fallback: the immediate top-level
 * sub-directory name). Also builds a per-kind id index for O(1) item lookup.
 * The tree is accepted atomically: unreadable paths, malformed records,
 * symlinks, and duplicate `(kind,id)` identities reject the whole package.
 *
 * @param {string} rootDir - absolute path of the addon's content dir
 * @returns {{content: Object<string, Array>, index: Object<string, Object>,
 *            kinds: string[], count: number}}
 */
function loadContentTree(rootDir) {
  const content = Object.create(null);
  const diagnostics = [];
  const sources = new Map();

  let rootStat;
  try {
    rootStat = fs.lstatSync(rootDir);
  } catch (error) {
    diagnostics.push({
      code: error.code === 'ENOENT' ? 'CONTENT_DIR_MISSING' : 'CONTENT_DIR_READ_FAILED',
      path: '.',
      message: error.code === 'ENOENT' ? 'Content directory does not exist' : 'Content directory cannot be read',
    });
    throw new AddonContentError(diagnostics);
  }
  if (rootStat.isSymbolicLink()) {
    throw new AddonContentError([{
      code: 'CONTENT_SYMLINK_UNSUPPORTED',
      path: '.',
      message: 'Symbolic links are not allowed in declarative content',
    }]);
  }
  if (!rootStat.isDirectory()) {
    throw new AddonContentError([{
      code: 'CONTENT_DIR_NOT_DIRECTORY',
      path: '.',
      message: 'Content path must be a directory',
    }]);
  }

  function walk(dir, topName) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      diagnostics.push({
        code: 'CONTENT_DIR_READ_FAILED',
        path: relativePath(rootDir, dir),
        message: 'Content directory cannot be read',
      });
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relative = relativePath(rootDir, full);
      if (e.isSymbolicLink()) {
        diagnostics.push({
          code: 'CONTENT_SYMLINK_UNSUPPORTED',
          path: relative,
          message: 'Symbolic links are not allowed in declarative content',
        });
      } else if (e.isDirectory()) {
        walk(full, topName || e.name);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        let rec;
        try {
          rec = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (error) {
          diagnostics.push({
            code: error instanceof SyntaxError ? 'CONTENT_JSON_INVALID' : 'CONTENT_FILE_READ_FAILED',
            path: relative,
            message: error instanceof SyntaxError ? 'File is not valid JSON' : 'Content file cannot be read',
          });
          continue;
        }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
          diagnostics.push({
            code: 'CONTENT_RECORD_INVALID',
            path: relative,
            message: 'Content record must be a JSON object',
          });
          continue;
        }
        if (typeof rec.id !== 'string' || !rec.id.trim()) {
          diagnostics.push({
            code: 'CONTENT_ID_INVALID',
            path: relative,
            message: 'Content record id must be a non-empty string',
          });
          continue;
        }
        if (rec.kind !== undefined && (typeof rec.kind !== 'string' || !rec.kind.trim())) {
          diagnostics.push({
            code: 'CONTENT_KIND_INVALID',
            path: relative,
            message: 'Content record kind must be a non-empty string when present',
          });
          continue;
        }
        const kind = rec.kind || topName;
        if (!kind) {
          diagnostics.push({
            code: 'CONTENT_KIND_REQUIRED',
            path: relative,
            message: 'A root-level content record must declare kind',
          });
          continue;
        }
        const identity = JSON.stringify([kind, rec.id]);
        if (sources.has(identity)) {
          diagnostics.push({
            code: 'CONTENT_DUPLICATE_ID',
            path: relative,
            relatedPath: sources.get(identity),
            message: 'Duplicate record id within one kind',
          });
          continue;
        }
        sources.set(identity, relative);
        (content[kind] || (content[kind] = [])).push(rec);
      }
    }
  }

  walk(rootDir, '');

  if (diagnostics.length) throw new AddonContentError(diagnostics);

  // Stable order within each kind so the API output is deterministic.
  for (const k of Object.keys(content)) {
    content[k].sort((a, b) => a.id.localeCompare(b.id));
  }

  return buildTree(content);
}

/**
 * Distinct values of `field` across every record in a loaded tree, with
 * record counts. Computed from the UNFILTERED tree by the caller, so a
 * disabled group still lists (checkable back on) with its true size.
 * Records lacking the field contribute no value — they're never part of a
 * group and never filterable. Values are stringified so a numeric field
 * compares stably against the registry's string off-list.
 *
 * Each value also carries a display `label`: when the tree ships a record of
 * the kind NAMED LIKE the group field whose id matches the value (the
 * compendium's `book` field is labelled by its `book`-kind records), that
 * record's `name` is used; otherwise the raw value falls through — so the
 * Manager's toggles show "Player's Handbook", not "phb", with zero manifest
 * additions. The registry off-list and the toggle wire format stay raw ids.
 *
 * @param {{content: Object<string, Array>}} tree - from loadContentTree
 * @param {string} field - the manifest's contentGroups.field
 * @returns {Array<{id: string, count: number, label: string}>} sorted by id
 */
function groupValues(tree, field) {
  const counts = new Map();
  const content = (tree && tree.content) || {};
  for (const k of Object.keys(content)) {
    for (const r of content[k]) {
      if (!r || r[field] === undefined || r[field] === null) continue;
      const id = String(r[field]);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const labels = new Map();
  for (const r of content[field] || []) {
    if (r && r.id != null && typeof r.name === 'string' && r.name.trim()) {
      labels.set(String(r.id), r.name);
    }
  }
  return [...counts.keys()].sort()
    .map((id) => ({ id, count: counts.get(id), label: labels.get(id) || id }));
}

/**
 * Drop every record whose `field` value is on the DM's `disabled` list —
 * the ONE filtering code path every consumer shares: server.js filters at
 * tree-build time (_applyAddonContent), so the /content aggregate, the
 * per-kind list, the /item lookup, /kinds, and anything else reading the
 * cached tree all agree by construction. Records LACKING the field are
 * ALWAYS kept: a group toggle can only hide records that opted into a
 * group, never unrelated content. Returns a new tree (record objects are
 * shared by reference — cheap); kinds emptied by the filter disappear from
 * both `content` and `kinds`. An empty off-list returns the input as-is.
 *
 * @param {{content, index, kinds, count}} tree - from loadContentTree
 * @param {string} field - the manifest's contentGroups.field
 * @param {string[]} disabled - group ids (String(record[field]) values)
 * @returns {{content: Object<string, Array>, index: Object<string, Object>,
 *            kinds: string[], count: number}}
 */
function filterContentTree(tree, field, disabled) {
  const off = new Set(Array.isArray(disabled) ? disabled : []);
  if (!field || !off.size) return tree;
  const content = Object.create(null);
  const src = (tree && tree.content) || {};
  for (const k of Object.keys(src)) {
    const kept = src[k].filter(
      (r) => !r || r[field] === undefined || r[field] === null || !off.has(String(r[field]))
    );
    if (!kept.length) continue;
    content[k] = kept;
  }
  return buildTree(content);
}

module.exports = { AddonContentError, loadContentTree, groupValues, filterContentTree };
