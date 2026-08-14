# O Barvách Draků

Self-hostable collaborative TTRPG wiki and API-v2 addon host. The server owns
JSON persistence, authentication, addon installation, and role-scoped SSE; the
browser is a vanilla ES-module SPA. Code and administration are English. UI
source strings are English with a per-browser Czech catalog.

## Commands and environment

Node.js 24 or newer is supported; `.nvmrc` and the Docker image use Node.js 26.
Run these commands from the repository root in any shell where Node and npm
are available:

```console
npm ci
npm run lint            # zero-warning ESLint gate
npm test                # complete Node test suite
npm run check           # lint, then tests
npm run test:browser    # native-size text rendering contract in Chromium
npm run test:browser:all # same contract in Chromium and Firefox
npm start               # local server
```

Install the pinned browsers once with `npx playwright install chromium firefox`
before running the cross-browser contract. CI installs Chromium for the default
gate; local rendering changes should run both engines.

Run a focused test with a relative path:

```console
node --test test/addon-archive.test.cjs
```

Use browser or manual application verification for behavior the Node tests do
not cover. State clearly when the active environment cannot run it.

## Read on demand

Read the relevant owner before changing a subsystem; keep detailed contracts
there instead of expanding this always-loaded file.

| Reference | Read before changing |
|---|---|
| [`docs/reference/i18n.md`](docs/reference/i18n.md) | User-facing strings, catalogs, pluralization, locale tests |
| [`docs/reference/ui-widgets.md`](docs/reference/ui-widgets.md) | Combobox, MultiSelect, TagFilter, actions, mount lifecycle |
| [`docs/reference/routing-navigation.md`](docs/reference/routing-navigation.md) | Routes, search, navigation, edit affordances, authentication flow |
| [`docs/reference/settings.md`](docs/reference/settings.md) | Settings categories, tabs, attitudes, marker icons |
| [`docs/reference/data-model.md`](docs/reference/data-model.md) | Collections, fields, visibility, IDs, trash/undo, Store and write queue |
| [`docs/reference/wiki-rendering.md`](docs/reference/wiki-rendering.md) | Articles, editors, Markdown, drafts, dirty guards |
| [`docs/reference/maps-timeline.md`](docs/reference/maps-timeline.md) | World/local maps and timeline |
| [`docs/reference/cloudmap.md`](docs/reference/cloudmap.md) | Mind-map registries, layout, physics, rejected approaches |
| [`docs/reference/server.md`](docs/reference/server.md) | API, persistence, locks, snapshots, path safety, security, deploy surface |
| [`docs/reference/addons.md`](docs/reference/addons.md) | Manifests, facades, permissions, services, lifecycle, install/import contracts |

Public documentation has separate owners:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md), and
[`examples/addons/AUTHORING.md`](examples/addons/AUTHORING.md). Addon-agent
guidance lives in [`examples/addons/AGENTS.md`](examples/addons/AGENTS.md).

## Repository map

```text
server.js             Express composition and REST surface
server/               Auth, visibility, SSE, durable writes, snapshots,
                      addon broker/install/testing, imports and transactions
server-utils.cjs      Pure security/path/snapshot helpers
tiler.js              Sharp world/local-map tile generation
web/index.html        SPA shell; loads bundle.css and app.js
web/js/app.js         Router, navigation, SSE and ACTIONS composition
web/js/store*.js      Domain state, validation, optimistic revisions, write queue
web/js/addon*.js      Host facade and pure addon contract/lifecycle planners
web/js/{wiki,map,cloudmap,timeline}.js
                      Major feature renderers/controllers
web/js/{settings,sidebar,search,role}.js
                      Shell and role-aware product surfaces
web/i18n/             English source and Czech translation catalogs
web/css/              Tokenized themes, shared components and feature styles
test/                 Unit, contract, integration and regression tests
examples/addons/      Public addon authoring contract and fixtures
data/                 Ignored runtime volume; never source code
```

## Server and persistence invariants

- JSON files are the only database. Writes that span shared state must use the
  established lock, durable-file, transaction, revision, and publication
  primitives. Do not introduce uncoordinated direct writes.
