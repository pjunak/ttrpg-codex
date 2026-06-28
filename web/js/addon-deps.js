// ═══════════════════════════════════════════════════════════════
//  ADDON-DEPS — pure dependency-graph helpers for CodexHost.
//
//  No DOM / Store / network dependencies, so these are unit-testable in
//  isolation (test/addon-deps.test.mjs). The host (addons.js) uses
//  planLoadOrder() to load addons in dependency order and to flag
//  missing / incompatible / cyclic dependencies as `blocked` — a
//  dependent never silently half-works when its dependency is absent.
// ═══════════════════════════════════════════════════════════════

/** A manifest dependency value is either a range string ("^1.2.0") or an
 *  object `{ range, repo? }`. Return the range string. */
export function depRange(spec) {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object') return spec.range || '';
  return '';
}

export function parseVer(v) {
  // NOTE: a pre-release suffix is intentionally ignored — `1.2.0-alpha`
  // parses to [1,2,0] and is treated as its release. Real semver excludes
  // pre-releases from ranges that don't name one; we accept the
  // simplification because this addon ecosystem is solo-authored and
  // pre-release deps are vanishingly unlikely. Pinned by a test so it's a
  // known choice, not an accident.
  const m = String(v == null ? '' : v).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function _cmp(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

/** Minimal semver-range check covering the common forms: "" / "*" (any),
 *  exact "x.y.z", comparators >= > <= < , "^x.y.z" (caret), "~x.y.z" (tilde),
 *  and X-ranges "M.x" / "M.m.x" (also `*`). Compound forms we deliberately
 *  DON'T parse — hyphen ranges ("1 - 2") and OR ("^1 || ^2") — fall through to
 *  permissive `true` (documented; an unparseable version also doesn't block). */
export function satisfies(version, range) {
  range = String(range || '').trim();
  if (!range || range === '*') return true;
  const v = parseVer(version);
  if (!v) return true;
  let m;
  if ((m = range.match(/^>=\s*(\d+\.\d+\.\d+)$/)))      return _cmp(v, parseVer(m[1])) >= 0;
  if ((m = range.match(/^>\s*(\d+\.\d+\.\d+)$/)))       return _cmp(v, parseVer(m[1])) > 0;
  if ((m = range.match(/^<=\s*(\d+\.\d+\.\d+)$/)))      return _cmp(v, parseVer(m[1])) <= 0;
  if ((m = range.match(/^<\s*(\d+\.\d+\.\d+)$/)))       return _cmp(v, parseVer(m[1])) < 0;
  if ((m = range.match(/^\^\s*(\d+)\.(\d+)\.(\d+)$/))) {
    // Caret: >= the floor AND within the leftmost-non-zero component. Crucially
    // for 0.x (every early addon): ^0.2.3 = >=0.2.3 <0.3.0 (lock MINOR), and
    // ^0.0.3 = exactly 0.0.3 (lock patch) — not just "major 0 and >=".
    const r = [+m[1], +m[2], +m[3]];
    if (_cmp(v, r) < 0) return false;
    if (r[0] > 0) return v[0] === r[0];                       // ^M.m.p → lock major
    if (r[1] > 0) return v[0] === 0 && v[1] === r[1];         // ^0.m.p → lock minor
    return v[0] === 0 && v[1] === 0 && v[2] === r[2];         // ^0.0.p → exact
  }
  if ((m = range.match(/^~\s*(\d+)\.(\d+)\.(\d+)$/)))   { const r = [+m[1], +m[2], +m[3]]; return v[0] === r[0] && v[1] === r[1] && v[2] >= r[2]; }
  if ((m = range.match(/^(\d+)\.(\d+)\.[xX*]$/)))       return v[0] === +m[1] && v[1] === +m[2];   // X-range M.m.x → lock minor
  if ((m = range.match(/^(\d+)\.[xX*]$/)))              return v[0] === +m[1];                     // X-range M.x   → lock major
  if ((m = range.match(/^(\d+\.\d+\.\d+)$/)))           return _cmp(v, parseVer(m[1])) === 0;
  return true;
}

/**
 * Topo-sort enabled addons so each loads after its dependencies, and flag
 * addons whose deps are missing / version-incompatible / (transitively)
 * blocked / cyclic.
 *
 * @param {Array<{id:string, version:string, dependencies?:object}>} list
 * @returns {{ order: Array, blocked: Map<string,string>, cycles: string[] }}
 *   `order` is the load order of loadable addons; `blocked` maps an
 *   un-loadable addon id to a human reason; `cycles` lists ids in cycles.
 */
export function planLoadOrder(list) {
  const byId = new Map(list.map(a => [a.id, a]));
  const deps = (a) => Object.entries((a && a.dependencies) || {}).map(([id, spec]) => ({ id, range: depRange(spec) }));
  const blocked = new Map();

  // 1. direct missing / version-incompatible dependencies
  for (const a of list) {
    for (const d of deps(a)) {
      const dep = byId.get(d.id);
      if (!dep) { blocked.set(a.id, `chybí závislost „${d.id}"`); break; }
      if (!satisfies(dep.version, d.range)) { blocked.set(a.id, `„${d.id}" ${dep.version || '?'} nesplňuje ${d.range}`); break; }
    }
  }
  // 2. transitively block anything depending on a blocked addon
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of list) {
      if (blocked.has(a.id)) continue;
      for (const d of deps(a)) {
        if (blocked.has(d.id)) { blocked.set(a.id, `závislost „${d.id}" je blokovaná`); changed = true; break; }
      }
    }
  }
  // 3. Kahn topo-sort of the survivors (dependency → dependent edges)
  const active = list.filter(a => !blocked.has(a.id));
  const activeIds = new Set(active.map(a => a.id));
  const indeg = new Map(active.map(a => [a.id, 0]));
  const dependents = new Map(active.map(a => [a.id, []]));
  for (const a of active) {
    for (const d of deps(a)) {
      if (activeIds.has(d.id)) { dependents.get(d.id).push(a.id); indeg.set(a.id, indeg.get(a.id) + 1); }
    }
  }
  const queue = active.filter(a => indeg.get(a.id) === 0).map(a => a.id);
  const orderIds = [];
  while (queue.length) {
    const id = queue.shift();
    orderIds.push(id);
    for (const dep of dependents.get(id)) { indeg.set(dep, indeg.get(dep) - 1); if (indeg.get(dep) === 0) queue.push(dep); }
  }
  // 4. Survivors Kahn couldn't place are either IN a cycle or merely DOWNSTREAM
  //    of one (they depend on a cycle but nothing depends back on them). Tell
  //    them apart so the DM gets an accurate reason: peel "sink" nodes (no
  //    other unplaced node depends on them) — a true cycle member always has a
  //    dependent within the cycle, so it never peels. A self-dependency is a
  //    trivial cycle and is pinned in place.
  const placed = new Set(orderIds);
  const unplacedIds = active.filter(a => !placed.has(a.id)).map(a => a.id);
  const cycleSet = new Set(unplacedIds);
  const selfLoops = id => deps(byId.get(id)).some(d => d.id === id);
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const id of [...cycleSet]) {
      if (selfLoops(id)) continue;
      const hasUnplacedDependent = [...cycleSet].some(o => o !== id && deps(byId.get(o)).some(d => d.id === id));
      if (!hasUnplacedDependent) { cycleSet.delete(id); peeled = true; }
    }
  }
  const cycles = [...cycleSet];
  for (const id of unplacedIds) {
    blocked.set(id, cycleSet.has(id) ? 'cyklická závislost' : 'závislost je v cyklu');
  }

  return { order: orderIds.map(id => byId.get(id)), blocked, cycles };
}
