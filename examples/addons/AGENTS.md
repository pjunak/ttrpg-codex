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
2. **`addon.json` is at the repo root.** `apiVersion` is **exactly `1`**.
   `id` matches `^[a-z0-9][a-z0-9-]{1,38}$` (lowercase, hyphens, **no
   underscores**) and equals the repo/dir name. `version` is semver;
   `hostVersion` is `">=1.0.0"`.
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
   A throw in `register()` rolls back every partial registration.
9. **Addon-owned collections are declared in `addon.json` `collections[]`
   before `registerCollection`.** Wiki-kind resolvers look targets up **by name
   → real id** (ids carry a random suffix; never assume the slug).
10. **Write the whole addon — UI strings included — in English.** The app's
   language switcher is a visual layer over the *core* UI only; it doesn't reach
   addon code, and there is no addon translation API.

---

## `addon.json` skeleton

```json
{
  "id": "my-addon",
  "name": "My Addon",
  "version": "0.1.0",
  "apiVersion": 1,
  "hostVersion": ">=1.0.0",
  "entry": "entry.js",
  "permissions": ["ui:route", "ui:sidebar"],
  "summary": "One line shown in the install wizard."
}
```
Add only the fields you need: `server` (`.cjs`, needs `server:code`),
`serverDeps` (subset of `express` `adm-zip` `archiver` `multer`),
`collections` (`[{ "name": "x", "keyed": false }]`, name `^[a-z0-9][a-z0-9_]{0,39}$`),
`dependencies` (`{ "<id>": { "range": ">=1.0.0", "repo": "owner/name" } }`),
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
| `registerSettingsTab({id,label,icon?,role?,render})` | `ui:settings-tab` | `render() → html`. |
| `registerAction(name, fn)` | `ui:action` | For `data-action="<id>:<name>"`. |
| `registerCollection(name)` | `data:own` | Must be in manifest `collections[]`. |
| `registerWikiKind(scope, resolve)` | `wiki:kind` | `resolve(label) → {kind, id} \| null`. |
| `registerFragmentOp(target, {op, render?, order?, position?})` | `ui:override` | `op`: `replace`/`hide` (EXCLUSIVE) · `wrap`/`insert` (stack). |
| `provide(api)` / `use(depId)` | — | Inter-addon API (declare the dep first). |

**Other facade members** (always present unless noted):
```js
host.id · host.apiVersion (1) · host.permissions[] · host.action(name)
host.h    = { esc, dataAction, dataOn, renderMarkdown, slugify }
host.role = { isDM(), isAnonymous() }
host.ui   = { toast(msg), rerender() }          // rerender after a write
host.store.generateId(name)                      // always
host.store.getCharacters() / getLocations() / getEvents() / getMysteries() / getFactions()   // each needs data:read:<coll>
host.store.getCollection(name)                   // data:read:<name> → array
host.store.collection(name)                      // data:own → { list(), get(id), save(item), remove(id) }
host.store.patchAddonData(coll, id, fn)          // data:write:<coll>.addonData — RMW your namespace only
```
There is **no way to call one action from another** — factor shared logic into a
local function and reuse it.

---

## Style contract (non-negotiable)

```js
const { esc, dataAction, dataOn } = host.h;
// tokens + component classes, host.h for handlers, esc for text:
`<button class="inline-create-btn"${dataAction(host.action('go'), id)}>Akce</button>
 <p style="color:var(--text-muted);margin-top:var(--space-2)">${esc(note)}</p>`
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

---

## Self-check before publishing

```js
// tests/<name>.mjs  — author test against the published harness
import { test } from 'node:test';
import assert from 'node:assert/strict';
import register from '../entry.js';
import { dryRunRegister, smokeRegistrations } from '<host>/web/js/addon-test-harness.mjs';

test('registers + smokes clean', () => {
  const { ok, rec, error } = dryRunRegister(register, { id: 'my-addon', permissions: [/* … */] });
  assert.ok(ok, error);
  assert.ok(smokeRegistrations(rec).ok);   // renderers survive sample input
});
```
- `tests.server` (CommonJS) is the **green-gate run at install** — it must be
  **self-contained** (Node built-ins + your own files; the staged tree has no
  `node_modules`, so it can't import the harness). A red set blocks the install.
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
  "apiVersion": 1, "hostVersion": ">=1.0.0", "entry": "entry.js",
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
