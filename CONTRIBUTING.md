# Contributing

This is a hobby-scale deployment with production-style data boundaries. Prefer
small, explicit changes and keep the host independent from campaign- or game-
specific behavior.

## Setup and complete gate

Use Go 1.27.1, Node.js 26, and PowerShell on Windows.

```powershell
npm ci
npx playwright install chromium
npm run check
```

The frontend is an npm workspace. Local development, CI tests, and the Docker
build all use the root `package-lock.json`. Add or update frontend dependencies
from the repository root with `npm install -w @ttrpg-codex/frontend <package>`,
and commit the updated frontend manifest and root lockfile together.

`npm run check` type-checks, tests, and builds the TypeScript application, then
runs Chromium editor regressions, all project-owned Go tests, and `go vet`.
It also rejects JavaScript source files and checks the release tools and every
browser test with the strict `tsconfig.node.json` configuration. These Node
modules use `.mts` and run directly with Node's built-in TypeScript support;
type checking is a separate mandatory step because Node only strips types.
Generated browser JavaScript and add-on package entrypoints remain build outputs.
Linux CI installs Chromium with `npx playwright install --with-deps chromium`.
The browser fixtures use synthetic campaigns and a loopback Vite server; no
running host or campaign data directory is needed. Useful focused commands are:

```powershell
npm --workspace @ttrpg-codex/frontend test
npm --workspace @ttrpg-codex/frontend run test:browser
go test ./internal/transport/httpapi
go test ./internal/addons/packagemanager
go test ./sdk/go/workerrpc
```

Run `go test -race` for changed concurrent worker, broker, event, or lifecycle
packages where the platform supports it.

Installed first-party checks use disposable local hosts and reviewed release
ZIPs. Build the sibling packages first, then set the archives to include these
checks in `npm run check` (otherwise they report skipped):

```powershell
$env:CODEX_COMPENDIUM_ZIP = (Resolve-Path ../addon-dnd-2024-compendium/dist/dnd-2024-compendium-3.0.0.zip).Path
$env:CODEX_ENGINE_ZIP = (Resolve-Path ../addon-dnd-engine/dist/dnd-engine-3.0.0.zip).Path
$env:CODEX_SHEETS_ZIP = (Resolve-Path ../addon-dnd-character-sheets/dist/dnd-sheets-3.0.0.zip).Path
$env:CODEX_DM_TOOLS_ZIP = (Resolve-Path ../addon-dm-tools/dist/dm-tools-3.0.0.zip).Path
npm run check
```

The installed rules cases exercise the Sheets service consumer through the
native Engine and real Compendium, including late provider installation,
changed content, and stop/start with missing rules. They do not establish
character-sheet visual acceptance.

## Development processes

Build-and-serve loop:

```powershell
npm --workspace @ttrpg-codex/frontend run build
$env:CODEX_DM_PASSWORD = 'local-development-only'
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/development
```

Watch loop:

```powershell
$env:CODEX_DM_PASSWORD = 'local-development-only'
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/development
npm --workspace @ttrpg-codex/frontend run dev
```

Never point development or tests at production data. Runtime directories,
backups, built archives, credentials, and generated add-on installs stay out of
Git.

## Ownership boundaries

- `internal/domain` owns stable campaign concepts.
- `internal/application` owns policy and multi-record commands.
- `internal/storage` owns SQLite and blob implementation details.
- `internal/transport/httpapi` validates and authorizes wire input; it does not
  decide domain policy.
- `internal/addons` owns package, data, service, and worker lifecycle.
- `frontend/src/core` validates host responses before application state sees
  them.
- `frontend/src/addons` owns generation-scoped browser add-on execution.
- `contracts/addons/v3` and `sdk/go/workerrpc` are public compatibility surfaces.

Keep SQL behind stores, HTTP shapes behind clients/handlers, and add-on internals
behind versioned schemas. Add-ons must not import `internal/` packages or host
frontend modules.

## Data and compatibility

Campaign saves matter more than implementation compatibility. Schema migrations
are forward-only and checksum verified. Unknown record fields must survive
ordinary edits. Add-on IDs, collection IDs, extension IDs, service IDs, and
saved record keys are permanent once released.

The v1 converter is a one-shot offline tool for the two downloaded UI backups.
Do not add startup-time legacy readers or a general legacy restore mode.

## Tests and commits

Add a regression test at the narrowest owner for every behavior change. Contract
changes also require affected first-party add-on gates and package inspection.
Keep commits independently understandable. Never deploy, push, or edit live
campaign data as part of development validation.
