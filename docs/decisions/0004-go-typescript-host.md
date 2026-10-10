# ADR-0004: Go and TypeScript host

**Status:** Accepted

**Date:** 2026-08-31

**Decider:** Project owner

## Context

The host is a self-hosted campaign archive and the runtime for optional
add-ons. It must keep campaign data safe through crashes and updates, contain
faulty add-ons, and stay simple to operate on one small server. Data crosses
several trust boundaries (browser, host, add-on workers), so those boundaries
need machine-checked contracts rather than shared in-memory objects.

## Decision

- A TypeScript browser application built to standards-based ESM.
- A Go modular monolith for HTTP, authorization, persistence, add-on
  supervision, imports and background work, shipped as one deployable binary.
  Package boundaries inside the module are internal interfaces, not networked
  services.
- SQLite as the transactional source of truth; files only for immutable
  packages, content, exports, backups and opaque blobs.
- Shared schemas at HTTP, storage, service and worker boundaries.
- HTTP/JSON for request-response operations and SSE for one-way live updates.
- Out-of-process Go workers for backend add-on code, not in-process plugins
  ([ADR-0005](0005-addon-platform-v3.md)).
- Node.js only as build and test tooling for the frontend, never a production
  runtime. No project-owned Python runtime.

## Alternatives considered

- **TypeScript on both browser and server:** maximal language sharing, but Go
  better fits a single-binary, low-overhead host and gives a clear process
  boundary for backend add-ons.
- **Rust:** excellent control and performance, but the host is dominated by
  orchestration, persistence, HTTP and extension lifecycle work. Go is simpler
  to iterate on while still giving static binaries, explicit concurrency and
  strong typing.
- **Separate services:** would add deployment, versioning, tracing and failure
  modes without a matching scale need. The worker boundary supplies the
  isolation the project needs.

## Consequences

- Production has one runtime and one binary; the image contains no Node.js.
- SQLite provides atomic transactions, forward-only migrations, online backups
  and crash recovery.
- Add-on crashes and timeouts are contained by the worker supervisor.
- Development needs both Go and Node.js toolchains.
- Core ownership and add-on collection ownership must stay explicit so SQLite
  document and relational boundaries do not blur.

## Research basis

- [SQLite WAL](https://www.sqlite.org/wal.html) documents concurrent readers,
  the single-writer/checkpoint model, local-filesystem requirement, and WAL
  file handling.
- [SQLite Online Backup API](https://www.sqlite.org/backup.html) provides a
  supported way to back up a live database without copying an inconsistent
  standalone file.
