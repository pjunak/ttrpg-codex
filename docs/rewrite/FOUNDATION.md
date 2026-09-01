# Rewrite foundation

The rewrite is deliberately runnable beside the v1 application. The current
`server.js` and `web/` remain the stable product while the Go host and
TypeScript frontend grow behind explicit contracts.

## Toolchains

- Go 1.26.x for the host, migrations, add-on package tooling, and future
  workers. The module stays on this supported release line until a newer line
  has completed its first patch cycle.
- Node.js 24 or newer for frontend development only; CI and containers use
  Node.js 26.
- TypeScript 7, Vite 8, Lit 3, and Vitest 4 in `frontend/`.

Production will run the compiled Go host and prebuilt browser assets. It will
not require Node.js, JavaScript add-on servers, or Python.

## Current commands

Run the focused Go packages during coexistence because the repository root
still contains the v1 `node_modules` tree:

```console
go test ./cmd/... ./contracts/... ./internal/... ./sdk/...
go vet ./cmd/... ./contracts/... ./internal/... ./sdk/...
go build ./cmd/codex
go run ./cmd/codex-addon-inspect path/to/addon.zip
go run ./cmd/codex-maintenance verify -in path/to/codex-backup.zip
go run ./cmd/codex-convert-v1 -in path/to/v1-ui-backup.zip -out path/to/fresh-data
```

Run the frontend gate from `frontend/`:

```console
npm ci
npm run check
```

Start the two development processes separately:

```powershell
$env:CODEX_DM_PASSWORD = '<choose-a-local-development-password>'
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/rewrite
npm --prefix frontend run dev
```

Vite proxies `/api` to the local Go host. Rewrite state is isolated under
`data/rewrite/` and is not compatible with the v1 runtime data yet.

## Implemented boundaries

- The Go process opens SQLite with foreign keys, WAL, a bounded busy timeout,
  defensive settings, and numbered checksum-verified migrations.
- Migration 0006 and the durable blob store publish immutable hash-addressed
  objects behind opaque, revisioned handles whose ownership and visibility
  remain authoritative in SQLite. Creation publishes and verifies bytes before
  committing metadata, while deletion is logical so shared or recovery data is
  not removed. No runtime surface creates blobs until backup and authorization
  composition are complete. See [`BLOBS.md`](BLOBS.md).
- The native `codex-backup.v1` archive uses SQLite's online backup primitive,
  inventories immutable add-on files by hash, and verifies an isolated copy
  before an offline journaled data-directory swap. The host holds a portable
  process lock and recovers interrupted swaps before opening SQLite. See
  [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md). A real-and-effective-DM download
  endpoint exposes this same archive contract without a second serializer.
- Migration 0005 and the campaign record store preserve legacy list/keyed
  shapes, opaque record JSON, stable IDs, list order, and absent-versus-empty
  collection state. Optimistic record revisions, audit rows, collection
  invalidation, and SSE publication share one transaction. See
  [`CORE_DATA.md`](CORE_DATA.md). A domain-facing application service now
  publishes the versioned campaign dataset through `GET /api/campaign`, with
  an exact DM snapshot and a reference-closed anonymous/player projection.
  Its CSRF-protected transaction endpoint plans requested and derived changes
  above storage, applies player/twin/reference policy, and commits compound
  cascades with optimistic revisions as one unit. A separate explicit twin
  endpoint owns create/link/unlink, server-generated twin identities, opposite
  visibility, and atomic reciprocal updates. The strict TypeScript mutation
  client serializes ordinary, twin, and enum writes through one stale-base
  guard. The explicit enum boundary can reject, replace, or clear known usages
  while definition removal and its tombstone remain one transaction.
- The narrow offline `codex-convert-v1` command accepts only a v1 UI backup,
  imports known core campaign collections into a fresh SQLite database in one
  transaction, verifies the result before atomic publication, and reports the
  media and add-on-owned files still awaiting their rewrite owners. It never
  merges with live state or becomes a startup compatibility mode. See
  [`LEGACY_CONVERSION.md`](LEGACY_CONVERSION.md).
- The HTTP boundary exposes no-store health and version responses. Its add-on
  administration routes require both a lifecycle service and an administrator
  authorizer at composition time; partial configuration fails closed and the
  current executable deliberately leaves those routes unregistered until the
  rewrite authentication service is wired. Browser graph and immutable
  generation-asset routes use the same paired fail-closed composition rule,
  authorize before parsing, and enforce private ETag-based cache contracts.
- The authentication service accepts explicit DM and optional player bootstrap
  credentials, issues bounded random process-local sessions, rotates authority
  on DM view-as transitions, and binds administrative mutations to a separate
  CSRF token. HTTP composition provides login, logout, and authoritative role
  probing plus reusable authenticated-browser and real-DM authorizers. See
  [`AUTHENTICATION.md`](AUTHENTICATION.md).
- The shared event broker durably commits bounded role-scoped events to the
  SQLite change log before waking live subscribers. Its SSE transport supports
  monotonic replay IDs, explicit reset recovery, bounded queues, slow-client
  eviction, and heartbeat-aware write deadlines. See
  [`EVENT_STREAM.md`](EVENT_STREAM.md).
- The v3 package inspector validates a ZIP before execution,
  applies archive and expansion limits, rejects unsafe paths and entry types,
  verifies the complete SHA-256 inventory, validates the manifest, and checks
  every declared package file and JSON Schema. It can safely extract a private
  staged copy and later reverify the exact extracted tree. The inspection CLI
  remains read-only and emits a machine-readable success report or stable
  failure code without executing or extracting the package.
