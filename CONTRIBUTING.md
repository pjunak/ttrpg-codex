# Contributing

Keep changes focused and preserve campaign data. The host owns general campaign
and add-on infrastructure; game-specific rules and workflows belong in add-ons.

## Set up

Use Go from [go.mod](go.mod) and Node.js from [.nvmrc](.nvmrc). Run commands
from the repository root.

```text
npm ci
npx playwright install chromium
npm run check
```

On Linux, Playwright may also need system libraries:
`npx playwright install --with-deps chromium`. The Go race detector needs a C
compiler that Go supports; without one the race step of `npm run check` fails.

The frontend is an npm workspace using the root lockfile. Add dependencies with
`npm install -w @ttrpg-codex/frontend <package>` and commit its manifest with the
root `package-lock.json`.

Migration SQL is pinned to LF by [.gitattributes](.gitattributes) because the
host verifies migration checksums over the exact bytes. Never change a released
migration. For databases created by older Windows builds, see
[migration checksum drift](docs/SELF_HOSTING.md#migration-checksum-drift).

## Run the development host

Build the frontend, set a local password and use a throwaway data directory:

```powershell
npm --workspace @ttrpg-codex/frontend run build
$env:CODEX_DM_PASSWORD = 'local-development-only'
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/development
```

For a watch loop, leave the host running and start Vite in another terminal;
it proxies `/api` to the host:

```text
npm --workspace @ttrpg-codex/frontend run dev
```

Never point development tools at a live site's data. To try a change against
real content, restore a downloaded backup into a new directory with
`go run ./cmd/codex-maintenance restore -data-dir <new-dir> -in <backup.zip>`
and, if needed, set a local password there with `-reset-passwords` (see
[password recovery](docs/SELF_HOSTING.md#password-changes-and-access-recovery)).

## Checks

| Command | What it runs |
| --- | --- |
| `npm run check:fast` | No-JavaScript source guard, strict types, typed Oxlint, Prettier, gofmt, `go vet`, Staticcheck |
| `npm run check` | Fast checks, tool tests, frontend unit tests, browser tests, Go tests and selected race tests |
| `npm run format` / `go run ./tools/check.go format` | Format TypeScript/CSS/config and Go |
| `npm run lint:fix` | Apply Oxlint fixes (review the diff) |
| `npm run check:workflows` | actionlint, with ShellCheck from `PATH` |
| `npm run check:vulnerabilities` | Reachable Go vulnerabilities |
| `npm run check:dependencies` | npm audit; high or critical advisories fail |

Pick the narrowest useful test while iterating:

```text
npm --workspace @ttrpg-codex/frontend test
npm --workspace @ttrpg-codex/frontend run test:browser
go test ./internal/transport/httpapi
go test ./internal/addons/packagemanager
go test -race ./sdk/go/workerrpc
```

Run `go test -race` on changed worker, broker, event or lifecycle packages.
Node tools and browser tests are strict `.mts` files executed through Node's
type stripping, so `npm run typecheck` still checks them. Top-level test
registrations use `void test(...)`.

Failed browser tests keep a Playwright trace under
`frontend/test-results/traces/` (set `CODEX_TEST_TRACE=1` to keep traces for
passing tests too). Open one with `npx playwright show-trace <trace.zip>`.

Go analysis tools are pinned in `go.tools.mod` so they never upgrade
application dependencies. Dependabot proposes grouped npm, Go and Actions
updates monthly; it does not touch `go.tools.mod`.

### Installed add-on smoke test

The `installed-*.browser.mts` files start disposable hosts, install real add-on
ZIPs through the normal review lifecycle and exercise each add-on's main
workflows. Cases that need a package skip when its ZIP is not supplied. Build
the add-ons in their own repositories, then:

```powershell
$env:CODEX_DM_TOOLS_ZIP = (Resolve-Path ../addon-dm-tools/dist/dm-tools-3.0.0.zip).Path
$env:CODEX_ENGINE_ZIP = (Resolve-Path ../addon-dnd-engine/dist/dnd-engine-4.0.0.zip).Path
$env:CODEX_SHEETS_ZIP = (Resolve-Path ../addon-dnd-character-sheets/dist/dnd-sheets-4.0.0.zip).Path
$env:CODEX_COMPENDIUM_ZIP = (Resolve-Path ../addon-dnd-2024-compendium/dist/dnd-2024-compendium-3.1.0.zip).Path
npm --workspace @ttrpg-codex/frontend run build
npm --workspace @ttrpg-codex/frontend run test:installed
```

It takes about two minutes. The **Installed add-on smoke test** workflow runs
the same suite nightly against the latest published add-on releases; it never
blocks a deployment. It needs the `ADDON_SUITE_TOKEN` secret (read access to the
private compendium) for the compendium, rules and character cases, and it does
not upload traces because they can contain private compendium text.

Detailed character, rules and planner behaviour is tested in each add-on's own
repository. Add an installed case only for something that needs the real host
and packages together.

## CI and releases

| Workflow | When | What |
| --- | --- | --- |
| Build and dispatch | Push to `main`, pull requests, manual | `npm run check`, image build and start-up check; on `main` publishes the image and deploys both sites |
| Deploy published release | Manual | Redeploys an earlier successful build to one site |
| Installed add-on smoke test | Nightly, manual | Latest published add-ons on this host |
| Quality maintenance | Weekly, manual | npm audit, actionlint, Go vulnerabilities |
| Secret scan | Push, pull request | Gitleaks |

Documentation-only changes (`*.md`, `docs/`) skip build and deploy. Operating
the deployment is described in [publishing and deploying
updates](docs/SELF_HOSTING.md#publishing-and-deploying-updates).

Each add-on repository builds, tests and packages from a plain clone. Its Go
code requires this module by version through the public module proxy, and its
CI runs this repository's package inspector as a pinned Go tool. When an add-on
needs an unreleased host change, develop against a local checkout with an
uncommitted `go.work` (`go work init . ../ttrpg-codex` in the add-on), then
push the host change and bump the add-on's requirement with
`go get github.com/pjunak/ttrpg-codex@<commit>`. Successful add-on `main` builds
publish their inspected ZIP as a GitHub release; installing it on a site is a
separate step in Settings → Add-ons.

## Keep ownership clear

| Boundary | Owner |
| --- | --- |
| Stable campaign concepts | `internal/domain` |
| Policy and multi-record commands | `internal/application` |
| SQLite and blobs | `internal/storage` |
| Wire validation and authorization | `internal/transport/httpapi` |
| Packages, data, services and workers | `internal/addons` |
| Browser response validation | `frontend/src/core` |
| Browser add-on lifetime | `frontend/src/addons` |
| Public compatibility contracts | `contracts/addons/v3` and `sdk/go/workerrpc` |

Keep SQL behind stores and wire shapes behind clients and handlers. Add-ons use
the public schemas and SDK; they never import host `internal/` packages or
frontend modules. See [Architecture](docs/ARCHITECTURE.md).

## Write useful documentation

Lead with the reader's task. Each kind of text has one home:

| Text | Home |
| --- | --- |
| Setup and everyday use | The repository README |
| How something works now | The owning reference under [docs/reference/](docs/reference/) (add-ons: their `docs/`) |
| Why it is built this way | An [architecture decision](docs/decisions/) (copy the [template](docs/decisions/TEMPLATE.md)) |
| A problem that is not decided yet | A [design note](docs/design/) marked **Undecided** |
| Future work, for every repository | [BACKLOG.md](docs/BACKLOG.md), in its documented entry format |
| A plan for the change in progress | The ignored `docs/plans/`; delete it when done |

References end with a short **Limits** section that links backlog entries
instead of keeping their own task lists. Do not leave TODO comments in code;
add a backlog entry. Describe current behaviour in the present tense; history
belongs in Git, not in documents. Update the owning document in the same
change as the behaviour.

## Commit and hand off

Group changes into understandable commits, one repository at a time, and say
why in the message. Report which checks ran. Pushing, publishing, deploying and
live-data operations are separate decisions.
