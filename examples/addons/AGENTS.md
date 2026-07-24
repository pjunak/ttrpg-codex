# AGENTS.md — building a CodexHost addon (for AI agents)

> **What this is.** Instructions for an AI assistant (Claude Code, Cursor, …)
> writing an addon for **O Barvách Draků** (the CodexHost addon framework).
> **Copy this file to the root of the addon's own GitHub repo** so the agent
> working there has the rules in context. The long-form human reference is
> [`AUTHORING.md`](AUTHORING.md); the design-token map is `web/css/STYLE.md` in
> the host repo. When this file and AUTHORING.md disagree, AUTHORING.md wins —
> tell the user.

An addon is a GitHub repo the DM installs from a URL. **No build step** (browser
ES modules), **no clobbering CSS** (reuse the host design system). The host loads
your `entry.js` and calls its default-export `register(host)`. You only ever
reach the app through the `host` facade — there are no globals.

---

## Hard invariants — violating any of these breaks the addon

1. **`entry.js` default-exports `register(host)`.** Optional server code is a
   separate CommonJS file that **exports `init(serverHost)`**.
2. **`addon.json` is at the repo root.** New addons use `apiVersion` **`2`**;
   legacy API-v1 addons remain supported.
   `id` matches `^[a-z0-9][a-z0-9-]{1,38}$` (lowercase, hyphens, **no
   underscores**) and equals the repo/dir name. `version` is semver;
   API-v2 `hostVersion` (e.g. `">=1.0.0"`) is required and enforced.
3. **Request exactly the permissions you use** in `permissions[]`, no more. An
   ungranted capability **throws** (caught, shown as an error). Each register
   method needs its specific token (table below).
4. **All HTML goes through `host.h`.** Escape every dynamic value with
   `host.h.esc(...)`. Wire every handler with `host.h.dataAction(...)` /
   `host.h.dataOn(...)`. **Never** write inline `onclick`/`onchange`, and never
   interpolate unescaped user/data text (keeps the app CSP-clean + XSS-safe).
5. **No literal colours / spacing / sizes.** Use `var(--token)` only (see
   `web/css/STYLE.md`) and the documented component classes. This is what lets
   the theme switcher re-skin your addon for free.
6. **Namespace everything.** Build action strings with `host.action(name)` →
   `"<id>:<name>"`. Don't shadow a built-in route, wiki scope, or collection.
7. **Renderers must tolerate sparse/empty input and never throw** — a load-time
   smoke test calls them with a minimal sample entity. Guard optional fields
   (`c?.addonData?.[host.id] ?? {}`).
8. **`register()` is side-effect-free except for `register*` calls.** Do data
   work (reads/writes, fetches) inside actions/renderers, never at register time.
   A throw in `register()` rolls back every partial registration. Register
   cleanup with `host.onDispose(fn)` or return a cleanup function for every
   timer, listener, request, observer, overlay, or cache you own.
9. **Addon-owned collections are declared in `addon.json` `collections[]`
   before `registerCollection`.** DM access additionally requires API v2,
   `collections.dm`, and effective-DM registration. Wiki-kind resolvers look targets up **by name
   → real id** (ids carry a random suffix; never assume the slug).
10. **Write code and the mandatory source catalog in English.** Localized UI
   uses API v2, requires `i18n.catalogs`, declares a `locales` map with complete
   `en`, and renders through scoped `host.i18n`. Translations may be partial.

---

## `addon.json` skeleton

