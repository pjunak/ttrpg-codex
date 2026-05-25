// ═══════════════════════════════════════════════════════════════
//  UTILS — shared helpers used across modules.
//  Single source for HTML/regex escaping, diacritic-insensitive
//  normalisation, debouncing, slug+outline generation, sanitised
//  Markdown rendering, and the [[wiki-link]] resolver hook.
// ═══════════════════════════════════════════════════════════════

/**
 * HTML-escape a value for safe interpolation into a template literal that
 * builds DOM. Handles `&`, `"`, `<`, `>` — use this for any user-supplied
 * text that ends up inside an attribute value or text node.
 *
 * @param {*} s - Anything stringifiable; null/undefined become "".
 * @returns {string} Escaped string safe for direct innerHTML interpolation.
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape a string so it can be embedded literally inside a `RegExp` source.
 *
 * @param {*} s - Anything stringifiable.
 * @returns {string} Source string with every regex metacharacter backslashed.
 */
export function escapeRe(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lowercase + strip diacritics. Used for every diacritic-insensitive search
 * and chip-filter match (e.g. typing "kresava" matches "Křesava").
 *
 * @param {*} s - Anything stringifiable.
 * @returns {string} Lowercased, NFD-normalised, combining-marks-removed.
 */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Jaro\u2013Winkler string similarity, scaled to 0..1 (1 = identical).
 *
 * Standard short-string fuzzy-matching metric \u2014 favours strings that
 * share characters in close positions and gives a small prefix bonus
 * (so "Frulam" matches "Frulam Mondath" more strongly than "Mondath
 * Frulam"). Used by the DM twin picker to rank candidate entities by
 * name similarity.
 *
 * Both inputs are normalised first via `norm()` (lowercase + diacritic
 * strip) so "K\u0159esava" and "kresava" score 1.0.
 *
 * @param {*} a - Any stringifiable value.
 * @param {*} b - Any stringifiable value.
 * @returns {number} Score in [0, 1]; 0 when either input is empty
 *                   (after normalisation), 1 when equal.
 */
export function jaroWinkler(a, b) {
  const s1 = norm(a);
  const s2 = norm(b);
  if (!s1 || !s2)   return 0;
  if (s1 === s2)    return 1;

  // Jaro: count "matching" characters (same char within a window of
  // floor(max(|s1|,|s2|)/2) - 1 positions) and "transpositions".
  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end   = Math.min(i + matchWindow + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j])          continue;
      if (s1[i] !== s2[j])       continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions: half the number of matched chars that
  // appear in a different order between s1 and s2.
  let t = 0, k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / s1.length + m / s2.length + (m - t / 2) / m) / 3;

  // Winkler prefix bonus: up to 4 leading matching characters,
  // scaled by 0.1 per char. Boosts names that share a prefix.
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Trailing-edge debounce. Wraps `fn` so rapid consecutive calls collapse
 * into one invocation `ms` milliseconds after the last call.
 *
 * @param {Function} fn - The function to debounce.
 * @param {number} [ms=120] - Quiet-time before the wrapped call fires.
 * @returns {Function} A debounced wrapper preserving `this` and arguments.
 */
export function debounce(fn, ms = 120) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/** Czech relative-time formatter. Input: timestamp ms (typically from
 *  `entity.updatedAt`). Output short, human strings for recent times,
 *  falling back to an absolute date for anything older than ~10 days.
 *
 *    just now (< 1 min)   → "teď"
 *    minutes  (< 60 min)  → "před N minutami"
 *    hours    (< 24 h)    → "před N hodinami"
 *    days     (< 10 d)    → "před N dny" / "včera"
 *    older                → "12. 3. 2026"                    */
export function humanTime(ms, now = Date.now()) {
  if (!ms || typeof ms !== 'number') return '';
  const diff = Math.max(0, now - ms);
  const sec  = Math.floor(diff / 1000);
  if (sec < 45) return 'teď';
  const min  = Math.floor(sec / 60);
  if (min < 60) return `před ${min} ${min === 1 ? 'minutou' : min < 5 ? 'minutami' : 'minutami'}`;
  const hr   = Math.floor(min / 60);
  if (hr < 24) return `před ${hr} ${hr === 1 ? 'hodinou' : hr < 5 ? 'hodinami' : 'hodinami'}`;
  const day  = Math.floor(hr / 24);
  if (day === 1) return 'včera';
  if (day < 10) return `před ${day} dny`;
  // Absolute date for anything older (Czech short form D. M. YYYY).
  const d = new Date(ms);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}

/** Diacritic-insensitive slug. Used to build stable heading IDs for
 *  the article outline (TOC) so anchor links survive small edits
 *  as long as the human-readable heading text is unchanged.        */
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

/** Scan raw markdown for ATX headings (# .. ###) and return an
 *  array of { level, text, slug } entries. Heading IDs in the
 *  rendered HTML match these slugs, so anchors link up cleanly.
 *  Duplicate-text headings get `-2`, `-3`, … suffixes — same algorithm
 *  as `renderMarkdown`'s post-process so the outline links resolve. */
export function extractOutline(src) {
  const text = String(src ?? '');
  if (!text) return [];
  const out  = [];
  const seen = new Map();
  for (const line of text.split('\n')) {
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const headText = m[2].trim();
    const base     = slugify(headText);
    const n        = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.push({
      level: m[1].length,
      text:  headText,
      slug:  n === 1 ? base : `${base}-${n}`,
    });
  }
  return out;
}

// ─ Wiki-link resolver ────────────────────────────────────────────
// The resolver function is injected from `app.js` at init time so this
// module stays free of `Store` imports and remains trivially testable.
let _wikiResolver = null;

/**
 * Register the function that resolves a `[[Name]]` token to an entity.
 * Called once from `app.js` during boot. The resolver receives
 * `(label, hint)` and must return `{kind, id}` or `null`.
 *
 * @param {(label: string, hint: string) => ({kind: string, id: string} | null)} fn
 */
export function setWikiLinkResolver(fn) { _wikiResolver = fn; }

/**
 * Rewrite `[[Name]]` and `[[Name|hint]]` tokens inside `src` into real
 * markdown links (`[label](#/kind/id)`) before `marked` parses them.
 * Unresolved tokens render as a visibly-broken span the GM can fix.
 *
 * @param {*} src - Markdown source possibly containing wiki-link tokens.
 * @returns {string} Source with tokens rewritten in place.
 */
export function expandWikiLinks(src) {
  const text = String(src ?? '');
  if (!text || !_wikiResolver) return text;
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, label, hint) => {
    const match = _wikiResolver(label.trim(), hint ? hint.trim() : '');
    if (!match) return `<span class="wlink-missing" title="Nenalezeno">[[${label}]]</span>`;
    return `[${label}](#/${match.kind}/${match.id})`;
  });
}

