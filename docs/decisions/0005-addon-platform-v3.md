# ADR-0005: Replace in-process add-ons with Add-on Platform v3

- Status: Accepted
- Date: 2026-08-31
- Decider: Project owner

**Implementation status, September 14, 2026:** Native workers, inspection, the browser SDK and isolated frames are implemented. WASI remains unavailable and conditional; the original delivery list below is not a current completion checklist. Use the [availability table](../../examples/addons/API_V3.md#current-implementation-status) and [backlog](../BACKLOG.md).

## Context

Add-on API v2 has good ownership principles: stable IDs, capability discovery,
permission review, generic service contracts, optional providers, bounded
lifecycle hooks, and host-owned import transactions. Its execution model is
the limiting factor. Browser entry modules receive a broad facade, while
server entry modules execute inside the Node.js host and exchange live objects.
That boundary cannot survive a Go rewrite and makes failures hard to isolate or
replay.

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

The manifest declares every host surface the add-on may occupy. A typed
TypeScript SDK supplies scoped handles for data, services, imports, events,
settings, navigation, and logs. Runtime code binds implementations only to
declared contribution IDs.

Integrated UI modules run in the trusted application realm and use custom
elements with scoped styles. Packages that need a stronger UI boundary use a
sandboxed iframe and the same logical SDK over `postMessage`. The host never
accepts raw HTML strings or string-to-function action dispatch.

### 3. Framed worker protocol

Backend add-ons run outside the host process. Native workers communicate over
standard input/output; WASI workers communicate over equivalent virtual
streams. Both use JSON-RPC 2.0 messages with LSP-style `Content-Length` framing.
Standard output is protocol-only and standard error carries structured logs.

The protocol defines initialization, readiness, health, cancellation,
deadlines, graceful shutdown, stable error kinds, request and correlation IDs,
frame and concurrency limits, and capability negotiation. Large data crosses
the boundary through opaque blob handles or bounded chunks, not unbounded base64
messages.

Workers receive no database handle, host filesystem path, or bearer secret.
They call capability-scoped host methods for data, blobs, services, events,
logging, and reviewed outbound HTTP. Mutation requests carry idempotency keys.

### 4. Host-mediated service and data contracts

Services are addressed by stable contract ID and semantic version. Providers
publish machine-readable request and response schemas. Consumers declare a
version range, cardinality, requirement, and selection policy. The host
persists bindings and never silently replaces a stale single-provider binding.

Core data and add-on collections are accessed through revision-aware APIs.
The host validates schemas and permissions and owns transaction boundaries.
Add-on data migrations are planned against a snapshot, reviewed when relevant,
and applied by the host inside a recoverable transaction.

### 5. Supervised generation lifecycle

Install and update follow a staged state machine:

`inspect -> approve -> stage -> resolve -> migrate -> start -> health -> switch`

The previous generation remains recoverable until the new generation is
healthy and active. Disable, reload, update, and uninstall cancel scoped work,
dispose browser contributions, stop workers, release service bindings, and
invalidate generation handles in a deterministic order.

The host exposes an Add-on Inspector showing lifecycle transitions, versions,
grants, service bindings, worker health, redacted RPC traces, logs, active jobs,
subscriptions, migrations, and rollback results under shared correlation IDs.

## Isolation profiles

Add-on Platform v3 makes trust claims explicit:

| Profile | Intended use | Isolation claim |
|---|---|---|
| Integrated TypeScript UI | Reviewed first-party UI | Lifecycle and API isolation, not a security sandbox |
| Sandboxed iframe UI | Less-trusted visual extensions | Browser-origin and capability boundary |
| WASI worker | Portable pure or bounded computation | Capability-oriented runtime boundary |
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
- Browser code that currently reaches into host DOM or objects must be ported.
- Native worker packaging needs per-target artifacts.
- A good Inspector and conformance harness are required, not optional polish.

## Follow-up actions

1. Maintain the normative v3 API specification and JSON Schemas in source.
2. Implement manifest validation and package inspection without execution.
3. Implement the worker framing, initialization, cancellation, and test harness.
4. Implement the TypeScript SDK and an isolated-iframe transport.
5. Port one pure service provider to WASI and one stateful add-on to a native
   worker to validate both profiles.
6. Add destructive update, crash, timeout, stale binding, and rollback tests.

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
