// ═══════════════════════════════════════════════════════════════
//  I18N — per-user UI language (translation catalogs + Intl helpers)
//
//  All source strings live in English keys; translations are flat JSON
//  catalogs under /i18n/<locale>.json (en = source of truth). Language
//  is PER-USER, stored in localStorage ('codex_lang') — NOT campaign-
//  wide, no server sync, no DM gate (it diverges from the theme system
//  here). Resolution: explicit choice → browser languages (primary
//  subtag match) → English fallback.
//
//  Plurals / dates / relative-time use native Intl.* — zero extra
//  dependencies AND correct CLDR rules (Czech one/few/other; the old
//  hand-rolled czPlural is gone).
//
//  This module imports NOTHING app-side and touches no DOM / navigator
//  at load time, so it's safe to import from Node tests. `t()` returns
//  PLAIN text — callers esc() before innerHTML exactly as they do for
//  plain literals.
// ═══════════════════════════════════════════════════════════════

export const I18n = (() => {
  const LS_KEY = 'codex_lang';

  // Shippable locales. `endonym` = the language's own name, shown
  // verbatim in the switcher (a language is never named in another
  // language). Adding a locale = one row here + one /i18n/<id>.json
  // catalog. `en` is the source of truth + universal fallback.
  const LOCALES = [
    { id: 'en', endonym: 'English' },
    { id: 'cs', endonym: 'Čeština' },
  ];
  const AVAILABLE = LOCALES.map(l => l.id);

  let _active     = 'en';
  const _catalogs = {};          // locale id → flat catalog object
  const _plural   = {};          // locale id → Intl.PluralRules (memoised)
  const _rtf      = {};          // locale id → Intl.RelativeTimeFormat
  const _warned   = new Set();   // dev missing-key warnings, deduped
  let   _rerender = null;        // re-render closure injected by app.js

  // ── Locale detection (pure; explicit args make it DOM-free testable) ─
  /**
   * Resolve the locale to use: an explicit stored choice wins, else the
   * first browser-preferred language whose primary subtag we ship, else
   * English. Both args default to the live browser state when omitted.
   *
   * @param {string[]} [languages] - e.g. navigator.languages.
   * @param {string|null} [stored] - e.g. localStorage 'codex_lang'.
   * @returns {string} An available locale id.
   */
  function detectLocale(languages, stored) {
    if (languages === undefined) {
      try {
        languages = (navigator.languages && navigator.languages.length)
          ? navigator.languages
          : (navigator.language ? [navigator.language] : []);
      } catch (_) { languages = []; }
    }
    if (stored === undefined) {
      try { stored = localStorage.getItem(LS_KEY); } catch (_) { stored = null; }
    }
    if (stored && AVAILABLE.includes(stored)) return stored;
    for (const tag of (languages || [])) {
      const primary = String(tag || '').toLowerCase().split('-')[0];
      if (AVAILABLE.includes(primary)) return primary;
    }
    return 'en';
  }

  // ── Catalog loading ────────────────────────────────────────────
  async function _fetchCatalog(id) {
    const res = await fetch(`/i18n/${id}.json`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`i18n ${id} HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Resolve the active locale, set <html lang>, and load the English
   * fallback catalog plus the active catalog. Awaited once at boot
   * BEFORE the first render so there's no flash of the wrong language.
   * Idempotent — already-loaded catalogs aren't refetched.
   *
   * @returns {Promise<string>} The resolved active locale id.
   */
  async function load() {
    _active = detectLocale();
    applyLocale();
    if (!_catalogs.en) {
      try { _catalogs.en = await _fetchCatalog('en'); }
      catch (e) { console.warn('[i18n] English catalog failed to load', e); }
    }
    if (_active !== 'en' && !_catalogs[_active]) {
      try { _catalogs[_active] = await _fetchCatalog(_active); }
      catch (e) {
        console.warn(`[i18n] '${_active}' catalog failed — falling back to English`, e);
        _active = 'en';
        applyLocale();
      }
    }
    return _active;
  }

  /** Inject a catalog without fetching. Used by tests + optional
   *  pre-loading; the app itself loads via load()/setLocale. */
  function register(id, catalog) { if (id && catalog) _catalogs[id] = catalog; }

  // ── Lookup + interpolation ─────────────────────────────────────
  function _interpolate(str, params) {
    if (params == null) return String(str);
    return String(str).replace(/\{(\w+)\}/g, (m, k) =>
      (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
  }

  function _missing(key) {
    try {
      if (localStorage.getItem('codex_i18n_debug') === '1') {
        if (!_warned.has(key)) { _warned.add(key); console.warn('[i18n] missing key:', key); }
        return `⟦${key}⟧`;
      }
    } catch (_) {}
    return key;
  }

  /**
   * Translate a key. Fallback chain: active locale → English → the key
   * itself (never throws, never blanks the UI). `params` interpolates
   * `{placeholder}` tokens. Returns PLAIN text — caller esc()s before
   * innerHTML.
   *
   * @param {string} key
   * @param {Object<string,*>} [params]
   * @returns {string}
   */
  function t(key, params) {
    let entry = _catalogs[_active] ? _catalogs[_active][key] : undefined;
    if (entry == null) entry = _catalogs.en ? _catalogs.en[key] : undefined;
    if (entry == null) return _missing(key);
    // A plural object reached via t() (no count) — best-effort 'other'.
    if (typeof entry === 'object') entry = entry.other != null ? entry.other : key;
    return _interpolate(entry, params);
  }

  /**
   * Pluralised translation via native Intl.PluralRules. The catalog
   * entry is an object keyed by CLDR categories ({one, few, many,
   * other}). Czech integers resolve to one(1)/few(2-4)/other(0,5+);
   * English to one(1)/other. `n` is auto-supplied to interpolation.
   *
   * @param {string} key
   * @param {number} n
   * @param {Object<string,*>} [params]
   * @returns {string}
   */
  function plural(key, n, params) {
    const rules = _plural[_active] || (_plural[_active] = new Intl.PluralRules(_active));
    const cat = rules.select(Math.abs(Number(n) || 0));
    let obj = _catalogs[_active] ? _catalogs[_active][key] : undefined;
    if (obj == null) obj = _catalogs.en ? _catalogs.en[key] : undefined;
    let tmpl;
    if (obj && typeof obj === 'object') tmpl = obj[cat] != null ? obj[cat] : (obj.other != null ? obj.other : key);
    else if (typeof obj === 'string')  tmpl = obj;
    else                               return _missing(key);
    return _interpolate(tmpl, Object.assign({ n }, params || {}));
  }

  // ── Locale-aware formatting (native Intl) ──────────────────────
  function formatNumber(n, opts) {
    try { return new Intl.NumberFormat(_active, opts).format(n); }
    catch (_) { return String(n); }
  }

  /** Format a date. Accepts a ms timestamp OR a Date-parseable string. */
  function formatDate(value, opts) {
    try { return new Intl.DateTimeFormat(_active, opts).format(new Date(value)); }
    catch (_) { return String(value); }
  }

  /**
   * Relative time ("3 hours ago" / "před 3 hodinami" / "yesterday" /
   * "včera") via Intl.RelativeTimeFormat, falling back to an absolute
   * date past ~10 days. Locale-correct for any language — replaces the
   * Czech-only humanTime body.
   */
  function relativeTime(ms, now = Date.now()) {
    if (!ms || typeof ms !== 'number') return '';
    const rtf = _rtf[_active] || (_rtf[_active] = new Intl.RelativeTimeFormat(_active, { numeric: 'auto' }));
    const diff = Math.max(0, now - ms);
    const sec  = Math.floor(diff / 1000);
    if (sec < 45) return t('time.now');
    const min = Math.floor(sec / 60);
    if (min < 60) return rtf.format(-min, 'minute');
    const hr  = Math.floor(min / 60);
    if (hr < 24) return rtf.format(-hr, 'hour');
    const day = Math.floor(hr / 24);
    if (day < 10) return rtf.format(-day, 'day');
    return formatDate(ms, { day: 'numeric', month: 'numeric', year: 'numeric' });
  }

  // ── Locale application + switching ─────────────────────────────
  /** Set <html lang> to the active locale. Idempotent, DOM-guarded. */
  function applyLocale() {
    if (typeof document === 'undefined') return;
    try { document.documentElement.setAttribute('lang', _active); } catch (_) {}
  }

  /**
   * Translate every `[data-i18n]` textContent + `[data-i18n-title]`
   * title attribute under `root` (default: document). Localises the
   * STATIC index.html chrome (loading text, bottom-nav, map sheet)
   * at boot + after a language switch — JS-rendered UI calls t() inline.
   *
   * @param {Element|Document} [root]
   */
  function hydrate(root) {
    if (typeof document === 'undefined') return;
    const r = root || document;
    // Keep the element's existing (English source) markup when a key is
    // missing — `t()` returns the key on a miss, and overwriting good
    // English HTML with a raw dotted key would look broken (e.g. a failed
    // catalog fetch while the server is down).
    r.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n'); const v = t(k);
      if (v !== k) el.textContent = v;
    });
    r.querySelectorAll('[data-i18n-title]').forEach(el => {
      const k = el.getAttribute('data-i18n-title'); const v = t(k);
      if (v !== k) el.setAttribute('title', v);
    });
  }

  /**
   * Persist + switch the active locale, then re-render. Per-browser
   * (localStorage) — no server sync. Wired to the dashboard dropdown
   * via `data-on-change`. Async because a not-yet-loaded catalog is
   * fetched once. The user's choice is remembered even if the fetch
   * transiently fails (this session degrades to English; next boot
   * retries).
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function setLocale(id) {
    if (!AVAILABLE.includes(id) || id === _active) return;
    try { localStorage.setItem(LS_KEY, id); } catch (_) {}
    if (id !== 'en' && !_catalogs[id]) {
      try { _catalogs[id] = await _fetchCatalog(id); }
      catch (e) { console.warn(`[i18n] '${id}' catalog failed`, e); id = 'en'; }
    }
    _active = id;
    applyLocale();
    if (typeof _rerender === 'function') {
      try { _rerender(); } catch (e) { console.error('[i18n] rerender failed', e); }
    }
  }

  function getLocale()        { return _active; }
  function availableLocales() { return LOCALES.map(l => ({ ...l })); }
  /** app.js injects the closure that re-renders the live UI on switch. */
  function setRerender(fn)    { _rerender = (typeof fn === 'function') ? fn : null; }

  return {
    load, register, t, plural,
    formatNumber, formatDate, relativeTime,
    detectLocale, getLocale, availableLocales,
    setLocale, applyLocale, hydrate, setRerender,
  };
})();