/**
 * Render Markdown to sanitized HTML for long-description fields.
 * Uses vendored marked + DOMPurify (loaded globally from index.html).
 * Falls back to escaped + <br>-joined text if libs aren't loaded yet.
 *
 * Post-processes the output to add `id` attributes onto h1..h6
 * elements (matching `slugify(heading)`), so the sidebar outline
 * links can jump to sections.
 *
 * Pipes the source through `expandWikiLinks` first so `[[Name]]`
 * syntax becomes a real link before marked parses it.
 *
 * Output is memoised in a small LRU keyed by the source markdown.
 * Since the wiki-link resolver depends on the entity dataset, the
 * cache must be cleared whenever entities change — `Store.load`
 * (and the SSE refresh path) call `clearMarkdownCache()` for that.
 */
const _mdCache    = new Map();
const _MD_CACHE_MAX = 50;

/**
 * Drop every entry from the markdown render cache. Call whenever entity
 * data changes — wiki-link resolution depends on the entity dataset, so
 * cached HTML can reference stale targets after a rename or creation.
 * `Store.load()` and the SSE refresh path call this automatically.
 */
export function clearMarkdownCache() { _mdCache.clear(); }

export function renderMarkdown(src) {
  const raw = String(src ?? '');
  if (!raw.trim()) return '';
  if (_mdCache.has(raw)) {
    // Move-to-end so the most-recently-used stays warmest.
    const v = _mdCache.get(raw);
    _mdCache.delete(raw);
    _mdCache.set(raw, v);
    return v;
  }
  // Expand [[Name]] / [[Name|kind:id]] into real markdown links first,
  // then let marked parse the rest. The DM-twin model replaced the
  // [secret] inline markers; markdown body fields are now plain prose
  // again (any DM-only lore lives in a linked DM-only twin entity).
  const text = expandWikiLinks(raw);
  const marked  = window.marked;
  const purify  = window.DOMPurify;
  if (!marked || !purify) {
    return esc(text).replace(/\n/g, '<br>');
  }
  const html = typeof marked.parse === 'function'
    ? marked.parse(text, { breaks: true, gfm: true })
    : marked(text, { breaks: true, gfm: true });
  // `id` is intentionally NOT in ADD_ATTR — author-supplied IDs from
  // markdown are stripped by sanitize, then the post-process below
  // assigns predictable slug-derived IDs that match `extractOutline`.
  const sanitized = purify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
  });
  if (typeof document === 'undefined') return sanitized;
  const tmp = document.createElement('div');
  tmp.innerHTML = sanitized;
  // Disambiguate duplicate slugs with -2, -3, … so each heading is
  // reachable via its own anchor. Mirror this exact algorithm in
  // `extractOutline` so the TOC links match the rendered IDs.
  const seen = new Map();
  tmp.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    if (h.id) {
      seen.set(h.id, (seen.get(h.id) || 0) + 1);
      return;
    }
    const base = slugify(h.textContent || '');
    if (!base) return;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    h.id = n === 1 ? base : `${base}-${n}`;
  });
  const finalHtml = tmp.innerHTML;
  // Cache + LRU evict.
  _mdCache.set(raw, finalHtml);
  while (_mdCache.size > _MD_CACHE_MAX) {
    _mdCache.delete(_mdCache.keys().next().value);
  }
  return finalHtml;
}