- Preserve point-in-time backup/restore behavior, bounded archive handling,
  path containment, optimistic revisions, and role-filtered projections. Add a
  regression test for changes near these safety boundaries.
- `data/` and `data-snapshots/` are runtime state. Never commit or edit addon
  code inside `data/addons/`; reinstall from the source repository instead.
- Authentication uses an HttpOnly `edit_session` cookie and credential-derived
  tokens. Passwords live in runtime data or documented environment variables.
  Preserve role gates on both HTTP and long-lived SSE/addon surfaces.
- SSE updates on `/api/events` are role-scoped and should reach clients in
  under one second. Avoid state changes that bypass the normal broadcast path.
- Client-controlled paths, ZIP entries, uploads, and restore targets must pass
  the existing normalization, containment, size, and compression guards.
- Helmet remains enabled. CSP is intentionally off because product HTML uses
  inline style attributes; do not weaken the other security headers.

## Browser boundaries

- No framework, bundler, or transpiler. Use browser-native named ES-module
  exports and established module ownership.
- Stateful facades may use an IIFE; pure modules export focused functions.
  Import shared helpers rather than creating private duplicate escaping,
  normalization, or action systems.
- Methods referenced by `data-action="Module.method"` must be imported in
  `app.js` and registered in `ACTIONS`; do not export them through `window`.
- Every user or translated string inserted into HTML passes through `esc()`.
  Free-text colors pass through `safeColor`. Sanitized `renderMarkdown()`
  output is the documented exception.
- English is the complete source catalog. Preserve Czech key/value shape and
  placeholders. Follow both i18n guard tests for every user-visible string.
- Read [`web/css/STYLE.md`](web/css/STYLE.md) before UI work. Reuse tokens and
  shared components; add recurring or semantic values to the design system.
  `web/index.html` links only `css/bundle.css`; themes override tokens rather
  than components. Canonical breakpoints are 768, 1100, and 1200 px.
- Clean up listeners, timers, observers, requests, object URLs, graph handles,
  and mounts on rerender, role change, navigation, and disposal.
- Comments explain only non-obvious invariants, constraints, or why an obvious
  approach is unsafe. Do not preserve implementation history in source.

## Addon contract

- The scoped host facade is the sole addon integration boundary. Addons must
  not depend on host globals, private modules, DOM structure, raw Cytoscape, or
  filesystem layout.
- Manifest IDs are permanent data namespaces. Permissions and capabilities
  must match actual use. Optional dependencies and discoverable services must
  fail gracefully when providers are absent or incompatible.
- API-v2 lifecycle disposal is LIFO, once-only, bounded, and failure-isolated.
  Changed entry/content revisions unload consumers before providers and reload
  providers before consumers.
- Addon package extraction is untrusted input. Keep it streaming, bounded,
  traversal-safe, content-addressed, and free of repository-only agent/tool
  metadata in installed runtime copies.
- DM Tools owns the visible Import Center. Core owns authorization,
  transactions, campaign-bundle primitives, and recovery; providers own their
  reviewed preview/commit workflows.

Companion addons are independent repositories and may be checked out anywhere.
Each addon has its own root instructions. For addon source changes:

```console
# Run in the addon repository
node --test tests/*.mjs

# Run in this host repository with the addon's actual source path
node scripts/dev-install-addon.cjs <path-to-addon>
```

Use relative test paths on Windows. Source edits are invisible until
reinstalled. Restart for server-module changes and refresh for client changes.
Permission additions require the per-addon production wizard; bulk update does
not grant new permissions.

## Completion and durable planning

- Run focused tests while iterating and `npm run check` before handoff for host
  changes. Run `npm run test:browser` for zoom, typography, or browser-rendering
  changes. Run relevant host/addon compatibility tests on both sides of a
  contract change.
- Update the owning reference, public docs, test inventory, and this file only
  when their actual contracts change.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) is the only durable backlog for the host
  and companion addons. Keep temporary plans under ignored `docs/plans/` and
  delete them when the task closes. Do not create additional roadmap/TODO files.
- Do not commit runtime data, secrets, generated installs, backups, or local
  plans. The global Codex instructions govern task commits. Never push,
  release, deploy, or change production credentials unless explicitly asked.
