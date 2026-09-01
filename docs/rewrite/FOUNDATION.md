# V2 foundation

The Go host and TypeScript frontend are the application. The former v1 runtime
has been removed from this branch; legacy data enters only through the bounded
offline converter.

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

The repository-level gate covers both toolchains:

```console
npm ci
npm run check
```

Focused Go commands are still useful while iterating:

```console
go test ./cmd/... ./contracts/... ./internal/... ./sdk/...
go vet ./cmd/... ./contracts/... ./internal/... ./sdk/...
go build ./cmd/codex
go run ./cmd/codex-addon-inspect path/to/addon.zip
go run ./cmd/codex-maintenance verify -in path/to/codex-backup.zip
go run ./cmd/codex-convert-v1 -in path/to/v1-ui-backup.zip -out path/to/fresh-data `
  -report path/to/conversion-report.json `
  -addon-package path/to/dm-tools-v3.zip -addon-package path/to/dnd-sheets-v3.zip
```

Run the frontend gate from `frontend/`:

```console
npm ci
npm run check
```

For a watch loop, start the two development processes separately:

```powershell
$env:CODEX_DM_PASSWORD = '<choose-a-local-development-password>'
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/rewrite `
  -locale en -time-zone Europe/Prague
npm --prefix frontend run dev
```

Vite proxies `/api` to the local Go host. Development state stays isolated
under `data/rewrite/`.

## Implemented boundaries

- The Go process opens SQLite with foreign keys, WAL, a bounded busy timeout,
  defensive settings, and numbered checksum-verified migrations.
- Migration 0006 and the durable blob store publish immutable hash-addressed
  objects behind opaque, revisioned handles whose ownership and visibility
  remain authoritative in SQLite. Creation publishes and verifies bytes before
  committing metadata, while deletion is logical so shared or recovery data is
  not removed. See [`BLOBS.md`](BLOBS.md).
- Migration 0007 and the core media service bind those handles to typed
  campaign targets, derive visibility from authoritative records, validate
  bounded image content, and expose CSRF-protected uploads, revisioned logical
  deletion, latest-slot lookup, and visibility-safe immutable reads. The strict
  TypeScript client accepts only the exact path-free response. See
  [`MEDIA.md`](MEDIA.md).
- The native `codex-backup.v2` archive uses SQLite's online backup primitive,
  inventories immutable add-on generations and blob objects by hash, and
  verifies an isolated copy—including every database-referenced blob—before an
  offline journaled data-directory swap. Blob-free v1 archives remain accepted.
  The host holds a portable process lock and recovers interrupted swaps before
  opening SQLite. See [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md). A
  real-and-effective-DM download endpoint exposes this same archive contract
  without a second serializer.
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
  imports known core campaign collections into a fresh SQLite database, moves
  owned source images through the normal opaque-media contract, rewrites known
  media URLs, discards generated tiles, verifies the result before atomic
  publication, and reports add-on-owned or unreferenced files still awaiting
  an owner. It never merges with live state or becomes a startup compatibility
  mode. See [`LEGACY_CONVERSION.md`](LEGACY_CONVERSION.md).
- The HTTP boundary exposes no-store health and version responses. Its add-on
  administration routes require both a lifecycle service and an administrator
  authorizer at composition time; partial configuration fails closed. The
  executable wires them to real-and-effective-DM plus CSRF authority. Browser
  graph and immutable
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
- Migrations 0008 and 0009 plus the add-on data application service persist
  package-owned collections and record extensions with optimistic revisions,
  deletion tombstones, stable order, audit commits, schema-closure identity,
  core-record lifetime binding, derived visibility, and payload-free events.
  Exact generation registries are switched under a quiescing package
  lifecycle transition, and unsafe upgrades become activation-review blockers.
  See [`ADDON_DATA.md`](ADDON_DATA.md).
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
  It also composes supervised native workers with generation-bound add-on data
  handlers. `-locale` and `-time-zone` define the BCP 47 locale and IANA time
  zone reported in the worker handshake; their defaults are `en` and `UTC`.

These contracts define the implemented v2 minimum. Optional platform expansion
and the supervised cutover gates live only in `docs/BACKLOG.md`.
