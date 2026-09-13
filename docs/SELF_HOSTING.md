# Self-hosting

This guide covers a new installation, ordinary updates, add-on management and
recovery. Use Docker Compose with an HTTPS reverse proxy for an internet-facing
server. The supplied Compose file expects an existing external `proxy` network;
it does not publish a host port. Adapt that network to your reverse proxy before
starting the service.

For an existing campaign, keep a verified backup and stop the server for updates.
Database migrations are forward-only, so rolling back the image alone does not
roll back its data. [Upgrade and rollback](#upgrade-and-rollback) describes the
sequence. Old v1 campaigns and schema-3 sheets have separate offline procedures;
a new installation needs neither.

## Requirements

- Docker Engine with Compose for production.
- A reverse proxy providing HTTPS for internet-facing instances.
- Go 1.27.1 and Node.js 24+ only when building or converting outside Docker.

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Purpose |
|---|---|
| `CODEX_DM_PASSWORD` | Initial DM password; required only before passwords have been saved |
| `CODEX_PLAYER_PASSWORD` | Optional initial public-record editing password |
| `CODEX_SECURE_COOKIES` | Set `true` behind HTTPS |
| `CODEX_LOCALE` | Locale reported to add-on workers; default `en` |
| `CODEX_TIME_ZONE` | IANA time zone reported to workers |

The host has no default credential. These values initialize saved password
hashes once and are not imported from v1 backups. Later starts use the saved
credentials, so editing `.env` does not undo a password change or re-enable a
disabled player password. Bootstrap values can be removed after first start.

Map tiles are generated on first use in `data/cache/map-tiles-v1`; the first
open can take longer while later reads reuse the cache. Originals remain in
the verified blob store. This cache is excluded from backups and may be removed
while the host is stopped; it regenerates automatically. Unsupported or oversized
images use the original-image viewer. See [media limits](rewrite/MEDIA.md#map-tile-contract-and-cache).

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
health probe, package inspector, converter, maintenance utility, and compiled
frontend; it does not contain Node.js. The runtime user is deliberately pinned
to UID/GID 1000 so existing production bind mounts retain their ownership
across the Node-to-Go cutover.

The default Compose network is the existing external `proxy` network. Adjust
that declaration for another reverse-proxy topology. Forward the original
scheme and client address normally, terminate TLS at the proxy, and keep
`CODEX_SECURE_COOKIES=true`.

Existing schema-3 sheet installations use the separate, backed-up
[offline retirement procedure](rewrite/CHARACTER_SHEET_CUTOVER.md) before
activating Sheets 4. It never removes new retained character history.

## One-time v1 conversion

Reuse the downloaded UI backups already taken, keeping the input archives and
old data unchanged. A repeated backup cycle is not a release requirement; if
either site has changed since its backup, preserve those later changes before
cutover. Build and inspect the current DM Tools ZIP first. The converter counts
and omits retired sheet values; it does not accept a sheet conversion package:

```powershell
go run ./cmd/codex-addon-inspect ../addon-dm-tools/dist/dm-tools-3.0.0.zip
```

Convert each website independently. The output directory must not exist:

```powershell
go run ./cmd/codex-convert-v1 `
  -in D:\backups\site-a-v1.zip `
  -out D:\converted\site-a `
  -report D:\converted\site-a-conversion-report.json `
  -addon-package ..\addon-dm-tools\dist\dm-tools-3.0.0.zip
```

Read the JSON report printed to the terminal and saved at the requested new
`-report` path. Confirm the input hash, imported collection counts, media
counts, retired-core adjustments, omitted old-sheet counts, package hashes, and every deferred/unknown
entry. Generated map tiles are deliberately discarded. The source ZIP is never
modified.

One reviewed conversion per site is sufficient. It may happen during the
planned outage: stop the old site, retain its data directory, convert its final
backup into a fresh directory, review the report, and use that new directory
for v2. Keep the original UI ZIP and old directory available for rollback.
Do not repeat a separate staging conversion merely to satisfy a process gate.

## Add-on installation

Open **Settings → Add-ons** while signed in as DM. The toolbar has two actions:
**Check for updates** refreshes the installed list and checks linked repositories;
**Add add-on** opens the installation wizard.

In the wizard, choose **GitHub** or **ZIP file**:

- **GitHub** accepts a repository URL or `owner/repository`. Choose a successful
  **GitHub Actions build** or the **Latest stable release**. Build options are
  tucked away unless you need a specific branch or artifact name. The defaults
  are the repository's default branch and `reviewed-package`.
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
and activate** changes the active version. Cancelling a review leaves the
inspected package available under **Installed versions** for later review.

Update results appear directly on each installed add-on. Open **Update source**
on that add-on to connect or edit its repository, replace repository access, or
unlink it. Unlinking keeps installed versions and campaign data. Uploaded ZIPs
can also be linked to GitHub this way. Checking for updates never automatically
installs a package. GitHub builds must finish successfully before they can be
installed, and build artifacts must still be within their retention period.

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
token. A staged ZIP cannot execute. Keep provider order intuitive during the
first cutover: Compendium, Engine, Character Sheets, then DM Tools. The host
still resolves and enforces the actual dependency graph.

## Backups

Settings → Backup & recovery provides manual points, automatic edit groups,
restore/delete review, revert-last-N, and full ZIP download. Points cover
campaign records, add-on documents and uploaded media; they preserve current
passwords and installed add-ons. Each restore keeps a safety copy. Points live
in the same database and retain only the newest 50, so keep an independent ZIP
for recovery from disk loss. Restore a point with the same active add-on versions;
use full offline restore when recovering packages or the entire host.
See the [recovery contract](rewrite/BACKUP_RESTORE.md#campaign-recovery-points).

The DM endpoint `GET /api/backup` downloads the same verified archive contract
as the maintenance CLI. For command-line operation:

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
publishing it. Never unpack or merge backup contents by hand.

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

## First-start smoke check

For each site, check login, anonymous/player/DM visibility, the dashboard and
a representative record edit, a portrait and map, and the installed add-ons
actually used by that campaign. Confirm basic visual similarity on desktop and
one phone. If something fails, fix it while the site is down or switch back to
the old application and its unchanged data. A full automated test matrix is not
required before returning the personal site to use.

The broader checks below remain useful follow-ups. They are not all release
prerequisites under the owner's accepted downtime and rollback policy:

- Both converted instances report the expected core and add-on record counts.
- Representative hidden/public records are correct for anonymous, player, and
  DM views.
- Core character profiles and DM Tools planning collections are present; old
  sheet omissions match the conversion report. New characters use schema 4.
- Portraits, maps, logos, and other migrated media load through opaque URLs.
- All four v3 packages stage, review, activate, reload, and recover after a
  restart.
- Compendium browsing, rules-engine v4 calls, sheet Build/Play/History and DM
  Tools routes work together.
- Two browsers observe live edits and stale edits receive conflicts.
- A fresh v2 backup verifies and can be restored into a disposable directory.

Do not delete the old branch, old data directories, or downloaded UI backups
until the owner is comfortable that rollback is unnecessary.

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
Character-sheet namespace retirement remains the separate
[explicit offline operation](rewrite/CHARACTER_SHEET_CUTOVER.md).

Use the automation below for a host update, then the
[reviewed package workflow](#add-on-installation) for any intended add-on updates.

## Publishing and deploying updates

The following automation belongs to the maintained Asurai/Tiamat deployment.
Other installations can build the Docker image and follow the ordinary update
procedure below.

A push to `main` runs the host and add-on compatibility gates, checks that the
packaged runtime starts, publishes an immutable image, and deploys it to **both
Asurai and Tiamat**. The workflow stays active until both infrastructure runs
finish. A failed deployment makes the application run fail; accepting the
request alone is insufficient. Each deployment summary records the source
commit, image digest and infrastructure run link.

Automatic and manual releases share a queue so a new push cannot interrupt an
active deployment. Before publishing an automatic release, the workflow checks
that its commit is still the current `main`. A superseded run continues its
checks but skips publication and deployment, with an explanatory summary.
GitHub orders this queue by arrival, so the revision check also protects against
rerunning an old push. See [GitHub's concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

### Configure deployment once

In the **ttrpg-codex** repository, open **Settings → Secrets and variables →
Actions** and configure:

| Setting | Kind | Value |
| --- | --- | --- |
| `INFRA_REPO` | Variable | `pjunak/junak.eu` |
| `INFRA_SERVICE` | Variable | `asurai tiamat` |
| `INFRA_DISPATCH_TOKEN` | Secret | A fine-grained GitHub token scoped to the infrastructure repository |

When creating the token, select the infrastructure repository's owner and
**Only select repositories → junak.eu**. Give it **Contents: read and write**
(to send a repository dispatch) and **Actions: read-only** (to check the
workflow and follow its result). Set an expiry that fits your maintenance
schedule and replace the stored secret before it expires. If an organization
requires token approval, obtain that approval too. Use the GitHub secret form;
never place the token in source, logs or chat.

The early **Check deployment configuration** job verifies target names, token
access and that the infrastructure **Deploy** workflow is enabled. This read
check cannot prove Contents-write permission without sending a real dispatch;
a dispatch permission failure still fails the deployment. If the check returns
403 or 404, verify the token's repository selection, permissions, expiry and
owner approval, then update `INFRA_DISPATCH_TOKEN`. Merely rerunning with the
same inaccessible token will not repair it. Install and validate the matching
infrastructure workflow before enabling this application workflow.

See GitHub's [fine-grained token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [repository dispatch permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).

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

Add-on repositories publish reviewed ZIPs as private/public CI artifacts
according to repository visibility, retained for 14 days. Installing those ZIPs
still uses the host's upload, inspect, review, approve and activate lifecycle.
