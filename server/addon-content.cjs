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

module.exports = { loadContentTree };
