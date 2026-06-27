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
//  Surface so far: register{Route,SidebarPage,PageRenderer,ArticleSection,
//  SettingsTab,Action}, a permission-scoped store facade, and the shared
//  template helpers. register() is TRANSACTIONAL — a throw rolls back any
//  partial registrations. Collections, wiki-kinds, fragment overrides,
//  dependencies and server-side addons arrive in later phases.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { Role } from './role.js';
import { esc, dataAction, dataOn, renderMarkdown, slugify } from './utils.js';
import { planLoadOrder } from './addon-deps.js';
import { applyFragmentOps, listConflicts } from './addon-fragments.js';
import { smokeRegistrations } from './addon-test-harness.mjs';

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
  const _routes          = new Map();  // segment  -> { addonId, render }       (navigate hash routes)
  const _pageRenderers   = new Map();  // kind     -> { addonId, render }        (Wiki.renderPage dispatch)
  const _articleSections = new Map();  // kind     -> [{ addonId, fn, order }]   (additive, stacked)
  const _editorFields    = new Map();  // kind     -> [{ addonId, fields, collect }] (editor field injection)
  const _settingsTabs    = new Map();  // tabId    -> { id, label, icon, role, render, addonId }
  const _actions         = new Map();  // "<id>:<name>" -> { addonId, fn }
  const _sidebarPages    = [];         // [{ route, label, icon, section, role, addonId }]
  const _addonApis       = new Map();  // id       -> api provided via host.provide() (for host.use)
  const _collections     = new Map();  // "<id>:<name>" -> { addonId, name, keyed }   (addon-owned data)
  const _wikiKinds       = new Map();  // scope     -> { addonId, resolve }            ([[X|scope]] resolver)
  const _fragmentOps     = [];         // [{ addonId, target, op, render, order, position }]  (override claims)
  let   _resolutions     = {};         // target   -> winner addonId | null            (DM conflict resolutions, from registry)
  const _unmatched       = new Map();  // "<id>::<target>" -> {addonId,target,op}      (claims whose fragment is absent; best-effort, reset on (re)boot)
  const _addons          = new Map();  // id       -> { id, state, error, meta }

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

  // ── Permission catalogue (human-readable, for the install wizard) ──
  const PERMISSION_LABELS = {
    'ui:route':        'Přidat vlastní stránku',
    'ui:sidebar':      'Přidat odkaz do panelu',
    'ui:settings-tab': 'Přidat záložku v nastavení',
    'ui:action':       'Reagovat na kliknutí',
    'ui:override':     'Měnit vestavěný obsah',
    'wiki:kind':       'Rozšířit [[odkazy]]',
    'data:own':        'Ukládat vlastní data doplňku',
    'net:external':    'Přístup k internetu',
    'server:code':     'Spustit kód na serveru',
    'server:endpoint': 'Vlastní serverové API',
  };
  const _COLL_LABELS = {
    characters: 'postavy', locations: 'místa', events: 'události',
    mysteries: 'záhady', factions: 'frakce',
  };
  /** Human-readable Czech description of a permission token, for the
   *  DM-facing review checklist. Falls back to the raw token. */
  function describePermission(perm) {
    if (PERMISSION_LABELS[perm]) return PERMISSION_LABELS[perm];
    let m = perm.match(/^data:read:(.+)$/);
    if (m) return 'Číst: ' + (_COLL_LABELS[m[1]] || m[1]);
    m = perm.match(/^data:write:(.+?)(\.addonData)?$/);
    if (m) return (m[2] ? 'Ukládat vlastní data k: ' : 'Měnit: ') + (_COLL_LABELS[m[1]] || m[1]);
    m = perm.match(/^ui:article-section:(.+)$/);
    if (m) return 'Sekce v článku: ' + (_COLL_LABELS[m[1]] || m[1]);
    m = perm.match(/^ui:editor-fields:(.+)$/);
    if (m) return 'Pole v editoru: ' + (_COLL_LABELS[m[1]] || m[1]);
    return perm;
  }

  // ── Scoped host facade handed to each addon's register() ──────
  // Built from the addon's GRANTED permissions: a capability the addon
  // wasn't granted simply isn't reachable — calling it throws a clear,
  // caught error (surfaced in the Manager / as an inline error card),
  // never a silent partial. Because the app has NO window.* exports, the
  // facade is the only way an addon reaches Store/DOM — so this scoping
  // genuinely restricts Store access. It's mistake-prevention + a real
  // Store boundary, NOT a defence against deliberate malice (that needs
  // iframe/worker sandboxing, a later hardening phase).
  // Returns `{ host, tx }`. `tx.undo` is a stack of reversers — every
  // register method applies to the global registry immediately AND records
  // its undo, so a register() that throws can be cleanly rolled back
  // (_loadOne does this), leaving no half-registered addon behind.
  function _makeHost(meta) {
    const id = meta.id;
    const grants = Array.isArray(meta.permissions) ? meta.permissions : [];
    const has = (p) => grants.includes(p);
    const deny = (p, what) => {
      throw new Error(`Doplněk „${id}" nemá udělené oprávnění „${p}" (${what}).`);
    };
    const tx = { undo: [] };

    /** Register a top-level hash route. Needs `ui:route`. */
    function registerRoute(segment, render) {
      if (!has('ui:route')) deny('ui:route', 'registerRoute');
      if (typeof segment !== 'string' || !segment) throw new Error('registerRoute: segment must be a non-empty string');
      if (typeof render !== 'function') throw new Error('registerRoute: render must be a function');
      if (BUILTIN_SECTIONS.has(segment)) throw new Error(`registerRoute: "${segment}" collides with a built-in route`);
      const cur = _routes.get(segment);
      if (cur && cur.addonId !== id) throw new Error(`registerRoute: "${segment}" already registered by addon "${cur.addonId}"`);
      _routes.set(segment, { addonId: id, render });
      tx.undo.push(() => { const e = _routes.get(segment); if (e && e.addonId === id) _routes.delete(segment); });
    }

    /** Add a left-sidebar link (rendered under "Doplňky"). Needs `ui:sidebar`. */
    function registerSidebarPage(spec) {
      if (!has('ui:sidebar')) deny('ui:sidebar', 'registerSidebarPage');
      if (!spec || typeof spec.route !== 'string' || !spec.route) throw new Error('registerSidebarPage: spec.route required');
      const entry = { icon: '🧩', section: 'doplnky', role: '', ...spec, addonId: id };
      _sidebarPages.push(entry);
      tx.undo.push(() => { const i = _sidebarPages.indexOf(entry); if (i >= 0) _sidebarPages.splice(i, 1); });
    }

    /** Provide a renderer for a `Wiki.renderPage(kind)` page. Needs `ui:route`. */
    function registerPageRenderer(kind, render) {
      if (!has('ui:route')) deny('ui:route', 'registerPageRenderer');
      if (typeof kind !== 'string' || !kind) throw new Error('registerPageRenderer: kind required');
      if (typeof render !== 'function') throw new Error('registerPageRenderer: render must be a function');
      const cur = _pageRenderers.get(kind);
      if (cur && cur.addonId !== id) throw new Error(`registerPageRenderer: "${kind}" already registered by "${cur.addonId}"`);
      _pageRenderers.set(kind, { addonId: id, render });
      tx.undo.push(() => { const e = _pageRenderers.get(kind); if (e && e.addonId === id) _pageRenderers.delete(kind); });
    }

    /** Contribute a section to an entity article. ADDITIVE — multiple addons
     *  stack (ordered by `opts.order`). `fn(entity)` returns `{title, html}`
     *  or null. Needs `ui:article-section:<kind>`. */
    function registerArticleSection(kind, fn, opts) {
      const perm = 'ui:article-section:' + kind;
      if (!has(perm)) deny(perm, 'registerArticleSection');
      if (typeof fn !== 'function') throw new Error('registerArticleSection: fn must be a function');
      const lst = _articleSections.get(kind) || [];
      const entry = { addonId: id, fn, order: Number.isFinite(opts && opts.order) ? opts.order : 0 };
      lst.push(entry);
      lst.sort((a, b) => a.order - b.order);
      _articleSections.set(kind, lst);
      tx.undo.push(() => { const arr = _articleSections.get(kind); const i = arr ? arr.indexOf(entry) : -1; if (i >= 0) arr.splice(i, 1); });
    }

    /** Add a Settings special tab. Needs `ui:settings-tab`. `spec.render()`
     *  returns the panel HTML; the tab id is namespaced under the addon. */
    function registerSettingsTab(spec) {
      if (!has('ui:settings-tab')) deny('ui:settings-tab', 'registerSettingsTab');
      if (!spec || typeof spec.render !== 'function') throw new Error('registerSettingsTab: spec.render required');
      const tabId = id + ':' + (spec.id || 'tab');
      if (_settingsTabs.has(tabId)) throw new Error(`registerSettingsTab: "${tabId}" already registered`);
      _settingsTabs.set(tabId, { id: tabId, label: spec.label || id, icon: spec.icon || '🧩', role: spec.role || '', render: spec.render, addonId: id });
      tx.undo.push(() => { _settingsTabs.delete(tabId); });
    }

    /** Register a namespaced action callable from `data-action="<id>:<name>"`
     *  (use `host.action(name)` to build the string). Needs `ui:action`. */
    function registerAction(name, fn) {
      if (!has('ui:action')) deny('ui:action', 'registerAction');
      if (typeof name !== 'string' || !name) throw new Error('registerAction: name required');
      if (typeof fn !== 'function') throw new Error('registerAction: fn must be a function');
      const key = id + ':' + name;
      if (_actions.has(key)) throw new Error(`registerAction: "${key}" already registered`);
      _actions.set(key, { addonId: id, fn });
      tx.undo.push(() => { _actions.delete(key); });
    }

    /** Declare an addon-owned collection so its scoped CRUD (host.store
     *  .collection) works and reads never throw. The collection MUST be
     *  declared in the manifest's `collections[]` (the server's source of
     *  truth for the wire type + isolated file) — registering an undeclared
     *  one throws. `keyed` comes from the manifest, not the caller. Needs
     *  `data:own`. */
    function registerCollection(name, opts) {
      if (!has('data:own')) deny('data:own', 'registerCollection');
      if (typeof name !== 'string' || !name) throw new Error('registerCollection: name required');
      const decl = (Array.isArray(meta.collections) ? meta.collections : []).find(c => c && c.name === name);
      if (!decl) throw new Error(`registerCollection: "${name}" is not declared in addon.json collections[]`);
      const key = id + ':' + name;
      if (_collections.has(key)) throw new Error(`registerCollection: "${name}" already registered`);
      const keyed = !!decl.keyed;
      _collections.set(key, { addonId: id, name, keyed });
      // Backfill the local container so reads work before the first write.
      safe(() => Store.ensureCollection('addon:' + id + ':' + name, keyed), null);
      tx.undo.push(() => { _collections.delete(key); });
      void opts;
    }

    /** A scoped CRUD handle for one of THIS addon's own collections. The
     *  collection must have been registered (which required `data:own`).
     *  `list()` returns a fresh array; `save`/`remove` sync to the server. */
    function collection(name) {
      const rec = _collections.get(id + ':' + name);
      if (!rec) throw new Error(`store.collection: "${name}" not registered (call host.registerCollection first)`);
      const keyed = rec.keyed;
      return {
        list:   () => {
          const c = safe(() => Store.getAddonCollection(id, name, keyed), keyed ? {} : []);
          if (Array.isArray(c)) return c.slice();
          return Object.entries(c || {}).map(([k, v]) => ({ id: k, ...v }));
        },
        get:    (itemId) => {
          const c = safe(() => Store.getAddonCollection(id, name, keyed), keyed ? {} : []);
          if (Array.isArray(c)) return c.find(x => x && x.id === itemId) || null;
          return (c && c[itemId]) || null;
        },
        save:   (item) => safe(() => Store.saveAddonItem(id, name, item, keyed), item),
        remove: (itemId) => { safe(() => Store.deleteAddonItem(id, name, itemId, keyed), null); },
      };
    }

    /** Inject fields into a core editor (currently characters) + collect them
     *  back into THIS addon's addonData namespace on save. `spec.fields(entity)`
     *  → HTML string (the entity is null for a brand-new record);
     *  `spec.collect(scope, entity)` → object merged into `addonData[<id>]`
     *  (scope = this addon's `.addon-editor-section`). Needs
     *  `ui:editor-fields:<kind>`. */
    function registerEditorFields(kind, spec) {
      const perm = 'ui:editor-fields:' + kind;
      if (!has(perm)) deny(perm, 'registerEditorFields');
      if (!spec || typeof spec.fields !== 'function') throw new Error('registerEditorFields: spec.fields required');
      const entry = { addonId: id, fields: spec.fields, collect: typeof spec.collect === 'function' ? spec.collect : null };
      const lst = _editorFields.get(kind) || [];
      lst.push(entry);
      _editorFields.set(kind, lst);
      tx.undo.push(() => { const arr = _editorFields.get(kind); const i = arr ? arr.indexOf(entry) : -1; if (i >= 0) arr.splice(i, 1); });
    }

    /** Claim a fragment-override op on a decomposed built-in surface (e.g.
     *  `characters:section:vazby`, `characters:body`). Ops: `replace` / `hide`
     *  (EXCLUSIVE per target — competing claims are a detected conflict, never
     *  last-wins), `wrap` (stackable, ordered via `order`), `insert`
     *  (additive sibling, `position:'before'|'after'`). `render(html, ctx)` →
     *  string (`ctx` carries `{entity, kind, target}`). Needs `ui:override`.
     *  The claim is RECORDED — arbitration happens at render time so conflicts
     *  surface in the Manager instead of silently clobbering. */
    function registerFragmentOp(target, spec) {
      if (!has('ui:override')) deny('ui:override', 'registerFragmentOp');
      if (typeof target !== 'string' || !target) throw new Error('registerFragmentOp: target required');
      spec = spec || {};
      const op = spec.op;
      if (op !== 'replace' && op !== 'hide' && op !== 'wrap' && op !== 'insert') {
        throw new Error('registerFragmentOp: op must be replace|hide|wrap|insert');
      }
      if (op !== 'hide' && typeof spec.render !== 'function') {
        throw new Error(`registerFragmentOp: op "${op}" needs a render(html, ctx) function`);
      }
      const claim = {
        addonId: id, target, op,
        render: typeof spec.render === 'function' ? spec.render : null,
        order: Number.isFinite(spec.order) ? spec.order : 0,
        position: op === 'insert' ? (spec.position === 'before' ? 'before' : 'after') : null,
      };
      _fragmentOps.push(claim);
      tx.undo.push(() => { const i = _fragmentOps.indexOf(claim); if (i >= 0) _fragmentOps.splice(i, 1); });
    }

    /** Resolve `[[Label|<scope>]]` wiki-links for a custom kind. `resolve(label)`
     *  returns `{kind, id}` (a route + id, e.g. `{kind:'pravidla', id:'grappling'}`)
     *  or null. The scope token can't shadow a built-in. Needs `wiki:kind`. */
    function registerWikiKind(scope, resolve) {
      if (!has('wiki:kind')) deny('wiki:kind', 'registerWikiKind');
      if (typeof scope !== 'string' || !scope) throw new Error('registerWikiKind: scope required');
      if (typeof resolve !== 'function') throw new Error('registerWikiKind: resolve must be a function');
      if (BUILTIN_SECTIONS.has(scope)) throw new Error(`registerWikiKind: "${scope}" collides with a built-in scope`);
      const cur = _wikiKinds.get(scope);
      if (cur && cur.addonId !== id) throw new Error(`registerWikiKind: "${scope}" already registered by "${cur.addonId}"`);
      _wikiKinds.set(scope, { addonId: id, resolve });
      tx.undo.push(() => { const e = _wikiKinds.get(scope); if (e && e.addonId === id) _wikiKinds.delete(scope); });
    }

    /** Expose an API for dependent addons (host.use). Stored under this id. */
    function provide(api) {
      _addonApis.set(id, api);
      tx.undo.push(() => { if (_addonApis.get(id) === api) _addonApis.delete(id); });
    }
    /** Consume a DECLARED dependency's provided API. Throws (caught) if the
     *  dependency wasn't declared in the manifest or isn't loaded — load
     *  order guarantees declared deps are loaded first. */
    function use(depId) {
      const declared = meta.dependencies && Object.prototype.hasOwnProperty.call(meta.dependencies, depId);
      if (!declared) throw new Error(`Doplněk „${id}" nedeklaroval závislost „${depId}" (host.use).`);
      const api = _addonApis.get(depId);
      if (api == null) throw new Error(`Závislost „${depId}" není načtená (host.use).`);
      return api;
    }

    // Read getters gated by data:read:<collection>. generateId is a pure
    // helper (always available); role / h / ui.toast are harmless too.
    const store = {
      generateId:    (n) => Store.generateId(n),
      getCharacters: () => { if (!has('data:read:characters')) deny('data:read:characters', 'store.getCharacters'); return safe(() => Store.getCharacters(), []); },
      getLocations:  () => { if (!has('data:read:locations'))  deny('data:read:locations',  'store.getLocations');  return safe(() => Store.getLocations(), []); },
      getEvents:     () => { if (!has('data:read:events'))     deny('data:read:events',     'store.getEvents');     return safe(() => Store.getEvents(), []); },
      getMysteries:  () => { if (!has('data:read:mysteries'))  deny('data:read:mysteries',  'store.getMysteries');  return safe(() => Store.getMysteries(), []); },
      getFactions:   () => { if (!has('data:read:factions'))   deny('data:read:factions',   'store.getFactions');   return safe(() => Store.getFactions(), {}); },
      getCollection: (n) => { if (typeof n === 'string' && n.startsWith('addon:')) throw new Error(`Doplněk „${id}" nemůže přes getCollection číst kolekci jiného doplňku.`); if (!has('data:read:' + n)) deny('data:read:' + n, 'store.getCollection'); return safe(() => (Store.getCollection ? Store.getCollection(n) : []), []); },
      // Scoped CRUD for one of THIS addon's own collections (gated by the
      // data:own that registerCollection required).
      collection,
      // Read-modify-write THIS addon's namespace on a core entity (the host
      // injects the addon id, so it can never touch another addon's blob).
      // Needs `data:write:<collection>.addonData`.
      patchAddonData: (collection, itemId, patchFn) => {
        const perm = 'data:write:' + collection + '.addonData';
        if (!has(perm)) deny(perm, 'store.patchAddonData');
        return safe(() => Store.patchAddonData(collection, itemId, id, patchFn), null);
      },
    };

    const host = {
      id,
      apiVersion: HOST_API_VERSION,
      permissions: grants.slice(),
      action: (name) => id + ':' + name,
      registerRoute, registerSidebarPage, registerPageRenderer,
      registerArticleSection, registerSettingsTab, registerAction,
      registerCollection, registerWikiKind, registerEditorFields,
      registerFragmentOp,
      provide, use,
      store,
      role: {
        isDM:        () => safe(() => Role.isDM(), false),
        isAnonymous: () => safe(() => (Role.isAnonymous ? Role.isAnonymous() : false), false),
      },
      // Vetted template toolkit — addons MUST build HTML with these
      // (esc + dataAction/dataOn), never inline onclick, so the app stays
      // ready for script-src 'self'.
      h: { esc, dataAction, dataOn, renderMarkdown, slugify },
      ui: {
        toast: (m) => _services.toast(m),
        // Re-render the current route — addons call this after a write so the
        // user sees their change immediately (vs waiting on the SSE refetch).
        rerender: () => { try { _services.rerender(); } catch (_) {} },
      },
    };
    return { host, tx };
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
    const reg = await _fetchList();
    _resolutions = reg.resolutions;
    _unmatched.clear();
    const list = reg.addons.filter(a => a.enabled && a.entryUrl);
    const plan = planLoadOrder(list);
    _markBlocked(list, plan.blocked);
    for (const a of plan.order) await _loadOne(a);   // dependency order: deps first
  }

  /** Re-fetch the list, UNLOAD any addon no longer enabled, and load any
   *  newly-enabled addon. Wired to the SSE `addons-changed` event so a DM
   *  installing / removing / disabling on one tab takes effect on the others. */
  async function reconcile() {
    const reg = await _fetchList();
    // A transient fetch failure must be a NO-OP — never unload every addon or
    // wipe resolutions just because the list came back empty.
    if (!reg.ok) return false;
    // A DM conflict resolution (POST /api/addons/resolve → addons-changed)
    // changes only `resolutions` — flag that as a change so the caller
    // re-renders and the new winner actually applies.
    const resChanged = JSON.stringify(_resolutions) !== JSON.stringify(reg.resolutions);
    if (resChanged) _resolutions = reg.resolutions;
    const list = reg.addons.filter(a => a.enabled && a.entryUrl);
    const enabledIds = new Set(list.map(a => a.id));
    let changed = resChanged;
    // Unload addons that are gone from the enabled set (disabled / removed):
    // reverse their registrations so their routes / sidebar pages / fragment
    // claims / actions actually disappear, not just on a hard reload.
    for (const id of [..._addons.keys()]) {
      if (!enabledIds.has(id)) { _unloadAddon(id); changed = true; }
    }
    const plan = planLoadOrder(list);
    changed = _markBlocked(list, plan.blocked) || changed;
    for (const a of plan.order) {
      const cur = _addons.get(a.id);
      if (!cur || cur.state !== 'ok') { await _loadOne(a); changed = true; }   // includes now-unblocked
    }
    return changed;
  }

  /** Tear down a no-longer-enabled addon: reverse its registrations (routes,
   *  sidebar pages, sections, actions, fragment claims, collections, wiki
   *  kinds, provided API), drop its unmatched-claim notes, and forget it. */
  function _unloadAddon(id) {
    const rec = _addons.get(id);
    if (rec && Array.isArray(rec.undo)) {
      for (const u of rec.undo.slice().reverse()) { try { u(); } catch (_) {} }
    }
    _addonApis.delete(id);
    for (const k of [..._unmatched.keys()]) { if (k.startsWith(id + '::')) _unmatched.delete(k); }
    _addons.delete(id);
  }

  /** Record `blocked` addons (missing / incompatible / cyclic deps) as a
   *  visible state so a dependent never silently half-works. Returns true
   *  if anything changed. */
  function _markBlocked(list, blocked) {
    let changed = false;
    for (const [id, reason] of blocked) {
      const cur = _addons.get(id);
      if (!cur || cur.state !== 'blocked' || cur.error !== reason) {
        const a = list.find(x => x.id === id) || { id };
        _addons.set(id, { id, name: a.name || id, version: a.version || '', state: 'blocked', error: reason, meta: a });
        changed = true;
      }
    }
    return changed;
  }

  async function _fetchList() {
    try {
      const r = await fetch('/api/addons', { headers: { Accept: 'application/json' } });
      if (!r.ok) return { ok: false, addons: [], resolutions: {} };
      const j = await r.json();
      return {
        ok: true,
        addons: Array.isArray(j.addons) ? j.addons : [],
        resolutions: (j.resolutions && typeof j.resolutions === 'object' && !Array.isArray(j.resolutions)) ? j.resolutions : {},
      };
    } catch (e) {
      console.warn('[addons] could not fetch /api/addons:', e.message);
      // ok:false so a transient failure never looks like "zero addons" — which
      // would otherwise make reconcile unload everything + wipe resolutions.
      return { ok: false, addons: [], resolutions: {} };
    }
  }

  /** Collect THIS addon's live registrations into the harness `rec` shape for
   *  the AT-LOAD smoke. Deliberately OMITS full-page route/page renderers:
   *  they're the heaviest, the most likely to touch real data, and a throw in
   *  one is already caught + shown as an error pane at navigation time. The
   *  at-load smoke covers the cheap additive contributors (sections, settings
   *  tabs, wiki kinds, editor fields, fragment ops). Authors get the FULL smoke
   *  (incl. routes/pages) via the published harness's `smokeRegistrations`. */
  function _recForAddon(addonId) {
    const r = { routes: [], pages: [], articleSections: [], settingsTabs: [], wikiKinds: [], editorFields: [], fragmentOps: [] };
    for (const [kind, lst] of _articleSections) for (const e of lst) if (e.addonId === addonId) r.articleSections.push({ kind, fn: e.fn });
    for (const t of _settingsTabs.values())    if (t.addonId === addonId) r.settingsTabs.push({ id: t.id, render: t.render });
    for (const [scope, e] of _wikiKinds)       if (e.addonId === addonId) r.wikiKinds.push({ scope, resolve: e.resolve });
    for (const [kind, lst] of _editorFields)   for (const e of lst) if (e.addonId === addonId) r.editorFields.push({ kind, spec: { fields: e.fields } });
    for (const c of _fragmentOps)              if (c.addonId === addonId) r.fragmentOps.push({ target: c.target, spec: { op: c.op, render: c.render } });
    return r;
  }

  async function _loadOne(a) {
    const rec = { id: a.id, name: a.name || a.id, version: a.version || '', state: 'loading', error: '', smoke: null, meta: a };
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
    const { host, tx } = _makeHost(a);
    try {
      register(host);
      rec.state = 'ok';
      rec.undo  = tx.undo;   // keep the teardown stack so reconcile can UNLOAD it later
      // Tier-C render smoke (Phase 8): exercise this addon's renderers with
      // sample fixtures. A throw on benign input is almost certainly a bug —
      // surfaced as a NON-blocking warning in the Manager (the addon still
      // loads; a strict pre-activation gate is the wizard's job, Phase 9).
      try {
        const smoke = smokeRegistrations(_recForAddon(a.id));
        if (!smoke.ok) {
          rec.smoke = smoke.failures;
          console.warn(`[addon ${a.id}] render smoke flagged`, smoke.failures);
        }
      } catch (_) { /* smoke is best-effort */ }
    } catch (e) {
      // Transactional rollback — discard any partial registrations so a
      // half-registered addon leaves no dangling routes/sections/actions.
      for (const u of tx.undo.slice().reverse()) { try { u(); } catch (_) {} }
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

  function _errorPane(addonId, e) {
    return `<div class="page-header"><h1>⚠ Doplněk selhal</h1></div>` +
      `<p style="color:var(--text-muted);max-width:560px;margin:1rem 0">Doplněk ` +
      `<strong>${esc(addonId)}</strong> selhal: ${esc(e.message)}</p>`;
  }

  function hasPageRenderer(kind) { return _pageRenderers.has(kind); }
  /** Render an addon-contributed `Wiki.renderPage(kind)` page; a throw
   *  degrades to an inline error pane. Returns the HTML string. */
  function renderPage(kind, param) {
    const entry = _pageRenderers.get(kind);
    if (!entry) return '';
    try { const html = entry.render(param); return typeof html === 'string' ? html : ''; }
    catch (e) { console.error(`[addon ${entry.addonId}] page render failed`, e); return _errorPane(entry.addonId, e); }
  }

  /** Contributed article sections for an entity kind (additive, stacked).
   *  Each throwing section degrades to an inline error card. Returns
   *  [{title, html}] for `_articleShell`. */
  function articleSections(kind, entity) {
    const lst = _articleSections.get(kind);
    if (!lst || !lst.length) return [];
    const out = [];
    for (const e of lst) {
      try {
        const sec = e.fn(entity);
        if (sec && typeof sec.html === 'string') out.push({ addonId: e.addonId, title: sec.title || '', html: sec.html });
      } catch (err) {
        console.error(`[addon ${e.addonId}] article section failed`, err);
        out.push({ addonId: e.addonId, title: '⚠ ' + e.addonId, html: `<div style="color:var(--color-danger)">Sekce doplňku „${esc(e.addonId)}" selhala: ${esc(err.message)}</div>` });
      }
    }
    return out;
  }

  /** Apply addon fragment-override claims to a surface's ordered fragment
   *  list (replace/hide/wrap/insert + conflict-safe arbitration). Returns the
   *  transformed list; the renderer joins `.html`. Only claims namespaced to
   *  `kind` (`<kind>:…` targets) participate, so a claim for another surface is
   *  never mistaken for a missing target here. Early-returns (zero cost) when
   *  no override claims are installed. */
  function applyFragments(kind, fragments, entity) {
    if (!_fragmentOps.length) return fragments;
    const claims = _fragmentOps.filter(c => c.target.startsWith(kind + ':'));
    if (!claims.length) return fragments;
    const res = applyFragmentOps(fragments, claims, _resolutions, { entity, kind });
    for (const u of res.unmatched) _unmatched.set(`${u.addonId}::${u.target}`, u);
    for (const f of res.failures) {
      console.error(`[addon ${f.addonId}] fragment ${f.op} on "${f.target}" failed: ${f.message}`);
    }
    return res.fragments;
  }

  /** Eager conflict report for the Addon Manager — ≥2 exclusive (replace/hide)
   *  claims on one target, with the DM's current resolution (addonId | null |
   *  undefined). */
  function conflicts() { return listConflicts(_fragmentOps, _resolutions); }

  /** Claims whose target fragment was absent at render time (core renamed /
   *  removed it) — surfaced as addon warnings in the Manager. Best-effort,
   *  accumulated across renders, reset on (re)boot. */
  function unmatchedClaims() { return [..._unmatched.values()]; }

  /** Concatenated addon editor-field HTML for a kind — each addon's block
   *  wrapped in its own `.addon-editor-section[data-addon-id]` + error-isolated.
   *  editmode.js fills the `.addon-editor-fields` editor slot with this. */
  function editorFields(kind, entity) {
    const lst = _editorFields.get(kind);
    if (!lst || !lst.length) return '';
    let html = '';
    for (const e of lst) {
      try {
        const out = e.fields(entity);
        if (typeof out === 'string' && out) {
          html += `<div class="addon-editor-section" data-addon-id="${esc(e.addonId)}">${out}</div>`;
        }
      } catch (err) {
        console.error(`[addon ${e.addonId}] editor fields failed`, err);
        html += `<div class="addon-editor-section" style="color:var(--color-danger)">Pole doplňku „${esc(e.addonId)}" selhala: ${esc(err.message)}</div>`;
      }
    }
    return html;
  }

  /** Collect addon editor fields back into a `{ addonId: namespaceObj }` map for
   *  the editor's save path to merge into `entity.addonData`. Each addon's
   *  collect() is scoped to its own section + error-isolated (a throwing one is
   *  skipped, never blocking the save). */
  function collectEditorFields(kind, entity, root) {
    const lst = _editorFields.get(kind);
    const out = {};
    if (!lst || !lst.length) return out;
    const scopeRoot = root || document;
    // Index the addon sections by id via a non-injectable JS comparison rather
    // than interpolating addonId into a CSS attribute selector (which could
    // throw a SyntaxError on an unexpected char and silently drop the save).
    const sections = scopeRoot.querySelectorAll ? scopeRoot.querySelectorAll('.addon-editor-section') : [];
    const byId = new Map();
    sections.forEach(el => { if (el.dataset && el.dataset.addonId) byId.set(el.dataset.addonId, el); });
    for (const e of lst) {
      if (!e.collect) continue;
      try {
        const scope = byId.get(e.addonId) || scopeRoot;
        const data = e.collect(scope, entity);
        if (data && typeof data === 'object') out[e.addonId] = data;
      } catch (err) {
        console.error(`[addon ${e.addonId}] collect editor fields failed`, err);
      }
    }
    return out;
  }

  /** Addon-contributed Settings tabs (id/label/icon/role) for settings.js. */
  function settingsTabs() { return [..._settingsTabs.values()].map(t => ({ id: t.id, label: t.label, icon: t.icon, role: t.role })); }
  /** The full tab record (incl. render) for a given tab id, or null. */
  function settingsTab(tabId) { return _settingsTabs.get(tabId) || null; }

  /** Dispatch a namespaced addon action (data-action containing ":"). A
   *  throwing action toasts + logs, never crashing the dispatcher. */
  function runAction(actionStr, args) {
    const entry = _actions.get(actionStr);
    if (!entry) { console.warn('Unknown addon action:', actionStr); return; }
    try { return entry.fn(...(Array.isArray(args) ? args : [])); }
    catch (e) { console.error(`[addon ${entry.addonId}] action "${actionStr}" failed`, e); try { _services.toast(`Doplněk selhal: ${e.message}`); } catch (_) {} }
  }

  /** Snapshot of registered addon sidebar pages (for sidebar.js). */
  function sidebarPages() { return _sidebarPages.slice(); }

  /** Resolve a `[[Label]]` / `[[Label|scope]]` wiki-link against addon-
   *  registered kinds — the fallthrough app.js's core resolver calls when no
   *  built-in entity matches. With an explicit `scope` hint only that kind is
   *  tried; without one, every registered kind is tried in registration order.
   *  Returns `{kind, id}` (route + id) for `expandWikiLinks`, or null. */
  function resolveWikiLink(label, hint) {
    if (!label || !_wikiKinds.size) return null;
    if (hint) {
      const k = _wikiKinds.get(hint);
      return k ? _safeWiki(k, label) : null;
    }
    for (const k of _wikiKinds.values()) {
      const r = _safeWiki(k, label);
      if (r) return r;
    }
    return null;
  }
  function _safeWiki(k, label) {
    try {
      const r = k.resolve(label);
      if (!r) return null;
      const kind = r.kind || r.route;
      const id   = r.id != null ? r.id : r.slug;
      return (typeof kind === 'string' && kind && id != null) ? { kind, id: String(id) } : null;
    } catch (e) {
      console.error(`[addon ${k.addonId}] wiki-kind resolve failed`, e);
      return null;
    }
  }

  /** Loaded-addon states (for the Addon Manager UI / debugging). */
  function list() {
    return [..._addons.values()].map(r => ({ id: r.id, name: r.name, version: r.version, state: r.state, error: r.error, smoke: r.smoke || null }));
  }

  return {
    HOST_API_VERSION,
    init, boot, reconcile,
    hasRoute, renderRoute, sidebarPages, list,
    hasPageRenderer, renderPage, articleSections,
    editorFields, collectEditorFields,
    applyFragments, conflicts, unmatchedClaims,
    settingsTabs, settingsTab, runAction,
    resolveWikiLink,
    describePermission,
  };
})();
