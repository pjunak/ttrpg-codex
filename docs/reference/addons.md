# Addon framework (CodexHost) — deep reference (ttrpg-codex)

> Moved verbatim out of AGENTS.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as AGENTS.md itself. Cross-references like "see X above"
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
  collections live here as `data/addon-data/<id>/<name>.json` (one file per
  declared collection, not in the flat data root). Disable and ordinary
  uninstall preserve it; explicit `?purge=1` removes it. Snapshot- + DM-hash-covered (see the `_trackedDataFiles` helper
  in server.js — the single source of truth for "what counts as data").
- `data/addons.json` — the **registry** (top-level → rides snapshots +
  the data hash). Shape: `{ schema, addons:[{id, repo, ref, sha, name,
  version, apiVersion, hostVersion, entry, server, contentDir, contentGroups?, locales?,
  disabledContentGroups?, serverDeps[], activeHash,
  versions:[{contentHash,version,sha,installedAt, entry,server,contentDir,serverDeps,locales,
  collections,dependencies,optionalDependencies}], enabled, grantedPermissions[],
  dependencies{}, optionalDependencies{},
  collections:[{name,keyed,access}], schemaVersion}], resolutions:{}, sources:{allow:[]} }`.
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
`__proto__`-style keys), name, version (strict `MAJOR.MINOR.PATCH`),
apiVersion (`1` and `2` supported during migration), hostVersion, entry (client ESM,
**default-export `register(host)`**), server? (relative `.cjs`/`.js` Node module,
**exports `init(serverHost)`** — Phase 7), contentDir? (relative dir of a
per-record JSON tree the HOST serves at `/api/addon/<id>/content*` — the
declarative "static rulebook" seam: no server code, no `server:code` grant,
hot-loaded; see the API table row), contentGroups? (`{field, label?}` — names
a record property of the content tree, e.g. `book`, whose distinct values the
DM can toggle per group in Settings → Doplňky; the HOST filters the served
tree hot via `POST /api/addons/:id/content-groups` — registry stores the
declaration as `contentGroups` + the DM's picks as `disabledContentGroups`;
`normalizeContentGroups` in `server/addons.cjs` re-checks shapes on read.
`groupValues` emits `[{id, count, label}]`: `label` is the `name` of a
record of the field-named KIND with a matching id — `book` value `phb` →
the `book` record's "Player's Handbook" — falling back to the raw id, so
the Manager shows full names while the off-list wire format stays ids),
locales? (`{ "en": "locales/en.json", "cs": "locales/cs.json" }` — API-v2
declarative UI catalogs; requires `i18n.catalogs`, mandatory English source,
partial translations allowed; package paths are confined `.json` files and the
staged package validator checks their content before promotion),
serverDeps? (`string[]` of vetted host
npm libs the server module needs — must be in `HOST_SERVER_LIBS` =
`{express, archiver, multer}` or the addon loads `blocked`; archive readers are
deliberately not exposed), permissions[],
dependencies? (HARD — a missing/incompatible one `blocks` the addon), optionalDependencies?
(same shape; **SOFT** — ordering-only: loads the dep first WHEN present + compatible, but
NEVER blocks when it's absent/blocked/incompatible — the soft-use seam, e.g. a sheet that
  auto-fills from a rules engine when installed and hand-fills when not), collections? (`[{name (^[a-z0-9][a-z0-9_]{0,39}$), keyed?, access?}]` —
  addon-owned data collections, validated + de-duped by `normalizeCollections`;
  `access` defaults to `"public"`, while `"dm"` is API-v2-only and requires
  `collections.dm` in `capabilities.required`),
