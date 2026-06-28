# Writing addons for **O Barvách Draků** (CodexHost)

A living reference for **human and AI** addon authors. If you read only one
section, read **[For AI assistants](#for-ai-assistants)** — it has the
invariants and a complete copy-paste template.

An addon is a GitHub repo the DM installs from a URL. It can add pages, sidebar
links, settings tabs, article sections, editor fields, its own data collections,
wiki-link kinds, override built-in content, and run server-side code — all with
**no build step** (browser-native ES modules) and **no clobbering CSS** (it
reuses the host's design system, so the theme switcher re-skins it for free).

- **Host API version:** `1` (your manifest's `apiVersion` must equal it).
- **Distribution:** one GitHub repo per addon. The DM pastes the URL into the
  install wizard (Nastavení → 🧩 Doplňky).
- **Trust model:** DM-only install, commit-SHA-pinned, in-process. Permissions
  are an enforced **Store boundary** + transparency, not a sandbox — so be a
  good citizen.

---

## 1. Quickstart

A minimal addon is two files at the repo root:

**`addon.json`**
```json
{
  "id": "hello",
  "name": "Pozdrav",
  "version": "0.1.0",
  "apiVersion": 1,
  "hostVersion": ">=1.0.0",
  "entry": "entry.js",
  "permissions": ["ui:route", "ui:sidebar"],
  "summary": "Adds a /pozdrav page."
}
```

**`entry.js`** — a default-export `register(host)`:
```js
export default function register(host) {
  const { esc } = host.h;
  host.registerSidebarPage({ route: '/pozdrav', label: 'Pozdrav', icon: '👋' });
  host.registerRoute('pozdrav', () =>
    `<div class="page-header"><h1>👋 Ahoj!</h1></div>
     <p style="color:var(--text-muted)">Postav v databázi: ${esc(String(host.store.getCharacters?.().length ?? '—'))}</p>`);
}
```

Install it locally for development (no GitHub needed):
```
node scripts/dev-install-addon.cjs ./my-addon
```
Then launch the app — the addon loads at boot and its sidebar link appears under
**Doplňky**.

---

## 2. Repo layout

```
my-addon/
  addon.json              # manifest (required, repo root)
  entry.js                # client ESM, default-export register(host) (required)
  server/index.cjs        # OPTIONAL Node module, exports init(serverHost)
  tests/*.addon-test.mjs  # OPTIONAL self-tests (against the host harness)
  vendor/*.js             # OPTIONAL vendored client libs (import relatively)
```

Everything is served same-origin from `/addons/<id>/<contentHash>/…` so the page
stays CSP-clean. `entry.js` is a real ES module — you may `import './vendor/x.js'`
(relative). Do **not** load remote `<script>`/CDN URLs.

---

## 3. Manifest reference (`addon.json`)

| Field | Req | Notes |
|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]{1,38}$` — lowercase, hyphens, **no underscores**. Must equal the repo's declared id. Becomes the on-disk dir + URL segment + action/data namespace. |
| `name` | ✅ | Human-readable. |
| `version` | ✅ | semver `x.y.z`. Bump on every release. |
| `apiVersion` | ✅ | Must equal the host API version (**`1`**). A mismatch → the addon loads `incompatible`, never registers. |
| `hostVersion` | — | semver range vs the app version (e.g. `">=1.0.0"`). |
| `entry` | ✅ | Relative `.js`/`.mjs` path to the client module (default-export `register`). |
| `server` | — | Relative `.cjs`/`.js` path to a Node module (`exports.init(serverHost)`). Needs the `server:code` permission. |
| `serverDeps` | — | `string[]` of vetted host npm libs your server module needs via `serverHost.lib(...)`. Allowed: `express`, `adm-zip`, `archiver`, `multer`. Anything else → the addon loads `blocked`. |
| `permissions` | — | Declared + **enforced** capability tokens (see §5). The DM reviews + grants them at install. |
| `dependencies` | — | `{ "<otherAddonId>": { "range": ">=1.0.0", "repo": "owner/name" } }` (see §10). |
| `collections` | — | `[{ "name": "rules", "keyed": false }]` — your own data collections (see §8). `name` is `^[a-z0-9][a-z0-9_]{0,39}$`. |
| `tests` | — | `{ "server": "tests/srv.cjs", "client": "tests/cli.mjs" }` — an explicit file path or a `string[]` of them (**not** a glob — `node --test` doesn't expand `*`, so `tests/*.cjs` runs nothing). `tests.server` is a **green-gate run at install** (see §14). |
| `summary` | — | One line shown in the install wizard. |

> **Not supported:** manifest `styles[]`/`vendor[]` auto-loading. Style with the
> design system (§9); vendor client libs by relative `import` from `entry.js`.

---

## 4. The `host` facade

`register(host)` receives a facade **scoped to your granted permissions**. A
capability you didn't request **throws a clear error** (caught + surfaced in the
Manager). `register()` is **transactional** — if it throws, every partial
registration is rolled back and the addon is marked `error` (others still load).

### Identity & helpers (always available)
```js
host.id            // your addon id
host.apiVersion    // 1
host.permissions   // string[] of what you were granted
host.action(name)  // → "<id>:<name>"  — build action strings with this
host.h             // { esc, dataAction, dataOn, renderMarkdown, slugify }
host.role          // { isDM(), isAnonymous() }
host.ui            // { toast(msg), rerender() }  — rerender re-renders the current route
```

### Registration methods (each needs the listed permission)

| Method | Permission | Purpose |
|---|---|---|
| `registerRoute(seg, render)` | `ui:route` | A hash route `#/<seg>/…`. `render(sub, parts) → htmlString`. |
| `registerSidebarPage(spec)` | `ui:sidebar` | A left-nav link. `spec = {route:'/x', label, icon?, section?, role?}`. |
| `registerPageRenderer(kind, render)` | `ui:route` | Provide a `Wiki.renderPage(kind)` page. |
| `registerArticleSection(kind, fn)` | `ui:article-section:<kind>` | A section on every entity article. `fn(entity) → {title, html} \| null`. ADDITIVE (stacks). |
| `registerEditorFields(kind, spec)` | `ui:editor-fields:<kind>` | Inject fields into an editor + collect on save. `spec = {fields(entity)→html, collect(scope, entity)→obj}`. Wired for `characters`. |
| `registerSettingsTab(spec)` | `ui:settings-tab` | A Nastavení tab. `spec = {id, label, icon?, role?, render()→html}`. |
| `registerAction(name, fn)` | `ui:action` | A handler for `data-action="<id>:<name>"`. Build with `host.action(name)`. |
| `registerCollection(name)` | `data:own` | Wire your manifest-declared collection's scoped CRUD (§8). |
| `registerWikiKind(scope, resolve)` | `wiki:kind` | Resolve `[[Label\|scope]]` links. `resolve(label) → {kind, id} \| null` (§7). |
| `registerFragmentOp(target, spec)` | `ui:override` | Override a built-in fragment (replace/hide/wrap/insert) (§11). |
| `provide(api)` / `use(depId)` | — | Inter-addon API channel (§10). |

### Data access (`host.store`)
```js
host.store.generateId(name)             // always — slug + random suffix
host.store.getCharacters()              // needs data:read:characters
host.store.getLocations() / getEvents() / getMysteries() / getFactions()
host.store.getCollection(name)          // needs data:read:<name>  → array
host.store.collection(name)             // your OWN collection (data:own) → { list, get, save, remove }
host.store.patchAddonData(coll, id, fn) // needs data:write:<coll>.addonData (§6)
```

> **Language.** The app's language switcher is a **visual layer over the core
> UI only** — it does not reach into addon code. Write your addon entirely in
> **English** (UI strings included), same as the rest of the codebase. There is
> no addon translation API.

---

## 5. Permission catalogue

Request the **least** you need. The DM sees friendly labels at install.

| Token | Grants |
|---|---|
| `ui:route` | Add a page / page-renderer. |
| `ui:sidebar` | Add a sidebar link. |
| `ui:settings-tab` | Add a Nastavení tab. |
| `ui:action` | Handle `data-action` clicks/events. |
| `ui:article-section:<kind>` | Add a section to `<kind>` articles (`characters`, `locations`, `events`, `mysteries`, `factions`, …). |
| `ui:editor-fields:<kind>` | Add fields to the `<kind>` editor. |
| `ui:override` | Replace/hide/wrap/insert built-in fragments. |
| `wiki:kind` | Extend `[[…]]` wiki-links. |
| `data:own` | Store the addon's own collections + per-entity `addonData`. |
| `data:read:<collection>` | Read a core collection. |
| `data:write:<collection>` | (reserved — most writes go through `addonData` or your own collections) |
| `data:write:<collection>.addonData` | Patch your namespace on a core entity (§6). |
| `net:external` | (declared transparency; the host can't actually stop `fetch`) |
| `server:code` | Run your `server/index.cjs` in-process (§13). |
| `server:endpoint` | (declared transparency for server routes) |

---

## 6. Per-entity data (`addonData`) + sheet fields

Stash a namespaced blob on a core entity at `entity.addonData["<your-id>"]`. It
rides inside the entity's JSON (snapshotted + role-filtered with it).

```js
// Read-modify-write YOUR namespace only (the host injects your id):
host.store.patchAddonData('characters', charId, (s) => ({ ...s, hp: (s.hp ?? 10) - 1 }));
// needs:  "data:write:characters.addonData"
```

Inject configuration into the character editor:
```js
host.registerEditorFields('characters', {
  fields: (c) => {
    const s = (c?.addonData?.[host.id]) || {};
    return `<div class="edit-section">
      <div class="edit-section-title">My fields</div>
      <input id="my-maxhp" class="edit-input" type="number" value="${host.h.esc(String(s.maxHp ?? 10))}">
    </div>`;
  },
  // scope = your <div class="addon-editor-section">; merged into addonData[id] on save
  collect: (scope) => ({ maxHp: parseInt(scope.querySelector('#my-maxhp')?.value, 10) || 10 }),
});
// needs:  "ui:editor-fields:characters"  (+ data:write:characters.addonData to also patch it live)
```

See `examples/addons/sheet` for a full active character sheet (HP +/− buttons +
editor fields).

---

## 7. Wiki-link kinds

Make `[[Grappling|pravidlo]]` resolve into your page. Look the target up **by
name** and return its real id (ids carry a random suffix, so don't assume the
slug).
```js
host.registerWikiKind('pravidlo', (label) => {
  const hit = host.store.collection('rules').list().find(r => r.name?.toLowerCase() === label.trim().toLowerCase());
  return hit ? { kind: 'pravidla', id: hit.id } : null;   // → #/pravidla/<id>
});
// needs:  "wiki:kind"  (scope can't shadow a built-in like postava/misto/…)
```

---

## 8. Your own data collections

Declare in the manifest, register in `entry.js`, then use the scoped CRUD handle.
Data lives isolated at `data/addon-data/<id>/<name>.json` and syncs to every
client over SSE like core data.

```jsonc
// addon.json
"permissions": ["data:own"],
"collections": [{ "name": "rules", "keyed": false }]   // keyed:true → keyed-object store
```
```js
// entry.js
host.registerCollection('rules');
const rules = host.store.collection('rules');

rules.list();                       // → array (fresh copy, safe to sort/filter)
rules.get(id);                      // → item | null
const saved = rules.save({ name: 'Grappling', body: '' });  // upsert; id generated if missing
rules.remove(id);
```

---

## 9. Styling — the design-system contract

**Never ship clobbering CSS. Never use literal colours/sizes.** Build HTML with
`host.h` and style with **design tokens** so the theme switcher (and any future
theme) re-skins your addon for free.

- Build markup with `host.h.esc(...)` for any dynamic text, and
  `host.h.dataAction(...)` / `host.h.dataOn(...)` for handlers — **never inline
  `onclick`** (keeps the app CSP-clean).
- Use `var(--…)` tokens, never literals: colours (`--text-muted`,
  `--text-parchment`, `--accent-gold`, `--bg-raised`, `--color-danger`,
  `--color-success`, …), spacing (`--space-1..6`), type (`--text-xs..3xl`),
  radius (`--radius`, `--radius-sm/lg`), etc. Full map: **`web/css/STYLE.md`**.
- Reuse documented component classes: `.page-header`, `.edit-section`,
  `.edit-input`, `.inline-create-btn`, `.settings-panel`, `.settings-hint`,
  `.md-view`, `.char-section`, …
- Bespoke styling, if truly needed, goes in an `.addon-<id>` wrapper — but prefer
  tokens + existing classes first.

```js
// Good: tokens + host.h, no inline onclick
const { esc, dataAction } = host.h;
`<button class="inline-create-btn"${dataAction(host.action('go'), id)}>Akce</button>
 <p style="color:var(--text-muted);margin-top:var(--space-2)">${esc(note)}</p>`
```

---

## 10. Actions & events (no inline handlers)

Addon actions are namespaced `data-action="<id>:<name>"`. The dispatcher resolves
sentinels (`$value`, `$el`, `$ev`, `$checked`, `$text`) **before** calling you.
```js
host.registerAction('save', (id) => { /* … */ host.ui.rerender(); });

