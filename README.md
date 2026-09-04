# TTRPG Codex

TTRPG Codex is a self-hosted campaign archive and add-on host for small tabletop
groups. Version 2 is an active Go and TypeScript rewrite of the former
Node/JavaScript application.

> **Rewrite status:** the host, storage, conversion tools, and Add-on API v3
> foundations are implemented and the campaign product interface is being
> rebuilt in verified slices. The current archive, dashboard, search, Markdown,
> and record editors are substantial, but this branch is not yet a production
> replacement for the complete v1 UI. The deprecated v1 branch remains the
> supported choice until every gate in [`docs/BACKLOG.md`](docs/BACKLOG.md)
> passes.

The core stays deliberately generic: it stores campaign records, visibility,
media, revisions, backups, and live updates. Campaign-specific planning and D&D
features live in separately versioned Add-on API v3 packages.

## Implemented foundations

- DM and optional player credentials with role-aware projections and guarded
  writes.
- SQLite transactions, optimistic record revisions, reference-safe mutations,
  immutable media blobs, and Server-Sent Event refreshes.
- Verified `codex-backup.v2` archives and offline restore tooling.
- Immutable, checksummed add-on generations with explicit permission review,
  dependency ordering, service contracts, rollback, and supervised native Go
  workers.
- Integrated or iframe-isolated TypeScript browser add-ons with generation-
  scoped cleanup.
- One-time conversion of the two existing v1 UI backups. The running v2 host
  contains no legacy JSON compatibility mode.

The browser now provides the rebuilt campaign shell, public/private session
views, live refresh, core archive routes, grouped campaign search, and safe
add-on mounting surfaces. Its dashboard, saved attitude presentation, and
role-safe record editors cover common fields plus canonical references,
attitudes, ownership, hierarchy, event links, tags, fact lists, question
ledgers, faction ranks, location roles, and atomic relationship changes. Dirty
forms are protected across navigation and session changes, and the rebuilt wiki
renders safe Markdown with campaign links and article outlines. The first
DM-facing settings slice manages shared campaign enumerations with stable IDs,
usage-aware deletion, and enum-backed record fields. Bundled English and Czech
catalogs now drive the shell, dashboard, search, and personal settings, while a
per-browser language preference and DM-owned campaign appearance setting cover
the first localization and theme slices. Record/editor catalog coverage and a
full design-token audit remain intentionally open alongside maps, timeline,
graph views, the remaining settings, administrative UI, and first-party add-on
workflow acceptance in the suite backlog, reinforced by
`frontend/REWRITE_INCOMPLETE`.

## Technology

| Area | Choice |
|---|---|
| Host, storage, maintenance, native workers | Go 1.27.1 |
| Browser application and add-on UI | TypeScript 7, Lit 3, Vite 8 |
| Persistent metadata and campaign records | SQLite |
| Immutable media and package files | Hash-addressed files under `data/` |
| Deployment | One multi-stage Docker image; Node.js is build-only |

## Local development

Install Go 1.27.1 and Node.js 24 or newer, then run:

```powershell
npm ci
npm run check
$env:CODEX_DM_PASSWORD = 'choose-a-local-password'
npm start
```

The Go host listens on `127.0.0.1:3001` and serves `frontend/dist`. For a
frontend watch loop, run the host and `npm --workspace @ttrpg-codex/frontend
run dev` separately; Vite proxies `/api` to the Go process.

## Docker

```powershell
Copy-Item .env.example .env
# Edit .env and choose a long CODEX_DM_PASSWORD.
docker compose up --build -d
```

Open <http://localhost:3000> to confirm that the development build is running.
Set `CODEX_SECURE_COOKIES=true` when the service is behind HTTPS. Do not replace
a complete v1 campaign deployment with this branch yet. See
[self-hosting](docs/SELF_HOSTING.md) before operating real campaign data.

## Repository map

```text
cmd/                 Host, health, inspection, conversion, and maintenance CLIs
contracts/addons/v3/ Public Add-on API package and protocol schemas
frontend/            Authenticated Lit application and browser add-on runtime
internal/            Host domain, storage, package, worker, and HTTP boundaries
sdk/go/workerrpc/    Public native-worker RPC runtime
docs/rewrite/        Detailed implementation contracts created during the rewrite
examples/addons/     Public v3 authoring and protocol guides
```

The first-party add-ons are independent sibling repositories:

- `addon-dm-tools`
- `addon-dnd-2024-compendium`
- `addon-dnd-engine`
- `addon-dnd-character-sheets`

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Self-hosting and one-time conversion](docs/SELF_HOSTING.md)
- [Contributing](CONTRIBUTING.md)
- [Add-on authoring](examples/addons/AUTHORING.md)
- [Complete Add-on API v3 design](examples/addons/API_V3.md)
- [Current suite backlog](docs/BACKLOG.md)

## License

The software and documentation are licensed under the [MIT License](LICENSE).
