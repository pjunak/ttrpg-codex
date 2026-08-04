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

import { testRange } from './addon-compat.js';
import { resolveServiceBindings } from './addon-services.js';

/** Strict semver-range check covering "*" (any),
 *  exact "x.y.z", comparators >= > <= < , "^x.y.z" (caret), "~x.y.z" (tilde),
 *  and X-ranges "M.x" / "M.m.x". Unsupported syntax and malformed versions
 *  fail closed. */
export function satisfies(version, range) {
  const result = testRange(version, range);
  return result.valid && result.matches;
}

/**
 * Topo-sort enabled addons so each loads after its dependencies, and flag
 * addons whose HARD deps are missing / version-incompatible / (transitively)
 * blocked / cyclic.
 *
 * `optionalDependencies` are ORDERING-ONLY: when the optional dep is present
 * (enabled) and version-compatible, the dependent is ordered AFTER it (so it
 * can host.use() it during register). When the optional dep is absent, blocked,
 * or version-incompatible it is simply ignored — it NEVER blocks the dependent,
 * and an optional-edge cycle is broken (optional ordering dropped) rather than
 * blocking anyone. This is what lets an addon SOFT-use another (e.g. a sheet
 * that auto-fills from a rules engine when present, hand-fills when not) while
 * still installing standalone.
 *
 * @param {Array<{id:string, version:string, dependencies?:object, optionalDependencies?:object}>} list
 * @returns {{ order: Array, blocked: Map<string,string>, cycles: string[] }}
 *   `order` is the load order of loadable addons; `blocked` maps an
 *   un-loadable addon id to a human reason; `cycles` lists ids in HARD cycles.
 */