// click:
host.h.dataAction(host.action('save'), id)           // → data-action="myid:save" data-args='["…"]'
// change/input/keydown/submit/blur (value resolved for you):
host.h.dataOn('change', host.action('pick'), '$value')
```

---

## 11. Overriding built-in content (fragments + conflicts)

A decomposed surface is an ordered list of **named fragments**. Today the
character-article main column is finely decomposed:
`characters:section:vazby` · `…:udalosti` · `…:znalosti` · `…:otazky` ·
`…:mazlicci` · `characters:body` (other article kinds expose
`<kind>:section:s<i>` + `<kind>:body`). Sections added by an addon are
targetable too, at `<kind>:addon:<that-addon-id>:<seq>` — `seq` is the section's
index **within that addon** (stable across load order, so the id holds even if
other addons load before it).

```js
host.registerFragmentOp('characters:body', {
  op: 'wrap',                                   // wrap | insert | replace | hide
  render: (html) => `<div style="border:1px solid var(--accent-gold)">${html}</div>`,
});
// needs:  "ui:override"
```

- `wrap` (`render(html, ctx)→html`) and `insert` (`{op:'insert', position:'before'|'after', render(_, ctx)→html}`)
  are **stackable** — they never conflict.
- `replace` and `hide` are **EXCLUSIVE per target**. If two addons claim an
  exclusive op on the same fragment, the host renders the **built-in** (safe
  default) and surfaces a **conflict** in Nastavení → Doplňky → Konflikty for the
  DM to resolve. There is no silent last-wins.
- `ctx` = `{ entity, kind, target }`. A throwing render degrades to the built-in.

---

## 12. Dependencies & inter-addon APIs

```jsonc
// addon.json
"dependencies": { "core-dice": { "range": ">=1.0.0", "repo": "owner/core-dice" } }
```
```js
// provider addon:
host.provide({ roll: (n) => 1 + Math.floor(Math.random() * n) });
// consumer addon (must DECLARE the dependency):
const dice = host.use('core-dice');   // throws (caught) if undeclared / not loaded
```
Load order is topologically sorted (dependencies first). Missing / version-
incompatible / cyclic deps → the addon loads to a visible `blocked` state (a
node merely *downstream* of a cycle is blocked too, but reported as such, not as
"cyclic").

Supported `range` forms: empty / `*` (any), exact `x.y.z`, comparators
`>= > <= <`, caret `^x.y.z`, tilde `~x.y.z`, X-ranges `1.x` / `1.2.x`. Compound
ranges (hyphen `1 - 2`, OR `^1 || ^2`) are **not** parsed — they silently match
anything, so don't rely on them to gate. A pre-release tag (`1.2.0-beta`) is
treated as its release.

---

## 13. Server-side code

Ship a Node module and run it in-process. Routes mount under
`/api/addon/<id>/*` (namespaced — never collide). The facade is scoped: data is
confined to your dir, core reads need a permission, `lib()` only yields vetted
host npm deps.

```jsonc
// addon.json
"server": "server/index.cjs",
"permissions": ["server:code"],
"serverDeps": []                 // e.g. ["multer"] if you need it via host.lib
```
```js
// server/index.cjs  (CommonJS)
'use strict';
module.exports.init = (host) => {
  host.get('/roll', async (req, res) => {
    const n = Math.min(1000, Math.max(2, parseInt(req.query.d, 10) || 20));
    const value = 1 + Math.floor(Math.random() * n);
    await host.data.write('log', [{ at: Date.now(), value }]);   // data/addon-data/<id>/log.json
    res.json({ value, by: req.role || 'anon' });                  // req.role/realRole are stamped — self-gate if needed
  });
};
```
`serverHost`: `get/post/put/delete(subpath, handler)` + `router`;
`data.{read(name), write(name, obj), dir}` (confined to your dir);
`readCollection(name)` (needs `data:read:<name>`); `lib(name)` (vetted);
`withLock(fn)`; `broadcastDataChanged()`; `log(...)`.

> **Restart-to-load:** server code activates on the next server restart. The
> Manager shows `🖥 restart serveru` until then. A throw in `init` is isolated —
> it never crashes the server; the addon just shows `🖥 chyba serveru`.

Call your own endpoints from `entry.js` with `fetch('/api/addon/<id>/…')`.

---

## 14. Testing

Write tests against the **published harness** `web/js/addon-test-harness.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dryRunRegister, smokeRegistrations } from '<host>/web/js/addon-test-harness.mjs';
import register from '../entry.js';

test('registers + smokes clean', () => {
  const { ok, rec, error } = dryRunRegister(register, { id: 'my-addon', permissions: [/* … */] });
  assert.ok(ok, error);
  assert.ok(rec.routes.length >= 1);
  assert.ok(smokeRegistrations(rec).ok);       // renderers survive sample input
});
```
- `createMockHost(meta, opts)` — records every `register*` call; stubs
  store/role/h/ui (no DOM, no server).
- `dryRunRegister(register, meta)` → `{ ok, rec, error }` (catches throws).
- `smokeRegistrations(rec)` → `{ ok, failures }` (invokes your renderers with
  sample fixtures; does **not** run actions).
- `tests.server` files are auto-run as a **green-gate at install** (`node --test`
  against the staged tree — must be self-contained: Node built-ins + your own
  files, no `node_modules`). A red set → the install is rejected.

Reference: `examples/addons/sheet/tests/sheet.addon-test.mjs`.

---

## 15. The build → install → update → rollback loop

1. **Develop** locally: `node scripts/dev-install-addon.cjs ./my-addon` → launch.
2. **Publish**: push to a GitHub repo. Bump `version` each release.
3. **Install**: DM pastes the repo URL into the wizard → reviews permissions →
   the wizard takes a backup snapshot, runs your `tests.server` gate, installs
   the SHA-pinned commit, and live-loads it.
4. **Update**: DM clicks "🔄 Zkontrolovat aktualizace" → ⬆ badge → "Aktualizovat"
   reopens the wizard at the latest commit.
5. **Rollback**: "↩ Vrátit verzi" flips to a kept prior version instantly.

Versioning: bump `apiVersion` only if the host bumps it; bump your `version`
every release; widen `hostVersion` only when you've tested against newer hosts.

---

## For AI assistants

You can author a correct addon from this section alone. For a **standalone,
copy-into-the-addon-repo** version of these rules (so an agent working in the
addon's own repo has them in context), use [`AGENTS.md`](AGENTS.md) — it carries
the same invariants + template and is named so Claude Code / Cursor pick it up
automatically.

**Hard invariants (violating any of these breaks the addon):**
1. `entry.js` **default-exports** `register(host)`. Server code **exports**
   `init(serverHost)` (CommonJS `.cjs`).
2. `addon.json` `apiVersion` is **`1`**. `id` matches `^[a-z0-9][a-z0-9-]{1,38}$`
   (no underscores) and equals the dir/repo name.
3. Request **exactly** the permissions you use, no more. An ungranted capability
   throws. Match them to §4's table (e.g. `registerArticleSection('characters', …)`
   needs `ui:article-section:characters`).
4. Build **all** HTML with `host.h.esc(...)` for dynamic text and
   `host.h.dataAction(...)` / `host.h.dataOn(...)` for handlers. **Never** write
   inline `onclick`/`onchange` or unescaped interpolation.
5. **Never** use literal colours/spacing/sizes. Use `var(--token)` only (see
   `web/css/STYLE.md`) + documented component classes.
6. Namespace everything: actions via `host.action(name)`; ids you choose live
   under your addon. Don't shadow built-in routes/scopes.
7. Renderers must **tolerate sparse/empty input** (the smoke test calls them with
   a minimal sample entity) and must not throw.
8. Addon-owned collections must be **declared in `addon.json` `collections[]`**
   before `registerCollection`. Wiki-kind targets resolve **by name → real id**.
9. Keep `register()` side-effect-free except for `register*` calls. Do data work
   in actions/renderers, not at register time.
10. **Write the whole addon — UI strings included — in English.** The app's
   language switcher is a visual layer over the *core* UI only; it doesn't reach
   addon code, and there is no addon translation API.

**Complete minimal template** (route + sidebar + action + data, all rules
satisfied):
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

  // Factor shared logic into a local function — the host facade has no way to
  // call one action from another, so don't try; just reuse the function.
  function doAdd() {
    const input = document.getElementById('note-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    notes().save({ text });
    host.ui.toast('Added');
    host.ui.rerender();
  }
  host.registerAction('add', doAdd);
  host.registerAction('addOnEnter', (ev) => { if (ev?.key === 'Enter') { ev.preventDefault(); doAdd(); } });
  host.registerAction('del', (id) => { notes().remove(id); host.ui.rerender(); });

  host.registerRoute('notes', () => {
    const items = notes().list();
    const rows = items.length
      ? items.map(n => `<li>${esc(n.text)}
          <button class="inline-create-btn"${dataAction(host.action('del'), n.id)}>×</button></li>`).join('')
      : `<li style="color:var(--text-muted)">Nothing yet.</li>`;
    const canEdit = !host.role.isAnonymous();
    return `
      <div class="page-header"><h1>📝 Notes</h1></div>
      <ul style="line-height:1.9;margin-top:var(--space-3)">${rows}</ul>
      ${canEdit ? `<div style="display:flex;gap:var(--space-2);margin-top:var(--space-3);max-width:32rem">
        <input id="note-input" class="edit-input" style="flex:1" placeholder="New note"
               ${dataOn('keydown', host.action('addOnEnter'), '$ev')}>
        <button class="inline-create-btn"${dataAction(host.action('add'))}>＋ Add</button>
      </div>` : ''}`;
  });
}
```

**Self-check before publishing:** `dryRunRegister(register, {id, permissions})`
returns `ok:true`, `smokeRegistrations(rec).ok` is true, and the app shows no
`⚠ test vykreslení` chip in the Manager.

---

## Worked examples (in this repo)

| Example | Shows |
|---|---|
| `examples/addons/hello` | route + sidebar, reads characters |
| `examples/addons/rules` | own collection (`registerCollection` + scoped CRUD) + `[[…\|pravidlo]]` wiki-links + a `/pravidla` page |
| `examples/addons/sheet` | per-entity `addonData`: interactive HP via `patchAddonData` + `registerEditorFields` + a settings tab + a self-test |
| `examples/addons/override` | a `wrap` fragment-override on `characters:body` |
| `examples/addons/dice` | server-side code: `server/index.cjs` exposing `/api/addon/dice/roll` + isolated data |

See also **`web/css/STYLE.md`** (tokens + components) and the **Addon
framework** section of `CLAUDE.md` (host internals).