- The TypeScript shell validates responses at the HTTP boundary. Its
  bounded campaign client accepts only the complete `campaign-data.v1`
  collection set, serializes refreshes across authority changes, and retains
  the last accepted dataset after malformed or failed refreshes. A first
  read-only campaign overview renders campaign identity, core counts, and
  knowledge-aware character summaries for anonymous, player, and DM views. A
  serialized mutation client validates payload-free commit receipts, and the
  first DM editor updates campaign name/tagline over the full authoritative
  record so unknown future fields survive.
  The application shell owns the one shared SSE connection independently of
  add-ons and refreshes the campaign on validated collection invalidations.
  Its
  generation scope establishes abort-first, LIFO, once-only, failure-isolated
  cleanup. A serialized browser generation manager validates a complete
  server-authoritative dependency graph, tears consumers down before providers,
  and rebuilds providers before consumers for each opaque graph revision. Its
  graph client validates the exact versioned wire shape and generation-bound
  URLs plus effective capabilities, permission resources, and contribution
  declarations. It serializes private ETag refreshes and preserves the last
  accepted graph across malformed or failed responses. See
  [`BROWSER_ADDONS.md`](BROWSER_ADDONS.md). A runtime coordinator serializes
  that transport through reconciliation, preserves active contributions on
  fetch failures, and invalidates cached authority before ordered teardown on
  role or session changes. The browser SDK exposes immutable identity and
  effective authority without leaking the internal generation scope. Its
  host-owned registry binds only declared, surface-compatible custom elements,
  actions, or model providers, automatically publishes declarative sidebar
  metadata, and removes every registration before module cleanup. The
  authenticated Lit shell now probes session authority, offers login/logout,
  owns the single shared EventSource, refreshes the graph on validated events,
  loads generation styles, renders role-filtered `slot` contributions through
  a keyed host-owned outlet, runs isolated visual modules and bounded
  action/model callbacks in per-contribution opaque CSP-restricted frames over
  transferred message ports, projects exact route/sidebar metadata into a
  host-owned hash namespace, mounts only the selected same-generation route,
  and tears all browser authority down on logout or HTTP authorization loss.
- The shared Go worker codec enforces bounded canonical `Content-Length`
  framing, serializes concurrent writes, validates UTF-8/JSON/envelopes, and
  reports stable transport failure codes. The same package is usable by the
  host supervisor, native workers, and virtual WASI streams.
- The native worker supervisor launches an exact reviewed executable without
  inheriting the host environment, negotiates initialize/start/health before
  readiness, bounds lifecycle deadlines and stderr diagnostics, records an
  Inspector-ready snapshot, and force-terminates failed generations. Its
  detailed boundary is in
  [`WORKER_SUPERVISION.md`](WORKER_SUPERVISION.md).
- The shared worker RPC peer now owns continuous bidirectional routing,
  response correlation, deadlines, cooperative cancellation, fixed
  concurrency limits, late-response disposal, and Inspector-safe counters.
  The host-only dispatcher requires request and response validation, resolves
  host-owned authority, checks exact permissions, contains handler panics, and
  never exposes internal failures to workers. See
  [`WORKER_BROKER.md`](WORKER_BROKER.md).
- The service broker persists installed providers and revisioned operator
  target sets while keeping live generations in memory. It resolves semantic
  version ranges deterministically, preserves stale bindings, prevents a new
  catalog from reusing an old process, issues bounded host-authoritative
  request contexts, and routes schema-validated worker service calls through
  generation-safe handles. See
  [`SERVICE_BROKER.md`](SERVICE_BROKER.md).
- The package lifecycle manager publishes immutable archive-hash generations,
  persists hashed prepared/approved/consumed reviews, atomically consumes an
  approval with its revisioned generation switch, coordinates
  start/switch/cleanup with the service broker, reuses the verified path for
  rollback, and reconstructs exact active generations in
  provider-before-consumer order after restart. It refuses provider changes
  that would strand live dependent handles outside reviewed activation, uses a
  cold add-on-graph restart to rebind affected consumers after approval,
  reloads a runtime without invalidating generation-safe consumer handles, and
  disables even an unrecovered generation without discarding grants or
  installed files. It also projects recovered UI generations and a
  deterministic whole-graph browser revision without exposing package paths,
  and checksum-verifies inventory-backed `web/` assets when opened. See
  [`PACKAGE_LIFECYCLE.md`](PACKAGE_LIFECYCLE.md).
- The rewrite executable now composes authentication, campaign reads, the
  shared event broker, package inspection, service resolution, package
  recovery, protected add-on administration, browser graph/assets, and SSE. It
  requires an explicit
  `CODEX_DM_PASSWORD`, accepts optional `CODEX_PLAYER_PASSWORD`, and has no
  default credential. Production TLS deployments must pass `-secure-cookies`.
  Native worker capability remains unavailable until the worker-to-host
  authorization handlers are composed; UI-only generations can recover now.

These are foundation contracts, not a compatibility claim. Persistent
credentials, core data migration, coordinated dependent disable, stable
contribution-slot rendering, remaining SDK transports, concrete host method
implementations, and import execution remain subsequent milestones in the
dependency order in `docs/REWRITE_ARCHITECTURE.md`.
