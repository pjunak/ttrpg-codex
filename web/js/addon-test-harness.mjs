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

/** A fresh, blank registration record. */
function _emptyRec() {
  return {
    routes: [], pages: [], sidebar: [], settingsTabs: [], actions: [],
    collections: [], wikiKinds: [], editorFields: [], fragmentOps: [],
    articleSections: [], provided: undefined, toasts: [], rerenders: 0,
  };
}

/**
 * Build a recording mock of the host facade. Mirrors the real method names
 * (so tests exercise the real surface) but records instead of mutating any
 * registry. Does NOT enforce permissions — a unit test asserts register LOGIC,
 * not the host's permission gating (covered elsewhere).
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

  // Mirror the REAL scoped-CRUD shape (so author tests don't pass on the mock
  // then break in production): get() filters by id, save() generates a missing
  // id + stamps updatedAt and returns the stored record.
  const collectionHandle = (name) => ({
    list:   () => get('collection:' + name).slice(),
    get:    (itemId) => get('collection:' + name).find(x => x && x.id === itemId) || null,
    save:   (item) => {
      const rec = { ...item };
      if (!rec.id) rec.id = _slugify((item && item.name) || name) + '_mock';
      rec.updatedAt = 0;
      return rec;
    },
    remove: () => {},
  });

  const host = {
    id,
    apiVersion: 1,
    permissions: Array.isArray(meta.permissions) ? meta.permissions.slice() : [],
    action: (name) => id + ':' + name,

    registerRoute:        (segment, render)   => { rec.routes.push({ segment, render }); },
    registerSidebarPage:  (spec)              => { rec.sidebar.push(spec); },
    registerPageRenderer: (kind, render)      => { rec.pages.push({ kind, render }); },
    registerArticleSection: (kind, fn)        => { rec.articleSections.push({ kind, fn }); },
    registerSettingsTab:  (spec)              => { rec.settingsTabs.push(spec); },
    registerAction:       (name, fn)          => { rec.actions.push({ name, fn }); },
    registerCollection:   (name, o)           => { rec.collections.push({ name, opts: o }); },
    registerWikiKind:     (scope, resolve)    => { rec.wikiKinds.push({ scope, resolve }); },
    registerEditorFields: (kind, spec)        => { rec.editorFields.push({ kind, spec }); },
    registerFragmentOp:   (target, spec)      => { rec.fragmentOps.push({ target, spec }); },

    provide: (api)   => { rec.provided = api; },
    use:     (depId) => (opts.deps ? opts.deps[depId] : undefined),

    store: {
      generateId:    (n) => _slugify(n || 'id') + '_mock',
      getCharacters: () => get('characters'),
      getLocations:  () => get('locations'),
      getEvents:     () => get('events'),
      getMysteries:  () => get('mysteries'),
      getFactions:   () => fx.factions || {},
      getCollection: (n) => get('collection:' + n),
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
    h: { esc: _esc, slugify: _slugify, dataAction: _dataAction, dataOn: _dataOn,
         renderMarkdown: (s) => _esc(s) },
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
  return { ok: failures.length === 0, failures };
}
