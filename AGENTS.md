# TTRPG Codex

A self-hosted campaign archive (records, maps, timeline, relationships,
DM/player views) and the host for optional Add-on API v3 packages. Go owns the
server, SQLite storage, package/worker runtime and maintenance CLIs. Lit and
TypeScript own the browser app. Node.js is build/test tooling only.

This is a personal, low-traffic project. Preserving campaign data comes first;
then usability, clear code and good documentation. Backwards compatibility with
old formats and hardening beyond the existing security model are low priority.

## Commands

Use Go from `go.mod` and Node from `.nvmrc` (Node 26+), from this directory.

```console
npm ci
npx playwright install chromium
npm run check:fast   # types, lint, format, gofmt, vet, staticcheck (~1 min)
npm run check        # + tool, unit, browser and Go tests incl. race (~5 min)
```

Focused loops: `npm --workspace @ttrpg-codex/frontend test`,
`npm --workspace @ttrpg-codex/frontend run test:browser`, `go test ./internal/...`.
Format with `npm run format` and `go run ./tools/check.go format`. Run a local
host with a throwaway data directory (see [README](README.md#run-locally));
never point development tools at a live site's data.

## Layout

```text
cmd/                  Host, health probe, package inspector, maintenance CLI
contracts/addons/v3/  Public manifest and protocol schemas
sdk/go/workerrpc/     Public Go SDK for native add-on workers
internal/domain/      Campaign concepts and invariants
internal/application/ Policy and multi-record commands
internal/storage/     SQLite, migrations, blobs, backups
internal/transport/   Authenticated HTTP/SSE API
internal/addons/      Packages, data, content, services, workers, lifecycle
frontend/src/core/    Validated API clients and app state
frontend/src/app/     Views and editors
frontend/src/ui/      Shared controls lent to add-ons (ui.controls.v1)
frontend/src/addons/  Browser add-on runtime
examples/addons/      Add-on author guide and API reference
docs/                 Operator guide, architecture, references, backlog
```

## Invariants

- SQLite is the only mutable store. Writes go through the existing
  transactions with optimistic revisions; stale writes fail with a conflict.
  Unknown record fields survive edits. Migrations are forward-only and
  checksum-verified; never edit a released migration.
- Released add-on, collection, extension and service IDs are permanent.
- Blobs and packages are immutable and content-addressed. Paths, sizes and
  counts from clients or archives stay bounded and containment-checked.
- The server decides actors and roles (HttpOnly session cookie plus CSRF
  header). Events are role-scoped; never publish unfiltered record bodies.
- Add-ons install as prebuilt ZIPs: upload, inspect, review permissions,
  approve, activate. Production never compiles add-on source.
- Services are found by contract and version, never by provider add-on ID.
  Optional consumers must keep working without a provider.
- Browser handles, worker requests, bindings and jobs belong to one add-on
  generation; replacement stops consumers before providers.
- UI code validates every API response, uses the shared controls and design
  tokens, never inserts untrusted HTML, and cleans up listeners, timers and
  requests with its owner.
- Comments explain non-obvious constraints, not history.

## Validation by change

| Change | Run |
| --- | --- |
| Docs only | Check changed claims, commands and links |
| Host code | `npm run check` |
| Worker, broker, event or lifecycle concurrency | Also `go test -race` on the package |
| Public add-on contract (manifest, SDK, services) | Host tests plus the affected add-ons' gates |
| Installed add-on behaviour | `npm --workspace @ttrpg-codex/frontend run test:installed` with the four `CODEX_*_ZIP` variables ([how](CONTRIBUTING.md#installed-add-on-smoke-test)) |

## Where to read more

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests, CI and releases.
- [docs/README.md](docs/README.md): index of the operator guide, architecture
  and subsystem references (`docs/reference/`).
- [docs/BACKLOG.md](docs/BACKLOG.md): the only task list for the host and the
  first-party add-ons. Temporary plans go in the ignored `docs/plans/`.
- [examples/addons/AUTHORING.md](examples/addons/AUTHORING.md) and
  [API_V3.md](examples/addons/API_V3.md): the public add-on contract. Keep
  them in sync with `contracts/addons/v3/` and the SDK.

## Delivery

A push to `main` builds the image and deploys it to both sites (asurai and
tiamat) through `pjunak/infra`; documentation-only pushes do not deploy.
Pushing, deploying, installing or activating add-ons on a site, and touching
live data are separate decisions: ask first. Tiamat runs without add-ons.
Never commit runtime data, secrets, backups or build output.
