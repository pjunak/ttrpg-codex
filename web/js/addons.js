// ═══════════════════════════════════════════════════════════════
//  ADDONS — client-side host ("CodexHost").
//
//  Loads enabled addons that the server has laid down under the
//  same-origin path /addons/<id>/<hash>/ (so the page can stay
//  CSP-clean — no remote script origins). Each addon's entry module
//  default-exports `register(host)`; the host hands it a scoped facade
//  and the addon calls back to register routes, sidebar pages, etc.
//
//  Failure isolation is the rule: a throwing addon (at import or at
//  register) is caught, marked `error`, and SKIPPED — boot still
//  completes and every other addon still loads. There are NO window.*
//  exports in this app, so an imported addon gets *nothing* except the
//  `host` we pass it — that's the real boundary the permission model
//  (later phase) tightens.
//
//  Phase 1 surface: registerRoute + registerSidebarPage, a read-only
//  store facade, and the shared template helpers. Page renderers,
//  settings tabs, article sections, fragment overrides, permissions
//  and server-side addons arrive in later phases.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { Role } from './role.js';
import { esc, dataAction, dataOn, renderMarkdown, slugify } from './utils.js';

export const Addons = (() => {
  const HOST_API_VERSION = 1;

  // Top-level route segments owned by core `navigate()` — an addon may
  // never shadow one of these (kept in sync with app.js's switch + the
  // early-return sections). Guards against an addon hijacking, say, the
  // character pages by registering the `postava` segment.
  const BUILTIN_SECTIONS = new Set([
    '', 'dashboard', 'parta', 'postavy', 'postava', 'mista', 'misto',
    'udalosti', 'udalost', 'zahady', 'zahada', 'frakce', 'mazlicci',
    'druhy', 'druh', 'panteon', 'buh', 'artefakty', 'artefakt',
    'historie', 'historicka-udalost', 'nastaveni', 'dm', 'mapa', 'casova-osa',
  ]);

  // ── Registries (keyed by namespaced ids) ──────────────────────
  const _routes       = new Map();   // segment   -> { addonId, render }
  const _sidebarPages = [];          // [{ route, label, icon, section, role, addonId }]
  const _addons       = new Map();   // id        -> { id, state, error, meta }

  // Injected by app.js so this module never has to import EditMode /
  // Sidebar (avoids import cycles): a toast fn + a "re-render current
  // route" fn used after a live reconcile.
  let _services = {
    toast:    (m) => console.log('[addon]', m),
    rerender: () => {},
  };
  let _booted = false;

  /** app.js calls this once before boot() to wire host services. */
  function init(services) {
    if (services && typeof services === 'object') _services = { ..._services, ...services };
  }

  // ── Scoped host facade handed to each addon's register() ──────
  // Phase 1: read-only store getters + shared template helpers. Writes
  // and per-permission gating land in the permission phase.
  function _scopedStore() {
    return {
      getCharacters:    () => safe(() => Store.getCharacters(), []),
      getLocations:     () => safe(() => Store.getLocations(), []),
      getEvents:        () => safe(() => Store.getEvents(), []),
      getMysteries:     () => safe(() => Store.getMysteries(), []),
      getFactions:      () => safe(() => Store.getFactions(), {}),
      getCollection:    (n) => safe(() => (Store.getCollection ? Store.getCollection(n) : []), []),
      generateId:       (n) => Store.generateId(n),
    };
  }

  function _makeHost(meta) {
    const id = meta.id;
    return {
      id,
      apiVersion: HOST_API_VERSION,

      /** Register a top-level hash route. `render(sub, parts)` returns
       *  an HTML string (injected into #main-content) or manages the DOM
       *  itself and returns undefined. */
      registerRoute(segment, render) {
        if (typeof segment !== 'string' || !segment) throw new Error('registerRoute: segment must be a non-empty string');
        if (typeof render !== 'function') throw new Error('registerRoute: render must be a function');
        if (BUILTIN_SECTIONS.has(segment)) throw new Error(`registerRoute: "${segment}" collides with a built-in route`);
        const cur = _routes.get(segment);
        if (cur && cur.addonId !== id) throw new Error(`registerRoute: "${segment}" already registered by addon "${cur.addonId}"`);
        _routes.set(segment, { addonId: id, render });
      },

      /** Add a left-sidebar link. Rendered under a "Doplňky" section
       *  (full layout-editor integration arrives in a later phase). */
      registerSidebarPage(spec) {
        if (!spec || typeof spec.route !== 'string' || !spec.route) throw new Error('registerSidebarPage: spec.route required');
        _sidebarPages.push({
          icon: '🧩', section: 'doplnky', role: '',
          ...spec,
          addonId: id,
        });
      },

      store: _scopedStore(),
      role: {
        isDM:        () => safe(() => Role.isDM(), false),
        isAnonymous: () => safe(() => (Role.isAnonymous ? Role.isAnonymous() : false), false),
      },
      // Vetted template toolkit — addons MUST build HTML with these
      // (esc + dataAction/dataOn) and never inline onclick, so the app
      // stays ready for script-src 'self'.
      h: { esc, dataAction, dataOn, renderMarkdown, slugify },
      ui: { toast: (m) => _services.toast(m) },
    };
  }

  function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  // ── Boot / load ───────────────────────────────────────────────

  /** Fetch the enabled-addon list and load each one. Called once from
   *  app.js boot after Store.load(). Never throws — a failure to reach
   *  the list endpoint just means "no addons this session". */
  async function boot() {
    if (_booted) return;
    _booted = true;
    const list = await _fetchList();
    for (const a of list) {
      if (a.enabled && a.entryUrl) await _loadOne(a);
    }
  }

  /** Re-fetch the list and load any newly-enabled addon not yet loaded.
   *  Wired to the SSE `addons-changed` event so a DM installing on one
   *  tab lights up the others. Disable/remove still needs a reload
   *  (live unload arrives with the registration bookkeeping phase). */
  async function reconcile() {
    const list = await _fetchList();
    let changed = false;
    for (const a of list) {
      if (a.enabled && a.entryUrl && !_addons.has(a.id)) {
        await _loadOne(a);
        changed = true;
      }
    }
    return changed;
  }

  async function _fetchList() {
    try {
      const r = await fetch('/api/addons', { headers: { Accept: 'application/json' } });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.addons) ? j.addons : [];
    } catch (e) {
      console.warn('[addons] could not fetch /api/addons:', e.message);
      return [];
    }
  }

  async function _loadOne(a) {
    const rec = { id: a.id, name: a.name || a.id, version: a.version || '', state: 'loading', error: '', meta: a };
    _addons.set(a.id, rec);
    let mod;
    try {
      mod = await import(/* @vite-ignore */ a.entryUrl);
    } catch (e) {
      rec.state = 'error';
      rec.error = `import failed: ${e.message}`;
      console.error(`[addon ${a.id}] import failed`, e);
      return;
    }
    const register = mod && (mod.default || mod.register);
    if (typeof register !== 'function') {
      rec.state = 'error';
      rec.error = 'entry module has no default-export register(host)';
      console.error(`[addon ${a.id}] ${rec.error}`);
      return;
    }
    try {
      register(_makeHost(a));
      rec.state = 'ok';
    } catch (e) {
      rec.state = 'error';
      rec.error = `register failed: ${e.message}`;
      console.error(`[addon ${a.id}] register failed`, e);
    }
  }

  // ── Router / sidebar integration (consulted by app.js + sidebar.js) ─

  function hasRoute(segment) { return _routes.has(segment); }

  /** Render an addon route into #main-content. A throwing renderer
   *  degrades to an inline error pane (never a white screen). Returns
   *  true if the segment was an addon route (so navigate() stops). */
  function renderRoute(segment, sub, parts) {
    const entry = _routes.get(segment);
    if (!entry) return false;
    const main = document.getElementById('main-content');
    if (main) main.style.display = '';
    try {
      const html = entry.render(sub, parts);
      if (typeof html === 'string' && main) {
        main.innerHTML = html;
        main.scrollTop = 0;
        window.scrollTo(0, 0);
      }
    } catch (e) {
      console.error(`[addon ${entry.addonId}] route render failed`, e);
      if (main) {
        main.innerHTML =
          `<div class="page-header"><h1>⚠ Doplněk selhal</h1></div>` +
          `<p style="color:var(--text-muted);max-width:560px;margin:1rem 0">` +
          `Doplněk <strong>${esc(entry.addonId)}</strong> selhal při vykreslování stránky: ` +
          `${esc(e.message)}</p>`;
      }
    }
    return true;
  }

  /** Snapshot of registered addon sidebar pages (for sidebar.js). */
  function sidebarPages() { return _sidebarPages.slice(); }

  /** Loaded-addon states (for the Addon Manager UI / debugging). */
  function list() {
    return [..._addons.values()].map(r => ({ id: r.id, name: r.name, version: r.version, state: r.state, error: r.error }));
  }

  return {
    HOST_API_VERSION,
    init, boot, reconcile,
    hasRoute, renderRoute, sidebarPages, list,
  };
})();
