# ADR-0005: Replace in-process add-ons with Add-on Platform v3

- Status: Accepted
- Date: 2026-08-31
- Decider: Project owner

**Current status, October 3, 2026:** Native workers, inspection, browser SDK,
isolated frames, automatic package retention and guided saved-data updates are
implemented. WASI and other reserved transports remain unavailable/conditional.
This records the accepted platform direction, not a list of callable APIs or
remaining implementation tasks. Use the
[availability table](../../examples/addons/API_V3.md#current-implementation-status)
and [backlog](../BACKLOG.md) for the actual current boundary.

## Context

The retired Add-on API v2 established useful ownership principles: stable IDs, capability discovery,
permission review, generic service contracts, optional providers, bounded
lifecycle hooks and host-owned import transactions. Its execution model was the
limiting factor: browser modules received a broad facade, while server modules
executed inside the Node.js host and exchanged live objects. That boundary could
not survive the Go rewrite and made failures hard to isolate or replay.

The replacement must cover the suite's current requirements:

- routes, sidebars, settings, article actions, editor panels, slots, renderers,
  wiki kinds, and other UI contributions;
- public and DM-only data, revisions, transactions, subscriptions, and add-on
  owned collections;
- versioned one-or-many services and operator-controlled provider bindings;
- content catalogs, provenance, localization, and enabled source groups;
- reviewed imports, campaign bundles, deletes, rollback, and recovery;
- pure rules computation and richer import or migration workers;
- deterministic install, update, disable, reload, and uninstall behavior;
- useful diagnostics without requiring a debugger inside an add-on process.

## Decision

Adopt Add-on Platform v3 with five explicit contracts.

### 1. Immutable package contract

Every release is an immutable archive containing a strict v3 manifest,
prebuilt browser assets, optional worker artifacts, schemas, content, locales,
and checksums. Production installation never compiles source code.

The installer parses and validates the package without executing it, computes
the permission and service-binding diff, and stages it separately from the
active generation. Stable add-on and contribution IDs are permanent
namespaces.

### 2. Declarative browser contribution contract

The manifest declares every host surface the add-on may occupy. The current
typed TypeScript SDK supplies scoped UI, data, content and service handles;
contribution contexts carry navigation and edit guards. Broader standalone
event, settings, job and logging handles remain reserved. Runtime code binds
implementations only to declared contribution IDs.

Integrated UI modules run in the trusted application realm and use custom
elements with scoped styles. Packages that need a stronger UI boundary use a
sandboxed iframe and the same logical SDK over `postMessage`. The host never
accepts raw HTML strings or string-to-function action dispatch.

### 3. Framed worker protocol

Backend add-ons run outside the host process. Implemented native workers use
standard input/output with JSON-RPC 2.0 and LSP-style `Content-Length` framing.
Standard output is protocol-only and standard error is diagnostic output.
Equivalent WASI virtual streams remain a conditional design, not a runtime.

The protocol defines initialization, readiness, health, cancellation,
deadlines, graceful shutdown, stable error kinds, request and correlation IDs,
frame and concurrency limits, and capability negotiation. Implemented messages
remain bounded; general worker blob transports are reserved.

Workers receive no database handle, host filesystem path, or bearer secret.
Implemented callbacks use capability-scoped data and service methods. Worker
blob, event, network and progress transports are unavailable; declared
permissions alone do not create them. Mutation requests retain idempotency.

### 4. Host-mediated service and data contracts

Services are addressed by stable contract ID and semantic version. Providers
publish machine-readable request and response schemas. Consumers declare a
version range, cardinality, requirement, and selection policy. The host
persists bindings and never silently replaces a stale single-provider binding.

Core data and add-on collections are accessed through revision-aware APIs.
The host validates schemas and permissions and owns transaction boundaries.
Guided saved-data updates review a snapshot and apply compatible healing or
explicit reset inside a recoverable transaction, with an optional data download.
General value-transforming migrations require a concrete preservation case and
are not implemented.

### 5. Supervised generation lifecycle

Install and update follow a staged state machine:

`inspect/stage -> review -> approve -> resolve -> start -> health -> switch`

Saved-data resolution is included when required. The default selected-build
retention removes superseded packages after successful updates and at startup;
removed builds need re-upload for rollback. Campaign recovery stays independent.
Disable, reload, update and uninstall cancel scoped work,
dispose browser contributions, stop workers, release service bindings, and
invalidate generation handles in a deterministic order.

The manager exposes identity, grants, service selections, lifecycle state,
worker health/exit, bounded request timing, redacted correlation references and
tab-local browser failures. Full RPC payload tracing and support exports remain
unavailable; they are not required to close this platform implementation.

## Isolation profiles

Add-on Platform v3 makes trust claims explicit:

| Profile | Intended use | Isolation claim |
|---|---|---|
| Integrated TypeScript UI | Reviewed first-party UI | Lifecycle and API isolation, not a security sandbox |
| Sandboxed iframe UI | Less-trusted visual extensions | Browser-origin and capability boundary |
| WASI worker | Conditional portable-computation design | Reserved; no runtime or current isolation claim |
| Native Go worker | OS, parser, or library access not available in WASI | Crash isolation; not a security sandbox by itself |

Native Go workers are ordinary executables, not Go `plugin` packages. The Go
plugin mechanism is unsuitable because it is platform-limited, tightly coupled
to toolchain and dependency builds, and unavailable on Windows.

## Compatibility policy

- Additive optional fields and methods are compatible within a major version.
- Required capability, permission, or schema changes require a new compatible
  range or major contract version.
- Unknown optional capabilities are ignored; unknown required capabilities
  prevent activation with a diagnostic.
- Host code must not branch on add-on IDs. Identity-specific collaboration is
  expressed as an explicit add-on dependency; interchangeable behavior uses a
  service contract.
- V2 CommonJS server modules are not supported in the final production host.
  A temporary development converter may inspect manifests or data, but it must
  not become a second runtime.

## Options considered

### Embed Go plugins

Rejected due to Windows incompatibility, build coupling, weak operational
isolation, and poor upgrade characteristics.

### Require every worker to use WASI

Rejected because WASI is a valuable containment profile but does not yet cover
all networking, threading, debugging, and native-library needs. It is preferred
for pure computation, not mandated for every extension.

### Keep server add-ons in a Node.js sidecar

Rejected because it preserves two production runtimes and turns temporary v2
compatibility into a permanent architectural dependency.

### Expose only HTTP endpoints to add-ons

Rejected because it leaves lifecycle, provider discovery, transactions,
cancellation, backpressure, and tracing underspecified. HTTP can be exposed as
a contribution, but it runs through the same worker and permission contracts.

## Consequences

### Positive

- Failures are attributable to a package, generation, request, and capability.
- Add-ons can evolve independently without sharing runtime objects.
- Permission review happens before code execution.
- First-party add-ons use the same public boundary as third-party add-ons.
- New surfaces and worker profiles can be negotiated without provider-ID logic.

### Negative

- RPC and schema generation add engineering overhead.
- Ports must not restore browser access to private host DOM or live objects.
- Native worker packaging needs per-target artifacts.
- A good Inspector and conformance harness are required, not optional polish.

## Implemented foundation and conditional scope

Manifest/package validation, native framing/lifecycle, the TypeScript SDK,
isolated iframe transport and first-party ports are implemented and covered by
worker and installed-package regressions. Normative schemas remain maintained
in source. WASI and other reserved transports need a concrete consumer and an
explicit scope decision; the original prototype suggestions are not pending
rewrite tasks. Current live/human acceptance is tracked only in the backlog.

## Research basis

- The official [Go `plugin` documentation](https://pkg.go.dev/plugin) lists its
  supported operating systems and build/runtime drawbacks, including the lack
  of Windows support and inability to close a loaded plugin.
- Go's official [WASI support](https://go.dev/blog/wasi) documents the
  `wasip1/wasm` target and its threading and socket limitations.
- [wazero](https://github.com/wazero/wazero) is a Go-native, non-CGO WebAssembly
  runtime with Windows support and a stable major-version API policy. It is the
  leading embedding candidate, subject to a proof-of-concept and dependency
  review rather than an irreversible contract dependency.
- The worker envelope follows the [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification).
  Its byte framing borrows the proven `Content-Length` base protocol described
  by the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol),
  while lifecycle, methods, limits, and security remain Codex-specific.