tests? (`{client?, server?}` — relative path or `string[]` of self-test files
run by the pre-activation gate, Phase 8), summary }`.
`server/addons.cjs:validateManifest` is the always-run Tier-A gate.

**API v2 compatibility contract.** API v1 remains loadable unchanged; an
omitted v1 `hostVersion` means `*`. API v2 requires an enforced
`hostVersion`. Versions have exactly three numeric components. Ranges support
only `*`, exact, `> >= < <=`, `^`, `~`, and `M.x`/`M.m.x`; malformed installed
versions and unsupported range syntax fail closed. Dependency keys must be
valid addon ids. `capabilities` is API-v2-only and has the shape
`{required?:string[], optional?:string[]}`. Required unavailable capabilities
block installation and loading; optional known capabilities can be discovered
with `host.capabilities.has(id)`. Unknown, malformed, or duplicate declarations
are rejected. `collections.dm` enables host-managed DM-only collections. Collection
security fields are strict: API v1 cannot declare `access`; API v2
`access:"dm"` requires `collections.dm`; unknown fields are rejected. This
ensures old hosts reject v2 and incapable new hosts reject the capability,
never broadening DM data to public access.
`collections.transactions` enables atomic, revision-checked writes across an
addon's own declared collections and requires `data:own` plus at least one
collection declaration.

The API-v2 capabilities currently advertised by the host are
`collections.dm`, `collections.transactions`, `lifecycle.dispose`,
`content.revision`, `i18n.catalogs`, `imports.providers`, and `graphs.facade`. An addon that requires any
contract must declare it in `capabilities.required`; v1 addons remain loadable
without either declaration. `lifecycle.dispose` enables the teardown contract
described below. `content.revision` exposes the active package/content-policy
revision as `host.contentRevision`.
`i18n.catalogs` enables the declarative manifest locale map and the scoped
`host.i18n` facade; English must load successfully before registration.
`imports.providers` enables the F4 server-side import-provider contract. It
requires a server module, `server:code`, `data:import-provider`, `data:own`,
`collections.transactions`, and at least one declared collection. Existing
addons that do not negotiate it are unchanged.
`graphs.facade` enables browser graph facade API v1 and requires
`lifecycle.dispose` plus the reviewed `ui:graph` permission. The facade
version is independent of the bundled graph-library version.

### Server broker — `server/addons.cjs` (pure/injectable, unit-tested)
`validateManifest` · `matchRepoRule`/`isAllowed` · `contentHash` (sha256
over sorted `relpath\0buf`, 16-char) ·
`resolveRefToSha`/`fetchZipball` (injected `fetch`) ·
`defaultRegistry`/`normalizeRegistry` · **collection helpers** (4b-2):
`normalizeCollections` (manifest `collections[]` → clean `[{name,keyed,access}]`),
`addonCollectionType(id,name)` → `addon:<id>:<name>`, `parseAddonType(type)`
→ `{id,name}|null` (tight id+name regex = the path-safety gate), and
`contentRevision(entry, crypto)` → a deterministic short SHA-256 over the
active package hash, version, content declaration, and sorted disabled content
groups. server.js
owns the disk + the endpoints. Install is two-phase so it never blocks other
writers: **`_stageAddon`** (fetch→validate→hash→stage `.incoming`→server
test-gate — all the network + up-to-30 s test work, **outside** the write lock)
then **`_promoteAddon`** (atomic rename to `<hash>/`→registry mutation→collection
wiring→prune, **under** `withWriteLock` + `_safeJoinIn`). GitHub fetches carry an
`AbortSignal.timeout` so a hung repo can't stall the install (or wedge the lock).
**Private repos:** every api.github.com call (preview `fetchManifest`, install
`_stageAddon`, `check-updates`, `update-all`) threads `_githubToken()` as
`Authorization: Bearer`. Two token sources, stored-wins: the **DM-stored
token** — set from the install wizard's 🔑 section via
`POST /api/addons/github-token`, persisted in `data/secrets.json`
(NON_DATA_JSON_FILES: excluded from snapshots, the data hash and restore,
PLUS filtered out of the `/api/backup` ZIP — a live plaintext credential
must never ride into a shareable archive; `chmod 600` best-effort) — then
the env vars `CODEX_GITHUB_TOKEN` / alias `GITHUB_TOKEN` (see
SELF_HOSTING.md). The value is never echoed, logged, backed up or
snapshotted. A 404 with no token configured gets the `_privateRepoHint`
suffix (GitHub 404s anonymous hits on private repos, which otherwise reads
as "repo doesn't exist") and the wizard auto-opens its token section.
`GET /api/addons` carries DM-only `githubTokenConfigured` (boolean) +
`githubTokenSource` (`'stored'|'env'|null`) → the Manager's 🔑 line + the
wizard summary. Covered by `test/integration-github-token.test.cjs`.
`_readAddonsRegistry`/`_writeAddonsRegistry`,
`_publicAddonList`. Endpoints in the API table; install/sources are
**DM-only on `realRole`**. Each write broadcasts a new SSE event
**`addons-changed`**. `server/addons.cjs` joins
`visibility.cjs`/`migrations.cjs` as a required `server/` module (covered
by `COPY server ./server`); `ADDONS_DIR`/`ADDON_DATA_DIR` are mkdir'd at
boot.

**Addon collections through the data path (4b-2 + F1).**
`_applyAddonCollections(reg)` augments the mutable type sets
(`ALLOWED_TYPES`/`ALL_TYPES`, plus `KEYED_OBJ_TYPES` when `keyed`) with the
wire identity `addon:<id>:<name>` for every enabled declaration. The
`_addonCollections` map retains `{addonId,name,keyed,access}` for each wire
type, so authorization never relies on a bare global collection name.
Re-applying after install, update, rollback, enable, disable, restore, or
remove is a clean swap. `getFile(type)` maps that identity to
`data/addon-data/<id>/<name>.json` through `parseAddonType` and `_safeJoinIn`.

Public declarations keep the existing posture: any authenticated role may
write, anonymous writes are 401, records are schema-opaque, and keyed
collections use the prototype-pollution guard. An API-v2 declaration with
`access:"dm"` is readable and writable only for the effective DM role.
Player, anonymous, and DM view-as-player `/api/data` projections omit it
before serialization. Guessed PATCH requests receive the same generic 404 for
a hidden declaration and an undeclared addon type. The public `/api/addons`
projection similarly removes hidden collection declarations and the addon's
`collections.dm` requirement; DM metadata includes normalized access and the
full capability declaration for diagnostics.

Snapshots, restore, and DM-authorized backup continue to include the isolated
file without changing its record schema. The DM hash covers the full tracked
dataset. The player hash is computed from the player-authorized `/api/data`
projection, so DM-only files and audit metadata cannot perturb it. A DM-only
write sends `data-changed` only to effective-DM SSE connections. Snapshots
created solely by such writes are omitted from the player snapshot list, and
the player snapshot projection carries neither hashes nor sizes. Client JSON
exports contain only the already-authorized Store projection. Disable and
ordinary uninstall preserve collection files; `?purge=1` retains the existing
explicit destructive policy.

`server/addon-localization.cjs` applies the shared catalog validator to staged
packages: it resolves declared locale files inside the package root, rejects
symlinks/non-files and oversized files before reading, parses English first,
then checks every translation against its source shapes/placeholders. Both the
GitHub installer and `scripts/dev-install-addon.cjs` call it before promotion.

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
- **Lifecycle + reconciliation:** a successful `register(host)` may return a
  cleanup function and may also register any number of cleanup functions with
  `host.onDispose(fn)`. Each cleanup is invoked exactly once, in reverse
  registration order, before the host reverses the addon's ordinary
  registrations. Promise-returning cleanup is allowed; cleanup for each addon
  is bounded to two seconds and failure is isolated. `reconcile()` compares
  both `entryUrl` and `contentRevision`; changed/disabled/removed addons and
  their loaded hard or optional consumers unload consumer-first, then reload
  provider-first. Overlapping reconciliations are coalesced and serialized so
  only the newest server metadata survives.
- **Failure isolation**: every import + register is per-addon
  try/caught; a broken addon is marked `error` and SKIPPED — boot still
  completes, others still load, no white screen. A throwing route
  renderer degrades to an inline error pane.
- **Declarative localization:** before importing an addon module,
  `loadAddonCatalogs` fetches its manifest-declared catalogs from the active
  content-addressed package. The mandatory English source is a hard per-addon
  gate; optional translation fetch failures warn and fall back. The scoped
  facade resolves exact locale → base locale → English and never registers
  keys in core `I18n`. Cache identity includes addon/revision/locale/path;
  disposal aborts pending fetches, clears owned cache entries, and prevents
  late stale responses from reaching a replacement instance.
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
  (←`ui:settings-tab`; renders as a SUB-tab of Nastavení → Doplňky beside
  the DM-only Manager — see settings.md), `registerAction(name,fn)` (←`ui:action`; invoked via
  `data-action="<id>:<name>"` — build with `host.action(name)`),
  `registerCollection(name)` (←`data:own`; the collection MUST be declared in
  the role-authorized manifest `collections[]` — registering an undeclared one
  throws; shape/access come only from server metadata), `registerWikiKind(scope, resolve)`
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
  markdown cache; a DM handle read after entering player view returns the empty
  shape and rejects writes) + **`store.transaction(names, callback, opts?)`**
  (API v2 + negotiated `collections.transactions` + `data:own`; captures one
  revisioned snapshot of registered own collections, exposes buffered
  `tx.collection(name).{list,get,put,remove}`, then commits only if the whole
  read set is still current; callback/validation/conflict/expiry failure
  leaves every collection unchanged; nested transactions and duplicate
  `(collection,id)` writes reject; returns
  `{ok,commitId,changed,collections,revisions,value}`) +
  **`store.patchAddonData(collection,id,fn)`**
  (←`data:write:<collection>.addonData`; read-modify-write the addon's OWN
  namespace on a core entity — host injects the addon id; backed by
  `Store.patchAddonData`), `role`, `h`
  (`esc`/`dataAction`/`dataOn`/`renderMarkdown`/`slugify`/`breadcrumb`/`icon` — addons
  MUST build HTML with these, never inline `onclick`; `breadcrumb(crumbs)` =
  `utils.breadcrumbNav`, the core wayfinding row, so addon pages don't roll
  their own ← back links; `icon(name, {size, label})` = `utils.iconGlyph`, the
  shared stat-glyph set — heart/shield/bolt/chevrons/medal/plus-circle/eye — so
  addon stat tiles don't ship their own SVGs), **`host.asset(rel)`** (always available — URL of a
  file bundled with the addon: `/addons/<id>/<hash>/<rel>`, derived from the
  loaded entryUrl so it's version-safe; how book addons resolve record
  images), `ui.toast` + **`ui.rerender()`** (re-render
  the current route after a write) + **`ui.announce(text)`** (screen-reader
  status via the host's ONE persistent polite live region — survives the
  full-page re-renders that destroy any live region inside a route's own HTML;
  use for "N matches" / "N pts left", not as a visual toast). `Addons.describePermission(perm)` provides the
  permission labels (core Manager chrome — localized via `I18n.t`).
  **`host.i18n`** is always a per-addon facade with
  `locale`, `t`, `plural`, `formatDate`, `formatNumber`, and `relativeTime`;
  declarative catalogs require API v2 + `i18n.catalogs`.
  **`host.imports`** is the browser-side F5 facade for an API-v2 addon that
  negotiated `imports.providers` and received `data:import-provider`. It can
  list only that addon's authorized providers and can create, preview, inspect,
  commit, or cancel only jobs created by that facade instance. It never exposes
  raw server paths, provider execution, transactions, foreign jobs, or plan
  mutation. Requests abort on addon disposal; effective-player calls fail
  before transport.
  **`host.graphs`** is the browser-side F6 facade for an API-v2 addon that
  negotiated `graphs.facade` and received `ui:graph`. API v1 exposes
  `available()`, `status()`, and async `mount(container, spec)`. A mounted
  handle exposes only `update`, `select`, `focus`, `fit`, `on`, and idempotent
  `destroy`; raw Cytoscape constructors, instances, selectors, styles,
  layouts, events, globals, and plugin loading never cross the boundary.
  Always-available lifecycle metadata is `host.contentRevision`, and
  `host.onDispose(fn)` registers resource cleanup. The former changes when the
  active package identity/version or effective content-group policy changes,
  but stays stable for semantically equivalent policy data.
  A role transition clears every in-memory addon container before refetch,
  reconciles addons when their authorized collection declarations change, and
  reconnects SSE under the new effective role. Switching back to DM therefore
  reloads data only through the authorized server path.
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

### Import providers (F4 server core)

An API-v2 server addon may require `imports.providers` and call
`serverHost.registerImportProvider(descriptor)`. Provider identity is the
tuple `(addonId, providerId)`; duplicate, malformed, unknown-version,
undeclared, foreign, and unsupported declarations throw during addon init.
Provider API v1 supports JSON input and writes only the registering addon's
declared list/keyed collections. Core reads require an explicit
`data:read:<collection>` grant. Core writes and cross-addon reads/writes are
unsupported in v1 and fail closed; a bare collection name never implies
authority.

The descriptor declares `id`, `apiVersion:1`, an independent positive
`schemaVersion`, `formats:["json"]`, explicit `reads[]`/`writes[]` collection
references, accepted `targetTypes` (`addon-list`/`addon-keyed`), bounded
`limits`, `capabilities` (including `abort-signal`), and
`preview(input, context)`. The callback must be deterministic for the supplied
input, snapshots, and revisions. It receives parsed cloned data, harmless
filename/MIME hints, parse statistics, an `AbortSignal`, and `read`/`revision`
functions restricted to the declared read set. It receives no path,
transaction, journal, lock, password, request, or unrestricted Store object.
Because server addons remain trusted in-process Node code, this facade is a
contract boundary rather than a sandbox; malicious `server:code` can still use
Node built-ins outside the provider callback contract.

The host validates provider output into plan version 1. Operations are
put-only, target only declared writes, carry identity in `operation.id`, and
may not set host-owned metadata in `value` (`id`, addon/namespace/access,
revision/audit, or actor fields). Diagnostics are structured plain text
(`severity`, token-shaped `code`, bounded `message`, optional path); provider
HTML is never accepted as a renderable field.

Import jobs are ephemeral and real/effective-DM-only. Uploads are staged under
an OS-temp root keyed to the campaign data path, never under `data/`. A strict
raw JSON parser rejects invalid UTF-8, nested duplicate keys (including escaped
equivalents), forbidden prototype keys, excessive bytes/depth/records/strings/
nodes, and malformed JSON before provider work. Preview snapshots all declared
read/write revisions under the core queue, performs no mutation/snapshot/hash/
SSE work, validates the returned operations, stores the normalized plan
server-side, and returns an opaque token bound to its digest.

Commit accepts only the job id and token. It never reruns provider
transformation or accepts client operations. It verifies session ownership,
expiry, provider/package/schema identity, token single-use, and every base
revision, then submits the exact stored operations through the F2 transaction
manager. A conflict requires a new preview. Successful work produces one F2
logical revision/snapshot/event; failure produces no partial writes.

Jobs have bounded lifetime/count/input/operations/provider time, per-addon and
per-provider concurrency, outstanding-job limits, and token buckets.
Cancellation, timeout, disconnect,
disable/update/unload, and package/content revision changes abort or invalidate
outstanding work. Input files are removed after preview, cancel, failure,
expiry, and commit; startup clears the campaign-specific temp root, so previews
do not survive restart. The published `server/addon-import-harness.cjs`
exports `createMockImportHost(...)` and runs the same descriptor/parser/plan/job
implementation in memory, including revision conflicts and atomic commit
results.

### Addon graph facade (F6)

`web/js/addon-graph.js` owns the graph facade contract and the single
host-global implementation registry. The registry accepts only fixed,
host-owned adapters, rejects duplicates and incompatible facade ranges, and
selects by facade version, required features, and supported layout. Addons
cannot register, replace, inspect, or mutate implementations. The first
adapter is private `web/js/addon-graph-cytoscape.js`, registered once by
`app.js` after the existing SRI-pinned Cytoscape 3.34.0 and
cytoscape-dagre 4 runtime is ready. Core `cloudmap.js` remains on its existing
internal runtime and physics contract.

Facade API version 1 accepts nodes `{id,label,kind?}` and edges
`{id,source,target,label?}`. IDs are bounded token-shaped strings; ids are
unique across all elements; dangling edges reject. Limits are 1,000 nodes,
4,000 edges, 128-character ids, 500-character labels, a 200-character
accessible label, and viewport padding from 0 to 200. Configuration is plain
data only. Supported layouts are `grid`, `circle`, `concentric`,
`breadthfirst`, and `dagre`, each with a small validated option allowlist.
Documented events are `select`, `unselect`, `activate`, `viewport`, and
`focus`; callbacks receive frozen plain event summaries, never implementation
events.

Mount is allowed only below the calling addon's
`.addon-route-page[data-addon-id]` wrapper. The facade tracks pending and live
handles per addon instance and per container. Re-mounting a container destroys
the old graph. Every navigation calls `Addons.disposeRouteGraphs()`;
disable/update/reconciliation/failed registration uses the P5 lifecycle.
Epoch checks destroy late asynchronous mounts before they can revive a stale
page. Adapter cleanup stops layouts and removes event handlers, observers,
animation frames, container attributes, DOM artifacts, and the Cytoscape
instance. Failures destroy only the affected graph.

### Security posture (hardening pass)
The model is **trusted, DM-only install, in-process** (no sandbox yet) — `server:code`
is candidly full host access (the permission is transparency, not containment).
On top of that base, the concrete guardrails (added in the review/polish pass):
- **Install runs addon code only behind the same gate it'll run under.** The
  `tests.server` green-gate executes addon code, so it runs ONLY when `server:code`
  is granted, and the spawned `node --test` gets an explicit cross-platform
  **environment allowlist** (basic path/temp/home + locale variables only).
  Secret-shaped keys and ordinary deployment secrets such as `DATABASE_URL`,
  `AWS_ACCESS_KEY_ID`, and `SSH_*` never reach the child.
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
- **Bounded streaming addon extraction** lives in `server/addon-archive.cjs`:
  the compressed download is capped, then yauzl scans the complete central
  directory before any write (entry/file count, safe and unique paths,
  per-entry + total expanded sizes, per-entry + aggregate compression ratios).
  Pass two streams each entry directly to a unique staging tree through actual-
  byte limiters, so expanded files are never allocated as buffers. `adm-zip` is
  neither a production dependency nor exposed through `serverHost.lib()`.
- **Manifest hygiene:** `permissions[]` must be lowercase token strings;
  `_applyAddonCollections` re-validates `id`/collection-name from the persisted
  registry; a corrupt `addons.json` is preserved as `.corrupt-<ts>` rather than
  silently overwritten. Dispatcher + every addon render/route is try/caught (a
  throwing addon never crashes the server or white-screens the app).
- **Live unload:** `Addons.reconcile` disposes a disabled, removed, replaced, or
  content-revised addon (and its loaded consumers) before reversing the kept
  `tx.undo` registrations. A cleanup failure cannot keep another addon active
  or prevent it from reloading.
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
  loose allow-all), with live-compatible `use()` dependency errors, collection
  declaration/capability/role checks, keyed and list CRUD, transaction
  buffering/conflicts/rollback/nesting, empty player reads for DM collections,
  `host.contentRevision`, `host.onDispose`, scoped `host.i18n`, the scoped
  `host.imports` transport, the scoped mock `host.graphs` implementation,
  catalog validation/fallback behavior, and
  `disposeMockHost(rec)`. `validateAddonCatalogs(meta, catalogs)` exposes the
  same package-shape/placeholder guard to addon authors. `dryRunRegister(register, meta)` (Tier-A
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
  --test-isolation=none` (`NODE_TEST_CONTEXT` is not in the child env allowlist, so a nested run
  awaits async tests; `--test-isolation=none` so the timeout kill leaves no
  orphan; every caller-supplied/default env is reduced by the same allowlist)
  against the staged tree; red / timeout → discard staging,
  throw, never promote. Staged tree has no `node_modules` — server self-tests must be
  self-contained (Node built-ins + the addon's own files). `server/addon-testing.cjs`
  is a required `server/` module (COPYed by `COPY server ./server`).

### Dev / testing
- `node scripts/dev-install-addon.cjs <addon-dir> [data-dir]` installs a
  LOCAL addon directory (bypasses GitHub / allowlist / UI) — it mirrors
  `_installAddon`'s content-addressed layout, localization validation, and
  registry entry so the app
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
- Unit tests: `test/addon-i18n.test.mjs` (manifest/package validation,
  namespaces, interpolation/plurals, exact/base/English fallback,
  live/harness parity, cache/disposal/update/stale-response isolation) +
  `test/addons.test.cjs` (manifest validation / allowlist /
  content-hash determinism / bounded zipball download / repo-URL parsing + collection
  helpers `normalizeCollections`/`addonCollectionType`/`parseAddonType`) +
  `test/addon-archive.test.cjs` (streaming extraction, wrapper stripping,
  hash parity, path/count/per-entry/total/compression-ratio rejection before
  writes) +
  `test/addon-deps.test.mjs` (semver `satisfies` + `planLoadOrder`
  topo-sort / blocked / cycle) + `test/addon-data.test.mjs` (Phase 5
  `Store.patchAddonData` — namespace isolation, patchFn semantics, unknown
  collection/entity) + `test/addon-fragments.test.mjs` (Phase 6 pure engine —
  replace/hide/wrap/insert, conflict + resolution arbitration, unmatched,
  render failure isolation) + `test/integration-addon-resolve.test.cjs`
  (`POST /api/addons/resolve` — set/null/clear, realRole gating, proto-key
  guard) + `test/integration-addon-collections.test.cjs`
  (the addon-collection data path end-to-end: isolated-dir persistence,
  addon-scoped same-name identity, public compatibility, DM keyed/list CRUD,
  raw player concealment, guessed-write equivalence, role hashes, view-as,
  snapshot/disable/re-enable/uninstall behavior) +
  `test/integration-sse.test.cjs` (raw role-scoped events and before/after player
  hashes) + `test/integration-addon-server.test.cjs` (Phase 7 — server addon
  routing + isolated data, `server:code` gating, serverDeps blocking, throwing-
  init isolation, disabled state; uses the helper's new `seedFiles` option to
  lay down nested addon code before boot) + `test/addon-test-harness.test.mjs`
  (Phase 8 — mock/live dependency and declaration parity, lifecycle cleanup,
  dryRunRegister catch, smoke flags throwing renderers but not actions) +
  `test/addon-lifecycle.test.mjs` (live disposal ordering/idempotence,
  rollback, failure isolation, provider/consumer reload ordering, revision
  cache busting, and overlapping reconciliation) +
  `test/addon-testing.test.cjs` (the server
  green-gate runner — green/red/timeout/no-files) + `test/integration-addon-update.test.cjs`
  (Phase 9 — content-addressed rollback flip + field restore, targeted/default/
  error paths, check-updates empty/local/role-gating) + `test/integration-addon-backup.test.cjs`
  (Phase 10 — `/api/backup` ZIP includes addon-data/registry/code, boot-sweep
  prunes stale `<hash>`/`.incoming` but keeps kept-K + non-hash dirs) +
  `test/addon-content.test.cjs` (contentDir loader — tree walk, kinds,
  per-record shapes) + `test/integration-addon-content.test.cjs` (the
  host-served `/api/addon/:id/content*` endpoints end-to-end) +
  `test/addon-content-groups.test.cjs` (contentGroups declaration
  normalization, deterministic `contentRevision`, and the disabled-group
  content filter) +
  `test/addon-contrib.test.mjs` (graph/node-kind contribution registries) +
  `test/integration-restart-updateall.test.cjs` (`/api/restart` gating +
  `/api/addons/update-all`).
  `test/integration-player-edits.test.cjs`
  also covers the player `addonData` shallow-merge guard. `examples/` + `scripts/`
  are dev-only and are NOT copied into the Docker image.