export function planLoadOrder(list, options = {}) {
  const byId = new Map(list.map(a => [a.id, a]));
  const deps    = (a) => Object.entries((a && a.dependencies) || {}).map(([id, spec]) => ({ id, range: depRange(spec) }));
  const optDeps = (a) => Object.entries((a && a.optionalDependencies) || {}).map(([id, spec]) => ({ id, range: depRange(spec) }));
  const blocked = new Map();
  const serviceIssueHistory = new Map();

  // 1. direct missing / version-incompatible HARD dependencies
  for (const a of list) {
    for (const d of deps(a)) {
      const dep = byId.get(d.id);
      if (!dep) { blocked.set(a.id, `missing dependency "${d.id}"`); break; }
      if (!testRange(dep.version, d.range).valid) { blocked.set(a.id, `dependency "${d.id}" has an invalid version or range`); break; }
      if (!satisfies(dep.version, d.range)) { blocked.set(a.id, `"${d.id}" ${dep.version || '?'} does not satisfy ${d.range}`); break; }
    }
  }
  const propagateExactBlocks = () => {
    let changed = false;
    for (const a of list) {
      if (blocked.has(a.id)) continue;
      for (const d of deps(a)) {
        if (blocked.has(d.id)) { blocked.set(a.id, `dependency "${d.id}" is blocked`); changed = true; break; }
      }
    }
    return changed;
  };

  // Kahn topo-sort over a node-id set + directed edges [from, to] (`from` must
  // load before `to`). Returns the ids it could place — all of them unless the
  // edge set contains a cycle, in which case the cycle members are omitted.
  const kahn = (nodeIds, edges) => {
    const idset = new Set(nodeIds);
    const indeg = new Map(nodeIds.map(id => [id, 0]));
    const outs = new Map(nodeIds.map(id => [id, []]));
    for (const [from, to] of edges) {
      if (idset.has(from) && idset.has(to)) { outs.get(from).push(to); indeg.set(to, indeg.get(to) + 1); }
    }
    const queue = nodeIds.filter(id => indeg.get(id) === 0);
    const out = [];
    while (queue.length) {
      const id = queue.shift();
      out.push(id);
      for (const to of outs.get(id)) { indeg.set(to, indeg.get(to) - 1); if (indeg.get(to) === 0) queue.push(to); }
    }
    return out;
  };

  // Resolve hard exact and service requirements to a fixed point. A required
  // service participates in the same graph as a hard dependency. Optional
  // services only refine provider-first ordering and never block an addon.
  const cycles = [];
  let graphChanged = true;
  while (graphChanged) {
    graphChanged = false;
    while (propagateExactBlocks()) graphChanged = true;
    const servicePlan = resolveServiceBindings(list, options.serviceBindings, new Set(blocked.keys()));
    for (const issue of servicePlan.issues) {
      if (issue.required) serviceIssueHistory.set(`${issue.consumerId}::${issue.contract}`, issue);
    }
    for (const [id, reason] of servicePlan.requiredBlocks) {
      if (!blocked.has(id)) { blocked.set(id, reason); graphChanged = true; }
    }
    if (graphChanged) continue;

    const active = list.filter(a => !blocked.has(a.id));
    const activeIds = new Set(active.map(a => a.id));
    const hardEdges = servicePlan.hardEdges.slice();
    for (const a of active) for (const d of deps(a)) if (activeIds.has(d.id)) hardEdges.push([d.id, a.id]);
    const placedIds = kahn(active.map(a => a.id), hardEdges);
    if (placedIds.length === active.length) break;

    const placed = new Set(placedIds);
    const unplacedIds = active.filter(a => !placed.has(a.id)).map(a => a.id);
    const cycleSet = new Set(unplacedIds);
    const selfLoops = id => hardEdges.some(([from, to]) => from === id && to === id);
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const id of [...cycleSet]) {
        if (selfLoops(id)) continue;
        const hasUnplacedDependent = hardEdges.some(([from, to]) => from === id && cycleSet.has(to) && to !== id);
        if (!hasUnplacedDependent) { cycleSet.delete(id); peeled = true; }
      }
    }
    for (const id of cycleSet) if (!cycles.includes(id)) cycles.push(id);
    for (const id of unplacedIds) {
      blocked.set(id, cycleSet.has(id) ? 'cyclic dependency' : 'dependency is in a cycle');
    }
    graphChanged = true;
  }

  const active = list.filter(a => !blocked.has(a.id));
  const activeIds = new Set(active.map(a => a.id));
  const services = resolveServiceBindings(list, options.serviceBindings, new Set(blocked.keys()));
  const hardEdges = services.hardEdges.slice();
  for (const a of active) for (const d of deps(a)) if (activeIds.has(d.id)) hardEdges.push([d.id, a.id]);
  const hardOrderIds = kahn(active.map(a => a.id), hardEdges);

  // 5. Final order over the (hard-acyclic) survivors, REFINED by optional-dep
  //    ordering edges where they're satisfiable. If the optional edges would
  //    introduce a cycle, drop them wholesale and keep the hard order — optional
  //    ordering is best-effort and must never block a survivor. When no optional
  //    edges apply, the hard order is returned verbatim (zero behaviour change).
  const survivorIds = hardOrderIds;
  const survSet = new Set(survivorIds);
  const combinedEdges = hardEdges.filter(([from, to]) => survSet.has(from) && survSet.has(to));
  let optAdded = false;
  for (const a of active) {
    if (!survSet.has(a.id)) continue;
    for (const d of optDeps(a)) {
      const dep = byId.get(d.id);
      if (dep && survSet.has(d.id) && !blocked.has(d.id) && satisfies(dep.version, d.range)) {
        combinedEdges.push([d.id, a.id]);
        optAdded = true;
      }
    }
  }
  for (const edge of services.optionalEdges) {
    if (survSet.has(edge[0]) && survSet.has(edge[1])) {
      combinedEdges.push(edge);
      optAdded = true;
    }
  }
  let finalIds = survivorIds;
  if (optAdded) {
    const refined = kahn(survivorIds, combinedEdges);
    finalIds = refined.length < survivorIds.length ? survivorIds : refined;   // optional cycle → keep hard order
  }

  const issueMap = new Map(serviceIssueHistory);
  for (const issue of services.issues) issueMap.set(`${issue.consumerId}::${issue.contract}`, issue);
  return {
    order: finalIds.map(id => byId.get(id)),
    blocked,
    cycles,
    services: { ...services, issues: [...issueMap.values()] },
  };
}
