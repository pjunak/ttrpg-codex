// ═══════════════════════════════════════════════════════════════
//  UTILS — shared helpers used across modules.
//  Single source for HTML/regex escaping, diacritic-insensitive
//  normalisation, debouncing, slug+outline generation, sanitised
//  Markdown rendering, and the [[wiki-link]] resolver hook.
// ═══════════════════════════════════════════════════════════════

// One-way edge: utils → i18n (i18n imports nothing app-side, so no
// cycle). Used only by the humanTime shim below.
import { I18n } from './i18n.js';

/**
 * HTML-escape a value for safe interpolation into a template literal that
 * builds DOM. Handles `&`, `"`, `'`, `<`, `>` — use this for any
 * user-supplied text that ends up inside an attribute value or text node.
 * The `'` escape matters because `dataAction`/`dataOn` emit their JSON
 * args inside SINGLE-quoted attributes — without it an apostrophe in an
 * arg ("Baldur's Gate") terminates the attribute (dead button at best,
 * attribute injection at worst).
 *
 * @param {*} s - Anything stringifiable; null/undefined become "".
 * @returns {string} Escaped string safe for direct innerHTML interpolation.
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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

/** Locale-aware relative-time formatter (thin shim over
 *  `I18n.relativeTime`, which uses native Intl.RelativeTimeFormat). Kept
 *  here so the many `humanTime(ms)` call sites don't all change their
 *  import. Input: timestamp ms (typically `entity.updatedAt`). Output:
 *  "now"/"3 hours ago"/"yesterday" — or "před 3 hodinami"/"včera" etc.
 *  in the active locale — with an absolute date past ~10 days. */
export function humanTime(ms, now = Date.now()) {
  return I18n.relativeTime(ms, now);
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
  // Localised via I18n (utils already imports it — no cycle). `{label}`
  // is the page noun ("the map", "the timeline", …) supplied by the caller.
  const title = isEditing
    ? I18n.t('action.editStopTitle')
    : I18n.t('action.editStartTitle', { label });
  const text  = isEditing
    ? I18n.t('action.editDone')
    : I18n.t('action.editStart', { label });
  return `<button type="button" class="${cls}"${dataAction(moduleName + '.toggleEditing')}
    title="${esc(title)}">${esc(text)}</button>`;
}

/**
 * Horizontal breadcrumb nav from ordered crumbs `[{label, href?}]` —
 * wayfinding, not history: list root → ancestors → current page. Every
 * crumb but the last links; the last always renders as the current page
 * (its `href` is ignored — a breadcrumb never links to itself). Returns
 * '' for fewer than 2 crumbs (nothing to walk back to). Separators are
 * decorative `›` spans (aria-hidden); styling in wiki.css, docking into
 * the article shell's top-left gutter in edit.css.
 *
 * Shared by the wiki article shell and by addon pages via the host
 * facade's `h.breadcrumb` (addons.js).
 *
 * @param {Array<{label: string, href?: string}>} crumbs
 * @returns {string} HTML, or '' when there is no trail to show.
 */
export function breadcrumbNav(crumbs) {
  const list = (crumbs || []).filter(c => c && c.label);
  if (list.length < 2) return '';
  const rows = list.map((c, i) => {
    const sep = i ? '<span class="bc-sep" aria-hidden="true">›</span>' : '';
    const label = (i === list.length - 1 || !c.href)
      ? `<span class="bc-current"${i === list.length - 1 ? ' aria-current="page"' : ''}>${esc(c.label)}</span>`
      : `<a class="bc-crumb" href="${esc(c.href)}">${esc(c.label)}</a>`;
    return `<li class="bc-row">${sep}${label}</li>`;
  }).join('');
  return `<nav class="wiki-breadcrumb" aria-label="${esc(I18n.t('wiki.breadcrumbLabel'))}"><ol>${rows}</ol></nav>`;
}

