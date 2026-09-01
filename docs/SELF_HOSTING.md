# Self-hosting and cutover

This guide covers the Go/TypeScript v2 deployment. Live conversion and final
smoke testing are intentionally performed with the maintainer present.

## Requirements

- Docker Engine with Compose for production.
- A reverse proxy providing HTTPS for internet-facing instances.
- Go 1.26 and Node.js 24+ only when building or converting outside Docker.

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Purpose |
|---|---|
| `CODEX_DM_PASSWORD` | Required full-authority password; choose a long random value |
| `CODEX_PLAYER_PASSWORD` | Optional public-record editing password |
| `CODEX_SECURE_COOKIES` | Set `true` behind HTTPS |
| `CODEX_LOCALE` | Locale reported to add-on workers; default `en` |
| `CODEX_TIME_ZONE` | IANA time zone reported to workers |

The host has no default credential. Password values are deployment
configuration and are not imported from v1 backups.

## Build and start

```powershell
docker compose build
docker compose up -d
docker compose logs -f ttrpg-codex
```

The container listens on port 3000 and stores all durable state below
`/app/data`, mounted from `./data`. The production image contains the Go host,
health probe, package inspector, converter, maintenance utility, and compiled
frontend; it does not contain Node.js.

The default Compose network is the existing external `proxy` network. Adjust
that declaration for another reverse-proxy topology. Forward the original
scheme and client address normally, terminate TLS at the proxy, and keep
`CODEX_SECURE_COOKIES=true`.

## One-time v1 conversion

Keep the downloaded UI backups unchanged and make an additional copy before
conversion. Build fresh v3 ZIPs for DM Tools and Character Sheets and inspect
them first:

```powershell
go run ./cmd/codex-addon-inspect ../addon-dm-tools/dist/dm-tools-3.0.0.zip
go run ./cmd/codex-addon-inspect ../addon-dnd-character-sheets/dist/dnd-sheets-3.0.0.zip
```

Convert each website independently. The output directory must not exist:

```powershell
go run ./cmd/codex-convert-v1 `
  -in D:\backups\site-a-v1.zip `
  -out D:\converted\site-a `
  -report D:\converted\site-a-conversion-report.json `
  -addon-package ..\addon-dm-tools\dist\dm-tools-3.0.0.zip `
  -addon-package ..\addon-dnd-character-sheets\dist\dnd-sheets-3.0.0.zip
```

Read the JSON report printed to the terminal and saved at the requested new
`-report` path. Confirm the input hash, imported collection counts, media
counts, package hashes, and every deferred/unknown entry. Generated map tiles
are deliberately discarded. The source ZIP is never modified.

During supervised cutover, stop the old service, move its existing data aside,
place the verified converted directory at the new instance's `data/` mount,
start v2, and retain both the original UI ZIP and old data directory until the
campaign has been manually checked.

## Add-on installation

Build release archives in each add-on repository and validate them with
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

The DM endpoint `GET /api/backup` downloads the same verified archive contract
as the maintenance CLI. For offline operation:

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

## Supervised acceptance checklist

- Both converted instances report the expected core and add-on record counts.
- Representative hidden/public records are correct for anonymous, player, and
  DM views.
- Character-sheet extension data and DM Tools planning collections are present.
- Portraits, maps, logos, and other migrated media load through opaque URLs.
- All four v3 packages stage, review, activate, reload, and recover after a
  restart.
- Compendium browsing, rules-engine calls, sheet manual/automated paths, and DM
  Tools routes work together.
- Two browsers observe live edits and stale edits receive conflicts.
- A fresh v2 backup verifies and can be restored into a disposable directory.

Do not delete the old branch, old data directories, or downloaded UI backups
until both sites have passed this checklist and run successfully long enough to
make rollback unnecessary.
