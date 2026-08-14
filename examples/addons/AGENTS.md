# AGENTS.md — CodexHost addon contract

Reference this file from an addon's repository when an AI coding tool needs the
host contract. Keep it canonical in the host rather than copying it into each
addon. The complete author reference is [`AUTHORING.md`](AUTHORING.md); the
host design system is documented in
[`web/css/STYLE.md`](../../web/css/STYLE.md). If the two references disagree,
follow `AUTHORING.md` and report the mismatch.

## Start here

1. Read `addon.json`, this file, the addon's README, and its tests.
2. Identify the permissions, capabilities, collections, dependencies, and
   localization catalogs already declared.
3. Preserve the addon's standalone behavior unless a hard dependency is
   intentional. Optional integrations must fail gracefully when absent.
4. Make the smallest coherent change, update current documentation, and run the
   addon tests plus relevant host compatibility tests.
5. Reinstall the addon into the host before manual testing:
   `node scripts/dev-install-addon.cjs <path-to-addon>`.

The global Codex instructions govern task commits. Do not create branches,
releases, or pushes unless the maintainer asks.
The only durable suite backlog is [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
Temporary implementation plans belong only in the host repository's ignored
`docs/plans/` directory and must be deleted when the task closes. Do not create
repo-local TODO, roadmap, or planning files.

## Runtime model

- `entry.js` is a browser-native ES module that default-exports
  `register(host)`. There is no bundler or transpiler.
- Optional server code is CommonJS and exports `init(serverHost)`. It activates
  after a host restart.
- New addons use manifest API v2 and declare an enforced `hostVersion`.
- Addon IDs match `^[a-z0-9][a-z0-9-]{1,38}$` and are stable data namespaces.
- The host facade is the only integration boundary. Do not depend on host
  globals, private modules, DOM structure, Cytoscape, or filesystem layout.
- Installed addon code is trusted and runs in process. Permissions constrain
  host APIs and make authority visible; they are not an OS sandbox.

## Non-negotiable implementation rules

- Request only permissions and required capabilities that the code uses.
- Namespace actions with `host.action(name)` and wire events with
  `host.h.dataAction()` or `host.h.dataOn()`. Never add inline handlers.
- Escape every dynamic or translated string inserted into HTML with
  `host.h.esc()`. `host.h.renderMarkdown()` returns sanitized HTML.
- Use host component classes and design tokens for product-facing styling.
  Literal values are acceptable only for one-off technical geometry.
- Renderers accept sparse or empty data and return a coherent loading, empty,
  unavailable, or error state instead of throwing.
- Declare addon collections in `addon.json` before registering or accessing
  them. DM-only collections require API v2 and the `collections.dm` capability.
- Keep registration deterministic. Start data loading from an action, renderer,
  or explicitly owned asynchronous task; do not depend on untracked ambient
  state during registration.
- Clean up every owned listener, timer, observer, request, graph handle,
  overlay, and cache with `host.onDispose()` or the disposer returned from
  `register()`. Request `lifecycle.dispose` when lifecycle cleanup is used.
- Write code and English source catalogs in English. UI localization uses API
  v2, `i18n.catalogs`, a complete `locales/en.json`, and `host.i18n`.
- Comments explain only non-obvious constraints or invariants. Do not narrate
  changes or preserve implementation history in source or reference docs.

## Manifest essentials

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

Add only fields that are needed:

- `capabilities`: `{ "required": [], "optional": [] }`.
- `locales`: catalog paths; English is mandatory and complete.
- `collections`: `{ "name", "keyed", "access" }`; access defaults to public.
- `dependencies` and `optionalDependencies`: versioned addon APIs.
- `services`: versioned contract discovery when any compatible provider should
  work. Declare `provides` and/or explicit `consumes` cardinality/range entries.
- `contentDir`: a host-served per-record JSON tree for data addons.
- `contentGroups`: DM-toggleable content slices.
- `server`: optional server module; requires `server:code`.
- `serverDeps`: only host-approved server libraries.
- `tests.server`: explicit self-contained test paths run at install; never a
  glob and never a dependency on the host harness.

The host currently advertises `collections.dm`,
`collections.transactions`, `lifecycle.dispose`, `content.revision`,
`i18n.catalogs`, `imports.providers`, `imports.bundle-contributors`, and
`graphs.facade`.

## Common facade surfaces

Registration permissions are exact:

| Surface | Permission |
|---|---|
| Route or page renderer | `ui:route` |
| Sidebar entry | `ui:sidebar` |
| Action | `ui:action` |
| Settings tab | `ui:settings-tab` |
| Article section | `ui:article-section:<kind>` |
| Editor fields | `ui:editor-fields:<kind>` |
| Content slot | `ui:slot:<surface>` |
| Fragment override | `ui:override` |
| Wiki kind | `wiki:kind` |
| Owned collection | `data:own` |
| Core read | `data:read:<collection>` |
| Addon-data patch | `data:write:<collection>.addonData` |
| Graph facade | `ui:graph` plus `graphs.facade` |
| Server module | `server:code` |
| Import provider | `data:import-provider` plus its documented capabilities |

Useful members include:

```js
host.id
host.action(name)
host.asset(path)
host.capabilities.has(id)
host.contentRevision
host.h
host.i18n
host.role
host.ui
host.store.collection(name)
host.store.transaction(names, callback)
host.store.patchAddonData(collection, id, update)
host.provide(api)
host.use(addonId)
host.provideService(contract, version, api)
host.useService(contract)
host.listServices(contract)
```

`host.h.layoutText(text, options)` provides cached, Unicode-aware plain-text
line breaking without DOM measurement. It returns exact line strings and
widths; addons must materialize those strings when layout geometry depends on
the measured breaks. `host.h.onTextLayoutInvalidated(listener)` returns an
unsubscribe function for mounted consumers that cache those results; release
it with the route's other listeners. Treat both helpers as optional when
retaining compatibility with a host version that predates them.

See `AUTHORING.md` for complete method signatures, collection identity,
transactions, dependency negotiation, fragments, slots, graph handles,
content trees, and server/import-provider contracts.

## Optional dependencies

An optional dependency controls load order only. Always retain a useful
standalone state:

```js
let provider = null;
try {
  provider = host.use('provider-addon');
} catch {
  // Standalone behavior remains available.
}
```

Dispose or invalidate provider-derived state when the addon is unloaded.
Provider APIs should return data rather than host-owned DOM or private objects.

## Discoverable services

Use exact dependencies only when identity matters. For extensible roles such as
rules data, engines, renderers, or import adapters, declare a service contract.
A cardinality-one consumer receives the sole compatible provider automatically;
multiple providers require a DM binding. Cardinality-many consumers receive
every compatible handle in deterministic provider-id order. Handles contain
`{api, provider}`; provider metadata includes addon/version, contract version,
and content revision. Optional consumers must handle `null` or `[]`.

## Localization and HTML

Catalog values are plain text. Resolution is exact locale, base locale,
English, then the key. Translation entries preserve the English value shape
and placeholder set.

```js
const { esc, dataAction } = host.h;
const title = host.i18n.t('page.title');
return `<h1>${esc(title)}</h1>
  <button class="inline-create-btn"
    ${dataAction(host.action('create'))}>${esc(host.i18n.t('action.create'))}</button>`;
```

## Testing and local installation

- Use
  [`web/js/addon-test-harness.mjs`](../../web/js/addon-test-harness.mjs) for
  client registration, permission, dependency, role, collection,
  localization, lifecycle, and renderer smoke tests. Pass the real manifest
  metadata; an allow-all mock hides mistakes.
- Keep `tests.server` self-contained: Node built-ins and addon files only.
- Test empty and failure states, optional-provider absence, cleanup
  idempotence, and any role-conditioned registration.
- Run the addon's complete test command and relevant host addon tests.
- Dev-install, restart when server code changed, refresh, and exercise the
  installed package. Source edits are invisible until reinstalled.

The worked examples in this directory demonstrate routes, sheets,
localization, dependencies, fragments, content packages, server code, and
failure isolation.
