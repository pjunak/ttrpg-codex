// ═══════════════════════════════════════════════════════════════
//  ADDON FRAGMENTS — pure slot/fragment override engine (Phase 6).
//
//  A rendered surface (e.g. a character article's main column) is
//  decomposed into an ordered list of NAMED fragments `[{id, html}]`.
//  Addons register "claims" against fragment ids:
//    • replace — substitute a fragment's html        (EXCLUSIVE per target)
//    • hide    — drop a fragment                       (EXCLUSIVE per target)
//    • wrap    — wrap the current html                 (STACKABLE, ordered)
//    • insert  — add a sibling before/after a fragment (ADDITIVE)
//
//  The whole point is to NEVER fail silently when two addons fight over
//  the same fragment:
//    • 0 exclusive claims → built-in renders.
//    • 1 exclusive claim  → it wins (recorded so the UI can show it).
//    • ≥2 exclusive claims, unresolved → CONFLICT: apply NONE, render the
//      built-in (safe default), and report the conflict so the DM resolves it.
//    • resolved (DM picked a winner via `resolutions[target]`) → that addon
//      wins; `null` forces the built-in.
//    • a claim whose target fragment doesn't exist → reported as `unmatched`
//      (never a silent no-op — the host surfaces it as an addon error).
//
//  This module is PURE: no DOM, no window, no Store. The host (addons.js)
//  feeds it the fragment list, the claims, the resolutions map, and a ctx;
//  render functions are plain `(html, ctx) => string`. That keeps the hard
//  part (conflict arbitration) unit-testable in isolation, mirroring
//  addon-deps.js.
// ═══════════════════════════════════════════════════════════════

const EXCLUSIVE = new Set(['replace', 'hide']);

/**
 * Apply fragment-override claims to an ordered fragment list.
 *
 * @param {Array<{id:string, html:string}>} fragments  ordered surface fragments
 * @param {Array<{addonId, target, op, render?, order?, position?}>} claims
 * @param {Object<string, string|null>} resolutions  target → winner addonId | null
 * @param {object} [ctx]  passed (with `target` added) to every render fn
 * @returns {{ fragments: Array, conflicts: Array, unmatched: Array, failures: Array }}
 */
