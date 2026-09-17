# TTRPG Codex

TTRPG Codex v2 is a self-hosted campaign archive and Add-on API v3 host. Go
owns the server, SQLite persistence, package/worker runtime, and maintenance
tools. Lit and TypeScript own the browser application. Node.js is a build and
test dependency only; it is not part of the production runtime.

## Commands and environment

Use the Go version in go.mod. Node.js 24+ is the supported minimum; .nvmrc
pins Node 26 for development/CI. Run from this repository root in the current
shell. Install dependencies/browser only when missing or stale:

```console
npm ci
npx playwright install chromium
npm run check
npm start
```

`npm run check` rejects JavaScript source files, type-checks the frontend and
Node tools/tests, runs unit and browser tests, builds the frontend, then runs all
project-owned Go tests and `go vet`. Author Node tools and browser tests as
strict `.mts` modules covered by `tsconfig.node.json`; Node executes them through
built-in type stripping. Useful focused checks include:

```powershell
npm --workspace @ttrpg-codex/frontend test
go test ./internal/transport/httpapi
go test ./internal/addons/packagemanager
go test ./sdk/go/workerrpc
```

Run `go test -race` for changed concurrent worker, broker, event, or lifecycle
packages where supported. Use a disposable data directory and local-only
password for manual development; never start development processes against a
production volume.

## Read on demand

Read the relevant owner before changing a subsystem; keep detailed contracts
there instead of expanding this always-loaded file.

