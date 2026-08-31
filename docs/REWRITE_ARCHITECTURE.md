# Rewrite architecture

This document describes the target architecture on `rewrite/go-typescript`.
It is intentionally separate from `docs/ARCHITECTURE.md`, which remains the
truth for the still-running v1 implementation until the replacement reaches
cutover.

The associated decisions are [ADR-0004](decisions/0004-go-typescript-rewrite.md)
and [ADR-0005](decisions/0005-addon-platform-v3.md). The public target add-on
contract is [Add-on API v3](../examples/addons/API_V3.md).

## Goals and boundaries

The rewrite optimizes for a self-hosted personal application that is easy to
reason about when something goes wrong. It is not designed for horizontally
scaled multi-tenant hosting.

The hard ownership rules are:

- the Go host owns identity, authorization, storage, transactions, package
  lifecycle, service bindings, import execution, recovery, and audit history;
- TypeScript owns browser behavior and presentation, not authoritative data;
- add-ons own their domain behavior and data schemas but use host capabilities;
- providers are selected by contract and version, never hardcoded add-on IDs;
- generated model output remains a reviewable proposal and cannot silently
  mutate user-authored state;
- the visible Import Center remains a DM Tools contribution while the host owns
  generic import authorization and commit/recovery primitives.

## System map

```text
Browser
  TypeScript application
    core UI and router
    typed HTTP/SSE client
    Add-on SDK + Add-on Inspector
    integrated custom elements / isolated iframe bridge
                     |
                     | HTTP/JSON + SSE
                     v
Go host (one process, modular monolith)
  transport -> auth -> application commands/queries
                         |       |        |
                   core domains  |   import coordinator
                                 |
                  add-on package manager
                  supervisor / service broker
                    |                    |
       framed JSON-RPC over stdio    virtual stdio
                    |                    |
             native Go worker        WASI worker
                         |
                         v
              SQLite + blob/package files
```

Only the arrows shown above are public boundaries. Browser modules do not open
the database. Workers do not receive host objects or filesystem paths. Domain
packages do not call transport handlers. Add-ons do not call each other
directly.

## Target source layout

The host repository should converge on this shape:

```text
cmd/codex/                 Go executable wiring only
internal/
  transport/http/          decoding, authentication, response mapping
  application/             commands, queries, transactions, policies
  domain/                  core entities and invariants
  storage/sqlite/          repositories and migrations
  addons/                  packages, supervisor, broker, permissions
  imports/                 generic preview/commit/recovery coordinator
  observability/           logs, metrics, traces, support bundles
frontend/
  src/                     TypeScript application
  test/                    unit and browser tests
sdk/
  go/                      worker SDK and protocol helpers
  typescript/              browser SDK and generated clients
contracts/
  http/                    OpenAPI and generated models
  addons/                  manifests, worker protocol, service schemas
```

During the migration, the existing `web/` tree remains the v1 browser source
and `frontend/` is the isolated v2 workspace. They do not share packages or
runtime modules; `web/` is removed only at cutover.

First-party add-on repositories keep independent release histories. Their
common layout is:

```text
addon.json                 v3 package manifest
web/src/                   optional TypeScript contribution code
worker/                    optional Go module and executable
contracts/                 add-on-owned service and collection schemas
content/                   optional immutable content
locales/                   catalogs
tests/                     conformance and domain tests
```

An add-on does not need empty layers. The compendium may be content plus
TypeScript; a pure rules engine may be a WASI worker; a hand-fillable sheet may
be TypeScript only; DM Tools may use both TypeScript and a native worker.

## Go host modules

### Transport

HTTP handlers validate shape, attach actor and correlation context, call one
application operation, and map typed failures. They contain no domain policy.
OpenAPI 3.1 is generated or verified from the same models used to generate the
TypeScript client.

Normal commands and queries use HTTP/JSON. Static and immutable content uses
cacheable HTTP responses. Live invalidation and progress use SSE with replay
IDs. WebSockets should be introduced only for a demonstrated bidirectional
streaming requirement.

### Application and domain

Application packages define use cases and transaction boundaries. Domain
packages define invariants without knowledge of HTTP, SQLite, or add-on
processes. Cross-domain effects are explicit events recorded with the
transaction, then dispatched after commit.

### Storage

SQLite is the authoritative database with foreign keys, WAL mode, numbered
migrations, and online backup support.

The database and its WAL files must live on the same host and local filesystem;
network-share storage is unsupported. WAL permits concurrent readers with one
writer, which fits this deployment model, but write transactions must stay
short and checkpoint health must be observable.

- Core entities use typed relational tables where relationships and queries
  matter.
- Add-on collections and per-core-record extensions use generic document tables
  keyed by add-on, collection/extension, target key, schema version, and
  revision. JSON is schema validated before commit.
- Attachments and large imports use opaque blob IDs. Blob bytes live outside
  SQLite when appropriate; metadata, ownership, hash, and lifecycle stay in the
  database.
- A monotonic change log supports SSE replay, cache invalidation, and support
  diagnostics.

No add-on owns database migrations against host tables. Core schema migrations
belong to the host. Add-on collection migrations use the supervised v3 data
API and remain rollback-capable.

