// ═══════════════════════════════════════════════════════════════
//  ADDON TEST HARNESS — published mock host + dry-run / smoke runners.
//
//  The framework publishes this so addon authors (human OR AI) can unit-test
//  their `register(host)` against the REAL host surface without a browser, a
//  running server, or real Store data. It's also what the host itself uses for
//  the Tier-A dry-run + Tier-C render smoke (pre-activation testing, Phase 8).
//
//  Deliberately PURE + dependency-free: no DOM, no window, no Store, no
//  utils.js import. The mock `host.h` ships its own tiny pure helpers so the
//  harness runs anywhere `node --test` runs. The mock records every register*
//  call into `rec` so a test can assert on what the addon wired up.
//
//  Usage (an addon's own test):
//    import register from '../entry.js';
//    import { dryRunRegister, smokeRegistrations } from '<host>/addon-test-harness.mjs';
//    const { ok, rec, error } = dryRunRegister(register, { id: 'myaddon' });
//    assert.ok(ok, error);
//    assert.equal(rec.routes.length, 1);
//    assert.ok(smokeRegistrations(rec).ok);
// ═══════════════════════════════════════════════════════════════

// ── Pure, self-contained mini-helpers for the mock host.h ─────────
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function _slugify(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function _dataAction(method, ...args) {
  const a = args.length ? ` data-args='${JSON.stringify(args)}'` : '';
  return ` data-action="${_esc(method)}"${a}`;
}
function _dataOn(kind, method, ...args) {
  const a = args.length ? ` data-${kind}-args='${JSON.stringify(args)}'` : '';
  return ` data-on-${kind}="${_esc(method)}"${a}`;
}
// Mirrors utils.breadcrumbNav: horizontal trail, last crumb = current page,
// '' below 2 crumbs — so addon tests exercise the same contract.
function _breadcrumb(crumbs) {
  const list = (crumbs || []).filter(c => c && c.label);
  if (list.length < 2) return '';
  const rows = list.map((c, i) => {
    const sep = i ? '<span class="bc-sep" aria-hidden="true">›</span>' : '';
    const label = (i === list.length - 1 || !c.href)
      ? `<span class="bc-current">${_esc(c.label)}</span>`
      : `<a class="bc-crumb" href="${_esc(c.href)}">${_esc(c.label)}</a>`;
    return `<li class="bc-row">${sep}${label}</li>`;
  }).join('');
  return `<nav class="wiki-breadcrumb"><ol>${rows}</ol></nav>`;
}
// Mirrors utils.iconGlyph: the shared stat-glyph set (h.icon). Same names +
// markup shape (`<svg class="codex-icon" …>`), '' for unknown names — so
// addon renders under test emit what the live host emits.
const _ICON_GLYPHS = {
  heart:         '<path d="M12 20.3C12 20.3 4.2 14.8 4.2 9 4.2 6.3 6.2 4.4 8.5 4.4 10.1 4.4 11.4 5.4 12 6.7 12.6 5.4 13.9 4.4 15.5 4.4 17.8 4.4 19.8 6.3 19.8 9 19.8 14.8 12 20.3 12 20.3Z"/>',
  shield:        '<path d="M12 2.6 19 5.3V11C19 15.6 16 19.4 12 21.4 8 19.4 5 15.6 5 11V5.3Z"/>',
  bolt:          '<path d="M13 2.5 6 13.5H11L10.5 21.5 18 9.5H12.5Z"/>',
  chevrons:      '<path d="M5 6.5 11 12 5 17.5"/><path d="M12 6.5 18 12 12 17.5"/>',
  'plus-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8V16.2M7.8 12H16.2"/>',
  eye:           '<path d="M2.6 12C6.5 6.6 17.5 6.6 21.4 12 17.5 17.4 6.5 17.4 2.6 12Z"/><circle cx="12" cy="12" r="2.6"/>',
};
function _icon(name, opts = {}) {
  const path = _ICON_GLYPHS[name];
  if (!path) return '';
  const size = Number(opts.size) > 0 ? Number(opts.size) : 17;
  const aria = opts.label ? `role="img" aria-label="${_esc(opts.label)}"` : 'aria-hidden="true"';
  return `<svg class="codex-icon" viewBox="0 0 24 24" width="${size}" height="${size}" ${aria}>${path}</svg>`;
}

/** A fresh, blank registration record. */
function _emptyRec() {
  return {
    routes: [], pages: [], sidebar: [], settingsTabs: [], actions: [],
    collections: [], wikiKinds: [], editorFields: [], fragmentOps: [],
    articleSections: [], slots: [],
    kinds: [], connectionKinds: [], nodeKinds: [], graphViews: [], graphContributors: [],
    provided: undefined, toasts: [], rerenders: 0,
  };
}

/**
 * Build a recording mock of the host facade. Mirrors the real method names
 * (so tests exercise the real surface) but records instead of mutating any
 * registry.
 *
 * PERMISSIONS ARE ENFORCED when `meta.permissions` is an array — each
 * register* throws the same error the real host would for an ungranted
 * capability, so a manifest that under-declares FAILS IN TESTS instead of at
 * install (this exact gap once shipped two broken addons). Declare the same
 * `permissions` your addon.json declares. Omitting `meta.permissions`
 * entirely runs loose (allow-all) for quick throwaway tests.
 *
 * @param {object} [meta]  `{ id, permissions?, dependencies? }`
 * @param {object} [opts]  `{ isDM?, isAnonymous?, fixtures?, deps? }`
 * @returns {{ host: object, rec: object }}
 */
export function createMockHost(meta = {}, opts = {}) {
  const id  = meta.id || 'mock-addon';
  const rec = _emptyRec();
  const fx  = opts.fixtures || {};
  const get = (k) => Array.isArray(fx[k]) ? fx[k] : [];

  // Permission gate — mirrors web/js/addons.js (_makeHost): same permission
  // per method, same error text. `null` grants (no `permissions` key) = loose.
  const grants = Array.isArray(meta.permissions) ? meta.permissions.slice() : null;
  const need = (perm, what) => {
    if (grants && !grants.includes(perm)) {
      throw new Error(`Doplněk „${id}" nemá udělené oprávnění „${perm}" (${what}).`);
    }
  };

  // A MUTABLE backing store for the scoped-CRUD mock, seeded from fixtures.
  // save()/remove() actually mutate it (and getCollection reads it) so a
  // "save then read back" author test behaves like production instead of
  // silently passing on a no-op mock.
  const _collStore = {};
  const _coll = (name) => (_collStore[name] || (_collStore[name] = get('collection:' + name).slice()));

  // Mirror the REAL scoped-CRUD shape: get() filters by id, save() generates a
  // missing id + stamps updatedAt + upserts, remove() deletes by id.
  const collectionHandle = (name) => ({
    list:   () => _coll(name).slice(),
    get:    (itemId) => _coll(name).find(x => x && x.id === itemId) || null,
    save:   (item) => {
      const arr = _coll(name);
      const r = { ...item };
      if (!r.id) r.id = _slugify((item && item.name) || name) + '_mock';
      r.updatedAt = 0;
      const i = arr.findIndex(x => x && x.id === r.id);
      if (i >= 0) arr[i] = r; else arr.push(r);
      return r;
    },
    remove: (itemId) => {
      const arr = _coll(name);
      const i = arr.findIndex(x => x && x.id === itemId);
      if (i >= 0) arr.splice(i, 1);
    },
  });

  const host = {
    id,
    apiVersion: 1,
    permissions: Array.isArray(meta.permissions) ? meta.permissions.slice() : [],
    action: (name) => id + ':' + name,

    registerRoute:        (segment, render)   => { need('ui:route', 'registerRoute'); rec.routes.push({ segment, render }); },
    registerSidebarPage:  (spec)              => { need('ui:sidebar', 'registerSidebarPage'); rec.sidebar.push(spec); },
    registerPageRenderer: (kind, render)      => { need('ui:route', 'registerPageRenderer'); rec.pages.push({ kind, render }); },
    registerArticleSection: (kind, fn)        => { need('ui:article-section:' + kind, 'registerArticleSection'); rec.articleSections.push({ kind, fn }); },
    registerSettingsTab:  (spec)              => { need('ui:settings-tab', 'registerSettingsTab'); rec.settingsTabs.push(spec); },
    registerAction:       (name, fn)          => { need('ui:action', 'registerAction'); rec.actions.push({ name, fn }); },
    registerCollection:   (name, o)           => { need('data:own', 'registerCollection'); rec.collections.push({ name, opts: o }); },
    registerWikiKind:     (scope, resolve)    => { need('wiki:kind', 'registerWikiKind'); rec.wikiKinds.push({ scope, resolve }); },
    registerEditorFields: (kind, spec)        => { need('ui:editor-fields:' + kind, 'registerEditorFields'); rec.editorFields.push({ kind, spec }); },
    registerFragmentOp:   (target, spec)      => { need('ui:override', 'registerFragmentOp'); rec.fragmentOps.push({ target, spec }); },
    registerSlot:         (slotId, render, o) => { need('ui:slot:' + String(slotId || '').split(':')[0], 'registerSlot'); rec.slots.push({ slotId, render, opts: o }); },
    registerKind:         (domain, def)       => { need('kinds:' + domain, 'registerKind'); rec.kinds.push({ domain, def }); },
    registerConnectionKind:   (def)           => { need('kinds:connections', 'registerConnectionKind'); rec.connectionKinds.push(def); },
    registerNodeKind:     (def)               => { need('kinds:graph', 'registerNodeKind'); rec.nodeKinds.push(def); },
    registerGraphView:    (def)               => { need('kinds:graph', 'registerGraphView'); rec.graphViews.push(def); },
    registerGraphContributor: (viewId, fn)    => { need('graph:contribute', 'registerGraphContributor'); rec.graphContributors.push({ viewId, fn }); },

    provide: (api)   => { rec.provided = api; },
    use:     (depId) => (opts.deps ? opts.deps[depId] : undefined),

    store: {
      generateId:    (n) => _slugify(n || 'id') + '_mock',
      getCharacters: () => get('characters'),
      getLocations:  () => get('locations'),
      getEvents:     () => get('events'),
      getMysteries:  () => get('mysteries'),
      getFactions:   () => fx.factions || {},
      getCollection: (n) => _coll(n).slice(),
      collection:    (n) => collectionHandle(n),
      // Real patchAddonData returns the SAVED ENTITY ({...entity, addonData}),
      // not the namespace — mirror that so a renderer reading `.addonData[id]`
      // off the return works the same in tests as in prod.
      patchAddonData: (_c, itemId, fn) => ({ id: itemId, addonData: { [id]: (typeof fn === 'function' ? (fn({}) || {}) : {}) } }),
    },
    role: {
      isDM:        () => !!opts.isDM,
      isAnonymous: () => !!opts.isAnonymous,
    },
    // Mirrors host.asset: the content-addressed static base (mock hash).
    asset: (rel) => `/addons/${meta.id || 'addon'}/mockhash/` + String(rel == null ? '' : rel).replace(/^\/+/, ''),
    h: { esc: _esc, slugify: _slugify, dataAction: _dataAction, dataOn: _dataOn,
         renderMarkdown: (s) => _esc(s), breadcrumb: _breadcrumb, icon: _icon },
    ui: {
      toast:    (m) => { rec.toasts.push(m); },
      rerender: () => { rec.rerenders++; },
    },
  };
  return { host, rec };
}

/**
 * Tier-A dry run: execute `register(host)` against a fresh mock host, catching
 * any throw. Returns the recorded registrations either way.
 *
 * @returns {{ ok: boolean, rec: object, error?: string }}
 */
export function dryRunRegister(register, meta = {}, opts = {}) {
  const { host, rec } = createMockHost(meta, opts);
  if (typeof register !== 'function') return { ok: false, rec, error: 'register is not a function' };
  try { register(host); return { ok: true, rec }; }
  catch (e) { return { ok: false, rec, error: (e && e.message) || String(e) }; }
}

// A reasonably-complete sample entity so a well-written renderer doesn't trip
// on a missing field during the smoke pass.
const SAMPLE_ENTITY = {
  id: '_smoke', name: 'Smoke Test', title: '', knowledge: 4, faction: 'neutral',
  status: 'alive', description: '', addonData: {}, tags: [], attitudes: [],
  known: [], unknown: [], questions: [], clues: [],
};

/**
 * Tier-C render smoke: invoke each recorded RENDER fn with sample inputs inside
 * try/catch. A render that throws on benign input is almost certainly buggy.
 * Pure side-effect-free renders only — actions / collect (DOM-bound) are NOT
 * invoked. Returns `{ ok, failures: [{kind, id, message}] }`.
 *
 * @param {object} rec  the record from createMockHost / dryRunRegister
 * @param {object} [opts]  `{ entity?, label?, html? }` overrides for the fixtures
 */
export function smokeRegistrations(rec, opts = {}) {
  const failures = [];
  const entity = opts.entity || SAMPLE_ENTITY;
  const label  = opts.label  || 'Smoke';
  const html   = opts.html   || '<div>smoke</div>';
  const ctx    = { entity, kind: 'characters', target: 'characters:body' };
  const guard = (kind, idLabel, fn) => {
    try { fn(); }
    catch (e) { failures.push({ kind, id: idLabel, message: (e && e.message) || String(e) }); }
  };

  // Route renderers are called as render(sub, parts) in production — pass a
  // representative non-empty sub + parts so a renderer that indexes parts[N]
  // or splits sub is actually exercised (not just the empty-arg path).
  for (const r of rec.routes)          guard('route',         r.segment, () => r.render('detail', [r.segment, 'detail']));
  for (const p of rec.pages)           guard('page',          p.kind,    () => p.render(entity.id));
  for (const s of rec.articleSections) guard('articleSection', s.kind,   () => s.fn(entity));
  for (const t of rec.settingsTabs)    guard('settingsTab',   t.id || 'tab', () => t.render && t.render());
  for (const w of rec.wikiKinds)       guard('wikiKind',      w.scope,   () => w.resolve(label));
  for (const e of rec.editorFields)    guard('editorFields',  e.kind,    () => e.spec.fields && e.spec.fields(entity));
  for (const f of rec.fragmentOps) {
    if (typeof f.spec.render === 'function') {
      guard('fragmentOp', f.target, () => f.spec.render(html, ctx));
    }
  }
  // Content slots — pass a superset ctx (card/column/generic) so a slot
  // renderer that reads event/sitting/role is exercised either way.
  // ctx.role mirrors the LIVE call sites, which pass BOOLEANS
  // (`role: { isDM: Role.isDM() }` in wiki.js/timeline.js/map.js) — a
  // function-shaped mock here let `ctx.role.isDM()` pass the smoke and
  // then break in production.
  const slotCtx = { entity, event: entity, sitting: 1, column: { sitting: 1, events: [entity] },
                    role: { isDM: false, isAnonymous: false } };
  for (const s of (rec.slots || []))     guard('slot', s.slotId, () => s.render(slotCtx));
  // Graph node-kind descriptors — exercise the cardHTML renderer on a sample node.
  for (const n of (rec.nodeKinds || [])) guard('nodeKind', n.id, () => { if (typeof n.cardHTML === 'function') n.cardHTML({ id: '_smoke', type: n.id, entity }); });
  return { ok: failures.length === 0, failures };
}
