# Add-on API v3 authoring

Add-on API v3 packages are reviewed build artifacts, not source folders loaded
by the host. Read [API_V3.md](API_V3.md) for the complete protocol and
[`contracts/addons/v3`](../../contracts/addons/v3) for machine-readable host
schemas. Check [current availability](API_V3.md#current-implementation-status)
before using a declared surface: the schema includes reserved names whose
runtime handlers do not yet exist.

## Package shape

For current-state extensions, `workerOnly: true` restricts mutations to the
package native worker without retaining snapshots. For worker-authorized
immutable record snapshots, see
[retained history](../../docs/rewrite/RETAINED_ADDON_HISTORY.md). For contextual
source links and saved calculation explanations, declare `ui.rule-details` and
use the [shared rule-details surface](../../docs/rewrite/RULE_DETAILS.md).
For integrated fields, comboboxes, search, actions, tabs, states and modal focus,
declare `ui.controls.v1` and call `context.ui.enhance(ownRoot)`. The
[shared UI contract](../../docs/rewrite/UI_FOUNDATIONS.md) defines markers, events,
semantic skin tokens and lifetime cleanup.
Prefer supported host UI where it fits; private host imports and DOM remain outside
the add-on contract.

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

Integrated record article sections can use the optional
[pending edit handoff](API_V3.md#pending-record-edits-during-generation-replacement)
to transfer detached pending input across a graph restart. Keep all SDK handles
generation-scoped, validate the current actor and saved state before restoring
input, and retain original revisions and uncertain command IDs.

Use a `settings` contribution for options belonging to your add-on. The host
groups these panels inside a Settings disclosure on that add-on's card in
Settings → Add-ons, filtered by effective role. Label whether your controls
affect personal preferences or shared campaign data, and publish dirty/saving
flags through the existing edit handle. See [Add-on settings](API_V3.md#add-on-settings)
for the host context, navigation, persistence ownership, and lifecycle rules.

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

- DM Tools demonstrates TypeScript UI, package collections, a native Go
  worker, read-only map context and the public integrated Markdown component.
- D&D 2024 Compendium demonstrates immutable content and a content service.
- D&D Engine demonstrates a headless native worker and optional service
  consumption.
- Character Sheets demonstrates record extensions and optional engine use.

Those repositories are examples of public-contract use, not additional host
API. If a first-party package needs an internal import, add the missing public
contract instead.


## Publishing tested commits

First-party add-on CI publishes the exact `reviewed-package` ZIP after its full
checks and host inspection pass. A separate job with Contents write calls the
shared [publisher action](../../.github/actions/publish-addon/action.yml), pinned
to a reviewed host commit. It uses the job's automatic `GITHUB_TOKEN`; no personal
deployment token or server access is needed. Private repositories keep private
releases.

Releases use `build-<full source SHA>` tags and retain the package's semantic
version for compatibility. Updating content or behavior therefore does not
require a version bump merely to make an update available. The publisher stages
a draft, verifies GitHub's uploaded SHA-256 digest, then publishes it. Reruns
never overwrite different package bytes. Older tested commits remain downloadable
without replacing the newest release. Keep main publication serialized.

The website defaults to the latest published package. Discovery and download
never activate it: each installation owner reviews permissions and compatibility
and chooses when to activate. Public releases download without a token; private
releases require Contents read on that add-on repository. Actions-artifact
sources remain supported for other branches and publishers, with Actions read
access and the configured retention limit.