export function applyFragmentOps(fragments, claims, resolutions, ctx) {
  resolutions = resolutions || {};
  const baseCtx = ctx || {};
  let list = Array.isArray(fragments) ? fragments.map(f => ({ ...f })) : [];
  const conflicts = [];
  const unmatched = [];
  const failures  = [];
  if (!Array.isArray(claims) || !claims.length) {
    return { fragments: list, conflicts, unmatched, failures };
  }

  const ids = new Set(list.map(f => f.id));

  // Claims whose target fragment isn't present in this surface — never a
  // silent no-op; the host turns these into a visible addon error.
  for (const c of claims) {
    if (!ids.has(c.target)) unmatched.push({ addonId: c.addonId, target: c.target, op: c.op });
  }

  // Index present-target claims.
  const byTarget = new Map();
  for (const c of claims) {
    if (!ids.has(c.target)) continue;
    if (!byTarget.has(c.target)) byTarget.set(c.target, []);
    byTarget.get(c.target).push(c);
  }

  // Call a claim's render with error isolation: a throw degrades to the
  // current html (built-in) and is collected so the host can surface it.
  function render(claim, html, target) {
    if (typeof claim.render !== 'function') return html;
    try {
      const out = claim.render(html, { ...baseCtx, target });
      return (typeof out === 'string') ? out : html;
    } catch (e) {
      failures.push({ addonId: claim.addonId, target, op: claim.op, message: e && e.message });
      return html;
    }
  }

  // 1. Per-fragment: resolve the exclusive op (replace/hide), then stack wraps.
  list = list.map(f => {
    const cs = byTarget.get(f.id);
    if (!cs) return f;
    // Collapse a SINGLE addon's multiple exclusive claims on one target — that's
    // an authoring error (replace+hide on the same fragment), surfaced as a
    // failure, NOT a cross-addon conflict ("addon a vs addon a" can't be
    // resolved). After this, `exclusives` holds at most one claim per addon, so
    // a genuine conflict means ≥2 DISTINCT addons.
    const exByAddon = new Map();
    for (const c of cs.filter(c => EXCLUSIVE.has(c.op))) {
      if (exByAddon.has(c.addonId)) failures.push({ addonId: c.addonId, target: f.id, op: c.op, message: 'více výlučných operací na stejný fragment' });
      else exByAddon.set(c.addonId, c);
    }
    const exclusives = [...exByAddon.values()];
    // Wraps stack deterministically: by `order`, then addonId (matches inserts)
    // so two addons wrapping at the same order get a stable, author-controllable
    // nesting rather than one that depends on load order.
    const wraps = cs.filter(c => c.op === 'wrap').slice()
      .sort((a, b) => ((a.order || 0) - (b.order || 0)) || (a.addonId < b.addonId ? -1 : a.addonId > b.addonId ? 1 : 0));
    let html = f.html;

    if (exclusives.length) {
      const hasRes = Object.prototype.hasOwnProperty.call(resolutions, f.id);
      let winner = null;
      if (hasRes) {
        const wid = resolutions[f.id];
        winner = (wid === null) ? null : (exclusives.find(c => c.addonId === wid) || null);
      } else if (exclusives.length === 1) {
        winner = exclusives[0];
      } else {
        // ≥2 exclusive claims, unresolved → conflict; keep built-in.
        conflicts.push({ target: f.id, claimants: exclusives.map(c => ({ addonId: c.addonId, op: c.op })) });
        winner = null;
      }
      if (winner) html = (winner.op === 'hide') ? '' : render(winner, f.html, f.id);
      // winner === null → built-in html stands.
    }

    // Wraps stack around whatever survived (skip when hidden — nothing to wrap).
    for (const w of wraps) {
      if (html === '') break;
      html = render(w, html, f.id);
    }
    return { ...f, html };
  });

  // 2. Inserts: splice sibling fragments at the anchor. An insert whose render
  //    yields no html is skipped (an empty fragment shouldn't occupy a slot).
  const inserts = [];
  for (const c of claims) {
    if (c.op !== 'insert' || !ids.has(c.target)) continue;
    const idx = list.findIndex(f => f.id === c.target);
    if (idx < 0) continue;
    // An insert with no render fn is a malformed claim (nothing to add) —
    // surface it rather than dropping it silently.
    if (typeof c.render !== 'function') {
      failures.push({ addonId: c.addonId, target: c.target, op: 'insert', message: 'insert bez render funkce' });
      continue;
    }
    const html = render(c, '', c.target);
    if (typeof html !== 'string' || html === '') continue;
    inserts.push({ at: c.position === 'before' ? idx : idx + 1, order: c.order || 0, addonId: c.addonId, frag: { id: `insert:${c.addonId}:${c.target}`, html } });
  }
  // Splice from the end (so earlier indices stay valid). DETERMINISTIC tiebreak
  // among inserts at the same anchor: by `order`, then addonId — so two addons
  // inserting at the same spot get a stable, author-controllable sequence.
  inserts
    .sort((a, b) => (b.at - a.at) || (b.order - a.order) || (b.addonId < a.addonId ? -1 : b.addonId > a.addonId ? 1 : 0))
    .forEach(ins => list.splice(ins.at, 0, ins.frag));

  return { fragments: list, conflicts, unmatched, failures };
}

/**
 * Eager conflict report from claims alone (independent of any rendered
 * surface) — the Addon Manager's "Konflikty" source. A conflict is ≥2
 * EXCLUSIVE claims on one target. `resolved` is the winner addonId, `null`
 * (forced built-in), or `undefined` (unresolved).
 *
 * @param {Array} claims
 * @param {Object<string,string|null>} resolutions
 * @returns {Array<{target, claimants:Array<{addonId,op}>, resolved}>}
 */
export function listConflicts(claims, resolutions) {
  resolutions = resolutions || {};
  const byTarget = new Map();
  for (const c of (claims || [])) {
    if (!EXCLUSIVE.has(c.op)) continue;
    if (!byTarget.has(c.target)) byTarget.set(c.target, []);
    byTarget.get(c.target).push(c);
  }
  const out = [];
  for (const [target, cs] of byTarget) {
    // Count DISTINCT addons — one addon's own duplicate exclusive claims aren't
    // a conflict (applyFragmentOps surfaces those as a failure instead).
    const byAddon = new Map();
    for (const c of cs) if (!byAddon.has(c.addonId)) byAddon.set(c.addonId, c);
    if (byAddon.size < 2) continue;
    out.push({
      target,
      claimants: [...byAddon.values()].map(c => ({ addonId: c.addonId, op: c.op })),
      resolved: Object.prototype.hasOwnProperty.call(resolutions, target) ? resolutions[target] : undefined,
    });
  }
  return out;
}
