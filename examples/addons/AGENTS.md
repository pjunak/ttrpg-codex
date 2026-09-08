# TTRPG Codex Add-on API v3 contract

Use this file as the compact AI-agent entrypoint for add-on work. The complete
human guide is [`AUTHORING.md`](AUTHORING.md), the normative design is
[`API_V3.md`](API_V3.md), and exact machine contracts live under
[`contracts/addons/v3`](../../contracts/addons/v3). If prose and a schema
disagree, treat the schema and implemented inspector as authoritative and
report the documentation mismatch.

## Start here

1. Read the add-on's root instructions. Use its README for setup/product work,
   schemas and tests for data/service changes, and manifest/package builder
   for permissions, lifecycle or package changes. Read this guide's matching
   sections rather than loading every reference for an unrelated edit.
2. Identify its permanent IDs, runtime targets, contributions, permissions,
   collections/extensions, services, content sets, and optional behavior.
3. Preserve the addon's standalone behavior unless a hard dependency is
   intentional. Optional integrations must fail gracefully when absent.
4. Build and test in the add-on repository, create its deterministic ZIP, and
   inspect that ZIP with the host CLI.
5. For integration, use upload, inspect/stage, review, approve, activate, and
   the relevant replacement/disposal behavior.

Follow the active task's local-commit policy. A local branch/worktree may isolate
implementation when authorized by that task; it does not authorize replacing
shared branches, publishing releases or pushing. External contributors need
the public contracts for the target host version, not the maintainer's workspace.
The only durable suite backlog is [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
Temporary implementation plans belong only in the host repository's ignored
`docs/plans/` directory and must be deleted when the task closes. Do not create
repo-local TODO, roadmap, or planning files.

## Package and runtime model

An Add-on API v3 release is a reviewed build artifact:

```text
addon.json       strict v3 manifest
checksums.json   hashes for every other regular package file
contracts/       closed JSON Schemas referenced by the manifest
web/             deterministic compiled TypeScript output, when UI exists
worker/          declared target-specific Go executables, when backend logic exists
locales/         declarative UI catalogs
data/            immutable declared content
```

- Package paths, counts, sizes, hashes, entrypoints, schema references, target
  binaries, and case collisions are validated before extraction or execution.
- Production never runs npm, Go, Python, a shell, or another compiler.
- Browser entry modules export `activate(context)` and use only
  generation-scoped SDK handles and manifest-declared contributions.
- Integrated modules are reviewed trusted browser code. Isolated visual modules
  run in an opaque sandboxed iframe and communicate only through the versioned
  host bridge. Neither may import host modules, inspect host DOM, or depend on
  filesystem layout.
- Native workers use Go and `sdk/go/workerrpc`. Stdout is reserved for framed
  RPC; diagnostics go to stderr. Workers are process/crash isolation, not an OS
  security sandbox.

## Permanent contracts and implementation rules

Once released, do not rename or reuse an add-on ID, contribution ID, collection
ID, record-extension ID, content-set ID, or service contract major version for
different semantics. Display names may change.

- Request only the bounded permissions the package actually uses. Capabilities
  describe host features; they do not grant authority.
- Collections and record extensions use closed schemas, explicit visibility,
  schema versions, optimistic revisions, and host-owned transactions.
- Services use namespaced contracts, semantic versions, and schema-validated
  request/response values. Consumers target the contract and compatible range,
  never a provider ID. Optional consumers remain useful without a provider.
- Content records have stable `(kind, id)` identity, provenance, and immutable
  package revisions. User choices and overlays belong in durable host/add-on
  data, never rewritten package files.
- Imports and migrations are reviewable two-phase operations. Preview/plan is
  read-only and stored; commit applies only the exact accepted digest and
  operations. Never reconstruct an accepted mutation plan at commit time.
- Comments explain only non-obvious constraints or safety decisions. Do not
  preserve implementation history in source or contract documentation.

## Lifecycle and failure behavior

- Every UI contribution, listener, subscription, timer, request, worker call,
  service handle, and cache belongs to one activation generation and is safe to
  dispose more than once.
- Cancellation, deadline, health, shutdown, crash, replacement, and stale
  binding behavior must be explicit and bounded. Late responses cannot revive
  a disposed generation.
- Provider replacement stops consumers before the old provider and starts the
  new provider before consumers. Include provider generation and content
  revision in derived cache identity.
- A revision-`0` service binding is a valid automatic binding when exactly one
  compatible provider exists. Multiple candidates stay visibly unresolved.
- Worker actor, generation, deadline, correlation, and grants originate from
  the host. Echoed or invented metadata never grants authority.
- Render coherent loading, empty, unavailable, retry, and error states. Test
  optional-provider absence, malformed values, cancellation, cleanup, and
  repeated activation.

## Browser implementation

- Author strict TypeScript and package deterministic compiled JavaScript.
- Use the supplied UI, navigation, model, data, content, and service SDK
  handles. Register only contributions declared by stable manifest ID.
- Treat all external data as untrusted. Prefer DOM nodes and `textContent`;
  never inject raw package, translation, service, or record HTML.
- Use host design tokens and accessible semantic interaction. Keep source UI
  strings in English and catalogs declarative.
- Isolated entry modules must be self-contained: no relative imports or network
  assets. Dispose the bridge and frame state with the same generation scope.

## Worker implementation

- Keep the worker entrypoint as composition. Domain behavior belongs in
  focused packages independent of framing and host process details.
- Implement only declared, versioned methods. Honor initialization, start,
  initial health, bounded domain calls, cancellation, and graceful shutdown.
- Use host data/service clients rather than hand-authoring authority metadata.
  Keep payloads serializable and schema validated; never return functions,
  facades, DOM, or raw HTML.
- Package every deployment target declared in the manifest and keep committed
  binaries synchronized with source for a release candidate.

## Build and verify

For prose or agent-guidance-only changes, review the diff, check local links,
and verify changed commands or contract claims. Runtime builds and operational
acceptance are required only for the affected behavior below. Reuse successful
checks on unchanged inputs; preserve complete CI and release gates.

Run the add-on's applicable runtime gates for implementation changes. Build and
inspect artifacts for package/manifest/schema/worker changes or release
candidates; exercise affected lifecycle and optional-provider behavior in an
isolated host when integration changes.

A release candidate must pass:

1. the add-on repository's complete build, test, type, and vet gates;
2. deterministic package creation;
3. host inspection from `ttrpg-codex`:

   ```powershell
   go run ./cmd/codex-addon-inspect <path-to-addon.zip>
   ```

4. standalone behavior with optional providers absent;
5. affected provider/consumer integration and activate/replace/dispose checks.

Contract changes require relevant host conformance tests and every affected
first-party add-on gate. Source checkouts and GitHub-generated archives are not
install packages.
