# Add-on API v3 authoring

Add-on API v3 packages are reviewed build artifacts, not source folders loaded
by the host. Read [API_V3.md](API_V3.md) for the complete protocol and
[`contracts/addons/v3`](../../contracts/addons/v3) for machine-readable host
schemas.

## Package shape

```text
addon.json
checksums.json
contracts/          JSON Schemas referenced by the manifest
web/                compiled TypeScript output, when the package has UI
worker/             target-specific executables, when it has backend logic
locales/            declarative UI catalogs
data/               immutable content, when declared
```

`checksums.json` lists every regular package file except itself. Package paths
are normalized forward-slash paths. Symbolic links, duplicate/case-colliding
paths, unlisted files, external schema references, and undeclared entrypoints
are rejected before extraction.

## Manifest essentials

An add-on declares stable identity, compatibility, capabilities, permissions,
runtime entrypoints, contributions, dependencies, services, data contracts,
content sets, and locales. Request only authority the package uses. IDs become
persistent data and integration namespaces; do not rename released IDs.

The host currently supports:

- `ui.contributions` for integrated or isolated browser modules;
- `worker.native` for reviewed target-specific Go workers;
- package-owned collections and record extensions;
- schema-validated `ui`, `content`, and `worker` services;
- immutable content sets and source-group filtering.

The manifest schema is the authority for exact fields. Use the reference
manifest under `contracts/addons/v3/examples/` as a structural starting point.

## Browser code

Author browser code in TypeScript and commit or package only deterministic
compiled `web/` output. The entry exports `activate(context)`. Register only
manifest-declared contributions and use the supplied SDK handles. Do not import
host frontend modules, inspect host DOM, store global credentials, or retain
resources outside the generation scope.

Integrated modules can register custom elements, actions, model providers, and
navigation contributions. Isolated visual contributions run in an opaque
iframe and communicate only through the host bridge. Either mode must tolerate
empty data, missing optional services, abort, reload, and repeated disposal.

Reference libraries use the public `wiki-kind` model provider for campaign wiki
links, declared old bookmark roots, and optional global search. Return local
route IDs plus query pairs; the host owns URLs, role filtering, and lifetime.
See [Wiki references and library search](API_V3.md#wiki-references-and-library-search).

## Worker code

Native workers are Go executables using `sdk/go/workerrpc`. Stdout is reserved
for framed protocol messages; diagnostics go to stderr. The host supplies exact
generation identity, grants, service bindings, deadlines, and actor lineage.
Workers must not trust claimed actor fields or invent service handles.

Implement only declared methods, honor cancellation, keep requests bounded, and
make health meaningful. Package Linux amd64/arm64 and Windows amd64 targets when
those deployments are supported. Production never invokes `go build`.

## Data and services

Collections and record extensions require closed JSON Schemas and explicit
visibility. Mutate them only through the host data client so schema validation,
ownership, revisions, events, and transactions stay intact.

Services are stable namespaced contracts with semantic versions and JSON Schema
request/response documents. Consumers target a contract and range, never a
known provider ID. Optional consumers remain useful without a provider.
Provider identity and generation stay in cache keys and diagnostics.

Content sets are immutable package assets. Use stable `(kind, id)` identity,
explicit provenance, and a revision changed with content. User choices and
overlays belong in host or add-on data, not rewritten package files.

Rules packages declare `rules.supports`; a complete-profile package additionally
declares `rules.defines` to establish one ruleset for the website instance.
Compatible source packages may coexist and contain several selectable books.
Use `groups.catalogKind` for book labels, tolerate zero effective records, and
include effective revisions in caches. Follow the shared
[rules/source contract](../../docs/rewrite/RULES_SOURCES.md); source changes
never authorize rewriting authored character state. Update the host before
installing packages that use these manifest fields.

## Build and verify

Each add-on owns its compiler, tests, deterministic packager, and package
archive. A release candidate should pass:

1. repository build and tests;
2. deterministic packaging;
3. `go run ./cmd/codex-addon-inspect path/to/addon.zip` from the host;
4. standalone behavior without optional providers;
5. affected provider/consumer integration during supervised testing.

Installation is always upload, inspect/stage, review, approve exact grants, and
activate. A source checkout or GitHub archive is not a production package.

## First-party references

- DM Tools demonstrates TypeScript UI, package collections, and a native Go
  worker.
- D&D 2024 Compendium demonstrates immutable content and a content service.
- D&D Engine demonstrates a headless native worker and optional service
  consumption.
- Character Sheets demonstrates record extensions and optional engine use.

Those repositories are examples of public-contract use, not additional host
API. If a first-party package needs an internal import, add the missing public
contract instead.
