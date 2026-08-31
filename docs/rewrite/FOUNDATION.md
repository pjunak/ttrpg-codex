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
```

Run the frontend gate from `frontend/`:

```console
npm ci
npm run check
```

Start the two development processes separately:

```console
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/rewrite
npm --prefix frontend run dev
```

Vite proxies `/api` to the local Go host. Rewrite state is isolated under
`data/rewrite/` and is not compatible with the v1 runtime data yet.

## Implemented boundaries

- The Go process opens SQLite with foreign keys, WAL, a bounded busy timeout,
  defensive settings, and numbered checksum-verified migrations.
- The initial HTTP boundary exposes no-store health and version responses.
- The v3 package inspector validates a ZIP without executing or extracting it,
  applies archive and expansion limits, rejects unsafe paths and entry types,
  verifies the complete SHA-256 inventory, validates the manifest, and checks
  every declared package file and JSON Schema. The inspection CLI emits a
  machine-readable success report or stable failure code without executing or
  extracting the package.
- The TypeScript shell validates responses at the HTTP boundary. Its
  generation scope establishes abort-first, LIFO, once-only, failure-isolated
  add-on cleanup semantics before UI SDK handles are added.
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

These are foundation contracts, not a compatibility claim. Authentication,
core data migration, add-on activation and restart coordination, service
binding, domain-call routing, and import execution remain subsequent
milestones in the dependency order in `docs/REWRITE_ARCHITECTURE.md`.