| Reference | Read before changing |
|---|---|
| [`README.md`](README.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, boundaries, and complete gates |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System ownership and request/data flow |
| [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) | Configuration, backup, conversion, deployment, and recovery |
| [`docs/rewrite/CORE_DATA.md`](docs/rewrite/CORE_DATA.md) | Core records, revisions, visibility, and transactions |
| [`docs/rewrite/AUTHENTICATION.md`](docs/rewrite/AUTHENTICATION.md) | Sessions, CSRF, role authority, and credential policy |
| [`docs/rewrite/EVENT_STREAM.md`](docs/rewrite/EVENT_STREAM.md) | Durable role-scoped event delivery |
| [`docs/rewrite/BLOBS.md`](docs/rewrite/BLOBS.md) and [`MEDIA.md`](docs/rewrite/MEDIA.md) | Immutable file and media lifecycle |
| [`docs/rewrite/MAPS.md`](docs/rewrite/MAPS.md) | World/local map coordinates, media, placement, and view presets |
| [`docs/rewrite/PACKAGE_LIFECYCLE.md`](docs/rewrite/PACKAGE_LIFECYCLE.md) | Package inspection, approval, activation, update, and rollback |
| [`docs/rewrite/WORKER_SUPERVISION.md`](docs/rewrite/WORKER_SUPERVISION.md) and [`WORKER_BROKER.md`](docs/rewrite/WORKER_BROKER.md) | Native worker process and RPC rules |
| [`docs/rewrite/SERVICE_BROKER.md`](docs/rewrite/SERVICE_BROKER.md) | Versioned provider/consumer binding |
| [`docs/rewrite/RULES_SOURCES.md`](docs/rewrite/RULES_SOURCES.md) | Instance ruleset, sourcebook eligibility, provider settings and preserved character values |
| [`docs/rewrite/ADDON_DATA.md`](docs/rewrite/ADDON_DATA.md) and [`CONTENT.md`](docs/rewrite/CONTENT.md) | Package collections, extensions, content, and migrations |
| [`docs/rewrite/BROWSER_ADDONS.md`](docs/rewrite/BROWSER_ADDONS.md) | Integrated and isolated TypeScript UI lifecycles |
| [`docs/rewrite/UI_FOUNDATIONS.md`](docs/rewrite/UI_FOUNDATIONS.md) | Shared host/add-on controls, researched interaction patterns, semantic skin tokens and focus/lifetime behavior |
| [`docs/rewrite/BACKUP_RESTORE.md`](docs/rewrite/BACKUP_RESTORE.md) and [`LEGACY_CONVERSION.md`](docs/rewrite/LEGACY_CONVERSION.md) | Current backups and the one-time v1 conversion boundary |

Public add-on guidance lives in [`examples/addons/AGENTS.md`](examples/addons/AGENTS.md),
[`AUTHORING.md`](examples/addons/AUTHORING.md),
[`API_V3.md`](examples/addons/API_V3.md), and machine-readable
[`contracts/addons/v3`](contracts/addons/v3). Keep those surfaces synchronized.

## Repository map

```text
cmd/                 Host, health, package inspection, conversion, and maintenance CLIs
contracts/addons/v3/ Public manifest and protocol schemas
frontend/src/core/   Validated host clients and application state
frontend/src/addons/ Generation-scoped integrated and isolated add-on runtime
internal/domain/     Stable campaign concepts and invariants
internal/application/ Policy and multi-record commands
internal/storage/    SQLite, migrations, blobs, packages, and backup implementation
internal/transport/  Authenticated and validated HTTP/SSE boundary
internal/addons/     Package, data, content, service, worker, and lifecycle ownership
sdk/go/workerrpc/    Public native-worker RPC runtime
examples/addons/     Public authoring contract and examples
data/                Ignored runtime state; never source code
```

## Durable data and security invariants

- SQLite is the sole mutable metadata and campaign-record database. Writes use
  established transactions, optimistic revisions, schema checks, audit
  metadata, and event publication.
- Unknown record fields survive ordinary edits. Add-on IDs, collection IDs,
  extension IDs, service IDs, and durable record keys are permanent once
  released.
- Immutable blobs and packages are content-addressed. Archive paths, sizes,
  counts, hashes, restore targets, and client-controlled paths remain bounded
  and containment checked.
- Authentication uses HttpOnly cookies and CSRF protection. The server is
  authoritative for actors and roles; client or worker metadata never grants
  authority.
- SSE events are durable and role scoped. Never publish unfiltered record
  bodies or bypass the normal commit/event sequence.
- Runtime data, backups, package generations, credentials, support bundles,
  generated frontend output, and conversion artifacts stay out of Git.

## Browser boundaries

- Author the application and add-on UI in strict TypeScript. Validate host wire
  responses before they reach state or components.
- Use Lit component ownership, existing design tokens, semantic HTML, keyboard
  behavior, and explicit loading, empty, unavailable, and error states. Never
  insert untrusted HTML.
- Clean up every listener, timer, observer, subscription, request, object URL,
  and add-on contribution with its owning component or generation scope.
- Integrated add-ons are reviewed trusted browser code. Isolated visual add-ons
  run in opaque sandboxed iframes and communicate only through the versioned
  bridge. Neither mode may reach host internals.
- Browser add-on bindings with revision `0` are valid automatic bindings, not
  missing bindings. Generation identity remains part of handles and caches.
- Comments explain only non-obvious invariants, constraints, or why an obvious
  approach is unsafe. Do not preserve implementation history in source.

## Add-on API v3 invariants

- Installation is upload -> inspect/stage -> review the exact permission and
  compatibility diff -> approve -> activate. Production never invokes npm,
  Go, Python, a shell, or another compiler for an add-on.
- A package is an immutable checksummed ZIP. Entrypoints, contracts, locales,
  content, and target workers are declared and verified before execution.
- Services are addressed by contract and compatible semantic version, never a
  provider add-on ID. Optional consumers remain useful without a provider;
  ambiguous and stale bindings remain visible instead of silently changing.
- Every browser handle, worker request, service binding, subscription, and job
  is scoped to one activation generation. Replacement stops consumers before
  providers and starts providers before consumers.
- Native Go workers are crash/process isolation, not an OS security sandbox.
  They use framed RPC on stdout, diagnostics on stderr, host-issued actor and
  deadline metadata, bounded concurrency, health checks, cancellation, and
  graceful shutdown.
- Collections, record extensions, services, imports, and content use closed,
  versioned schemas. Imports and migrations store an immutable reviewed plan
  and commit only that exact plan.
- DM Tools owns the visible Import Center. Core owns authorization,
  transactions, plans, campaign-bundle primitives, and recovery; providers own
  domain-specific preview semantics.

Build an add-on in its own repository, then inspect its release archive here:

```powershell
go run ./cmd/codex-addon-inspect <path-to-addon.zip>
```

Integration testing uses the actual staged-package lifecycle. Never copy a
source checkout into a runtime generation. The host's `companion-revisions.json`
pins the source set used by local installed acceptance and CI. Follow the
[contributor procedure](CONTRIBUTING.md#choose-validation-for-the-change) to
update pins deliberately after companion commits, and the
[delivery procedure](docs/SELF_HOSTING.md#coordinate-host-and-companion-commits)
to publish them before the dependent host revision.

## Deployment and package delivery

This repository builds the host image; `pjunak/infra` owns production Compose,
ingress, host configuration and rollout. Successful current main pushes dispatch
the immutable digest to `asurai` and `tiamat` through infra's main-only workflow
and wait for both exact run results. `INFRA_SERVICE` selects the two targets;
the shared infra credential has Contents read and Actions write. Follow
[publishing and recovery](docs/SELF_HOSTING.md#publishing-and-deploying-updates)
for **Deploy published release** and ambiguous-result inspection.

Companion add-ons publish inspected ZIPs independently. Website owners review
and activate them through Settings -> Add-ons; deploying a host image never
installs a new add-on generation. Preserve server-owned `.env`, managed image
overrides, current `rewrite-v2/data` mounts and retained backups.

## Completion and durable planning

- Architecture completion is not product completion. The product-parity gates
  in the [historical acceptance record](docs/rewrite/FEATURE_PARITY_AUDIT.md#accepted-product-parity-release-gates)
  and npm run release-check define the release
  boundary; release-check also rejects frontend/REWRITE_INCOMPLETE if present.
  npm run check proves
  technical consistency. Follow [the self-hosting runbook](docs/SELF_HOSTING.md)
  for the owner-authorized cutover; do not invent additional launch blockers.
- A generic record browser is not an acceptable substitute for the authored
  dashboard, wiki, editors, maps, timeline, relationship views, settings, and
  first-party add-on workflows. Port, deliberately redesign, or explicitly
  retire each old workflow with maintainer approval and a recorded gate result.
- Ordinary backup and restore accept only codex-backup.v2. The offline
  cmd/codex-convert-v1 tool preserves its input and writes a fresh directory.
  [The legacy conversion contract](docs/rewrite/LEGACY_CONVERSION.md) owns
  retired-data handling; do not add startup readers or general legacy repair.
- For runtime/build changes, run focused tests while iterating and `npm run check`
  before handoff. For prose or agent guidance, review the diff, local links and
  changed claims; no application rebuild is needed solely for documentation. Run
  relevant host/add-on compatibility tests on both sides of a contract change.
- Update the owning reference, public docs, test inventory, and this file only
  when their actual contracts change.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) is the only durable backlog for the host
  and companion addons. Keep temporary plans under ignored `docs/plans/` and
  delete them when the task closes. Do not create additional roadmap/TODO files.
- Do not commit runtime data, secrets, generated packages, backups, or local
  plans. The global Codex instructions govern task commits. Never push,
  release, deploy, replace branches, edit live data, or change production
  credentials unless explicitly asked for that operational step.
