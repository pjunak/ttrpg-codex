// Unit tests for the data-driven sidebar layout: Store.getSidebarLayout
// (registry reconciliation) + setSidebarLayout + the hiddenSidebarPages
// shims. No fetch/load — `_sync` no-ops while `_serverAvailable` is
// false, so saves mutate the in-memory `_data` and read straight back.
//
// NOTE: these tests share one Store singleton (per-file), so the first
// test asserts the *unsaved* default; every later test sets its own
// layout via setSidebarLayout before reading.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = globalThis.window || { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = globalThis.document || { createElement: () => ({}) };

const { Store } = await import('../web/js/store.js');
const { SIDEBAR_PAGES, SIDEBAR_LAYOUT_DEFAULT } = await import('../web/js/constants.js');

const allRoutes = (layout) => [...layout.sections.flatMap(s => s.pages), ...layout.hidden];
const cloneDefault = () => JSON.parse(JSON.stringify(SIDEBAR_LAYOUT_DEFAULT));
const secById = (layout, id) => layout.sections.find(s => s.id === id);

test('default layout seeds every registry page exactly once (runs first — no saved layout)', () => {
  const layout = Store.getSidebarLayout();
  const routes = allRoutes(layout);
  for (const p of SIDEBAR_PAGES) {
    assert.ok(routes.includes(p.route), `default layout missing registry route ${p.route}`);
  }
  assert.equal(routes.length, new Set(routes).size, 'no route appears twice');
  for (const id of ['prehled', 'kampan', 'svet', 'kompendium', 'dm']) {
    assert.ok(secById(layout, id), `default section ${id} missing`);
  }
  assert.equal(secById(layout, 'kompendium').collapsible, true, 'Kompendium is collapsible');
  assert.equal(secById(layout, 'dm').role, 'dm', 'DM section is role-gated');
});

test('reconcile: a registry page missing from the saved layout returns to its home section', () => {
  const custom = cloneDefault();
  const svet = secById(custom, 'svet');
  svet.pages = svet.pages.filter(r => r !== '/frakce');   // user-removed-but-still-a-real-route
  Store.setSidebarLayout(custom);

  const svet2 = secById(Store.getSidebarLayout(), 'svet');
  assert.ok(svet2.pages.includes('/frakce'), '/frakce re-added to its home section (svet)');
});

test('reconcile: a new registry page whose home section was deleted lands in hidden', () => {
  // Only a single section survives; every other page has no home → hidden.
  Store.setSidebarLayout({
    sections: [{ id: 'svet', label: 'Svět', icon: '', collapsible: false, defaultOpen: true, role: '', pages: ['/mista'] }],
    hidden: [],
  });
  const layout = Store.getSidebarLayout();
  const routes = allRoutes(layout);
  for (const p of SIDEBAR_PAGES) assert.ok(routes.includes(p.route), `${p.route} placed somewhere`);
  // e.g. /postavy's home 'svet' exists → goes there; /casova-osa's home 'kampan' is gone → hidden.
  assert.ok(secById(layout, 'svet').pages.includes('/postavy'), '/postavy joins existing home svet');
  assert.ok(layout.hidden.includes('/casova-osa'), '/casova-osa with no home section → hidden');
});

test('reconcile: a route not in the registry is dropped', () => {
  const custom = cloneDefault();
  secById(custom, 'prehled').pages.push('/totally-bogus-route');
  Store.setSidebarLayout(custom);
  assert.equal(allRoutes(Store.getSidebarLayout()).includes('/totally-bogus-route'), false);
});

test('reconcile: a route present in two sections is kept once (first wins)', () => {
  const custom = cloneDefault();
  secById(custom, 'kampan').pages.push('/mista');   // /mista already lives in svet
  Store.setSidebarLayout(custom);
  const routes = allRoutes(Store.getSidebarLayout());
  assert.equal(routes.filter(r => r === '/mista').length, 1, '/mista appears exactly once');
});

test('hidden bucket: hidden routes round-trip and never appear inside a section', () => {
  const custom = cloneDefault();
  const svet = secById(custom, 'svet');
  svet.pages = svet.pages.filter(r => r !== '/mazlicci');
  custom.hidden.push('/mazlicci');
  Store.setSidebarLayout(custom);

  const layout = Store.getSidebarLayout();
  assert.ok(layout.hidden.includes('/mazlicci'), 'stays hidden');
  assert.equal(layout.sections.some(s => s.pages.includes('/mazlicci')), false, 'not re-added to a section');
});

test('setSidebarLayout: normalizes an invalid role to "" and preserves defaultOpen:false', () => {
  const custom = cloneDefault();
  const prehled = secById(custom, 'prehled');
  prehled.role = 'superuser';     // invalid → coerced to ''
  prehled.defaultOpen = false;
  Store.setSidebarLayout(custom);

  const sec = secById(Store.getSidebarLayout(), 'prehled');
  assert.equal(sec.role, '', 'unknown role coerced to ""');
  assert.equal(sec.defaultOpen, false, 'explicit defaultOpen:false preserved');
});

test('hiddenSidebarPages shims: get reflects layout.hidden; set moves routes in/out', () => {
  Store.setSidebarLayout(cloneDefault());
  assert.deepEqual(Store.getHiddenSidebarPages(), [], 'default has nothing hidden');

  Store.setHiddenSidebarPages(['/historie']);
  assert.ok(Store.getHiddenSidebarPages().includes('/historie'));
  const hiddenLayout = Store.getSidebarLayout();
  assert.ok(hiddenLayout.hidden.includes('/historie'), 'routed into hidden');
  assert.equal(hiddenLayout.sections.some(s => s.pages.includes('/historie')), false, 'removed from its section');

  Store.setHiddenSidebarPages([]);
  assert.deepEqual(Store.getHiddenSidebarPages(), [], 'un-hidden');
  assert.ok(secById(Store.getSidebarLayout(), 'kompendium').pages.includes('/historie'),
    '/historie returns to its home section (kompendium)');
});
