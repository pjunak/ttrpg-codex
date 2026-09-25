# Contributing

Keep changes focused and preserve campaign data. The host owns general campaign
and add-on infrastructure; game-specific rules and workflows belong in add-ons.

## Set up

Use Go from [go.mod](go.mod) and Node.js from [.nvmrc](.nvmrc). Run commands
from the repository root. PowerShell examples below show environment-variable
syntax; use the equivalent syntax in your preferred shell.

```text
npm ci
npx playwright install chromium
npm run check
```

On Linux, Playwright may also need system libraries:
`npx playwright install --with-deps chromium`.

The frontend is an npm workspace using the root lockfile. Add dependencies with
`npm install -w @ttrpg-codex/frontend <package>` and commit its manifest together
with the root `package-lock.json`.

Migration SQL is pinned to LF by [.gitattributes](.gitattributes). Checksums
cover the exact embedded bytes, so do not change released SQL or disable drift
validation. The full gate verifies both Git checkout modes and the embedded
history. An existing checkout may need a fresh checkout to pick up this rule;
first preserve any local work. For databases created by older Windows builds,
see [migration checksum recovery](docs/SELF_HOSTING.md#migration-checksum-drift).

## Run the development host

Build the frontend, set a local password and use a separate data directory:

```powershell
npm --workspace @ttrpg-codex/frontend run build
$env:CODEX_DM_PASSWORD = 'local-development-only'
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/development
```

For a watch loop, leave the Go host running and open another terminal:

```text
npm --workspace @ttrpg-codex/frontend run dev
```

Vite proxies `/api` to the host. Never point development checks at production
data. Runtime directories, credentials, backups and install ZIPs stay out of Git.

## Choose validation for the change

| Change | Checks |
| --- | --- |
| Documentation only | Review changed claims, commands, relative links and heading anchors |
| Host source or tooling | `npm run check` |
| Concurrent worker, broker, event or lifecycle behavior | Full gate plus `go test -race` for affected packages |
| Public add-on contract | Relevant host tests and every affected producer/consumer gate |
| Package, manifest, worker or schema | Owning build, regenerated outputs and host ZIP inspection |
| Release candidate | Full gates, relevant installed-package checks and `npm run release-check` |

`npm run check` rejects tracked JavaScript source, type-checks application and
Node tooling, tests release scripts, runs frontend unit and Chromium tests,
builds browser assets, and runs all project-owned Go tests and vet. TypeScript
also rejects unused locals and parameters. Node `.mts` tools execute through
built-in type stripping, so their separate type check remains mandatory.

The compatibility workflow checks out the exact source SHAs in
[`companion-revisions.json`](companion-revisions.json), checks their availability
before building, and inspects each current manifest's ZIP. It runs Sheets Go
tests/vet against the candidate host SDK as well as its browser checks. All
packages remain in the same job; private package contents are never uploaded as
CI artifacts. `release/companions/provenance.json` records exact host/sibling
commits and ZIP hashes and is retained as the job artifact. Failed installed
acceptance also records the source/hash table in the job summary.

When companion source changes, run its owning gates and commit it first. From
clean adjacent checkouts, explicitly update the host's source set with
`node scripts/companion-revisions.mts record`. This changes only the revision
file; it does not publish commits or establish acceptance. Otherwise use the
already pinned commits. Check before building (some builds modify tracked
generated outputs):

```text
node scripts/companion-revisions.mts check full
```

After building the four companion ZIPs from those commits:

```text
node scripts/companion-suite.mts prepare ../addon-dm-tools ../addon-dnd-engine ../addon-dnd-character-sheets ../addon-dnd-2024-compendium
npm --workspace @ttrpg-codex/frontend run build
node scripts/companion-suite.mts test full
```

Inspection and installed acceptance both reject source revisions that differ
from the committed pins. The runner verifies every copied ZIP against its
inspected hash, supplies all four `CODEX_*_ZIP` inputs, and rejects any test
failure or skip. Commit the accepted pins with the dependent host change. During
authorized publication, make those companion commits available before the host;
follow the [delivery procedure](docs/SELF_HOSTING.md#coordinate-host-and-companion-commits).

Publication requires the private token and the full suite. A PR without private
access runs the pinned public packages and explicitly reports incomplete
publication coverage. Repository T14 work may remove generated tracked outputs
only after each producer retains its standalone deterministic package build.

Browser files run four at a time to bound Chromium resource usage without
changing individual test deadlines or coverage.

Focused checks are useful during development:

```text
npm --workspace @ttrpg-codex/frontend test
npm --workspace @ttrpg-codex/frontend run test:browser
go test ./internal/transport/httpapi
go test ./internal/addons/packagemanager
go test ./sdk/go/workerrpc
```

Use the narrowest meaningful regression for changed behavior. Do not remove
public SDK exports, dynamically registered contributions or fixture coverage
solely because an unused-code tool cannot see their consumers.

Browser test files start multiple Chromium processes. On a resource-constrained
machine, build the frontend once and run the same suite from `frontend/` with
`node --test --test-concurrency=4 test/browser/*.browser.mts`. Keep the same
add-on archive variables and complete the other full-gate checks separately.
This limits simultaneous processes without dropping cases.

### Check secret-scanning changes

**Secret scan** runs separately from the application tests. `npm run check`
does not run Gitleaks. Before publication, use the Gitleaks version pinned in
[the workflow](.github/workflows/secret-scan.yml) to scan the outgoing commits:

```text
gitleaks git --redact --log-opts="origin/main..HEAD" .
npm run test:secret-scan
```

Choose the actual base revision when checking a different commit range. The
scanner must be on `PATH`; the regression command also accepts an absolute
`GITLEAKS_BINARY` path. Its fixtures are generated in a temporary directory and
prove that the reviewed exception still detects other generic and
provider-specific credentials.

Keep [.gitleaks.toml](.gitleaks.toml) exceptions limited to the matching rule,
exact value and file. The current exception is a static browser focus selector;
it does not exclude the test directory, file contents or historical commits.
See [Gitleaks rule allowlists](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md#configuration).

### Inspect companion package builds

After building the companion ZIPs, run the same inspection command as the host
compatibility workflow:

```text
node scripts/inspect-addon-builds.mts ../addon-dm-tools ../addon-dnd-engine ../addon-dnd-character-sheets ../addon-dnd-2024-compendium
```

The helper reads each repository's `addon.json` and inspects its exact current
`dist/<id>-<version>.zip` through the host inspector. An older ZIP cannot stand
in for a missing current build, and inspection failure still fails the gate.
Use repository paths in workflows instead of maintaining versioned filenames
there; each add-on owns its release identity.

### Installed add-on checks

These tests start disposable hosts and install reviewed ZIPs. Build the companion
packages first, then supply their archive paths; without them the corresponding
tests report skipped. In PowerShell:

```powershell
$env:CODEX_COMPENDIUM_ZIP = (Resolve-Path ../addon-dnd-2024-compendium/dist/dnd-2024-compendium-3.1.0.zip).Path
$env:CODEX_ENGINE_ZIP = (Resolve-Path ../addon-dnd-engine/dist/dnd-engine-4.0.0.zip).Path
$env:CODEX_SHEETS_ZIP = (Resolve-Path ../addon-dnd-character-sheets/dist/dnd-sheets-4.0.0.zip).Path
$env:CODEX_DM_TOOLS_ZIP = (Resolve-Path ../addon-dm-tools/dist/dm-tools-3.0.0.zip).Path
npm run check
```

The installed rules suite covers provider discovery, source changes and provider
loss. Character tests exercise reviewed changes, drafts, history, transfer and
print. Planner tests exercise the packaged UI, imports and lifecycle. Browser
automation does not establish physical-device, human screen-reader or printer
acceptance.

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

Keep SQL behind stores and wire shapes behind clients/handlers. Add-ons consume
public schemas and SDKs; they do not import host `internal/` or frontend modules.
See [Architecture](docs/ARCHITECTURE.md) for the larger system.

Migrations are forward-only and checksum verified. Preserve unknown record
fields during ordinary edits. Released add-on, collection, extension and service
IDs are permanent. Offline campaign conversion is a separate tool; do not add
startup compatibility readers.

## Write useful documentation

Lead with the reader's task and resulting behavior. Put setup and common use in
the README, detailed behavior in the owning reference, design rationale in an
architecture decision, and future work only in [BACKLOG.md](docs/BACKLOG.md).
The [documentation index](docs/README.md) links those owners.

Use descriptive links, short paragraphs and copyable commands with their working
directory and prerequisites. Link to version declarations instead of repeating
tool versions throughout prose. Describe current behavior in the present tense;
label old audit findings and acceptance results with their date. Remove obsolete
plans once the current reference covers their useful decisions.

Update documentation with behavior or contract changes. A passing test count is
dated evidence, not a permanent claim about current coverage.

## Commit and hand off

Group changes into understandable commits and keep independent repositories
separate. Include the reason and relevant validation for nontrivial changes.
Regenerate intentionally tracked distribution assets through their owning build.

Report checks that passed, checks unavailable or skipped, and remaining manual
verification. Pushing, publishing, deployment and live-data operations are
separate decisions.
