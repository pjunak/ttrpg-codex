# Writing a TTRPG Codex add-on

An add-on is an optional, prebuilt package that a DM installs on their site
through **Settings → Add-ons**: upload or download, review the requested
permissions, approve, activate. The host never builds add-on source. Add-ons can
contribute pages, record sections, settings, graph views and services, store
their own data, and run backend logic in a native Go worker.

This guide is the starting point. [API_V3.md](API_V3.md) is the full reference
and [`contracts/addons/v3`](../../contracts/addons/v3) holds the exact schemas.
If prose and a schema disagree, the schema and the host's inspector win; please
report the mismatch.

## Your first package

An add-on lives in its own repository. The first-party add-ons are complete
examples: [DM Tools](https://github.com/pjunak/addon-dm-tools) (UI, data, Go
worker), [D&D Engine](https://github.com/pjunak/addon-dnd-engine) (worker-only
service) and [Character Sheets](https://github.com/pjunak/addon-dnd-character-sheets)
(record extension, optional service consumer).

A built package is a ZIP with this layout:

```text
addon.json       manifest (start from contracts/addons/v3/examples/reference-addon.json)
checksums.json   SHA-256 of every other regular file
contracts/       closed JSON Schemas referenced by the manifest
web/             compiled browser code, if the add-on has UI
worker/          one executable per supported target, if it has a worker
locales/         UI string catalogs
data/            immutable content, if declared
```

Paths are forward-slash and normalized. Symbolic links, duplicate or
case-colliding paths, unlisted files, external schema references and undeclared
entrypoints are rejected before anything is extracted.

Check a package with the host's inspector. It runs from any directory; pick the
host version you target:

```text
go run github.com/pjunak/ttrpg-codex/cmd/codex-addon-inspect@<host-version> dist/my-addon.zip
```

To try it, run a local host (see the host [README](../../README.md#run-locally)),
sign in as DM and upload the ZIP in **Settings → Add-ons → Add add-on**.

## Manifest essentials

The manifest declares a stable identity, host compatibility, capabilities,
permissions, runtime entrypoints, contributions, dependencies, services, data
contracts, content sets and locales. Request only what the package uses.

These IDs are permanent once released: add-on, contribution, collection, record
extension, content set and service contract (per major version). They become
saved-data and integration namespaces. Display names may change.

| Capability | Gives you |
| --- | --- |
| `ui.contributions` | Browser modules (integrated or sandboxed iframe) |
| `ui.controls.v1` | The host's shared fields, searchable choices, tabs and dialogs |
| `ui.markdown`, `ui.rule-details` | Shared Markdown rendering and rule-detail popovers |
| `worker.native` | A native Go worker per target platform |
| `data.transactions` | Multi-document transactions on your collections |

See [what is available](API_V3.md#what-is-available) before relying on a
surface. Package-owned collections, record extensions, schema-validated
services and immutable content sets are all supported.

## Browser code

Write browser code in strict TypeScript and ship only the compiled `web/`
output. The entry module exports `activate(context)`. Bind only contributions
declared in the manifest and use only the SDK handles you receive.

- **Integrated** modules run in the app page as trusted, reviewed code.
  **Isolated** modules run in a sandboxed iframe, talk only through the host
  bridge and must be one self-contained bundle. Neither may import host modules,
  read host DOM or assume file layout.
- Treat all data as untrusted. Build DOM with `textContent`; never insert raw
  HTML from packages, translations, services or records.
- For forms and controls, declare `ui.controls.v1` and call
  `context.ui.enhance(ownRoot)`; the [shared UI contract](../../docs/reference/UI_FOUNDATIONS.md)
  covers markers, skin tokens and cleanup. Keep domain behaviour in your add-on.
- Render loading, empty, unavailable, retry and error states.
- Everything you create (listeners, timers, subscriptions, requests, caches)
  belongs to one activation generation. Dispose it on abort, and make disposal
  safe to repeat.
- Put options in a `settings` contribution; it appears on your add-on's card in
  Settings → Add-ons ([details](API_V3.md#add-on-settings)).
- Reference libraries can add campaign wiki links and search results through a
  `wiki-kind` provider ([details](API_V3.md#wiki-references-and-library-search)).
- Record sections can carry pending input across a host restart with the
  [pending edit handoff](API_V3.md#pending-record-edits-during-generation-replacement).

## Worker code

A native worker is a Go program using the host's public SDK:

```text
go get github.com/pjunak/ttrpg-codex@<host-commit-or-version>
```

```go
import "github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
```

- Stdout carries only framed protocol messages; write diagnostics to stderr.
- The host supplies the generation, grants, service bindings, deadlines and the
  acting user. Never trust actor fields from a request or invent handles.
- Implement only declared methods; honour cancellation and shutdown; keep
  requests bounded; make the health check meaningful.
- Keep `main` as wiring and put domain logic in its own packages.
- Return serializable, schema-valid values only.
- Build every target the manifest declares (Linux amd64/arm64 and Windows amd64
  for the first-party add-ons). A worker is crash isolation, not a security
  sandbox.

The [initialization protocol](API_V3.md#initialization) and
[required methods](API_V3.md#required-protocol-methods) are in the reference. To
develop against an unreleased host change, use an uncommitted `go.work`
(`go work init . ../ttrpg-codex`).

## Data, services and content

- **Collections and record extensions** need closed JSON Schemas and explicit
  visibility. Change them only through the host data client so validation,
  revisions, events and transactions apply. `workerOnly: true` limits writes to
  your worker; `retained: true` adds immutable history
  ([retained history](../../docs/reference/RETAINED_ADDON_HISTORY.md)).
- **Services** are namespaced contracts with semantic versions and JSON Schema
  request/response documents. Consumers ask for a contract and version range,
  never a provider add-on ID, and stay useful when no provider is installed.
  Include the provider's generation in cache keys.
- **Content sets** are immutable package files with stable `(kind, id)`
  identity and provenance. Store user choices in data, not in package files.
- **Rules packages** declare `rules.supports`; a package that defines a complete
  ruleset also declares `rules.defines`. See [rules and sources](../../docs/reference/RULES_SOURCES.md).
- **Imports** are two steps: a stored, read-only preview, then a commit of exactly
  that preview ([imports](API_V3.md#imports-and-campaign-bundles)).

## Before you release

1. Your repository's build, tests, type checks and `go vet` pass.
2. Packaging is deterministic (same source, same ZIP).
3. The host inspector accepts the ZIP.
4. The add-on works with its optional providers absent.
5. Install, update, reload and disable work on a local host, including any
   providers or consumers you integrate with.

## Publishing

The first-party add-ons publish each tested `main` commit as a GitHub release
tagged `build-<commit>` with the ZIP attached, using the host's
[publish action](../../.github/actions/publish-addon/action.yml) and the job's
own `GITHUB_TOKEN`. DMs then pick **Latest published package** when adding or
updating the add-on; publishing never installs anything. Private repositories
work too: the DM saves a token with Contents read access in the host. See
[add-on installation](../../docs/SELF_HOSTING.md#add-on-installation).

If something you need is missing from the public API, ask for a public
contract rather than reaching into host internals.
