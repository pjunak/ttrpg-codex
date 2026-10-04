# Self-hosting

This guide covers a new installation, ordinary updates, add-on management and
recovery. Use Docker Compose with an HTTPS reverse proxy for an internet-facing
server. The supplied Compose file expects an existing external `proxy` network;
it does not publish a host port. Adapt that network to your reverse proxy before
starting the service.

For an existing campaign, keep a verified backup and stop the server for updates.
Database migrations are forward-only, so rolling back the image alone does not
roll back its data. [Upgrade and rollback](#upgrade-and-rollback) describes the
sequence.

## Requirements

- Docker Engine with Compose for production.
- A reverse proxy providing HTTPS for internet-facing instances.
- Go (version in `go.mod`) when building the native host or maintenance tool.
- Node.js 26+ for frontend builds and repository checks; `.nvmrc` selects Node 26.

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Purpose |
|---|---|
| `CODEX_DM_PASSWORD` | Initial DM password; required only before passwords have been saved |
| `CODEX_PLAYER_PASSWORD` | Optional initial public-record editing password |
| `CODEX_SECURE_COOKIES` | Set `true` behind HTTPS |
| `CODEX_LOCALE` | Locale reported to add-on workers; default `en` |
| `CODEX_TIME_ZONE` | IANA time zone reported to workers |
| `CODEX_ADDON_AUTO_CLEANUP` | `true` by default; retain only the selected add-on build after healthy startup and activation. Superseded packages and their add-on recovery contexts are removed; campaign recovery and current saves remain. Set `false` for manual retention. See [package retention](reference/PACKAGE_LIFECYCLE.md#automatic-package-file-retention). |
| `CODEX_ADDON_KEEP_RECOVERY_PACKAGES` | `false` by default. Set `true` to retain historical add-on recovery contexts and package metadata, evicting only recoverable files. Has no effect while automatic cleanup is disabled. |

The host has no default credential. Password bootstrap values initialize saved
password hashes once. Later starts use the saved credentials, so editing `.env`
does not undo a password change or re-enable a disabled player password.
Bootstrap values can be removed after first start.

Map tiles are generated on first use in `data/cache/map-tiles-v1`; the first
open can take longer while later reads reuse the cache. Originals remain in
the verified blob store. This cache is excluded from backups and may be removed
while the host is stopped; it regenerates automatically. Unsupported or oversized
images use the original-image viewer. See [media limits](reference/MEDIA.md#map-tile-contract-and-cache).

## Password changes and access recovery

Open **Settings → Server access** while signed in as DM to change either shared
password. Enter the current DM password and confirm the replacement. Player
sign-in can also be disabled. The form explains which other sessions will be
signed out; the reviewing DM stays signed in. A failed or uncertain save retains
the form for review and explicit retry after refreshing status.

For forgotten passwords, stop the host, set `CODEX_DM_PASSWORD` in `.env` to
the replacement and optionally set `CODEX_PLAYER_PASSWORD` (empty disables it),
then run the offline reset against the same data directory:

```powershell
docker compose stop ttrpg-codex
docker compose run --rm --no-deps ttrpg-codex /app/codex -data-dir /app/data -reset-passwords
docker compose up -d ttrpg-codex
```

For a native checkout, use
`go run ./cmd/codex -data-dir data/rewrite -reset-passwords`
with the replacement values set in the current environment.
The command acquires the host's exclusive lock, changes only credential hashes,
and exits. It refuses to reset a directory in use by the running host.

Native backups include password hashes: restoring a newer backup restores the
passwords from that backup. Restore an older archive without saved credentials
using the initial environment values, or use the offline reset. Neither
password changes nor resets alter campaign records, media or add-on data.

## Build and start

```powershell
docker compose build
docker compose up -d
docker compose logs -f ttrpg-codex
```

The container listens on port 3000 and stores all durable state below
`/app/data`, mounted from `./data`. The production image contains the Go host,
health probe, package inspector, maintenance utility, and compiled
frontend; it does not contain Node.js. The runtime user is deliberately pinned
to UID/GID 1000 so existing production bind mounts keep their ownership.

The default Compose network is the existing external `proxy` network. Adjust
that declaration for another reverse-proxy topology. Forward the original
scheme and client address normally, terminate TLS at the proxy, and keep
`CODEX_SECURE_COOKIES=true`.

### Data directory

```text
data/
├── codex.db, codex.db-wal, codex.db-shm   SQLite: records, passwords, recovery points, add-on data
├── blobs/sha256/                          uploaded images and maps, named by content hash
├── addons/<id>/generations/<hash>/        installed add-on packages
├── credentials/github.db                  saved GitHub tokens (never in backups)
└── cache/map-tiles-v1/                    generated map tiles (safe to delete while stopped)
```

Never edit these files by hand or copy the database while the host runs; use
the [backup tools](#backups). `.staging` folders hold uploads in progress.

## Add-on installation

Open **Settings → Add-ons** while signed in as DM. The toolbar has two actions:
**Check for updates** refreshes the installed list and checks linked repositories;
**Add add-on** opens the installation wizard.

In the wizard, choose **GitHub** or **ZIP file**:

- **GitHub** accepts a repository URL or `owner/repository`. The default is the
  **Latest published package (recommended)**. First-party add-ons publish one durable release
  per tested main commit, even when the package version stays the same. Public
  releases need no token. **Test build (advanced)** downloads a successful GitHub Actions build for
  developers, other branches or publishers without releases; its default artifact
  is `reviewed-package`. These temporary downloads expire according to the
  repository's Actions retention setting. Use the recommended option for normal
  installation and updates; the wizard explains the selected source inline.
- **ZIP file** uploads a prebuilt add-on package from your computer. The limit
  is 128 MiB. GitHub's generated source-code archives are not installable packages.

For a private repository, tick **Private repository** to show the token field
and setup instructions. Create a fine-grained token for that repository with
**Contents: read** for releases and **Actions: read** for workflow artifacts.
GitHub requires a token for Actions downloads even from public repositories,
so choosing a build also exposes the access field. Existing saved access is
reused unless you enter a replacement. The wizard saves new tokens for the
specific repository, including future update checks.

**Find package** checks availability without downloading or activating code.
Select **Download and review**, or **Inspect ZIP** for a local file, to continue
to the permission and compatibility review in the same popup. Only **Approve
and activate** changes the active version when saved data is compatible.
For an installed add-on, click **Update** beside the available build. The review
shows compatibility, required dependencies/services, requested privileges and
affected running add-ons. Required and previously approved privileges are
selected for review; new optional privileges remain unchecked.

If saved data needs attention, **Continue update** opens a floating confirmation:

- **Download add-on data backup** optionally saves that add-on's exact current
  values and schema information as private JSON before either action.
- **Heal and update** preserves values when all of them already satisfy the new
  schema. It is unavailable if healing would require guessing or changing values.
- **Remove data and update** clears only this add-on's current saves and starts
  the selected package with an empty namespace. Core campaign records, other
  add-ons, retained history/media and existing backups remain intact.
- **Exit upgrade** keeps the current package and saves.

The server handles stopping/restarting dependencies and activation as one
confirmed operation. A failed activation restores the previous package and
saved data. **Check update result** resolves a lost response without repeating
data removal. A changed package review opens a fresh compatibility/privilege
review; a changed save requires a fresh data confirmation. No manual disable,
schema application or second activation step is needed. The downloadable JSON
is scoped recovery evidence, not a full backup ZIP or a general import file;
[snapshot details](reference/ADDON_DATA.md#recovery-and-retention) explain its use.

Update results appear directly on each installed add-on. Open **Update source**
on that add-on to connect or edit its repository, replace repository access, or
unlink it. Unlinking keeps installed versions and campaign data. Uploaded ZIPs
can also be linked to GitHub this way. Checking for updates never automatically
installs a package. A new commit can offer an update with the same package
version. Published ZIPs stay available independently of Actions retention;
Actions builds must finish successfully and their artifacts must not have expired.
Existing linked sources keep their selected channel until you edit them.

The collapsed **GitHub access tokens** section provides default-token management
and lets you replace or remove saved repository tokens. Repository tokens take
precedence over the stored default, followed by `CODEX_GITHUB_TOKEN` and
`GITHUB_TOKEN`. Token values stay on the server in `<data-dir>/credentials/github.db`
and are excluded from campaign backups and recovery points. Protect that
folder like other server credentials and configure access again after restoring
to a new server. The UI shows which access is configured without returning tokens.
If a token-save response is lost, the wizard refreshes configured state and
clears the input; retrying does not silently repeat the token write.

The popup keeps keyboard focus inside it and returns focus on close. Escape or
Cancel closes it when no request is running; requests finish before it can close.
On small screens the content scrolls while the title and Cancel button stay visible.
The interaction follows the [WAI modal-dialog guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
Token instructions follow [GitHub's personal access token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
[release asset API](https://docs.github.com/en/rest/releases/assets), and
[Actions artifact API](https://docs.github.com/en/rest/actions/artifacts).

The runtime image must include the operating system's trusted CA certificates for
outbound HTTPS. The official image installs Debian's `ca-certificates` and CI checks
GitHub HTTPS from that image before publishing it. A `GITHUB_TLS` failure means the
server cannot verify the connection; replacing a repository token cannot fix it.
Do not disable certificate verification. Ordinary access/network failures retain
separate errors, and signed download URLs or token values are never returned.

The host only installs prebuilt Add-on API v3 packages. For manual uploads,
build release archives in each add-on repository and validate them with
`codex-addon-inspect`. The protected API then uses four distinct steps:

| Request | Result |
|---|---|
| `POST /api/admin/addons/generations` with `application/zip` | Inspect and stage an inert immutable generation |
| `POST /api/admin/addons/{id}/activation-reviews` | Produce a durable permission/dependency diff |
| `POST /api/admin/addon-activation-reviews/{review}/approval` | Approve the exact complete grant set |
| `POST /api/admin/addon-activation-reviews/{review}/activation` | Start, health-check, and switch the reviewed generation |

All four require a real DM session; mutations require its `X-Codex-CSRF`
token. A staged ZIP cannot execute. Install providers before their consumers:
Compendium, Engine, Character Sheets, then DM Tools. The host still resolves and
enforces the actual dependency graph.

## Backups

Settings → Backup & recovery provides manual points, automatic edit groups,
restore/delete review, revert-last-N, and full ZIP download. Points cover
campaign records, add-on documents and uploaded media; they preserve current
passwords and installed add-ons. Each restore keeps a safety copy. Points live
in the same database and retain only the newest 50, so keep an independent ZIP
for recovery from disk loss. Choose Campaign or one add-on in the recovery panel.
Campaign restore works without matching add-ons and leaves their current saves
untouched. Add-on restore requires its own matching build, schema and linked
record identities. Deleting its recovery context leaves the campaign snapshot
available. Use full offline restore when recovering packages or the entire host.
See the [recovery contract](reference/BACKUP_RESTORE.md#campaign-recovery-points).

### Verify and restore a full backup

The guide linked from Settings → Backup & recovery covers the whole installation.
A full restore includes saved passwords and installed add-on packages. GitHub
access tokens are excluded; configure them again on a new server. Use the
maintenance binary from the same image or source revision as the host, and the
actual data directory used by that installation.

The DM endpoint `GET /api/backup` downloads the same verified archive contract
as the maintenance CLI. Download a full ZIP from Settings → Backup & recovery,
then verify it independently.

#### Verify with the running host image

The image includes `/app/codex-maintenance`. Run these commands on the Docker
host that owns the installation, with the downloaded ZIP in its backup
directory. This Linux example uses the supplied Compose service name;
adjust the service name and archive path for your installation:

```bash
task_container_id="$(docker compose ps --no-trunc -q ttrpg-codex)" || exit 1
if [[ ! "$task_container_id" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'Select exactly one running Codex container.' >&2
  exit 1
fi
task_image_id="$(docker inspect --type container --format '{{.Image}}' "$task_container_id")" || exit 1
if [[ ! "$task_image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'Could not resolve the running host image.' >&2
  exit 1
fi
task_backup_directory=/srv/codex-backups
docker run --rm --pull never --network none \
  --user "$(id -u):$(id -g)" \
  --entrypoint /app/codex-maintenance \
  --mount "type=bind,source=$task_backup_directory,target=/backups,readonly" \
  "$task_image_id" verify -in /backups/codex-2026-10-03.zip || exit 1
sha256sum "$task_backup_directory/codex-2026-10-03.zip"
```

The container's immutable image ID selects the matching tool even if an image
tag has since changed. The verifier mounts only the backup directory, read-only,
and extracts into its disposable container as the current user. Leave enough
temporary disk space for the expanded archive. A successful command prints
`Verified codex-backup.v2 (...)` and exits with status zero. Retain the archive,
its SHA-256, the selected image ID and that result together.
Docker's [Compose ps](https://docs.docker.com/reference/cli/docker/compose/ps/),
[inspect](https://docs.docker.com/reference/cli/docker/inspect/),
[run](https://docs.docker.com/reference/cli/docker/container/run/) and
[bind-mount](https://docs.docker.com/engine/storage/bind-mounts/) references
describe these options. A remote Docker context resolves the bind source on the
daemon's machine, so the backup must be present there.

#### Native command-line backup and restore

For a native installation, use a checkout or compiled utility from the same
revision as that host:

```powershell
go run ./cmd/codex-maintenance backup `
  -data-dir .\data -out D:\backups\codex-2026-09-01.zip

go run ./cmd/codex-maintenance verify `
  -in D:\backups\codex-2026-09-01.zip
```

Keep backups outside the mounted data directory and copy them off the server.
Verification is read-only and should be part of the backup routine.

Restore only while the host is stopped:

```powershell
go run ./cmd/codex-maintenance restore `
  -data-dir .\data -in D:\backups\codex-2026-09-01.zip
```

Restore verifies the archive and an isolated database before atomically
publishing it. Never unpack or merge backup contents by hand. Keep the verified
archive and an independent copy of the current data before replacement. After
restoring, start the host and check login, campaign records, media and active
add-ons before returning it to use. See the [archive and publication contract](reference/BACKUP_RESTORE.md)
for verification limits and interrupted-restore recovery.

## Reviewed offline storage maintenance

Use the maintenance binary built from the same commit as the host. These
commands require a database already migrated by that host, and refuse while
the host or another maintenance operation holds the data-directory lock.
They are separate from uninstall and saved-package cleanup in Settings.

1. Stop the host and run a preview. Choose exactly one operation:

   ```console
   codex-maintenance delete-addon-data -data-dir ./data/rewrite -addon retired-addon
   codex-maintenance collect-blobs -data-dir ./data/rewrite
   codex-maintenance prune-logs -data-dir ./data/rewrite -keep-events 10000 -keep-lifecycle 10000 -keep-audit 10000
   ```

2. Read the counts, byte estimates, recovery implications and `reviewSHA256`.
   Namespace removal includes that add-on's retained field history and its
   contents inside local recovery points. It preserves core records, unrelated
   namespaces and package archives. Existing external backups remain unchanged.
   Disable or uninstall the selected add-on before stopping the host.
3. Repeat the **same command and options** with
   `-apply <reviewSHA256> -backup <new-backup.zip>`. The CLI creates and fully
   verifies this new backup before applying the exact reviewed operation. A
   changed preview or failed backup leaves data untouched. Pruned package files
   are materialized through their normal verified sources for the backup;
   unavailable package bytes prevent cleanup.
4. If blob unlinking was interrupted after its intent committed, run
   `codex-maintenance collect-blobs -data-dir ./data/rewrite -resume`.
   This completes only previously reviewed removal intent. It never chooses
   additional objects or requires deleting recovery points.
5. Restart and check representative campaign records, media and add-ons. Keep
   the verified backup independently until the operator accepts the result.

Log retention is explicit, not automatic. Review it again as storage grows.
SSE retention is per audience; lifecycle rows and each commit audit have
separate newest-row limits. Preview reports encoded row payload sizes rather
than SQLite page allocation, and cleanup need not shrink the database file.
Authoring history, idempotency receipts, recovery points and package archives
are never expired by log retention. Clients reconnecting behind a pruned event
window receive a reset and reload authoritative state.

## Upgrade and rollback

1. Download a current `codex-backup.v2` archive and verify it.
2. Build the new image without replacing the running container.
3. Stop, replace, and start the service.
4. Check `/api/health`, login, campaign counts, representative DM/player
   records, media, live updates, and every active add-on.
5. If validation fails, stop v2 and restore the verified pre-upgrade archive or
   previous data directory before returning traffic.

Database migrations are forward-only. Container rollback alone is not a data
rollback.

### Migration checksum drift

Every host and maintenance binary embeds the SQL migration files and compares
their exact SHA-256 checksums with the database history. Git now pins these files
to LF on every platform. Before that rule, Windows Git checkouts with
`core.autocrlf=true` could produce binaries with CRLF checksums even though the
SQL in Git and Linux builds used LF. This fix does not rewrite existing history.

If a pre-fix database reports `migration checksum drift`:

- For disposable development data, identify the data directory and start the
  canonical build with a new empty directory. Keep the old directory until its
  contents have been confirmed disposable; do not reset a campaign to test this.
- For retained data, stop writers and preserve the original data and its matching
  binary/image. Create and verify an independent backup with that matching build.
  Compare the reported migration version against that build's source before
  concluding the difference is only line endings; real SQL drift also fails.
- Use a verified backup created with canonical migrations if one is available.
  Otherwise retain the matching build pending a separately reviewed offline
  conversion. There is no automatic history normalization or general conversion
  for this case. Ordinary backup/restore preserves the stored checksums and does
  not itself fix this mismatch.

Never update `schema_migrations` hashes manually or bypass validation. A
canonical build rejects the mismatch before applying any pending migration.

## After an update

Check `/api/health`, sign in, open the dashboard and a few records as DM and as
a player, look at a portrait and a map, and open each active add-on. If
something is wrong, restore the backup taken before the update (see
[upgrade and rollback](#upgrade-and-rollback)).

## When new features are missing

First sign in as DM and open **Settings → Add-ons**. Package installation and
GitHub credentials are administrative controls. If the current host UI and API
are not installed, refreshing the page or updating an add-on cannot add them.

The main-branch workflow now links publication and deployment, but each stage
still has its own result:

- A skipped **Build image** job publishes nothing. If that job failed, inspect
  the publication and metadata steps before treating its image as a release.
- A manual check-only run leaves the websites unchanged. A superseded push also
  skips publication and deployment, with a notice in its summary.
- A failed **Check deployment configuration** job blocks the image build. Check
  the repository variables, token permissions and infrastructure workflow state.
- A completed deployment must identify the selected instance and pass its
  infrastructure health check. Verify the served frontend and the intended
  feature afterward; HTTP 200 and the generic `2.0.0-dev` health version do not
  identify the source commit.

The host supplies add-on management, GitHub access, sourcebook/provider controls
and contributed-settings containers. Installed add-on generations supply their
own planner, compendium and character-sheet screens. Updating the host does not
activate new add-on ZIPs, and updating an add-on does not deploy a newer host.

Use the automation below for a host update, then the
[reviewed package workflow](#add-on-installation) for any intended add-on updates.

## Publishing and deploying updates

The following automation belongs to the maintained Asurai/Tiamat deployment.
Other installations can build the Docker image and follow the ordinary update
procedure below.

A push to `main` runs the host checks, checks that the packaged runtime starts,
publishes an immutable image, and deploys it to **both Asurai and Tiamat**.
Pushes that change only documentation do not build or deploy. The workflow stays active until both infrastructure runs
finish. A failed deployment makes the application run fail; accepting the
request alone is insufficient. Each deployment summary records the source
commit, image digest and infrastructure run link.

The infrastructure repository is `pjunak/infra`; `pjunak/junak.eu` now owns the
separate public/owner portal application. Host tooling calls infra's main-only
`workflow_dispatch` with `service`, full source `sha`, immutable `image_ref` and
unique `request_id`. It verifies the returned run ID and waits for that run.
Infra's `registry/deployments.json` approves both campaign targets for the
`ttrpg-codex` image; adding a new campaign requires matching registration there.
The [infra deployment contract](https://github.com/pjunak/infra/blob/main/docs/application-deployments.md)
owns server rollout, shared locking and publication-retry integration.

Automatic and manual releases share a queue so a new push cannot interrupt an
active deployment. Before publishing an automatic release, the workflow checks
that its commit is still the current `main`. A superseded run continues its
checks but skips publication and deployment, with an explanatory summary.
GitHub orders this queue by arrival, so the revision check also protects against
rerunning an old push. See [GitHub's concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

### Releasing add-ons

Each add-on repository publishes its own releases: a successful `main` build
uploads the inspected ZIP to a GitHub release tagged `build-<commit>`, marked
latest. Publishing installs nothing; each site's DM updates through
**Settings → Add-ons**. Add-ons depend on the host's Go SDK by module version, so
a host change that add-ons need must be pushed to the host first; the add-on then
updates its requirement (see [contributing](../CONTRIBUTING.md#ci-and-releases)).
Keep public contracts compatible so the host and the installed add-ons keep
working whichever is updated first.

The nightly **Installed add-on smoke test** installs the latest published add-on
releases into the current host and exercises their main workflows. A failure
there does not block deployment; read its log and fix whichever side broke.

### Configure deployment once

In the **ttrpg-codex** repository, open **Settings → Secrets and variables →
Actions** and configure:

| Setting | Kind | Value |
| --- | --- | --- |
| `INFRA_REPO` | Variable | `pjunak/infra` |
| `INFRA_SERVICE` | Variable | `asurai tiamat` |
| `INFRA_DISPATCH_TOKEN` | Secret | A fine-grained GitHub token scoped to the infrastructure repository |

When creating the token, select the infrastructure repository's owner and
**Only select repositories → infra**. Give it **Contents: read-only** and
**Actions: read and write** (to start the deployment workflow and follow its
returned run ID). Set an expiry that fits your maintenance
schedule and replace the stored secret before it expires. If an organization
requires token approval, obtain that approval too. Use the GitHub secret form;
never place the token in source, logs or chat.

The early **Check deployment configuration** job verifies target names, token
access and that the infrastructure **Deploy** workflow is enabled. This read
check cannot prove Actions-write permission without sending a real dispatch;
a dispatch permission failure still fails the deployment. If the check returns
403 or 404, verify the token's repository selection, permissions, expiry and
owner approval, then update `INFRA_DISPATCH_TOKEN`. Merely rerunning with the
same inaccessible token will not repair it. Install and validate the matching
infrastructure workflow before enabling this application workflow.

See GitHub's [fine-grained token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [workflow dispatch permissions](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

### Manual checks and recovery

A manual **Build and dispatch** run defaults to checks only. Selecting
`publish` publishes without deploying; selecting Asurai, Tiamat or `configured`
publishes and deploys that build. Publication and deployment require `main`.

Each published build stores a `release-metadata` artifact for 90 days. To reuse
it, run **Deploy published release** on `main`, enter the **Build and dispatch**
run ID, and select the campaign. This verifies the source, image and build
provenance without rerunning the build. A run whose deployment failed remains
eligible if its **Build image** job succeeded; a failed image build is rejected.
This also lets you retry only the campaign that failed after checking its
infrastructure run. Explicitly selecting an older release is a rollback and
requires the usual compatibility and backup review.

For a timeout or interrupted connection, inspect the linked infrastructure run
before retrying: the deployment may still be running or may already have
succeeded. Requests with an uncertain outcome are never automatically sent
again. A failed health check leaves diagnostic state available; it does not
automatically roll back campaign data.

For a failed build, open the job log. Failed host browser tests upload their
Playwright traces as the `host-browser-traces` artifact for 14 days.

Successful add-on main builds publish inspected ZIPs to permanent commit
releases, preserving repository visibility. **Latest published package** uses
those releases; the additional Actions artifacts expire after 14 days.
Publication does not install anything. Installation still uses the host's
upload/download, inspect, review, approve and activate lifecycle.

The server handles saved-package cleanup automatically. By default it retains
the selected build after successful updates and healthy startup, and removes
obsolete packages with only their add-on recovery context. Campaign recovery,
current saves and existing backup ZIPs remain intact. Cancelled candidates are
discarded; abandoned reviews expire after 30 minutes. The server retries pending
file cleanup every minute. Settings shows storage status without cleanup buttons.
A disabled add-on retains its selected build. An explicit operator retention
override can preserve older builds; see [retention policy](reference/PACKAGE_LIFECYCLE.md#automatic-package-file-retention).
No directory or SQLite editing is needed. Permanent namespace/history deletion
and unused-media cleanup remain separate offline maintenance operations.
