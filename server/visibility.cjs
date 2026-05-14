'use strict';

// ═══════════════════════════════════════════════════════════════
//  VISIBILITY — server-side role-aware filtering of the dataset.
//
//  Players literally cannot see DM content via DevTools because the
//  filtering happens BEFORE the bytes ever leave the server. The
//  three layers:
//
//    1. Entity-level   — `visibility: 'public' | 'dm'`. DM-only
//                        entities are dropped from non-DM payloads
//                        entirely.
//    2. Per-field      — `secrets: { fieldName: true }`. Listed
//                        fields are deleted from the clone before
//                        send (scoped to long-form content fields).
//    3. Inline markers — `[secret]…[/secret]` (and `[public]…[/public]`
//                        as the inverse for DM-only entities) inside
//                        markdown body fields. Stripped via a small
//                        state-machine tokenizer; mismatched markers
//                        are treated as literal text.
//
//  Pure functions. No `fs`, no globals, no module-level state. Easy
//  to unit-test (see test/visibility.test.cjs).
// ═══════════════════════════════════════════════════════════════

// Markdown fields that should be scanned for [secret]/[public]
// markers. Co-located with `ALLOWED_TYPES` in server.js. Adding a
// new markdown body field anywhere in the codebase REQUIRES adding
// it here too — otherwise the marker prose leaks through to player
// payloads. test/visibility.test.cjs has a smoke test that fails
// loudly if a known field is missing from this list.
const MARKDOWN_FIELDS = {
  characters:       ['description'],
  locations:        ['description', 'notes'],
  events:           ['description', 'short'],
  mysteries:        ['description'],
  factions:         ['description'],
  species:          ['description'],
  pantheon:         ['description'],
  artifacts:        ['description'],
  historicalEvents: ['summary', 'body'],
};

// Collections that participate in the visibility model. Everything
// else (settings, deletedDefaults, campaign) is inherently shared
// and bypasses filterForRole.
const VISIBILITY_BEARING = new Set([
  'characters', 'relationships', 'locations', 'events',
  'mysteries', 'factions', 'species', 'pantheon', 'artifacts',
  'historicalEvents',
]);

// Keyed-object collections among the visibility-bearing set.
const KEYED_OBJ_VISIBILITY = new Set(['factions']);

// ── Marker tokenizer ──────────────────────────────────────────────
// Scans for `[secret]` / `[/secret]` / `[public]` / `[/public]` as
// LITERAL tokens (case-sensitive). Mismatched markers (open without
// close, stray close) pass through as literal text — no destruction
// on malformed input. Idempotent: running the player strip twice is
// the same as running it once.
//
// For role==='dm': pass-through (DM should see everything; marker
// rendering on the client side wraps the spans with a visible class).
// For role!=='dm': strip [secret]…[/secret] regions entirely; emit
// the inner content of [public]…[/public] regions as plain text
// (the markers themselves are dropped).

const TOK_RE = /\[(\/?)(secret|public)\]/g;

