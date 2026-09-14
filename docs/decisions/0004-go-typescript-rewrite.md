# ADR-0004: Rewrite the host in Go and TypeScript

- Status: Accepted
- Date: 2026-08-31
- Decider: Project owner

**Implementation status, September 14, 2026:** The Go/TypeScript host and native first-party ports are implemented and the personal-site cutover was accepted. The original delivery list below is historical; current gaps are in [the backlog](../BACKLOG.md).

## Context

The current host is a Node.js/Express application with browser JavaScript,
CommonJS server modules, JSON-file persistence, and an in-process add-on API.
That implementation proved the product and established useful public contracts,
but the same JavaScript objects currently cross too many trust and ownership
boundaries. Runtime add-ons are coupled to Node.js, data contracts are only
partly machine checked, and a faulty server add-on can affect the host process.

This is a personal project, so a larger rewrite is acceptable. The preferred
end state is also intentionally consistent: TypeScript for browser code and Go
for backend or worker code, without retaining project-owned JavaScript or
Python runtimes as compatibility layers.

At acceptance, the `main` branches held the stable implementation. Cutover,
preservation of the old line, and branch renaming were separate release
operations and were not authorized by this decision.

## Decision

Develop the next major version on the coordinated `rewrite/go-typescript`
branch in the host and all first-party add-on repositories.

Implementation status, September 4: rewrite development now occupies `main` in
all five repositories, with the former host preserved at
`origin/deprecated/pre-rewrite-2026-09-01`. This source-branch transition does
not establish product parity or authorize production cutover. The current
workflow inventory, remaining gates, and acceptance order live in the
[suite backlog](../BACKLOG.md).

The target architecture is:

- a TypeScript browser application built to standards-based ESM;
- a Go modular monolith for HTTP, authorization, persistence, add-on
  supervision, imports, and background work;
- SQLite as the transactional source of truth, with files used only for
  immutable packages, content, exports, backups, and opaque blobs;
- generated TypeScript clients and shared schemas at HTTP, storage, service,
  and worker boundaries;
- HTTP/JSON for request-response operations and SSE for one-way live updates;
- out-of-process Go or WASI add-on workers rather than in-process host plugins;
- Node.js only as a development/build tool for the TypeScript frontend, not as
  a production runtime dependency;
- no project-owned Python runtime in the rewritten product.

The host remains a single deployable application. Package boundaries inside
the Go module are enforced through internal interfaces rather than split into
networked microservices.

The rewrite preserves stable add-on IDs, service contract IDs, content
provenance, user-authored data, and export/import semantics where they remain
sound. It does not preserve the current in-process JavaScript execution model.

## Options considered

### Continue evolving the Node.js host

This would minimize migration work and keep the present loader working. It was
rejected because the chosen project direction is a full backend replacement,
and retaining Node.js solely for old server add-ons would make that boundary
permanent.

### Use TypeScript for both browser and server

This would maximize language sharing. It was rejected because Go better fits
the desired single-binary, low-operational-overhead host and provides a clear
process boundary for backend add-ons.

### Use Rust for the host

Rust offers excellent control and performance. It was not chosen because this
application is dominated by orchestration, persistence, HTTP, and extension
lifecycle work rather than low-level computation. Go is simpler to iterate on
while still providing static binaries, explicit concurrency, and strong
typing.

### Split the host into services

Independent services could isolate components, but would add deployment,
versioning, tracing, and failure modes without a matching scale requirement.
The add-on worker boundary supplies the isolation the project actually needs.

## Consequences

### Positive

- The production host has one runtime and one deployable binary.
- Browser and backend boundaries become generated and machine checked.
- SQLite provides atomic transactions, migrations, backup primitives, and
  recovery behavior that JSON-file persistence cannot reliably provide.
- Add-on crashes and timeouts can be contained by the supervisor.
- The architecture can keep the simple self-hosted operating model.

### Negative

- Most implementation code will be replaced rather than incrementally ported.
- Existing JavaScript add-ons need explicit v3 ports.
- Development still requires Go and Node.js toolchains.
- A staged migration and compatibility test corpus are required before cutover.

### Risks

- Reproducing behavior without preserving accidental implementation coupling
  requires strong characterization tests.
- SQLite document and relational boundaries can become muddled unless core
  ownership and add-on collection ownership remain explicit.
- WASI is useful but cannot be treated as a universal replacement for native
  workers; runtime limitations must stay visible.

## Follow-up actions

1. Ratify Add-on Platform v3 before implementing the new loader.
2. Capture v2 behavior as black-box compatibility tests and export fixtures.
3. Establish the Go module, TypeScript workspace, generated contracts, and
   SQLite migration runner.
4. Implement package inspection and the add-on supervisor before porting
   first-party add-ons.
5. Migrate first-party add-ons in dependency order and exercise rollback.
6. Plan the branch cutover only after data migration and release checks pass.

## Research basis

- [SQLite WAL](https://www.sqlite.org/wal.html) documents concurrent readers,
  the single-writer/checkpoint model, local-filesystem requirement, and WAL
  file handling.
- [SQLite Online Backup API](https://www.sqlite.org/backup.html) provides a
  supported way to back up a live database without copying an inconsistent
  standalone file.
