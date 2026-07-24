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
  medal:         '<circle cx="12" cy="9.6" r="5.4"/><path d="M9.3 14.2 7.6 21 12 18.5 16.4 21 14.7 14.2"/>',
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
    provided: undefined, toasts: [], rerenders: 0, announces: [], i18nMissing: [],
    cleanup: createDisposalStack(), disposeResult: null,
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
import { HOST_CAPABILITIES, HOST_VERSION, compatibilityErrors } from './addon-compat.js';
import { requireCollectionDeclaration, resolveDependency } from './addon-host-contract.js';
import { addDisposer, addReturnedDisposer, createDisposalStack, disposeStack } from './addon-lifecycle.js';
import { createTransactionRunner } from './addon-transactions.js';
import { createAddonImportClient } from './addon-imports.js';
import {
  createScopedI18n,
  validateCatalogPackage,
} from './addon-i18n.js';

export function validateAddonCatalogs(meta = {}, catalogs = {}) {
  return validateCatalogPackage(meta.locales, catalogs, meta);
}

export function createMockHost(meta = {}, opts = {}) {
  meta = { version: '0.0.0', apiVersion: 1, hostVersion: '>=1.0.0', ...meta };
  const hostCapabilities = opts.capabilities
    ? new Set(opts.capabilities)
    : HOST_CAPABILITIES;
  const compatibility = compatibilityErrors(meta, hostCapabilities);
  if (compatibility.length) throw new Error(compatibility.join('; '));
  const id  = meta.id || 'mock-addon';
  const rec = _emptyRec();
  const fx  = opts.fixtures || {};
  const get = (k) => Array.isArray(fx[k]) ? fx[k] : [];
  let catalogs = { en: {} };
  if (meta.locales !== undefined) {
    const localization = validateCatalogPackage(meta.locales, opts.catalogs, meta);
    if (!localization.ok) throw new Error(localization.errors.join('; '));
    catalogs = localization.catalogs;
  }
  const scopedI18n = createScopedI18n({
    addonId: id,
    catalogs,
    getLocale: typeof opts.getLocale === 'function'
      ? opts.getLocale
      : () => opts.locale || 'en',
    onMissing: ({ key }) => {
      rec.i18nMissing.push(key);
    },
  });

  // Permission gate — mirrors web/js/addons.js (_makeHost): same permission
  // per method, same error text. `null` grants (no `permissions` key) = loose.
  const grants = Array.isArray(meta.permissions) ? meta.permissions.slice() : null;
  const need = (perm, what) => {
    if (grants && !grants.includes(perm)) {
      throw new Error(`Doplněk „${id}" nemá udělené oprávnění „${perm}" (${what}).`);
    }
  };
  const registeredCollections = new Set();
  const transactionDescriptors = new Map();
  const collectionVersions = new Map();
  const transactionLeases = new Map();
  const declaration = (name) => (Array.isArray(meta.collections) ? meta.collections : [])
    .find((entry) => entry && entry.name === name);
  const canAccess = (name) => declaration(name)?.access !== 'dm' || !!opts.isDM;

  // A MUTABLE backing store for the scoped-CRUD mock, seeded from fixtures.
  // save()/remove() actually mutate it (and getCollection reads it) so a
  // "save then read back" author test behaves like production instead of
  // silently passing on a no-op mock.
  const _collStore = {};
  const _coll = (name) => {
    if (_collStore[name]) return _collStore[name];
    const seeded = fx['collection:' + name];
    _collStore[name] = declaration(name)?.keyed
      ? { ...((seeded && !Array.isArray(seeded) && typeof seeded === 'object') ? seeded : {}) }
      : (Array.isArray(seeded) ? seeded.slice() : []);
    return _collStore[name];
  };
  const bumpCollection = name => collectionVersions.set(name, (collectionVersions.get(name) || 0) + 1);

  // Mirror the REAL scoped-CRUD shape: get() filters by id, save() generates a
  // missing id + stamps updatedAt + upserts, remove() deletes by id.
  const collectionHandle = (name) => ({
    list:   () => {
      if (!canAccess(name)) return [];
      const data = _coll(name);
      return Array.isArray(data) ? data.slice() : Object.entries(data).map(([key, value]) => ({ id: key, ...value }));
    },
    get:    (itemId) => {
      if (!canAccess(name)) return null;
      const data = _coll(name);
      return Array.isArray(data) ? data.find(x => x && x.id === itemId) || null : data[itemId] || null;
    },
    save:   (item) => {
      if (!canAccess(name)) throw new Error(`store.collection: "${name}" is not available for this role`);
      const data = _coll(name);
      const r = { ...item };
      if (!r.id) r.id = _slugify((item && item.name) || name) + '_mock';
      r.updatedAt = 0;
      if (Array.isArray(data)) {
        const i = data.findIndex(x => x && x.id === r.id);
        if (i >= 0) data[i] = r; else data.push(r);
      } else {
        data[r.id] = { ...r };
        delete data[r.id].id;
      }
      bumpCollection(name);
      return r;
    },
    remove: (itemId) => {
      if (!canAccess(name)) throw new Error(`store.collection: "${name}" is not available for this role`);
      const data = _coll(name);
      if (Array.isArray(data)) {
        const i = data.findIndex(x => x && x.id === itemId);
        if (i >= 0) data.splice(i, 1);
      } else {
        delete data[itemId];
      }
      bumpCollection(name);
    },
  });

  const transactionCapabilities = [
    ...(meta.capabilities?.required || []),
    ...(meta.capabilities?.optional || []),
  ];
  const transactionEnabled = meta.apiVersion === 2
    && transactionCapabilities.includes('collections.transactions')
    && (!grants || grants.includes('data:own'));
  const transaction = createTransactionRunner({
    descriptors: transactionDescriptors,
    transport: {
      begin: async (names, transactionOpts = {}) => {
        if (!transactionEnabled) {
          const capabilityError = new Error('Addon did not negotiate collections.transactions');
          capabilityError.code = 'TX_CAPABILITY_REQUIRED';
          throw capabilityError;
        }
        const timeoutMs = transactionOpts.timeoutMs ?? 5000;
        const transactionId = `mock-tx-${transactionLeases.size + 1}`;
        const snapshot = {};
        const revisions = {};
        for (const name of names) {
          const descriptor = transactionDescriptors.get(name);
          if (!descriptor || (descriptor.access === 'dm' && !opts.isDM)) {
            const missing = new Error('Collection not found');
            missing.code = 'TX_NOT_FOUND';
            throw missing;
          }
          snapshot[name] = structuredClone(_coll(name));
          revisions[name] = String(collectionVersions.get(name) || 0);
        }
        const deadline = Date.now() + timeoutMs;
        transactionLeases.set(transactionId, { names, revisions, deadline });
        return { transactionId, snapshot, revisions, deadline };
      },
      commit: async (transactionId, operations) => {
        const lease = transactionLeases.get(transactionId);
        transactionLeases.delete(transactionId);
        if (!lease || lease.deadline <= Date.now()) {
          const expired = new Error('Transaction expired');
          expired.code = 'TX_EXPIRED';
          throw expired;
        }
        for (const name of lease.names) {
          if (String(collectionVersions.get(name) || 0) !== lease.revisions[name]) {
            const conflict = new Error('Transaction snapshot is stale');
            conflict.code = 'TX_CONFLICT';
            throw conflict;
          }
        }
        const staged = new Map(lease.names.map(name => [name, structuredClone(_coll(name))]));
        for (const operation of operations) {
          const descriptor = transactionDescriptors.get(operation.collection);
          const data = staged.get(operation.collection);
          if (descriptor.keyed) {
            if (operation.op === 'put') {
              data[operation.id] = structuredClone(operation.value);
              delete data[operation.id].id;
            } else delete data[operation.id];
          } else {
            const index = data.findIndex(item => item && item.id === operation.id);
            if (operation.op === 'put') {
              const value = { ...structuredClone(operation.value), id: operation.id };
              if (index >= 0) data[index] = value; else data.push(value);
            } else if (index >= 0) data.splice(index, 1);
          }
        }
        const changed = [];
        for (const [name, data] of staged) {
          if (JSON.stringify(data) === JSON.stringify(_coll(name))) continue;
          _collStore[name] = data;
          bumpCollection(name);
          changed.push(name);
        }
        return {
          ok: true,
          commitId: changed.length ? `mock-commit-${Date.now()}` : null,
          changed,
          collections: Object.fromEntries(lease.names.map(name => [name, structuredClone(_coll(name))])),
          revisions: Object.fromEntries(lease.names.map(name => [name, String(collectionVersions.get(name) || 0)])),
        };
      },
      cancel: async transactionId => {
        transactionLeases.delete(transactionId);
        return { ok: true };
      },
    },
  });

  const importClient = createAddonImportClient({
    addonId: id,
    enabled: meta.apiVersion === 2
      && [
        ...(meta.capabilities?.required || []),
        ...(meta.capabilities?.optional || []),
      ].includes('imports.providers')
      && (!Array.isArray(meta.permissions) || meta.permissions.includes('data:import-provider')),
    isDM: () => !!opts.isDM,
    fetchImpl: opts.fetch || globalThis.fetch,
    FormDataImpl: opts.FormData || globalThis.FormData,
    AbortControllerImpl: opts.AbortController || globalThis.AbortController,
  });
  addDisposer(rec.cleanup, () => importClient.dispose());

  const host = {
    id,
    apiVersion: 2,
    hostVersion: HOST_VERSION,
    contentRevision: typeof meta.contentRevision === 'string' ? meta.contentRevision : '',
    capabilities: Object.freeze({ has: (capability) => hostCapabilities.has(capability), supported: Object.freeze([...hostCapabilities]) }),
    permissions: Array.isArray(meta.permissions) ? meta.permissions.slice() : [],
    i18n: scopedI18n,
    action: (name) => id + ':' + name,

    registerRoute:        (segment, render)   => { need('ui:route', 'registerRoute'); rec.routes.push({ segment, render }); },
    registerSidebarPage:  (spec)              => { need('ui:sidebar', 'registerSidebarPage'); rec.sidebar.push(spec); },
    registerPageRenderer: (kind, render)      => { need('ui:route', 'registerPageRenderer'); rec.pages.push({ kind, render }); },
    registerArticleSection: (kind, fn)        => { need('ui:article-section:' + kind, 'registerArticleSection'); rec.articleSections.push({ kind, fn }); },
    registerSettingsTab:  (spec)              => { need('ui:settings-tab', 'registerSettingsTab'); rec.settingsTabs.push(spec); },
    registerAction:       (name, fn)          => { need('ui:action', 'registerAction'); rec.actions.push({ name, fn }); },
    registerCollection:   (name)              => {
      need('data:own', 'registerCollection');
      requireCollectionDeclaration(meta, name);
      if (registeredCollections.has(name)) throw new Error(`registerCollection: "${name}" already registered`);
      registeredCollections.add(name);
      const collectionDeclaration = requireCollectionDeclaration(meta, name);
      transactionDescriptors.set(name, {
        keyed: !!collectionDeclaration.keyed,
        access: collectionDeclaration.access === 'dm' ? 'dm' : 'public',
      });
      rec.collections.push({ name, keyed: !!requireCollectionDeclaration(meta, name).keyed,
        access: requireCollectionDeclaration(meta, name).access === 'dm' ? 'dm' : 'public' });
    },
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
    use:     (depId) => {
      return resolveDependency(meta, depId, (dependencyId) => opts.deps && opts.deps[dependencyId]);
    },
    onDispose: (fn) => addDisposer(rec.cleanup, fn),
    imports: importClient,

    store: {
      generateId:    (n) => _slugify(n || 'id') + '_mock',
      getCharacters: () => { need('data:read:characters', 'store.getCharacters'); return get('characters'); },
      getLocations:  () => { need('data:read:locations', 'store.getLocations'); return get('locations'); },
      getEvents:     () => { need('data:read:events', 'store.getEvents'); return get('events'); },
      getMysteries:  () => { need('data:read:mysteries', 'store.getMysteries'); return get('mysteries'); },
      getFactions:   () => { need('data:read:factions', 'store.getFactions'); return fx.factions || {}; },
      getCollection: (n) => {
        if (typeof n === 'string' && n.startsWith('addon:')) throw new Error(`Doplněk „${id}" nemůže přes getCollection číst kolekci jiného doplňku.`);
        need('data:read:' + n, 'store.getCollection');
        const data = _coll(n);
        return Array.isArray(data) ? data.slice() : { ...data };
      },
      collection:    (n) => {
        if (!registeredCollections.has(n)) throw new Error(`store.collection: "${n}" not registered (call host.registerCollection first)`);
        return collectionHandle(n);
      },
      transaction,
      // Real patchAddonData returns the SAVED ENTITY ({...entity, addonData}),
      // not the namespace — mirror that so a renderer reading `.addonData[id]`
      // off the return works the same in tests as in prod.
      patchAddonData: (collection, itemId, fn) => {
        need('data:write:' + collection + '.addonData', 'store.patchAddonData');
        return { id: itemId, addonData: { [id]: (typeof fn === 'function' ? (fn({}) || {}) : {}) } };
      },
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
      // Mirrors ui.announce (utils.announce): screen-reader status line via
      // the host's persistent live region — recorded so tests can assert it.
      announce: (m) => { rec.announces.push(String(m == null ? '' : m)); },
    },
  };
  return { host, rec, dispose: () => disposeMockHost(rec) };
}

function _clearRegistrations(rec) {
  for (const key of [
    'routes', 'pages', 'sidebar', 'settingsTabs', 'actions', 'collections',
    'wikiKinds', 'editorFields', 'fragmentOps', 'articleSections', 'slots',
    'kinds', 'connectionKinds', 'nodeKinds', 'graphViews', 'graphContributors',
  ]) {
    rec[key].length = 0;
  }
  rec.provided = undefined;
}

export async function disposeMockHost(rec, opts = {}) {
  const result = await disposeStack(rec.cleanup, opts);
  if (result.started) _clearRegistrations(rec);
  rec.disposeResult = result;
  return result;
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
  try {
    addReturnedDisposer(rec.cleanup, register(host));
    return { ok: true, rec, dispose: () => disposeMockHost(rec) };
  } catch (e) {
    rec.disposePromise = disposeStack(rec.cleanup).then((result) => { rec.disposeResult = result; return result; });
    _clearRegistrations(rec);
    return { ok: false, rec, error: (e && e.message) || String(e), dispose: () => rec.disposePromise };
  }
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
