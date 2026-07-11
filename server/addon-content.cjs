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

/**
 * Recursively read every `*.json` under `rootDir`'s child directories and
 * group records by their `kind` field (fallback: the immediate top-level
 * sub-directory name). Also builds a per-kind id index for O(1) item lookup.
 * Never throws for missing/corrupt input: a missing root yields empty
 * content; an unparseable file is skipped.
 *
 * @param {string} rootDir - absolute path of the addon's content dir
 * @returns {{content: Object<string, Array>, index: Object<string, Object>,
 *            kinds: string[], count: number}}
 */
function loadContentTree(rootDir) {
  const content = {};
  let count = 0;

  function walk(dir, topName) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }                 // missing dir → nothing to add
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, topName || e.name);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        let rec;
        try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); }
        catch (_) { continue; }           // skip an unparseable file, keep going
        if (!rec || typeof rec !== 'object') continue;
        const kind = rec.kind || topName || 'unknown';
        (content[kind] || (content[kind] = [])).push(rec);
        count++;
      }
    }
  }

  // Each immediate child dir of rootDir is a kind bucket (spells/, gear/, …).
  let dirs = [];
  try {
    dirs = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (_) { /* no content dir → empty */ }
  for (const d of dirs) walk(path.join(rootDir, d), d);

  // Stable order within each kind so the API output is deterministic.
  for (const k of Object.keys(content)) {
    content[k].sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  }

  const index = {};
  for (const k of Object.keys(content)) {
    const m = (index[k] = Object.create(null));
    for (const r of content[k]) if (r && r.id != null) m[r.id] = r;
  }
  return { content, index, kinds: Object.keys(content).sort(), count };
}

/**
 * Distinct values of `field` across every record in a loaded tree, with
 * record counts. Computed from the UNFILTERED tree by the caller, so a
 * disabled group still lists (checkable back on) with its true size.
 * Records lacking the field contribute no value — they're never part of a
 * group and never filterable. Values are stringified so a numeric field
 * compares stably against the registry's string off-list.
 *
 * @param {{content: Object<string, Array>}} tree - from loadContentTree
 * @param {string} field - the manifest's contentGroups.field
 * @returns {Array<{id: string, count: number}>} sorted by id
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
  return [...counts.keys()].sort().map((id) => ({ id, count: counts.get(id) }));
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
  const content = {};
  let count = 0;
  const src = (tree && tree.content) || {};
  for (const k of Object.keys(src)) {
    const kept = src[k].filter(
      (r) => !r || r[field] === undefined || r[field] === null || !off.has(String(r[field]))
    );
    if (!kept.length) continue;
    content[k] = kept;
    count += kept.length;
  }
  const index = {};
  for (const k of Object.keys(content)) {
    const m = (index[k] = Object.create(null));
    for (const r of content[k]) if (r && r.id != null) m[r.id] = r;
  }
  return { content, index, kinds: Object.keys(content).sort(), count };
}

module.exports = { loadContentTree, groupValues, filterContentTree };