// The shared stat-glyph set for iconGlyph — named for the DRAWING, not a
// game stat, so any system addon can map its own concepts onto them
// (D&D: hp→heart, ac→shield, initiative→bolt, speed→chevrons,
// proficiency→medal, passive senses→eye). 24×24 stroke paths;
// stroke styling lives on .codex-icon (widgets.css).
const ICON_GLYPHS = {
  heart:         '<path d="M12 20.3C12 20.3 4.2 14.8 4.2 9 4.2 6.3 6.2 4.4 8.5 4.4 10.1 4.4 11.4 5.4 12 6.7 12.6 5.4 13.9 4.4 15.5 4.4 17.8 4.4 19.8 6.3 19.8 9 19.8 14.8 12 20.3 12 20.3Z"/>',
  shield:        '<path d="M12 2.6 19 5.3V11C19 15.6 16 19.4 12 21.4 8 19.4 5 15.6 5 11V5.3Z"/>',
  bolt:          '<path d="M13 2.5 6 13.5H11L10.5 21.5 18 9.5H12.5Z"/>',
  chevrons:      '<path d="M5 6.5 11 12 5 17.5"/><path d="M12 6.5 18 12 12 17.5"/>',
  medal:         '<circle cx="12" cy="9.6" r="5.4"/><path d="M9.3 14.2 7.6 21 12 18.5 16.4 21 14.7 14.2"/>',
  'plus-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8V16.2M7.8 12H16.2"/>',
  eye:           '<path d="M2.6 12C6.5 6.6 17.5 6.6 21.4 12 17.5 17.4 6.5 17.4 2.6 12Z"/><circle cx="12" cy="12" r="2.6"/>',
};

/**
 * Small inline-SVG stat glyph (`.codex-icon`, 17px by default) for labelling
 * stat tiles / vitals. stroke:currentColor, so it inherits the surrounding
 * text colour. Decorative by default (aria-hidden); pass `opts.label` to make
 * it meaningful on its own (role="img" + aria-label). Unknown names return ''
 * so callers can pass through unchecked.
 *
 * Shared by addon stat tiles via the host facade's `h.icon` (addons.js);
 * the addon test harness mirrors it (keep the two in sync).
 *
 * @param {string} name  one of: heart, shield, bolt, chevrons, medal, plus-circle, eye
 * @param {{size?: number, label?: string}} [opts]
 * @returns {string} SVG markup, or '' for an unknown glyph name.
 */
export function iconGlyph(name, opts = {}) {
  const path = ICON_GLYPHS[name];
  if (!path) return '';
  const size = Number(opts.size) > 0 ? Number(opts.size) : 17;
  const aria = opts.label ? `role="img" aria-label="${esc(opts.label)}"` : 'aria-hidden="true"';
  return `<svg class="codex-icon" viewBox="0 0 24 24" width="${size}" height="${size}" ${aria}>${path}</svg>`;
}

/**
 * Trap keyboard focus inside a modal panel. While active, Tab / Shift+Tab
 * cycle only through the panel's focusable elements, and focus is restored
 * to whatever was focused before the modal opened when the trap is released.
 *
 * Returns a `release()` function — call it when closing the modal. The
 * caller still owns Escape / backdrop-click handling; this only manages
 * the Tab cycle + focus restore so every modal behaves consistently for
 * keyboard + screen-reader users.
 *
 * @param {HTMLElement} panelEl - The dialog panel (not the backdrop).
 * @returns {() => void} release function (idempotent).
 */
export function trapFocus(panelEl) {
  if (!panelEl || typeof document === 'undefined') return () => {};
  const prevFocused = document.activeElement;
  const SELECTOR = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const focusables = () =>
    Array.from(panelEl.querySelectorAll(SELECTOR))
      .filter(el => el.offsetParent !== null || el === document.activeElement);
  function onKey(e) {
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last  = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panelEl.contains(active)) {
        e.preventDefault(); last.focus();
      }
    } else if (active === last || !panelEl.contains(active)) {
      e.preventDefault(); first.focus();
    }
  }
  panelEl.addEventListener('keydown', onKey);
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    panelEl.removeEventListener('keydown', onKey);
    try { if (prevFocused && prevFocused.focus) prevFocused.focus(); } catch (_) {}
  };
}