function stripMarkdownMarkers(text, role) {
  if (role === 'dm') return text;
  if (typeof text !== 'string' || !text) return text;
  // Fast path: no marker tokens at all.
  if (text.indexOf('[secret]') === -1 && text.indexOf('[public]') === -1 &&
      text.indexOf('[/secret]') === -1 && text.indexOf('[/public]') === -1) {
    return text;
  }
  // Walk tokens, build output. Track a stack of open kinds so nested
  // markers behave naturally (e.g. [secret]…[public]X[/public]…[/secret]
  // hides everything outside the [public] island).
  const tokens = [];
  let m, lastIdx = 0;
  while ((m = TOK_RE.exec(text)) !== null) {
    if (m.index > lastIdx) tokens.push({ kind: 'text', value: text.slice(lastIdx, m.index) });
    tokens.push({ kind: m[1] === '/' ? 'close' : 'open', name: m[2], raw: m[0], index: m.index });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) tokens.push({ kind: 'text', value: text.slice(lastIdx) });

  // Build a balanced-region map by pairing each open with its matching
  // close. Unpaired tokens fall back to literal text.
  const stack = []; // entries: index into `tokens`
  const pair  = new Map(); // openTokenIdx → closeTokenIdx
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'open') {
      stack.push(i);
    } else if (t.kind === 'close') {
      // Find the nearest open of the same name on the stack. If the
      // top of the stack matches, that's the natural pair. If not,
      // search down — outer mismatched opens become literal.
      let matchedOpenIdx = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        if (tokens[stack[j]].name === t.name) { matchedOpenIdx = j; break; }
      }
      if (matchedOpenIdx >= 0) {
        // Everything above the matched open is unbalanced — those
        // markers will be emitted as literal.
        pair.set(stack[matchedOpenIdx], i);
        stack.splice(matchedOpenIdx);
      }
      // else: unmatched close → literal
    }
  }

  // Now emit. Maintain a "visible" stack tracking whether we're
  // currently inside a [secret] (hidden for non-DM) or [public]
  // (visible) region. The outermost frame's default is `visible`.
  let out = '';
  const visStack = [true]; // top = currently visible?
  const peek = () => visStack[visStack.length - 1];
  // Track which open tokens were successfully paired (so we know
  // whether to push/pop visibility state vs emit literal).
  const pairedOpens = new Set(pair.keys());
  const pairedCloses = new Set(pair.values());

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'text') {
      if (peek()) out += t.value;
      continue;
    }
    if (t.kind === 'open') {
      if (!pairedOpens.has(i)) {
        // Unpaired open → literal
        if (peek()) out += t.raw;
        continue;
      }
      // Entering a [secret] region → hidden for non-DM; entering a
      // [public] region → visible (override the surrounding context).
      const nextVis = t.name === 'secret' ? false : true;
      // Don't emit the marker text itself.
      visStack.push(nextVis);
      continue;
    }
    if (t.kind === 'close') {
      if (!pairedCloses.has(i)) {
        // Unpaired close → literal
        if (peek()) out += t.raw;
        continue;
      }
      visStack.pop();
      continue;
    }
  }
  return out;
}

// ── Per-entity strip ──────────────────────────────────────────────
// Deletes fields listed `true` in `entity.secrets` for non-DM viewers,
// then applies marker stripping to known markdown fields. Returns a
// shallow clone so the caller can keep mutating the result safely.
function stripSecretsFromEntity(entity, collectionName, role) {
  if (!entity || typeof entity !== 'object') return entity;
  if (role === 'dm') {
    // DM still gets markers passed through (the client wraps them
    // in visible spans). No-op clone for simplicity.
    return entity;
  }
  const out = { ...entity };
  const secrets = out.secrets;
  if (secrets && typeof secrets === 'object') {
    for (const [field, hidden] of Object.entries(secrets)) {
      if (hidden && field !== 'secrets' && field !== 'visibility' && field !== 'id') {
        delete out[field];
      }
    }
  }
  const mdFields = MARKDOWN_FIELDS[collectionName] || [];
  for (const f of mdFields) {
    if (typeof out[f] === 'string') {
      out[f] = stripMarkdownMarkers(out[f], role);
    }
  }
  return out;
}

// ── Container-level filter ────────────────────────────────────────
// Drops DM-only entities, then runs each remaining entity through
// the per-entity strip. Handles both list-shape (array) and keyed-
// object collections. Non-visibility-bearing collections fall
// through unmodified.
function filterForRole(collectionName, container, role) {
  if (role === 'dm') return container;
  if (!VISIBILITY_BEARING.has(collectionName)) return container;
  if (Array.isArray(container)) {
    const out = [];
    for (const e of container) {
      if (!e || typeof e !== 'object') continue;
      if (e.visibility === 'dm') continue;
      out.push(stripSecretsFromEntity(e, collectionName, role));
    }
    return out;
  }
  if (container && typeof container === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(container)) {
      if (!v || typeof v !== 'object') { out[k] = v; continue; }
      if (v.visibility === 'dm') continue;
      out[k] = stripSecretsFromEntity(v, collectionName, role);
    }
    return out;
  }
  return container;
}

module.exports = {
  MARKDOWN_FIELDS,
  VISIBILITY_BEARING,
  KEYED_OBJ_VISIBILITY,
  filterForRole,
  stripSecretsFromEntity,
  stripMarkdownMarkers,
};