### Add-on supervisor and broker

The package manager validates immutable artifacts and records approvals. The
supervisor owns one generation-scoped runtime per enabled add-on, applies
limits and deadlines, restarts only according to policy, and invalidates all
handles during teardown.

The implemented package coordinator uses the archive SHA-256 as the generation
ID, keeps the active pointer and grants revisioned in SQLite, verifies archive
and extracted files before every activation/recovery, and starts providers
before required consumers after restart. Detailed switch and rollback ordering
is in [the lifecycle contract](rewrite/PACKAGE_LIFECYCLE.md).

The broker resolves service contracts and persists operator bindings. It also
routes UI and worker service calls through the same authorization, tracing,
deadline, and schema-validation path.

### Imports

Import providers produce immutable preview plans describing creates, updates,
deletes, provenance, warnings, and required permissions. The host stores and
hashes the plan. Commit applies that exact plan inside a transaction or rejects
it as stale. Campaign bundles use the same primitive; recovery never relies on
re-running provider logic after a partial failure.

## TypeScript browser architecture

The browser application uses strict TypeScript and native ESM output. Vite is
the build and development tool. UI composition should use standards-based
custom elements; Lit is the preferred small rendering layer when it materially
reduces repetitive DOM code, but the public add-on contract is custom elements
and events rather than Lit-specific types.

Core rules:

- server responses and events enter through generated, runtime-validated
  boundary models;
- domain state is separate from DOM components;
- async ownership always has an `AbortSignal` or disposable scope;
- custom events carry structured data and never function references;
- user-visible optimistic state is reconciled by revision, not by timing;
- generated suggestions remain distinct from accepted authored data.

The host supplies a small design-system layer and stable contribution slots.
Add-ons receive tokens and components, not selectors into private host DOM.
The implemented browser coordinator treats the server graph revision as an
opaque rebuild boundary, disposes consumers before providers, and activates
providers before consumers. Its detailed contract is in
[browser add-on generations](rewrite/BROWSER_ADDONS.md).

## API and contract versioning

There are separate versions for:

- host HTTP API;
- Add-on API;
- worker protocol;
- each service contract;
- each collection schema;
- package format.

These versions must not move in lockstep. A package declares compatible ranges
and the loader reports every mismatch before activation. Schemas are stored by
stable URI and used to generate Go and TypeScript types where practical.

Backward-compatible additions are optional and capability negotiated. Removing
or changing required fields creates a new major contract version. Unknown
required capabilities prevent activation; unknown optional capabilities do
not.

## Failure handling and observability

Every external operation has a request ID, correlation ID, actor context,
deadline, and stable error kind. The same correlation ID appears in browser
diagnostics, host logs, worker RPC traces, import jobs, and transaction audit
records.

Structured logs default to human-readable local output and can emit JSON. They
must redact secrets and sensitive payloads. Metrics cover request latency,
worker restarts, queue depth, dropped SSE clients, transaction conflicts, and
import outcomes. Trace propagation is OpenTelemetry-compatible but does not
require an external collector.

The Add-on Inspector is a first-class operational surface. It exposes resolved
versions and bindings, grants, lifecycle history, health, bounded redacted RPC
traces, active jobs and subscriptions, migrations, and exact failure causes.
It can export a sanitized support bundle.

## Testing strategy

The rewrite uses several complementary layers:

- characterization tests against current exports, imports, and user-visible
  flows;
- Go unit tests for domain invariants and storage adapters;
- SQLite integration tests with real migrations and transaction conflicts;
- contract tests generated from OpenAPI and JSON Schemas;
- worker conformance tests for framing, timeouts, cancellation, malformed
  messages, crashes, and backpressure;
- TypeScript unit tests plus Playwright flows for host and add-on lifecycle;
- package update and rollback tests using two real generations;
- first-party add-on contract tests run against the public SDK, not host
  internals.

The old and new implementations do not need identical internal structures.
They do need equivalent accepted data, authorization outcomes, stable IDs,
provider selection, and reviewed mutation behavior.

## Migration order

This is an architectural dependency order, not a release schedule:

1. freeze representative v2 behavior as fixtures and black-box tests;
2. create schemas, generation, Go module, TypeScript workspace, and SQLite
   migration runner;
3. implement host core data, auth, HTTP/SSE, and export/import compatibility;
4. implement package inspection, supervisor, broker, SDKs, and Inspector;
5. port the compendium and engine to prove content and WASI service paths;
6. port character sheets to prove optional providers and renderer selection;
7. port DM Tools last to prove complex UI, collections, imports, and native
   worker behavior;
8. run full data migration, rollback, packaging, and operating checks;
9. plan the main/deprecated branch cutover as a separately approved operation.

## Explicit non-goals

- Microservices, Kubernetes, or a distributed database.
- Executing arbitrary source packages during installation.
- Treating native worker processes as a security sandbox.
- Preserving undocumented DOM access or live JavaScript object sharing.
- Supporting v2 CommonJS add-ons indefinitely.
- Allowing add-ons or generated content to bypass reviewed host transactions.
