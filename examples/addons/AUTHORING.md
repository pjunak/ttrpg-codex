# Writing addons for **O Barvách Draků** (CodexHost)

The canonical reference for CodexHost addon authors. AI coding tools should
also load [`AGENTS.md`](AGENTS.md), which condenses the rules into an efficient
working contract.

An addon is a GitHub repo the DM installs from a URL. It can add pages, sidebar
links, settings tabs, article sections, editor fields, its own data collections,
wiki-link kinds, override built-in content, and run server-side code — all with
**no build step** (browser-native ES modules) and **no clobbering CSS** (it
reuses the host's design system, so the theme switcher re-skins it for free).

- **Host API versions:** new addons use `2`; existing API-v1 addons remain
  supported for compatibility.
- **Distribution:** one GitHub repo per addon. The DM pastes the URL into the
  install wizard (Nastavení → 🧩 Doplňky).
- **Trust model:** DM-only install, commit-SHA-pinned, in-process. Permissions
  are an enforced **Store boundary** + transparency, not a sandbox — so be a
  good citizen.

---

## 1. Quickstart

A minimal localized addon has three source files at the repo root:

**`addon.json`**
```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "apiVersion": 2,
  "hostVersion": ">=1.0.0",
  "entry": "entry.js",
  "capabilities": { "required": ["i18n.catalogs"] },
  "locales": { "en": "locales/en.json" },
  "permissions": ["ui:route", "ui:sidebar", "data:read:characters"],
  "summary": "Adds a /hello page."
}
```
(The third permission matters: `entry.js` below calls
`host.store.getCharacters()`, and an ungranted capability **throws** —
optional chaining doesn't save you, the method exists and denies.)

**`entry.js`** — a default-export `register(host)`:
```js
export default function register(host) {
  const { esc } = host.h;
  const { t } = host.i18n;
  host.registerSidebarPage({ route: '/hello', label: t('page.title'), icon: '👋' });
  host.registerRoute('hello', () =>
    `<div class="page-header"><h1>👋 ${esc(t('page.heading'))}</h1></div>
     <p style="color:var(--text-muted)">${esc(t('character.count', {
       count: host.store.getCharacters().length,
     }))}</p>`);
}
```

**`locales/en.json`**

```json
{
  "page.title": "Hello",
  "page.heading": "Hello!",
  "character.count": "Characters in the database: {count}"
}
```

Install it locally for development from the host checkout (no GitHub needed):
```
node scripts/dev-install-addon.cjs ./my-addon
```
Then launch the app. The addon loads at boot and its sidebar link appears in
the addon section.

---

## 2. Repo layout

```
my-addon/
  addon.json              # manifest (required, repo root)
  entry.js                # client ESM, default-export register(host) (required)
  locales/en.json         # REQUIRED source catalog when locales is declared
  locales/<locale>.json   # OPTIONAL partial UI translations
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
| `apiVersion` | ✅ | `1` or `2`. Unsupported versions are rejected. API v2 is required for security-sensitive manifest semantics. |
| `hostVersion` | v2: ✅ | Enforced against the host version. API-v1 manifests may omit it for legacy compatibility (equivalent to `"*"`). |
| `capabilities` | — | API-v2 negotiation: `{ "required": [], "optional": [] }`. Required unavailable capabilities block install/load; optional capabilities are queried through `host.capabilities.has(id)`. Advertised today: `collections.dm`, `collections.transactions`, `lifecycle.dispose`, `content.revision`, `i18n.catalogs`, `imports.providers`, and `graphs.facade`. |
| `entry` | ✅ | Relative `.js`/`.mjs` path to the client module (default-export `register`). |
| `locales` | — | API-v2 declarative UI catalogs: `{ "en": "locales/en.json", "cs": "locales/cs.json" }`. Requires `i18n.catalogs`; English is mandatory and complete, translations may be partial. |
| `server` | — | Relative `.cjs`/`.js` path to a Node module (`exports.init(serverHost)`). Needs the `server:code` permission. |
| `contentDir` | — | Relative dir of a **per-record JSON tree** the HOST serves for you at `/api/addon/<id>/content` (+ `/content/:kind`, `/item/:kind/:id`, `/kinds`). Every JSON file must contain one object with a non-empty string `id`; root-level records must declare `kind`, and `(kind,id)` identities must be unique. Invalid JSON/records, unreadable paths, symlinks, or duplicates reject the entire package. The right choice for DATA addons (rulebooks): **no server code, no `server:code` grant**, kinds keyed by each record's own `kind` field (sub-dir name is the fallback), and hot-loaded — install/update needs no restart. A live `server` router takes precedence over it entirely. |
| `contentGroups` | — | `{ "field": "book", "label": "Sourcebooks" }` — declare one record field as a DM-toggleable grouping key for the content tree (see the "Content groups" section under server code). `field` is `^[a-zA-Z0-9_]{1,40}$`. |
| `serverDeps` | — | `string[]` of vetted host npm libs your server module needs via `serverHost.lib(...)`. Allowed: `express`, `archiver`, `multer`. Archive readers are deliberately unavailable. Anything else → the addon loads `blocked`. |
| `permissions` | — | Declared + **enforced** capability tokens (see §5). The DM reviews + grants them at install. |
| `dependencies` | — | HARD deps: `{ "<otherAddonId>": { "range": ">=1.0.0", "repo": "owner/name" } }`. A missing/incompatible one **blocks** your addon (see §12). |
| `optionalDependencies` | — | SOFT deps, same shape — **ordering-only**: the provider loads first WHEN present, but your addon still installs/loads standalone when it's absent. Lets you `host.use()` it behind a try/catch (see §12). |
| `collections` | — | `[{ "name": "rules", "keyed": false, "access": "public" }]` — your own data collections (see §8). `name` is `^[a-z0-9][a-z0-9_]{0,39}$`; access defaults to `public`. `dm` is API-v2-only and requires `collections.dm` in `capabilities.required`. |
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
host.apiVersion    // 2 (latest supported API)
host.hostVersion   // "1.0.0"
host.capabilities.has('collections.dm') // true on hosts that enforce DM collections
host.contentRevision // stable revision of this package + effective content policy
host.onDispose(fn) // register cleanup for timers, listeners, requests, caches…
host.permissions   // string[] of what you were granted
host.action(name)  // → "<id>:<name>"  — build action strings with this
host.asset(rel)    // → "/addons/<id>/<hash>/<rel>" — URL of a file bundled
                   //   WITH your addon (images, fonts…), version-safe. E.g.
                   //   `<img src="${esc(host.asset('images/aboleth.webp'))}">`
host.h             // { esc, dataAction, dataOn, renderMarkdown, slugify, breadcrumb, icon }
                   //   breadcrumb([{label, href?}, …]) renders the same horizontal
                   //   wayfinding row core articles use (last crumb = current page,
                   //   '' below 2 crumbs). Use it at the top of your pages instead
                   //   of a hand-rolled "← Back" link.
                   //   icon(name, {size?, label?}) → the shared stat-glyph set
                   //   (heart, shield, bolt, chevrons, medal, plus-circle, eye) as an
                   //   inline `.codex-icon` SVG — use it to label stat tiles
                   //   instead of shipping your own SVGs. '' for unknown names.
host.role          // { isDM(), isAnonymous() }
host.i18n          // { locale, t, plural, formatDate, formatNumber, relativeTime }
host.imports       // scoped provider/job client for negotiated imports.providers
host.graphs        // scoped graph facade for negotiated graphs.facade + ui:graph
host.ui            // { toast(msg), rerender(), announce(text) } — rerender re-renders
                   //   the current route; announce(text) speaks a short status line
                   //   ("12 matches") to screen readers via the host's persistent
                   //   polite live region (in-page live regions don't survive the
                   //   full re-render, this one does). Not a visual toast.
```

### Scoped UI localization

Addon UI catalogs are declarative and isolated from both core strings and other
addons:

```json
{
  "apiVersion": 2,
  "capabilities": { "required": ["i18n.catalogs"] },
  "locales": {
    "en": "locales/en.json",
    "cs": "locales/cs.json"
  }
}
```

`locales/en.json` is the complete English source:

```json
{
  "page.title": "Notes",
  "item.count": { "one": "{n} note", "other": "{n} notes" }
}
```

Translations may omit keys; resolution is exact locale → base locale → English
→ key. A supplied translation must preserve the English string/plural shape and
the exact `{placeholder}` set. Locale ids and paths are validated, files must be
bounded regular JSON files inside the addon package, and unsafe keys/value
shapes are rejected before activation.

```js
export default function register(host) {
  const { esc } = host.h;
  const { t, plural } = host.i18n;
  host.registerSidebarPage({ route: '/notes', label: t('page.title') });
  host.registerRoute('notes', () =>
    `<h1>${esc(t('page.title'))}</h1><p>${esc(plural('item.count', 2))}</p>`);
}
```

`t()` and `plural()` return plain text: escape them before interpolating into
HTML. `formatDate`, `formatNumber`, and `relativeTime` use the viewer's current
locale. Catalog fetch/cache ownership follows the addon instance; install
replacement, content-revision reload, disable, and removal dispose the old
facade and stale responses cannot re-register old strings.

### Lifecycle and cleanup

If your addon owns a timer, event listener, observer, pending request, overlay,
or module cache, request the API-v2 `lifecycle.dispose` capability and clean it
up through either lifecycle form:

```js
export default function register(host) {
  const controller = new AbortController();
  const onResize = () => { /* … */ };
  window.addEventListener('resize', onResize);
  host.onDispose(() => controller.abort());

  return async () => {
    window.removeEventListener('resize', onResize);
    await flushPendingWork();
  };
}
```

Each registered cleanup is called exactly once in reverse registration order
before the host removes routes/actions/other registrations. Async cleanup is
supported and bounded to two seconds per addon; a rejection or timeout is
reported but never prevents another addon from unloading or loading.
`register()` itself remains synchronous; only cleanup may return a promise.

Disposal happens when the addon is disabled, removed, replaced, or its
`contentRevision` changes. Loaded hard and optional consumers are also disposed
consumer-first and re-registered provider-first, so consumers may safely cache a
provider during `register()`. `host.contentRevision` changes for active package
identity/version or effective content-group policy changes, and remains stable
for equivalent policy data. Request `content.revision` when your addon depends
on that value.

### Registration methods (each needs the listed permission)

| Method | Permission | Purpose |
|---|---|---|
| `registerRoute(seg, render)` | `ui:route` | A hash route `#/<seg>/…`. `render(sub, parts) → htmlString`. |
| `registerSidebarPage(spec)` | `ui:sidebar` | A left-nav link. `spec = {route:'/x', label, icon?, section?, role?}`. |
| `registerPageRenderer(kind, render)` | `ui:route` | Provide a `Wiki.renderPage(kind)` page. |
| `registerArticleSection(kind, fn, {order?})` | `ui:article-section:<kind>` | A section on every entity article. `fn(entity) → {title, html} \| null`. ADDITIVE (stacks, ordered by `order`). |
| `registerEditorFields(kind, spec)` | `ui:editor-fields:<kind>` | Inject fields into an editor + collect on save. `spec = {fields(entity)→html, collect(scope, entity)→obj}`. Wired for `characters`. |
| `registerSettingsTab(spec)` | `ui:settings-tab` | A settings panel under Nastavení → Doplňky (a sub-tab beside the DM-only Manager). `spec = {id, label, icon?, role?, render()→html}`. Omit `role` to keep it player-visible. |
| `registerAction(name, fn)` | `ui:action` | A handler for `data-action="<id>:<name>"`. Build with `host.action(name)`. |
| `registerCollection(name)` | `data:own` | Wire your manifest-declared collection's scoped CRUD (§8). |
| `registerWikiKind(scope, resolve)` | `wiki:kind` | Resolve `[[Label\|scope]]` links. `resolve(label) → {kind, id} \| null` (§7). |
| `registerFragmentOp(target, spec)` | `ui:override` | Override a built-in fragment (replace/hide/wrap/insert) (§11). |
| `registerSlot(slotId, render, opts?)` | `ui:slot:<surface>` | Inject content into a named slot on ANY surface (`<surface>` = slotId's first `:`-segment). `render(ctx) → {html} \| string \| null`. ADDITIVE, ordered by `opts.order`. Live slots: `dm:dashboard` (ctx `{role}`; invoked only for an effective DM), `dashboard:section` (ctx `{role}`), `map:pin:panel` (ctx `{location, pin, role}`), `timeline:card:extra`, `timeline:column:header\|footer`, `timeline:toolbar`. NOTE: `ctx.role.isDM` is a **boolean**, not a function. |
| `registerKind(domain, def)` | `kinds:<domain>` | Add a pure-DATA enum kind in `domain` — merged into `Store.getKinds(domain)`. Domains: `connections`, `statuses`, `priorities`, `attitudes`, `genders`, `pinTypes`. `def = {id, label, color?, …}` (NO functions). Id namespaced `<addonId>:<def.id>`. Renders wherever that kind's label/colour does (e.g. a `statuses` kind shows up via `getStatusMap` on cloudmap/wiki/map). NOT an editable row in Settings. |
| `registerConnectionKind(def)` | `kinds:connections` | Back-compat alias for `registerKind('connections', def)`. `def = {id, label, color, style, dirs?, target?}`. Shows in the rel editor + as a mind-map edge. |
| `registerNodeKind(def)` | `kinds:graph` | Add a mind-map node type: `def = {id, shape?, cardHTML(node)→html, height?(node)→px, searchText?, detailHash?(d)}`. `cardHTML` must emit a `.cm-cloud` card. |
| `registerGraphView(def)` | `kinds:graph` | Add a mind-map "mode": `def = {id, label, build()→{nodes,edges}}`. Reachable at `#/mapa/<addonId>:<def.id>`. |
| `registerGraphContributor(viewId, fn)` | `graph:contribute` | Inject nodes/edges into an EXISTING view (`'vztahy'`, `'frakce'`, `'tajemstvi'`, `'casova-osa'`). `fn() → {nodes:[{id,type,…}], edges:[{source,target,type?}]}`. |
| `provide(api)` / `use(depId)` | — | Inter-addon API channel (§10). |

### Data access (`host.store`)
```js
host.store.generateId(name)             // always — slug + random suffix
host.store.getCharacters()              // needs data:read:characters
host.store.getLocations() / getEvents() / getMysteries() / getFactions()
host.store.getCollection(name)          // needs data:read:<name>  → array
host.store.collection(name)             // your OWN collection (data:own) → { list, get, save, remove }
host.store.transaction(names, callback) // atomic own-collection transaction (API v2 capability)
host.store.patchAddonData(coll, id, fn) // needs data:write:<coll>.addonData (§6)
```

> **Language.** Code and the mandatory source catalog stay English. Addon UI
> participates in the viewer's language switcher only through a declared
> locale package and its scoped `host.i18n` facade; never read `codex_lang`
> directly or register strings in core `I18n`.

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
| `ui:slot:<surface>` | Inject content into named slots on `<surface>` (the slotId's first `:`-segment — e.g. `ui:slot:timeline` covers `timeline:card:extra`). Needed by `registerSlot`. |
| `wiki:kind` | Extend `[[…]]` wiki-links. |
| `data:own` | Store the addon's own collections + per-entity `addonData`. |
| `data:read:<collection>` | Read a core collection. |
| `data:write:<collection>` | (reserved — most writes go through `addonData` or your own collections) |
| `data:write:<collection>.addonData` | Patch your namespace on a core entity (§6). |
| `kinds:<domain>` | Add pure-DATA enum kinds via `registerKind(domain, def)`. Domains: `connections`, `statuses`, `priorities`, `attitudes`, `genders`, `pinTypes`. (`kinds:connections` is also what `registerConnectionKind` needs; `kinds:graph` covers `registerNodeKind`/`registerGraphView`.) |
| `graph:contribute` | Inject nodes/edges into an existing mind-map view (`registerGraphContributor`). |
| `ui:graph` | Render bounded interactive graphs through `host.graphs`. |
| `net:external` | (declared transparency; the host can't actually stop `fetch`) |
| `server:code` | Run your `server/index.cjs` in-process (§13). |
| `server:endpoint` | (declared transparency for server routes) |

---

## 6. Per-entity data (`addonData`) + sheet fields

Stash a namespaced blob on a core entity at `entity.addonData["<your-id>"]`. It
rides inside the entity's JSON (snapshotted + role-filtered with it).

> **Visibility caveat.** Role filtering is *entity*-granular: a DM-only
> entity is dropped for players, but on a **public** entity the whole
> `addonData` blob is sent to players **and anonymous viewers** verbatim.
> Never store DM secrets in the addonData of a public entity — put them on
> the entity's DM twin instead.

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

Declare in the manifest, register in `entry.js`, then use the scoped CRUD
handle. Identity is always `(addonId, collectionName)` and data lives at
`data/addon-data/<id>/<name>.json`, so two addons may use the same name.

Public collections retain the compatibility behavior: all viewers receive
them and any authenticated role may write. A DM collection is different:
declare API v2, require `collections.dm`, and set `access:"dm"`. The server
omits its data and metadata for players, anonymous visitors, and a DM using
view-as-player; guessed writes return a non-disclosing 404. DM-only writes
notify only effective-DM SSE clients and do not change the player hash.
Register a DM collection only while `host.role.isDM()` is true. Role changes
clear addon caches, reconcile declarations, and reload through the authorized
path.

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

DM-only variant:

```jsonc
"apiVersion": 2,
"hostVersion": ">=1.0.0",
"capabilities": { "required": ["collections.dm", "lifecycle.dispose"] },
"permissions": ["data:own"],
"collections": [{ "name": "scenarios", "keyed": false, "access": "dm" }]
```

```js
if (host.role.isDM()) host.registerCollection('scenarios');
```

### Atomic multi-collection transactions

Request API v2 capability `collections.transactions`, permission `data:own`,
and declare every participating collection. Register those collections before
calling:

```js
const result = await host.store.transaction(
  ['scenarios', 'initiative'],
  async tx => {
    const scenarios = tx.collection('scenarios');
    const initiative = tx.collection('initiative');

    const scenario = scenarios.get('current');
    scenarios.put({ ...scenario, id: 'current', state: 'running' });
    initiative.put({ id: 'round', value: 1 });
    return { started: scenario?.name || '' };
  },
  { timeoutMs: 5000 },
);
```

The callback reads one consistent snapshot and buffers writes. `put(item)`
requires an explicit string `id`; `remove(id)` buffers a delete. A
`(collection,id)` may be written only once. If any collection changes after
the snapshot, commit rejects with `error.code === "TX_CONFLICT"` and nothing
is published. Callback errors also leave storage unchanged. Nested
transactions reject with `TX_NESTED`.

Limits: 16 collections, 256 operations, 2 MiB total operation JSON, 256 KiB
per record, timeout 250–10,000 ms (default 5,000). Values must be finite,
JSON-compatible plain objects. One successful transaction yields one logical
commit and at most one role-scoped SSE event per audience. DM-only and public
collections may be mixed only by an effective DM; players receive only the
public resulting projection. The host uses a durable journal and startup
recovery; see `docs/reference/server.md` for the commit point and filesystem
durability assumptions.

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
- **Shared component classes** (widgets.css — theme-aware for free, so prefer
  them over restyling): `.codex-tip`/`.codex-pop` popover legends (hover/focus
  "how did we get this number" cards; `-l`/`-r` edge pins), `.codex-tab-strip`/
  `.codex-tab` (+`.is-active`, `.codex-tab-tool`) tab bars (you own the ARIA +
  keyboard wiring), `.codex-tile` (+`-label`/`-value`/`-accent`/`-wide`) stat
  tiles, `.codex-warnings` advisory warning lists, `.codex-stepper` −/＋ number
  steppers (the host steps the input for you via `data-num-step`).
- **Host widgets in addon HTML:** `Widgets.mountAll` runs after every route
  render (and after `host.ui.rerender()`), so placeholder divs in YOUR html
  mount too. `.tf-mount` (TagFilter — generic search+chips, you own the
  matching via the bubbling `tf-change` event) is fully usable. `.cb-mount` /
  `.ms-mount` (Combobox/MultiSelect) also mount but their option SOURCES are
  the host's `character`/`location` collections only — fine for picking
  characters/places, not (yet) for arbitrary addon option lists.
- Bespoke styling, if truly needed, goes in an `.addon-<id>` wrapper — but prefer
  tokens + existing classes first.

```js
// Good: tokens + host.h, no inline onclick
const { esc, dataAction } = host.h;
`<button class="inline-create-btn"${dataAction(host.action('go'), id)}>Akce</button>
 <p style="color:var(--text-muted);margin-top:var(--space-2)">${esc(note)}</p>`
```

### Interactive graphs

Graph consumers use API-v2 capability `graphs.facade`, permission `ui:graph`,
and `lifecycle.dispose`. Facade API version 1 is independent of the host's
bundled graph-library version. Never import Cytoscape, call
`window.cytoscape`, load a plugin, or depend on raw selectors/styles/events.

Render a `<div class="codex-graph-canvas">` in an addon route, then mount after
the route HTML exists:

```js
let graph = null;
const mountGraph = async () => {
  const container = document.getElementById('my-graph');
  if (!container || !host.graphs.available()) return;
  graph = await host.graphs.mount(container, {
    nodes: [{ id: 'a', label: 'Start', kind: 'planned' }],
    edges: [],
    layout: 'grid',
    accessibleLabel: 'Scenario graph',
    fitPadding: 40,
  });
  const off = graph.on('select', event => {
    if (event.nodeId) host.ui.announce(`Selected ${event.nodeId}`);
  });
  host.onDispose(off);
};
host.onDispose(() => graph?.destroy());
```

`mount` is permitted only below the calling addon's host-owned route wrapper.
It validates and clones plain data before the private adapter sees it. Nodes
are `{id,label,kind?}`; edges are `{id,source,target,label?}`. IDs are unique
across elements and dangling edges reject. Limits: 1,000 nodes, 4,000 edges,
128-character ids, 500-character labels, 200-character accessible labels,
and padding 0–200. Layouts are `grid`, `circle`, `concentric`,
`breadthfirst`, and `dagre`, each with documented bounded data options.

A handle exposes `update({nodes,edges},{layout?})`, `select(ids)`,
`focus(ids,{padding?})`, `fit(ids?,{padding?})`,
`on('select'|'unselect'|'activate'|'viewport'|'focus', fn)`, and idempotent
`destroy()`. Navigation and addon disposal are host cleanup boundaries;
still cancel any addon-owned scheduled mount work. Re-mounting the same
container destroys its old graph. The harness supplies a deterministic fake
implementation and records instances in `rec.graphInstances`.

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

// Drag-and-drop (dragstart / drop; dragover is auto-allowed on a data-on-drop
// element, and drop is preventDefaulted for you). Mark the source draggable and
// stash the dragged id; read it on drop. Pair with a click handler as a
// non-pointer fallback.
host.h.dataOn('dragstart', host.action('dragStart'), '$ev', ref)   // on draggable="true"
host.h.dataOn('drop',      host.action('dropHere'), targetId)      // on the drop zone
// host.registerAction('dragStart',(ev,ref)=>{ _drag=ref; ev.dataTransfer?.setData('text/plain',ref); });
// host.registerAction('dropHere',(targetId)=>{ if(_drag){ /* place _drag */ _drag=null; host.ui.rerender(); }});
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
- **Full-width takeover:** an exclusive claim on `<kind>:body` collapses the
  two-column article — the side rail is dropped and the host folds the
  side-card (✏ edit button + portrait + identity + facts, as a floated
  `.article-sidecard-inbody` block) **and every section** into the body html
  your `render` receives. Treat that html as the complete wiki profile (the
  D&D sheet shows it as its Overview tab). Consequently the
  `<kind>:section:*` fragment ids do **not exist** on a taken-over page — a
  section-targeted claim reports as unmatched there.

---

## 12. Dependencies & inter-addon APIs

```jsonc
// addon.json
"dependencies":         { "core-dice":  { "range": ">=1.0.0", "repo": "owner/core-dice" } },
"optionalDependencies": { "core-rules": { "range": ">=1.0.0", "repo": "owner/core-rules" } }
```
```js
// provider addon:
host.provide({ apiVersion: 1, roll: (n) => 1 + Math.floor(Math.random() * n) });
// consumer addon (must DECLARE the dep — as hard `dependencies` OR `optionalDependencies`):
const dice = host.use('core-dice');   // throws (caught) if undeclared / not loaded
```
Load order is topologically sorted (dependencies first). Missing / version-
incompatible / cyclic **hard** deps → the addon loads to a visible `blocked`
state (a node merely *downstream* of a cycle is blocked too, but reported as
such, not as "cyclic").

**Soft-use via `optionalDependencies` (the standalone-but-enhanced pattern).**
A hard `dependencies` entry makes the host *block* your addon when the provider
is absent — wrong if you want to run standalone and merely *light up extra*
behaviour when another addon is present. Declare it under `optionalDependencies`
instead: it's **ordering-only** (the provider, when installed, loads before you
so `host.use()` works during `register`/render; when it's absent, blocked, or
version-incompatible the edge is ignored and never blocks you).
Probe it **lazily, per render/action, try/caught** — never at module top-level —
and carry an `apiVersion` integer inside the provided API for API-shape
compatibility (the manifest range controls optional load ordering, while your
API version controls the object you receive):

```js
function getProvider() {
  try { const p = host.use('core-rules'); return (p && p.apiVersion >= 1) ? p : null; }
  catch { return null; }            // absent / not loaded → run standalone
}
// in a renderer:
const rules = getProvider();
return rules ? renderEnhanced(rules) : renderStandalone();
```

Supported `range` forms: `*` (any), exact `x.y.z`, comparators
`>= > <= <`, caret `^x.y.z`, tilde `~x.y.z`, X-ranges `1.x` / `1.2.x`. Compound
ranges, hyphen ranges, OR expressions, pre-release/build versions, leading
`v`, malformed syntax, and empty ranges are rejected rather than widened.

---

## 13. Server-side code

Ship a Node module and run it in-process. Routes mount under
`/api/addon/<id>/*` (namespaced — never collide). The facade is scoped: data is
confined to your dir, core reads need a permission, `lib()` only yields vetted
host npm deps.

> **Serving static content? You probably don't need server code.** If your
> server module would only read bundled JSON off disk and serve it (a rulebook
> / data addon), declare `"contentDir": "data"` instead — the host serves the
> aggregate endpoints for you with no `server:code` grant and no restart.
> Reach for a real server module only for LOGIC (authoritative dice, uploads,
> custom queries).

### Content groups (DM-toggleable slices of a content addon)

A content addon can declare ONE record field as its grouping key:

```jsonc
// addon.json
"contentDir": "data",
"contentGroups": { "field": "book", "label": "Sourcebooks" }
```

The Manager then shows a checkbox per distinct `field` value (with record
counts). **Checkbox labels are data-driven:** when your tree ships a record
of the kind *named like the field* whose `id` matches the value — e.g. the
compendium's `book`-kind records — the toggle shows that record's `name`
("Player's Handbook"), not the raw id (`phb`); values without such a record
fall back to the raw id. Ship one per group value. The DM can untick a
group and the host drops those records from
EVERYTHING it serves — the `/content` aggregate, per-kind lists, `/item`
lookups and `/kinds` — live, no restart or browser reload. The toggle changes
the addon's `contentRevision`; the host disposes/re-registers it and every
loaded hard or optional consumer so stale client caches and `provide()`d APIs
cannot survive the policy change. Consumers (browse pages, wiki-link kinds,
`provide()`d data APIs) automatically agree because they all read the same
filtered tree. A content addon relying on this behavior should use API v2 and
require both `lifecycle.dispose` and `content.revision`. Rules: records
**lacking** the field are always kept (a
toggle only hides records that opted into a group); unknown ids on the
off-list match nothing (harmless, forward-compatible); nothing is ever
deleted — re-ticking restores instantly. Toggle state survives updates.

Installs are DM-only and work with **private GitHub repositories** when the
operator sets `CODEX_GITHUB_TOKEN` (see `docs/SELF_HOSTING.md`).

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
`withLock(fn)` (30 s diagnostic watchdog; ownership remains with `fn` until it
settles so writes can never overlap);
`broadcastDataChanged()`; `log(...)`.

### Import-provider server contract

An addon may pair its provider with a DM-only Import Center page through the
`host.imports` facade. A server addon that registers a provider must require
`imports.providers` and `collections.transactions`, request
`server:code`, `data:own`, and `data:import-provider`, and declare every own
write collection. DM-only targets also require `collections.dm`.

```js
module.exports.init = serverHost => {
  const target = {
    scope: 'addon',
    addonId: serverHost.id,
    collection: 'items',
  };
  serverHost.registerImportProvider({
    id: 'items-json',
    apiVersion: 1,
    schemaVersion: 1,
    formats: ['json'],
    reads: [target],
    writes: [target],
    targetTypes: ['addon-list'],
    limits: {
      maxInputBytes: 1024 * 1024,
      maxDepth: 16,
      maxRecords: 5000,
      maxStringChars: 65536,
      maxOperations: 200,
      timeoutMs: 3000,
    },
    capabilities: ['abort-signal', 'structured-diagnostics'],
    async preview(input, context) {
      context.read(target);
      if (context.signal.aborted) throw context.signal.reason;
      return {
        schemaVersion: 1,
        operations: input.data.records.map(record => ({
          target,
          op: 'put',
          id: record.id,
          value: { name: record.name },
        })),
        diagnostics: [],
      };
    },
  });
};
```

`preview` must be deterministic for the supplied input, declared snapshots,
and revisions. It must not perform writes or depend on ambient request state.
Identity is `(addonId, providerId)`. Descriptors and output are strict:
unknown fields, duplicate registrations, unsupported versions/formats/
capabilities, undeclared access, foreign access, delete operations, duplicate
writes, unsafe JSON, and protected metadata fail closed. Core reads require an
explicit `data:read:<collection>` grant. Provider API v1 does not support core
writes, cross-addon reads/writes, or archives.

Input paths, requests, passwords, filesystem helpers, locks, transaction
journals, and transaction functions are never passed to `preview`. MIME and
extension are hints only; validate actual parsed content. Honor the supplied
abort signal. Diagnostics are bounded plain text objects with
`severity:"info"|"warning"|"error"`, uppercase token `code`, `message`, and
optional string/integer `path[]`; never return HTML.

The host parses raw JSON with nested duplicate-key/prototype/size guards,
captures declared collection revisions, validates and stores the normalized
plan, and issues an opaque single-use token. Commit never reruns the provider
and never accepts operations from the client; it verifies the provider package
and all base revisions, then sends the exact plan through the atomic
multi-collection transaction service. Import jobs are
ephemeral, session-bound, rate/concurrency/timeout limited, abort on provider
unload/update, and do not survive restart.

Server-addon tests can import `createMockImportHost` from
`server/addon-import-harness.cjs`. It uses the same descriptor/parser/plan/job
implementation as the live server and exposes in-memory `createJob`,
`manager.preview`, `manager.commit`, cancellation, revision mutation, event
counts, and atomic failure injection.

The browser facade exposes only:

```js
await host.imports.listProviders();
const job = await host.imports.createJob({ providerId, file, format: 'json' });
const preview = await host.imports.preview(job.id);
const status = await host.imports.getJob(job.id);
const result = await host.imports.commit(job.id, preview.previewToken);
await host.imports.cancel(job.id);
```

Provider lists are filtered to the calling addon, and job methods accept only
ids created by that facade instance. The facade preserves structured
`error.code/status/details`, aborts active requests on disposal, and refuses
effective-player use. Import pages must localize API errors, escape all
provider/file text, require explicit confirmation, disable repeated commit,
and recover an interrupted commit response with `getJob()` rather than
resubmitting. The completed status carries the owner-bound result until job
expiry. Leaving the page should cancel any active job; addon disposal remains
the final cleanup boundary.

> **Restart-to-load:** server code activates on the next server restart. The
> Manager shows `🖥 restart serveru` until then. A throw in `init` is isolated —
> it never crashes the server; the addon just shows `🖥 chyba serveru`.

Call your own endpoints from `entry.js` with `fetch('/api/addon/<id>/…')`.

---

## 14. Testing

Write tests against the **published harness** `web/js/addon-test-harness.mjs`:
Its `register*` argument validators are the same functions used by the live
host, so a successful dry run cannot rely on looser route, renderer, slot, kind,
or duplicate-registration checks.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  disposeMockHost,
  dryRunRegister,
  smokeRegistrations,
  validateAddonCatalogs,
} from '<host>/web/js/addon-test-harness.mjs';
import register from '../entry.js';
import en from '../locales/en.json' with { type: 'json' };

test('registers + smokes clean', () => {
  const meta = {
    id: 'my-addon',
    apiVersion: 2,
    permissions: [/* … */],
    capabilities: { required: ['i18n.catalogs'] },
    locales: { en: 'locales/en.json' },
  };
  assert.ok(validateAddonCatalogs(meta, { en }).ok);
  const { ok, rec, error } = dryRunRegister(register, meta, {
    catalogs: { en },
    locale: 'en',
  });
  assert.ok(ok, error);
  assert.ok(rec.routes.length >= 1);
  assert.ok(smokeRegistrations(rec).ok);       // renderers survive sample input
  assert.deepEqual(rec.i18nMissing, []);       // every exercised key exists in English
  return disposeMockHost(rec);                 // exercises lifecycle cleanup
});
```
- `createMockHost(meta, opts)` — records every `register*` call; stubs
  store/role/h/ui (no DOM, no server). **Declare `meta.permissions` with the
  SAME array as your addon.json** — the mock then enforces them exactly like
  the real host, so a `register*` your manifest doesn't cover fails in your
  tests with the same error it would throw at install. Dependency `use()` and
  collection declarations also use the same validation as the live facade.
  Pass `opts.catalogs` and `opts.locale` to exercise the same scoped
  localization, regional fallback, interpolation, and plural behavior.
  `rec.i18nMissing` records safe missing-key diagnostics, so assert it stays
  empty after exercising registrations/renderers.
  (Omitting the
  `permissions` key entirely runs loose/allow-all — fine for throwaway tests,
  but you lose that safety net.)
- `dryRunRegister(register, meta)` → `{ ok, rec, error, dispose }` (catches
  throws and rolls back partial lifecycle/registrations on failure).
- `disposeMockHost(rec, {timeoutMs?})` invokes cleanup in live LIFO order,
  exactly once, and returns its errors/timeout state. `createMockHost` also
  returns a bound `dispose()` helper.
- `smokeRegistrations(rec)` → `{ ok, failures }` (invokes your renderers with
  sample fixtures; does **not** run actions).
- `tests.server` files are auto-run as a **green-gate at install** (`node --test`
  against the staged tree — must be self-contained: Node built-ins + your own
  files, no `node_modules`). The child receives only a minimal cross-platform
  path/temp/home/locale environment allowlist; deployment variables and secrets
  are absent. A red set → the install is rejected.

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
2. New addons use `addon.json` `apiVersion` **`2`** with an enforced
   `hostVersion`. Legacy API-v1 addons remain supported. `id` matches
   `^[a-z0-9][a-z0-9-]{1,38}$` (no underscores) and equals the dir/repo name.
3. Request **exactly** the permissions you use, no more. An ungranted capability
   throws. Match them to §4's table (e.g. `registerArticleSection('characters', …)`
   needs `ui:article-section:characters`).
4. Build **all** HTML with `host.h.esc(...)` for dynamic text and
   `host.h.dataAction(...)` / `host.h.dataOn(...)` for handlers. **Never** write
   inline `onclick`/`onchange` or unescaped interpolation.
5. Use host component classes and design tokens for product-facing styling
   (see `web/css/STYLE.md`). Literals are reserved for one-off technical
   geometry without theme or system meaning.
6. Namespace everything: actions via `host.action(name)`; ids you choose live
   under your addon. Don't shadow built-in routes/scopes.
7. Renderers must **tolerate sparse/empty input** (the smoke test calls them with
   a minimal sample entity) and must not throw.
8. Addon-owned collections must be **declared in `addon.json` `collections[]`**
   before `registerCollection`. DM declarations additionally require API v2,
   `collections.dm`, and effective-DM registration. Wiki-kind targets resolve
   **by name → real id**.
9. Keep registration deterministic. Start data work in actions, renderers, or
   explicitly owned asynchronous tasks, and register cleanup with
   `host.onDispose(fn)` or return it from `register()`.
10. **Write code and the mandatory source catalog in English.** Addon UI that
   needs localization declares `locales` on API v2, requires `i18n.catalogs`,
   and renders through scoped `host.i18n`; translations may be partial but may
   not replace or omit the English source package.

**Complete minimal template** (route + sidebar + action + data, all rules
satisfied):
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
| `examples/addons/demo-contrib` | the data-driven contribution seams: `ui:slot:timeline`, `kinds:connections`, `kinds:statuses`, `kinds:graph` + `graph:contribute` |

See also **`web/css/STYLE.md`** (tokens + components) and
**`docs/reference/addons.md`** (the host-internals deep reference).
API v2 advertises `collections.dm`, `collections.transactions`,
`lifecycle.dispose`, `content.revision`, `i18n.catalogs`, and
`imports.providers`, and `graphs.facade`; addons whose
correctness relies on cleanup or revision metadata should require them.
An API-v2 collection with `"access": "dm"` must declare `collections.dm` in
`capabilities.required`. API-v1 collection declarations,
unknown collection fields, and API-v2 DM access without the required capability
are also rejected; none can be normalized into public access.

### Version-range grammar

Versions are exact stable `MAJOR.MINOR.PATCH` strings with no leading `v`,
pre-release, or build suffix. Supported ranges are `*`, exact versions,
`>`, `>=`, `<`, `<=`, caret (`^1.2.3`), tilde (`~1.2.3`), and X-ranges
(`1.x`, `1.2.x`; `X` and `*` are accepted in the wildcard position). Empty,
compound, hyphen, OR, and other syntax is rejected. The same grammar applies
to `hostVersion`, `dependencies`, and `optionalDependencies`.