```json
{
  "id": "my-addon",
  "name": "My Addon",
  "version": "0.1.0",
  "apiVersion": 2,
  "hostVersion": ">=1.0.0",
  "entry": "entry.js",
  "permissions": ["ui:route", "ui:sidebar"],
  "summary": "One line shown in the install wizard."
}
```
Add only the fields you need: `server` (`.cjs`, needs `server:code`),
`contentDir` (per-record JSON tree the HOST serves — the data-addon seam,
see below), `serverDeps` (subset of `express` `archiver` `multer`; archive
readers are deliberately unavailable),
`capabilities` (API-v2 `{required, optional}`; advertised:
`collections.dm`, `collections.transactions`, `lifecycle.dispose`,
`content.revision`, `i18n.catalogs`, `imports.providers`, `graphs.facade`),
`locales` (`{ "en": "locales/en.json", "cs": "locales/cs.json" }`; API v2,
requires `i18n.catalogs`; English is mandatory/complete, translations partial),
`collections` (`[{ "name": "x", "keyed": false, "access": "public" }]`, name
`^[a-z0-9][a-z0-9_]{0,39}$`; `dm` access requires API v2 plus
`collections.dm` in `capabilities.required`),
`dependencies` (HARD — `{ "<id>": { "range": ">=1.0.0", "repo": "owner/name" } }`;
missing/incompatible → your addon loads `blocked`),
`optionalDependencies` (same shape, SOFT — load-ordered after the provider
when present, NEVER blocks when absent; `host.use()` then throws → catch it
and run standalone),
`tests` (`{ "server": "tests/srv.cjs" }` — an explicit path or `string[]`,
**never a glob**).

---

## `host` facade — registration methods (each needs its permission)

