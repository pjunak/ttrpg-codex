# Addon framework (CodexHost) — deep reference (ttrpg-codex)

> Moved verbatim out of CLAUDE.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as CLAUDE.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## Addon framework (CodexHost)

Installable addons (hosted **one per GitHub repo**) extend the app with
new routes/pages, collections, settings tabs, article sections, and — in
later phases — server-side code, all with **no build step**. The
**server is the broker**; the **client host** (`addons.js`, the `Addons`
module, in the ACTIONS map) loads them. (The original design plan lived in
a machine-local file outside the repo; this section plus
`examples/addons/AUTHORING.md` are the surviving canonical reference.)

**Status: ALL 11 phases landed — the addon framework is complete.** Phase 1 = walking skeleton (broker + host +
one additive route). Phase 2 = the **Addon Manager** (Settings → 🧩 Doplňky,
DM-only): list installed addons with enable/disable/remove + a **URL install
wizard** (paste a GitHub URL → install → live-load via the `addons-changed`
SSE reconcile). Install auto-records the source — no allowlist to curate.
Phase 3 = **enforced permissions**: the manifest's `permissions[]` are shown in
the wizard's review step (resolved via `POST /api/addons/preview`) for the DM to
see before installing, and the client `host` facade is built **scoped to the
granted permissions** — an ungranted capability throws a clear, caught error (the
no-`window.*` design makes this a real Store boundary). **Phase 4a** added the
additive register API — `registerPageRenderer` / `registerArticleSection` /
`registerSettingsTab` / `registerAction` (+ namespacing + transactional
register), wired into `renderPage` / `_articleShell` / `_runAction` / settings
tabs (example: `examples/addons/sheet`). **Phase 4b (deps)** added
dependency-ordered loading + `host.provide`/`host.use` (inter-addon APIs) +
`blocked`/`cycle` states (pure, unit-tested `web/js/addon-deps.js`). **Phase 4b-2**
added **addon-owned collections** + **`registerWikiKind`**: an addon declares
`collections[]` in its manifest → the server registers each as the colon-
namespaced wire type `addon:<id>:<name>` (data isolated at
`data/addon-data/<id>/<name>.json`, riding the generic GET/PATCH `/api/data`
path, covered by the data hash + snapshots), and the client gets scoped CRUD
via `host.store.collection(name)` (gated by `data:own`) + `[[Label|scope]]`
wiki-links resolving into addon pages (example: `examples/addons/rules`). **Phase 5**
added **per-entity `addonData`** + **active-sheet hooks**: an addon stashes a
namespaced blob on a core entity at `entity.addonData[<addonId>]` and patches it
via `host.store.patchAddonData(collection, id, fn)` (the host injects the addon
id → it can only touch its OWN namespace, gated by
`data:write:<collection>.addonData`); `host.registerEditorFields('characters',
{fields, collect})` injects fields into the character editor (collected into
`addonData` on save). The blob rides inside the entity's JSON (snapshotted +
role-filtered with it). Server `_sanitizePlayerEntity` shallow-merges player
addonData over existing so a normal player edit can't drop a namespace by
omission (example: the upgraded `examples/addons/sheet` — interactive HP +/−).
**Phase 6** added the **slot/fragment override model + conflict resolution**: a
decomposed surface (the character article main column) emits NAMED fragments
(`characters:section:vazby`, `characters:body`, …) and addons claim ops via
`host.registerFragmentOp(target, {op})` — `replace`/`hide` (EXCLUSIVE per
target), `wrap` (stackable), `insert` (additive). The arbitration is
**conflict-safe**: ≥2 exclusive claims on one target with no DM resolution →
render the built-in (never last-wins) + surface the clash in Nastavení →
Doplňky → **Konflikty**, where the DM picks a winner (`POST /api/addons/resolve`
→ `resolutions[target]`). The pure engine is `web/js/addon-fragments.js`
(example: `examples/addons/override`). **Phase 7** added **server-side addon
code**: an addon with a `server` entry + granted `server:code` ships a Node
module the host loads in-process at boot (`init(serverHost)`), its routes mounted
under the namespaced `/api/addon/<id>/*` (example: `examples/addons/dice` —
server-authoritative dice). **Phase 8** added **pre-activation testing**: a
published host test harness (`web/js/addon-test-harness.mjs` — mock host +
`dryRunRegister` + `smokeRegistrations`), a client **render-smoke** diagnostic at
load (a renderer that throws on sample input → a non-blocking ⚠ chip in the
Manager), and a **server-side green-gate** (`server/addon-testing.cjs` runs an
addon's declared `tests.server` with `node --test` against the staged tree
before promoting — red → never activated). **Phase 9** added the wizard's
**backup + update + rollback** flow: install/update first takes a snapshot
(revertible), `POST /api/addons/check-updates` re-resolves each addon's stored
ref→latest SHA (Manager ⬆ badge → "Aktualizovat" reopens the wizard), and
`POST /api/addons/:id/rollback` flips `activeHash` to a kept prior version
(instant, offline, restores that version's structural fields). **Phase 10**:
the `/api/backup` ZIP already covers `data/` wholesale (so addon-data + the
registry + addon code are in it — a restore recreates the nested dirs); added
**keep-last-K pruning** of old `<hash>/` code dirs (`_pruneAddonVersions` on
install + `_pruneAllAddonCode` boot sweep — only 16-hex dirs + a stale
`.incoming` are ever removed). **Phase 11** = the **addon-authoring guide**
[`examples/addons/AUTHORING.md`](examples/addons/AUTHORING.md) — a living
reference for human + AI authors (manifest, full host + serverHost API +
permission catalogue, the design-system/style contract, the
build→install→update→rollback loop, copy-paste templates, a "For AI assistants"
invariants section). Its flagship template is validated against the real test
harness. **The framework is now feature-complete** across distribution,
permissions, additive UI, dependencies, addon collections, per-entity data,
fragment overrides + conflict resolution, server-side code, pre-activation
testing, the update/rollback wizard, and backup coverage.

### On-disk layout (all under the data volume)
- `data/addons/<id>/<contentHash>/` — extracted addon CODE,
  **content-addressed** (the live version is `registry.activeHash`;
  rollback = flip the hash; `versions[]` keeps the last K). Served
  same-origin (CSP-clean) at `/addons/<id>/<hash>/…`
  (`express.static`, `fallthrough:false` → clean 404 on a miss, never
  the SPA index).
- `data/addon-data/<id>/` — each addon's isolated runtime data. Addon-owned
  collections (Phase 4b-2) live here as `data/addon-data/<id>/<name>.json`
  (one file per declared collection — removed with the addon, NOT in the flat
  data root). Snapshot- + data-hash-covered (see the `_trackedDataFiles` helper
  in server.js — the single source of truth for "what counts as data").
- `data/addons.json` — the **registry** (top-level → rides snapshots +
  the data hash). Shape: `{ schema, addons:[{id, repo, ref, sha, name,
  version, apiVersion, hostVersion, entry, server, contentDir, serverDeps[], activeHash,
  versions:[{contentHash,version,sha,installedAt, entry,server,contentDir,serverDeps,
  collections,dependencies,optionalDependencies}], enabled, grantedPermissions[],
  dependencies{}, optionalDependencies{},
  collections:[{name,keyed}], schemaVersion}], resolutions:{}, sources:{allow:[]} }`.
  `ref` is the original branch/tag (for update checks); `sha` the installed
  commit. `versions[]` snapshots each version's structural manifest fields so a
  rollback restores them, not just the code dir.
  `sources.allow` is an **audit trail** of repos an addon was installed from
  (`owner/name` / `owner/*`), auto-appended on install. NOTE: install does NOT
  currently gate on it — explicit DM paste-and-confirm IS the trust gesture. The
  `isAllowed`/`matchRepoRule` broker helpers exist (and are unit-tested) for an
  optional future "only from recorded sources" gate, but are not wired into
  `/api/addons/install` today.

### Manifest (`addon.json`, repo root)
`{ id (^[a-z0-9][a-z0-9-]{1,38}$ — no underscores, which also blocks
`__proto__`-style keys), name, version (semver), apiVersion (must equal
host `HOST_API_VERSION`, currently 1), hostVersion, entry (client ESM,
**default-export `register(host)`**), server? (relative `.cjs`/`.js` Node module,
**exports `init(serverHost)`** — Phase 7), contentDir? (relative dir of a
per-record JSON tree the HOST serves at `/api/addon/<id>/content*` — the
declarative "static rulebook" seam: no server code, no `server:code` grant,
hot-loaded; see the API table row), serverDeps? (`string[]` of vetted host
npm libs the server module needs — must be in `HOST_SERVER_LIBS` =
`{express, adm-zip, archiver, multer}` or the addon loads `blocked`), permissions[],
dependencies? (HARD — a missing/incompatible one `blocks` the addon), optionalDependencies?
(same shape; **SOFT** — ordering-only: loads the dep first WHEN present + compatible, but
NEVER blocks when it's absent/blocked/incompatible — the soft-use seam, e.g. a sheet that
auto-fills from a rules engine when installed and hand-fills when not), collections? (`[{name (^[a-z0-9][a-z0-9_]{0,39}$), keyed?}]` —
addon-owned data collections, validated + de-duped by `normalizeCollections`),
tests? (`{client?, server?}` — relative path or `string[]` of self-test files
run by the pre-activation gate, Phase 8), summary }`.
`server/addons.cjs:validateManifest` is the always-run Tier-A gate.

### Server broker — `server/addons.cjs` (pure/injectable, unit-tested)
`validateManifest` · `matchRepoRule`/`isAllowed` · `contentHash` (sha256
over sorted `relpath\0buf`, 16-char) · `extractZip` (strips the GitHub
`<owner>-<repo>-<sha>/` wrapper, drops unsafe paths via `_safeRel`) ·
`resolveRefToSha`/`fetchZipball` (injected `fetch`) ·
`defaultRegistry`/`normalizeRegistry` · **collection helpers** (4b-2):
`normalizeCollections` (manifest `collections[]` → clean `[{name,keyed}]`),
`addonCollectionType(id,name)` → `addon:<id>:<name>`, `parseAddonType(type)`
→ `{id,name}|null` (tight id+name regex = the path-safety gate). server.js
owns the disk + the endpoints. Install is two-phase so it never blocks other
writers: **`_stageAddon`** (fetch→validate→hash→stage `.incoming`→server
test-gate — all the network + up-to-30 s test work, **outside** the write lock)
then **`_promoteAddon`** (atomic rename to `<hash>/`→registry mutation→collection
wiring→prune, **under** `withWriteLock` + `_safeJoinIn`). GitHub fetches carry an
`AbortSignal.timeout` so a hung repo can't stall the install (or wedge the lock).
`_readAddonsRegistry`/`_writeAddonsRegistry`,
`_publicAddonList`. Endpoints in the API table; install/sources are
**DM-only on `realRole`**. Each write broadcasts a new SSE event
**`addons-changed`**. `server/addons.cjs` joins
`visibility.cjs`/`migrations.cjs` as a required `server/` module (covered
by `COPY server ./server`); `ADDONS_DIR`/`ADDON_DATA_DIR` are mkdir'd at
boot.

**Addon collections through the data path (4b-2).** `_applyAddonCollections(reg)`
augments the mutable type sets (`ALLOWED_TYPES`/`ALL_TYPES`, + `KEYED_OBJ_TYPES`
when `keyed`) with `addon:<id>:<name>` for every enabled addon's declared
collections — tracked in `_addonCollTypes` so re-applying after an install /
enable / disable / remove is a clean swap, never an accumulation. Called once at
boot (in `_bootstrap`, after the visibility migration) and after each registry
mutation. `getFile(type)` routes an `addon:<id>:<name>` type to
`data/addon-data/<id>/<name>.json` (via `parseAddonType` + `_safeJoinIn`); the
PATCH handler mkdirs the per-addon dir before `_atomicWrite`. Addon collections
are **public, non-visibility-bearing, non-DM-only-write** (same posture as
`pets`): any authed role may write, anonymous is 401, `filterForRole` is
identity, and keyed addon collections still go through the `_isForbiddenKey`
proto-pollution guard. Snapshot + hash coverage: `_createSnapshot`,
`_restoreSnapshot`, and `_dataHash` all walk `_trackedDataFiles()` (core
top-level + `addon-data/<id>/*.json`, keyed `addon-data/<id>/<name>.json` in the
snapshot map), and `_maybeBustDataHash` busts on any write under
`ADDON_DATA_DIR` — so an addon-collection write propagates over SSE and survives
snapshot/restore exactly like core data. (Backup-ZIP coverage of `addon-data/**`
is still Phase 10.)

### Client host — `web/js/addons.js` (`Addons`)
- `init({toast, rerender})` (app.js injects `EditMode.toast` + a
  re-render fn so addons.js needn't import EditMode/Sidebar — avoids
  cycles) → `boot()` runs after `Store.load()`: fetch `/api/addons`,
  **topo-sort by manifest `dependencies` + `optionalDependencies`**
  (`addon-deps.js planLoadOrder`, deps first), then dynamic-`import()` each
  enabled addon's `entryUrl` in order + call its default-export
  `register(host)`. Addons whose HARD deps are missing / version-incompatible /
  cyclic load to a visible **`blocked`** state instead of half-working;
  `optionalDependencies` are **ordering-only** (load after the dep when present,
  never block when absent — and an optional-edge cycle is broken, not blocked).
  `host.provide(api)` / `host.use(depId)` is the versioned inter-addon channel
  (`use()` requires the dep be declared as a hard OR optional dependency + the
  provider loaded; a present declared dep is load-ordered first, an absent
  OPTIONAL one just makes `use()` throw → caught → the consumer runs standalone).
- **Failure isolation**: every import + register is per-addon
  try/caught; a broken addon is marked `error` and SKIPPED — boot still
  completes, others still load, no white screen. A throwing route
  renderer degrades to an inline error pane.
- **`host` facade (permission-scoped)**: built from the addon's GRANTED
  permissions — an ungranted capability throws a clear, caught error (never
  a silent partial); the no-`window.*` design means the facade is the only
  path to Store/DOM, so this is a real boundary. **register() is
  transactional** — a throw rolls back the addon's partial registrations.
  `registerRoute` (←`ui:route`; segments colliding with a built-in
  `navigate()` section are **rejected**, never last-wins), `registerSidebarPage`
  (←`ui:sidebar`), `registerPageRenderer` (←`ui:route`, → `Wiki.renderPage`
  default), `registerArticleSection(kind,fn)` (←`ui:article-section:<kind>`;
  ADDITIVE — sections stack, each rendered safely), `registerSettingsTab`
  (←`ui:settings-tab`), `registerAction(name,fn)` (←`ui:action`; invoked via
  `data-action="<id>:<name>"` — build with `host.action(name)`),
  `registerCollection(name)` (←`data:own`; the collection MUST be declared in
  the manifest's `collections[]` — registering an undeclared one throws; backfills
  the local container so reads never throw), `registerWikiKind(scope, resolve)`
  (←`wiki:kind`; `resolve(label)` → `{kind,id}` for `[[Label|scope]]`; scope
  can't shadow a built-in), `registerEditorFields(kind,{fields,collect})`
  (←`ui:editor-fields:<kind>`; `fields(entity)`→HTML injected into the editor,
  `collect(scope,entity)`→object merged into `addonData[<id>]` on save; wired for
  characters), `registerFragmentOp(target,{op,render,order,position})`
  (←`ui:override`; claim a `replace`/`hide`/`wrap`/`insert` op on a named
  built-in fragment — recorded, NOT executed at register time, so conflicts
  surface instead of last-wins), **`registerSlot(slotId, render, opts)`**
  (←`ui:slot:<surface>`, surface = slotId's first `:`-segment; ADDITIVE content
  injection into a NAMED slot on ANY surface — `render(ctx)` → `{html}`|string|null,
  errors isolated; readback `Addons.slotContent(slotId, ctx)`. The open-ended
  slotId is the "no future rewrites" seam — a new surface adopts it with just a
  `slotContent` call-site, no new host API. Live timeline slots:
  `timeline:card:extra`, `timeline:column:header|footer`, `timeline:toolbar`,
  plus `Addons.applyFragments('timeline:card', …)` for replace/hide/wrap),
  **`registerConnectionKind(def)`** (←`kinds:connections`; DATA-only
  `{id,label,color,style,dirs?,target?}` merged into `Store.getKinds('connections')`),
  **`registerNodeKind(def)`** / **`registerGraphView(def)`** (←`kinds:graph`) +
  **`registerGraphContributor(viewId, fn)`** (←`graph:contribute`; inject
  nodes/edges into an existing mind-map view — host surface + Store.getKinds
  landed; the cloudmap renders addon node-kinds as cards + injects contributor
  nodes/edges into any view, and addon views are reachable at `/mapa/<viewId>`),
  `store` read getters (←`data:read:<collection>`) +
  `generateId` (always) + **`store.collection(name)`** (scoped CRUD —
  `list`/`get`/`save`/`remove` over the addon's own collection, backed by
  `Store.{ensureCollection,getAddonCollection,saveAddonItem,deleteAddonItem}`;
  `save`/`remove` stamp `updatedAt`, fire `_sync(addon:<id>:<name>, …)`, bust the
  markdown cache) + **`store.patchAddonData(collection,id,fn)`**
  (←`data:write:<collection>.addonData`; read-modify-write the addon's OWN
  namespace on a core entity — host injects the addon id; backed by
  `Store.patchAddonData`), `role`, `h`
  (`esc`/`dataAction`/`dataOn`/`renderMarkdown`/`slugify`/`breadcrumb` — addons MUST
  build HTML with these, never inline `onclick`; `breadcrumb(crumbs)` =
  `utils.breadcrumbNav`, the core wayfinding row, so addon pages don't roll
  their own ← back links), **`host.asset(rel)`** (always available — URL of a
  file bundled with the addon: `/addons/<id>/<hash>/<rel>`, derived from the
  loaded entryUrl so it's version-safe; how book addons resolve record
  images), `ui.toast` + **`ui.rerender()`** (re-render
  the current route after a write). `Addons.describePermission(perm)` provides the
  permission labels (core Manager chrome — localized via `I18n.t`; the addon
  facade itself has NO translation API, addons are English-only).
- **Integration seams**: `app.js navigate()` default arm →
  `Addons.hasRoute(section) ? Addons.renderRoute(...)` before the dashboard
  fallback; `app.js _runAction` routes any `data-action` containing `:` to
  `Addons.runAction`; `wiki.js renderPage()` default → `Addons.renderPage`, and
  `_articleShell({kind, entity})` builds its main column as a NAMED fragment
  list (core sections + `Addons.articleSections` + body) and runs it through
  `Addons.applyFragments(kind, frags, entity)` (replace/hide/wrap/insert +
  conflict-safe arbitration; pass-through at zero cost when no override addons
  exist) — wired for characters / locations / events / mysteries / factions;
  **`editmode.js` fills the character
  editor's `.addon-editor-fields` slot from `Addons.editorFields('characters',
  c)` (in `mountEasyMDE`) and merges `Addons.collectEditorFields(...)` into
  `addonData` in `saveCharacter`; server `_sanitizePlayerEntity` shallow-merges
  player `addonData` over existing (no drop-by-omission)**; `settings.js
  _visibleSpecialTabs` +
  `_editorHtml` union `Addons.settingsTabs()` / `Addons.settingsTab(id)`;
  `sidebar.js render()` appends a **"🧩 Doplňky"** section from
  `Addons.sidebarPages()`; the SSE `addons-changed` listener calls
  `Addons.reconcile()` to live-load newly-enabled addons; **app.js's wiki-link
  resolver falls through to `Addons.resolveWikiLink(label, hint)`** after every
  built-in collection misses, so `[[Label|scope]]` resolves into an
  addon-registered kind (additive — never shadows a core scope).

### Fragment overrides + conflict resolution (Phase 6)
A decomposed built-in surface emits an ORDERED list of NAMED fragments
`[{id, html}]`. Today only the **character article main column** is decomposed:
ids `characters:section:{vazby,udalosti,znalosti,otazky,mazlicci}`,
`characters:addon:<addonId>:<i>` (addon-added sections), `characters:body`.
Other article kinds decompose coarsely (`<kind>:section:s<i>` + `<kind>:body`).
Adding a stable id to a `_articleShell` section makes it a targetable fragment.

Addons claim ops with `host.registerFragmentOp(target, {op, render, order,
position})` (perm `ui:override`). The claim is **recorded, never executed at
register time** — arbitration happens at render in the pure engine
[`web/js/addon-fragments.js`](web/js/addon-fragments.js) (`applyFragmentOps` +
`listConflicts`, unit-tested headless):
- `replace` / `hide` — **EXCLUSIVE** per target. 0 claims → built-in; 1 → it
  wins; **≥2 unresolved → CONFLICT**: render the built-in (safe default), report
  it. Never last-wins.
- `wrap` — STACKABLE, ordered by `order`; `render(innerHtml, ctx)` → wrapped.
- `insert` — additive sibling (`position:'before'|'after'`); never conflicts.
- A claim whose target fragment is absent → reported `unmatched` (a visible
  addon warning, never a silent no-op). A throwing render degrades to built-in.

**Resolution.** `data/addons.json → resolutions{ target: winnerAddonId | null }`
(`null` = force built-in). DM-only `POST /api/addons/resolve {target, winner}`
(realRole; absent winner clears). The host pulls `resolutions` from
`GET /api/addons` on boot/reconcile; `Addons.conflicts()` feeds the Manager's
**Konflikty** cards (radio per claimant + "Vestavěné"), `Settings.resolveAddonConflict`
→ `Store.resolveAddonConflict` → the POST → `addons-changed` SSE → `reconcile`
flags the resolution change so the article re-renders with the winner applied.
`Addons.applyFragments` filters claims to the surface's `<kind>:` namespace, so
a claim for another surface is never mistaken for a missing target.

### Server-side addons (Phase 7)
An addon with a `server` manifest entry + granted **`server:code`** ships a Node
module (`data/addons/<id>/<hash>/server/index.cjs`, exports `init(serverHost)`)
the host loads **in-process** — full trust (the permission is transparency, not
containment; install is DM-only + SHA-pinned). server.js owns it all:
- **Dispatcher**: one stable `app.use('/api/addon/:addonId', …)` mounted BEFORE
  the SPA fallback delegates to the addon's live `express.Router()` from
  `_addonServers` (Map). Singular `/api/addon/` can't collide with the plural
  `/api/addons` management routes; an unmatched sub-path / disabled / absent
  addon → JSON 404 (never the SPA index). `req.role`/`realRole` are pre-stamped,
  so addon routes self-gate.
- **`serverHost` facade** (`_makeServerHost`): `get/post/put/delete` (mount under
  the addon's prefix only) + raw `.router`; `data.{read,write,dir}` confined to
  `data/addon-data/<id>/` (name regex + `_safeJoinIn`, writes under
  `withWriteLock`); `readCollection(name)` gated by granted `data:read:<name>`;
  `lib(name)` → a vetted host npm dep (`HOST_SERVER_LIBS`); `withLock`,
  `broadcastDataChanged`, `log`.
- **Loader** (`_loadServerAddon`): `require()` the SHA-pinned file + `await
  init(host)` inside try/catch — a throw NEVER crashes the server (mirrors
  `try{require('./tiler')}catch`); records `loaded`/`error`/`blocked`(no perm /
  unmet serverDeps)/`null`(no server). `_loadServerAddons()` runs the sweep in
  `_bootstrap` before `app.listen`.
- **Restart-to-load (v1)**: runtime install/enable/disable does NOT hot-swap
  require()'d code — `GET /api/addons` reports `serverState` (incl.
  `pending-restart`), shown as a chip in the Manager; a restart loads/unloads.
  A disabled/removed addon's router is dropped from `_addonServers` immediately
  (serves nothing) even before the restart.
- Code lives in the `data/` volume → no Dockerfile change; survives rebuilds.

### Security posture (hardening pass)
The model is **trusted, DM-only install, in-process** (no sandbox yet) — `server:code`
is candidly full host access (the permission is transparency, not containment).
On top of that base, the concrete guardrails (added in the review/polish pass):
- **Install runs addon code only behind the same gate it'll run under.** The
  `tests.server` green-gate executes addon code, so it runs ONLY when `server:code`
  is granted, and the spawned `node --test` gets a **scrubbed env** (`_scrubbedChildEnv`
  strips `*TOKEN*`/`*PASSWORD*`/`*SECRET*`/… ) so an addon's tests can't read
  `GITHUB_TOKEN`/passwords.
- **Restore can't plant code.** `_safeJoinDataDir` rejects any entry under
  `data/addons/` (and the snapshots dir). Backups include addon code for
  inspection, but a restored ZIP can never write a `server/index.cjs` that boot
  `require()`s — addon code only ever lands via `_installAddon` (preview → SHA-pin
  → content-hash). Addon DATA (`data/addon-data/`) restores normally.
- **`serverHost.readCollection`** is gated by `data:read:<name>` AND restricted to
  real collections in `ALLOWED_TYPES` that aren't `addon:`-prefixed — so
  `data:read:auth` can't leak `auth.json` (password hashes) and an addon can't read
  another addon's collection. The client facade's `store.getCollection` likewise
  rejects `addon:` names.
- **Zip-bomb cap** in `extractZip` (declared-size + per-entry checks BEFORE/DURING
  decompression, + file-count cap) so a 25 MB zipball can't OOM the container.
- **Manifest hygiene:** `permissions[]` must be lowercase token strings;
  `_applyAddonCollections` re-validates `id`/collection-name from the persisted
  registry; a corrupt `addons.json` is preserved as `.corrupt-<ts>` rather than
  silently overwritten. Dispatcher + every addon render/route is try/caught (a
  throwing addon never crashes the server or white-screens the app).
- **Live unload:** `Addons.reconcile` now tears down a disabled/removed addon
  (reverses its registrations via the kept `tx.undo`) instead of leaving it active
  until a reload — so "remove" actually removes it across tabs.
- **CSRF** on the DM mutation endpoints (install = code execution) is mitigated by
  the `edit_session` cookie's `sameSite: 'lax'` — a cross-site POST omits the
  cookie, so `realRole` is null → 403.
- Accepted/deferred (documented, not bugs): no iframe/Worker sandbox; the wizard's
  permission review is all-or-nothing (no per-permission deny); restart-to-load for
  server code (the `require` cache isn't busted live).

### Pre-activation testing (Phase 8)
Three tiers gate a version before it goes live (green-only — a red set is never
activated, which is free because install stages to `.incoming` then atomic-
renames):
- **Host test harness** `web/js/addon-test-harness.mjs` (pure, no DOM, published
  for addon authors): `createMockHost(meta, opts)` (records every `register*`
  call, stubs `store`/`role`/`h`/`ui`; **ENFORCES `meta.permissions` like the
  real facade when the array is declared** — an under-declared manifest fails
  in tests with the exact live error instead of at install; omit the key for
  loose allow-all), `dryRunRegister(register, meta)` (Tier-A
  — run register against the mock, catch throws, return the `rec`), and
  `smokeRegistrations(rec)` (Tier-C — invoke each recorded RENDER with sample
  fixtures; actions/collect are NOT run). Unit-tested; the
  `examples/addons/sheet/tests/sheet.addon-test.mjs` reference test exercises it
  against a real addon.
- **Client render-smoke at load** (`addons.js`): after a clean `register`,
  `_recForAddon(id)` gathers the addon's LIVE renderers and runs
  `smokeRegistrations` — a throw on benign input becomes a NON-blocking `⚠ test
  vykreslení` chip in the Manager (`Addons.list()[].smoke`); the addon still
  loads (a hard pre-activation gate is the wizard's job, Phase 9).
- **Server green-gate at install** (`server/addon-testing.cjs` →
  `runNodeTests(cwd, paths, {spawn, timeoutMs})`, injectable spawn, unit-tested):
  `_stageAddon` runs the manifest's `tests.server` files with `node --test
  --test-isolation=none` (env stripped of `NODE_TEST_CONTEXT` so a nested run
  awaits async tests; `--test-isolation=none` so the timeout kill leaves no
  orphan; the spawned child env defaults to a SCRUBBED `process.env` even if a
  caller omits `env`) against the staged tree; red / timeout → discard staging,
  throw, never promote. Staged tree has no `node_modules` — server self-tests must be
  self-contained (Node built-ins + the addon's own files). `server/addon-testing.cjs`
  is a required `server/` module (COPYed by `COPY server ./server`).

### Dev / testing
- `node scripts/dev-install-addon.cjs <addon-dir> [data-dir]` installs a
  LOCAL addon directory (bypasses GitHub / allowlist / UI) — it mirrors
  `_installAddon`'s content-addressed layout + registry entry so the app
  loads it on next launch. Reference addons: `examples/addons/hello/`
  (route `/pozdrav` + sidebar link, reads characters via `host.store`),
  `examples/addons/sheet/` (Phase 5 — an active character sheet: interactive
  HP +/− via `patchAddonData`, `registerEditorFields` on the character editor,
  an article section, settings tab), and
  `examples/addons/rules/` (4b-2 — an addon-owned collection via
  `registerCollection` + scoped CRUD, `[[…|pravidlo]]` wiki-links via
  `registerWikiKind`, a `/pravidla` page), `examples/addons/override/`
  (Phase 6 — a `wrap` fragment-override op on `characters:body`), and
  `examples/addons/dice/` (Phase 7 — a `server/index.cjs` exposing
  server-authoritative `/api/addon/dice/roll` + an isolated server-side log).
  **Author reference: [`examples/addons/AUTHORING.md`](examples/addons/AUTHORING.md)**
  — the full guide for writing addons (human + AI). A condensed, standalone
  **[`examples/addons/AGENTS.md`](examples/addons/AGENTS.md)** holds the same
  invariants + template for an AI agent to copy into a new addon's own repo root
  (auto-picked-up by Claude Code / Cursor). Keep both current when the host API
  changes. No addons are published yet — these are dev fixtures + the contract
  real addons will be built against, so accuracy matters.
- Unit tests: `test/addons.test.cjs` (manifest validation / allowlist /
  content-hash determinism / zip extraction / repo-URL parsing + collection
  helpers `normalizeCollections`/`addonCollectionType`/`parseAddonType`) +
  `test/addon-deps.test.mjs` (semver `satisfies` + `planLoadOrder`
  topo-sort / blocked / cycle) + `test/addon-data.test.mjs` (Phase 5
  `Store.patchAddonData` — namespace isolation, patchFn semantics, unknown
  collection/entity) + `test/addon-fragments.test.mjs` (Phase 6 pure engine —
  replace/hide/wrap/insert, conflict + resolution arbitration, unmatched,
  render failure isolation) + `test/integration-addon-resolve.test.cjs`
  (`POST /api/addons/resolve` — set/null/clear, realRole gating, proto-key
  guard) + `test/integration-addon-collections.test.cjs`
  (the addon-collection data path end-to-end: isolated-dir persistence, GET
  payload, keyed/list shapes, proto guard, role gating, hash bust, snapshot
  restore) + `test/integration-addon-server.test.cjs` (Phase 7 — server addon
  routing + isolated data, `server:code` gating, serverDeps blocking, throwing-
  init isolation, disabled state; uses the helper's new `seedFiles` option to
  lay down nested addon code before boot) + `test/addon-test-harness.test.mjs`
  (Phase 8 — mock host records, dryRunRegister catch, smoke flags throwing
  renderers but not actions) + `test/addon-testing.test.cjs` (the server
  green-gate runner — green/red/timeout/no-files) + `test/integration-addon-update.test.cjs`
  (Phase 9 — content-addressed rollback flip + field restore, targeted/default/
  error paths, check-updates empty/local/role-gating) + `test/integration-addon-backup.test.cjs`
  (Phase 10 — `/api/backup` ZIP includes addon-data/registry/code, boot-sweep
  prunes stale `<hash>`/`.incoming` but keeps kept-K + non-hash dirs) +
  `test/addon-content.test.cjs` (contentDir loader — tree walk, kinds,
  per-record shapes) + `test/integration-addon-content.test.cjs` (the
  host-served `/api/addon/:id/content*` endpoints end-to-end) +
  `test/addon-contrib.test.mjs` (graph/node-kind contribution registries) +
  `test/integration-restart-updateall.test.cjs` (`/api/restart` gating +
  `/api/addons/update-all`).
  `test/integration-player-edits.test.cjs`
  also covers the player `addonData` shallow-merge guard. `examples/` + `scripts/`
  are dev-only and are NOT copied into the Docker image.