/** Build the attribute string for the click dispatcher in app.js.
 *  Replaces inline `onclick="Module.method('arg', …)"`. Output starts
 *  with a leading space so it can be dropped straight into a tag
 *  template literal: ``<button${dataAction('Wiki.foo', id)}>``.
 *  Args round-trip via JSON, so strings with quotes / objects / numbers
 *  all work — the dispatcher in app.js does the matching `JSON.parse`.
 *  Two sentinels are special-cased by the dispatcher:
 *    `'$el'`  — replaced with the element that carries the attribute,
 *    `'$ev'`  — replaced with the original Event object. */
export function dataAction(method, ...args) {
  const argAttr = args.length ? ` data-args='${esc(JSON.stringify(args))}'` : '';
  return ` data-action="${esc(method)}"${argAttr}`;
}

/** Same shape for non-click events. `kind` is one of `submit`, `change`,
 *  `input`. The dispatcher reads `data-on-<kind>` + `data-<kind>-args`. */
export function dataOn(kind, method, ...args) {
  const argAttr = args.length ? ` data-${kind}-args='${esc(JSON.stringify(args))}'` : '';
  return ` data-on-${kind}="${esc(method)}"${argAttr}`;
}

/**
 * Shared edit-toggle button for modal-interaction pages (map, timeline,
 * cloudmap). Renders a unified pill that flips between "✏ Editovat X"
 * and "✓ Hotovo" with the same colour scheme + position across pages.
 *
 * The button calls `${moduleName}.toggleEditing` with no args — each
 * module's toggleEditing reads its own `_editing` flag and flips. This
 * avoids the "stale data-args" bug where a setEditing(true) button can
 * only ever be clicked once (the data-args=[true] never updates).
 *
 * @param {object} opts
 * @param {string} opts.moduleName  - The ACTIONS-map key (e.g. 'WorldMap').
 * @param {boolean} opts.isEditing  - Current edit state.
 * @param {string} opts.label       - Localised noun for the page (e.g. 'mapu').
 * @returns {string} HTML
 */
export function pageEditToggle({ moduleName, isEditing, label }) {
  const cls = 'page-edit-toggle' + (isEditing ? ' is-active' : '');
  const title = isEditing ? 'Vypnout úpravy' : `Zapnout úpravy — ${label}`;
  const text  = isEditing ? '✓ Hotovo' : `✏ Editovat ${label}`;
  return `<button type="button" class="${cls}"${dataAction(moduleName + '.toggleEditing')}
    title="${esc(title)}">${esc(text)}</button>`;
}