| Method | Permission | Notes |
|---|---|---|
| `registerRoute(seg, render)` | `ui:route` | `#/<seg>/…`; `render(sub, parts) → html`. |
| `registerSidebarPage({route,label,icon?,section?,role?})` | `ui:sidebar` | Left-nav link (under "Doplňky"). |
| `registerPageRenderer(kind, render)` | `ui:route` | Provide a `Wiki.renderPage(kind)` page. |
| `registerArticleSection(kind, fn, {order?})` | `ui:article-section:<kind>` | `fn(entity) → {title, html} \| null`. Stacks. |
| `registerEditorFields(kind, {fields, collect})` | `ui:editor-fields:<kind>` | `fields(entity)→html`, `collect(scope,entity)→obj` merged into `addonData[id]` on save. (`characters`.) |
| `registerSettingsTab({id,label,icon?,role?,render})` | `ui:settings-tab` | `render() → html`. Renders as a SUB-tab of Nastavení → Doplňky (beside the DM-only Manager), not a top-level tab. |
| `registerAction(name, fn)` | `ui:action` | For `data-action="<id>:<name>"`. |
| `registerCollection(name)` | `data:own` | Must be in the role-authorized manifest `collections[]`. Register DM collections only when `host.role.isDM()`. |
| `registerWikiKind(scope, resolve)` | `wiki:kind` | `resolve(label) → {kind, id} \| null`. |
| `registerFragmentOp(target, {op, render?, order?, position?})` | `ui:override` | `op`: `replace`/`hide` (EXCLUSIVE) · `wrap`/`insert` (stack). An exclusive claim on `<kind>:body` = full-width takeover: the host folds the side-card + ALL sections into the body html your render receives (the whole wiki profile), and `<kind>:section:*` ids don't exist on that page. |
| `registerSlot(slotId, render, {order?})` | `ui:slot:<surface>` | Content into a named slot (any surface; `<surface>` = slotId's 1st `:`-seg). `render(ctx)→{html}\|string\|null`. Slots: `dashboard:section` (ctx `{role}`), `map:pin:panel` (ctx `{location,pin,role}`), `timeline:card:extra`, `timeline:column:header\|footer`, `timeline:toolbar`. `ctx.role.isDM` is a **boolean**, not a function. |
| `registerKind(domain, {id,label,color?,…})` | `kinds:<domain>` | Pure-DATA enum kind merged into `Store.getKinds(domain)`. Domains: `connections`/`statuses`/`priorities`/`attitudes`/`genders`/`pinTypes`. Id → `<addonId>:<id>`. Renders wherever that kind's label/colour does; NOT an editable Settings row. |
| `registerConnectionKind({id,label,color,style,dirs?,target?})` | `kinds:connections` | Alias for `registerKind('connections', …)`. In rel editor + mind-map edges. Id → `<addonId>:<id>`. |
| `registerNodeKind({id,shape?,cardHTML,height?,searchText?,detailHash?})` | `kinds:graph` | Mind-map node type; `cardHTML(node)` emits a `.cm-cloud` card. |
| `registerGraphView({id,label,build})` | `kinds:graph` | Mind-map "mode"; `build()→{nodes,edges}`; at `#/mapa/<addonId>:<id>`. |
| `registerGraphContributor(viewId, fn)` | `graph:contribute` | Inject into an existing view (`vztahy`/`frakce`/…); `fn()→{nodes,edges}`. |
| `provide(api)` / `use(depId)` | — | Inter-addon API (declare the dep first — hard or optional). |

**Data/rulebook addons:** declare manifest `"contentDir": "data"` and ship a
per-record JSON tree (`data/<dir>/<id>.json`, kinds keyed by each record's
`kind` field) — the HOST serves `/api/addon/<id>/{content,content/:kind,item/:kind/:id,kinds}`
for you: no server code, no `server:code` grant, no restart to load. Optionally
declare `"contentGroups": {field, label?}` (e.g. `field: "book"`) so the DM can
toggle whole record groups on/off in Settings — the host filters the served
tree hot without a browser reload, changes `host.contentRevision`, and
disposes/re-registers the addon plus its loaded hard/optional consumers. A
content addon that relies on this must use API v2 and require
`lifecycle.dispose` + `content.revision`. Each toggle is labelled by the `name`
of the field-named kind's matching record (ship a `book` record per book)
(full docs: AUTHORING.md). Only write a `server` module for real logic.

**Other facade members** (always present unless noted):
```js
host.id · host.apiVersion (2) · host.hostVersion · host.permissions[]
host.capabilities.has(id) · host.contentRevision · host.onDispose(fn)
host.action(name)
host.asset(rel)   // → /addons/<id>/<hash>/<rel> — URL of a bundled file (images…)
host.i18n = { locale, t, plural, formatDate, formatNumber, relativeTime }
host.graphs = { apiVersion, available, status, mount } // graphs.facade + ui:graph
host.h    = { esc, dataAction, dataOn, renderMarkdown, slugify, breadcrumb }
//            breadcrumb([{label, href?}, …]) — the core wayfinding row (last crumb
//            = current page); use it instead of hand-rolled "← Back" links
host.role = { isDM(), isAnonymous() }
host.ui   = { toast(msg), rerender() }          // rerender after a write
host.store.generateId(name)                      // always
host.store.getCharacters() / getLocations() / getEvents() / getMysteries() / getFactions()   // each needs data:read:<coll>
host.store.getCollection(name)                   // data:read:<name> → array
host.store.collection(name)                      // data:own → { list(), get(id), save(item), remove(id) }
await host.store.transaction(names, callback)    // API v2 + collections.transactions + data:own
host.store.patchAddonData(coll, id, fn)          // data:write:<coll>.addonData — RMW your namespace only
```
There is **no way to call one action from another** — factor shared logic into a
local function and reuse it.

`host.i18n` is isolated to this addon and resolves exact locale → base locale →
English → key. `t()`/`plural()` return plain text, so escape their results in
HTML. Locale files are bounded regular JSON files inside the package; supplied
translations must preserve each English value's string/plural shape and exact
`{placeholder}` set. Install/update disposal clears instance-owned catalog
caches and prevents stale responses from reaching a replacement.

`register(host)` may return another cleanup function. Each cleanup runs exactly
once in LIFO order before ordinary registrations are reversed. Promise cleanup
is allowed and bounded to two seconds per addon; rejection/timeout is isolated.
Disposal occurs on disable, removal, replacement, or content-revision change,
consumer-first; reload is provider-first.

**Interactive graphs:** require API-v2 `graphs.facade`,
`lifecycle.dispose`, and permission `ui:graph`. Mount only after a
`.codex-graph-canvas` inside your addon route exists:
`await host.graphs.mount(container, {nodes,edges,layout,accessibleLabel})`.
The returned handle exposes only `update`, `select`, `focus`, `fit`, documented
events, and idempotent `destroy`. Never import/use Cytoscape, raw graph globals,
selectors, styles, plugins, or implementation events. Navigation and unload
destroy host-owned handles; also cancel addon-owned scheduled mount work.

---

## Style contract (non-negotiable)

```js
const { esc, dataAction, dataOn } = host.h;
// tokens + component classes, host.h for handlers, esc for text:
`<button class="inline-create-btn"${dataAction(host.action('go'), id)}>Akce</button>
 <p style="color:var(--text-muted);margin-top:var(--space-2)">${esc(note)}</p>`
// Shared component classes (widgets.css): .codex-tip/.codex-pop popover
// legends · .codex-tab-strip/.codex-tab tab bars · .codex-tile stat tiles ·
// .codex-warnings · .codex-stepper. Widget mounts work in addon HTML too:
// .tf-mount (TagFilter) is generic; .cb-mount/.ms-mount sources are
// host characters/locations only.
```
Real tokens: `--text-parchment` `--text-cream` `--text-muted` `--accent-gold`
`--bg-raised` `--bg-surface` `--color-danger` `--color-success` · spacing
`--space-1..6` · type `--text-xs..3xl` · radius `--radius` `--radius-sm/lg`.
Real classes: `.page-header` `.inline-create-btn` `.edit-input` `.edit-section`
`.edit-section-title` `.settings-panel` `.settings-hint` `.char-section`
`.md-view`. (Full list: `web/css/STYLE.md`.)

---

## Server code (only with `server:code`)

`server/index.cjs`, CommonJS, `exports.init(serverHost)`. Routes mount under
`/api/addon/<id>/*`. `serverHost`: `get/post/put/delete(subpath, handler)` +
`router`; `data.{read(name), write(name, obj), dir}` (confined to your dir —
`host.data.write` already locks, so never call it inside `host.withLock`);
`readCollection(name)` (needs `data:read:<name>`); `lib(name)` (vetted only);
`withLock(fn)`; `broadcastDataChanged()`; `log(...)`. `req.role`/`req.realRole`
are stamped — self-gate sensitive routes. **Restart-to-load**: server code
activates on the next server restart (the Manager shows `🖥 restart serveru`).
A throw in `init` is isolated — it never crashes the host.

An import provider additionally requires API v2 capability
`imports.providers`, capability `collections.transactions` (and
`collections.dm` for DM targets), permissions `server:code`, `data:own`, and
`data:import-provider`, plus declared own collections. Register with
`serverHost.registerImportProvider(descriptor)`. Provider API v1 accepts only
strict JSON and commits only put operations to the registering addon's own
declared list/keyed collections. Declare explicit `{scope, addonId?,
collection}` reads/writes; core reads need `data:read:<collection>`, while
core writes and cross-addon access are unsupported. The preview callback gets
parsed cloned input, declared read snapshots/revisions, and an `AbortSignal`;
it never gets paths, locks, journals, transactions, passwords, or Store.
Return `{schemaVersion, operations, diagnostics}`. Put identity in
`operation.id`, not `value.id`; host-owned namespace/access/revision/audit
metadata is forbidden. The host binds the validated plan to a single-use
token and commits that exact plan through F2.

---

## Self-check before publishing

```js
// tests/<name>.mjs  — author test against the published harness
import { test } from 'node:test';
import assert from 'node:assert/strict';
import register from '../entry.js';
import { disposeMockHost, dryRunRegister, smokeRegistrations, validateAddonCatalogs } from '<host>/web/js/addon-test-harness.mjs';

test('registers + smokes clean', () => {
  const { ok, rec, error } = dryRunRegister(register, { id: 'my-addon', permissions: [/* … */] });
  assert.ok(ok, error);
  assert.ok(smokeRegistrations(rec).ok);   // renderers survive sample input
  return disposeMockHost(rec);
});
```
- The mock uses the live dependency/declaration/capability/catalog checks. Pass
  `opts.catalogs` and `opts.locale` to test locale switching and fallback;
  `validateAddonCatalogs(meta, catalogs)` exposes the package guard and
  `rec.i18nMissing` records exercised keys absent from English. Test
  `host.use()`, public and DM collection roles, keyed/list CRUD, disposal order/idempotence, and failed
  registration cleanup. `dryRunRegister` also returns a bound `dispose()`.
- `tests.server` (CommonJS) is the **green-gate run at install** — it must be
  **self-contained** (Node built-ins + your own files; the staged tree has no
  `node_modules`, so it can't import the harness). It receives only the host's
  minimal path/temp/home/locale environment allowlist; deployment variables and
  secrets are absent. A red set blocks the install.
- A renderer that throws on the load-time smoke shows a `⚠ test vykreslení` chip
  in the Manager — fix it.

**Local dev loop** (needs a checkout of the host repo): from the host repo run
`node scripts/dev-install-addon.cjs <path-to-your-addon>` then launch the app;
the addon loads at boot. Iterate, re-run to reinstall.

---

## Minimal correct addon (route + sidebar + action + own collection)

```jsonc
// addon.json
{
  "id": "notes", "name": "Notes", "version": "0.1.0",
  "apiVersion": 2, "hostVersion": ">=1.0.0", "entry": "entry.js",
  "permissions": ["ui:route", "ui:sidebar", "ui:action", "data:own"],
  "collections": [{ "name": "notes", "keyed": false }],
  "summary": "A simple notes page."
}
```
```js
// entry.js
export default function register(host) {
  const { esc, dataAction, dataOn } = host.h;
  host.registerCollection('notes');
  const notes = () => host.store.collection('notes');
  host.registerSidebarPage({ route: '/notes', label: 'Notes', icon: '📝' });

  function add() {
    const el = document.getElementById('note-input');
    const text = (el?.value || '').trim();
    if (!text) return;
    notes().save({ text });            // upsert; id generated if missing
    host.ui.toast('Added');
    host.ui.rerender();
  }
  host.registerAction('add', add);
  host.registerAction('addOnEnter', (ev) => { if (ev?.key === 'Enter') { ev.preventDefault(); add(); } });
  host.registerAction('del', (id) => { notes().remove(id); host.ui.rerender(); });

  host.registerRoute('notes', () => {
    const items = notes().list();
    const rows = items.length
      ? items.map(n => `<li>${esc(n.text)} <button class="inline-create-btn"${dataAction(host.action('del'), n.id)}>×</button></li>`).join('')
      : `<li style="color:var(--text-muted)">Nothing yet.</li>`;
    const canEdit = !host.role.isAnonymous();
    return `
      <div class="page-header"><h1>📝 Notes</h1></div>
      <ul style="line-height:1.9;margin-top:var(--space-3)">${rows}</ul>
      ${canEdit ? `<div style="display:flex;gap:var(--space-2);margin-top:var(--space-3);max-width:32rem">
        <input id="note-input" class="edit-input" style="flex:1" placeholder="New note"${dataOn('keydown', host.action('addOnEnter'), '$ev')}>
        <button class="inline-create-btn"${dataAction(host.action('add'))}>＋ Add</button>
      </div>` : ''}`;
  });
}
```

For everything else (per-entity `addonData`, fragment overrides + conflicts,
dependencies, full server example), read [`AUTHORING.md`](AUTHORING.md) and the
worked examples under `examples/addons/` in the host repo.
