# TTRPG Codex

TTRPG Codex is a self-hosted campaign archive and add-on host for small tabletop
groups. Version 2 is a clean Go and TypeScript replacement for the former
Node/JavaScript application.

The core stays deliberately generic: it stores campaign records, visibility,
media, revisions, backups, and live updates. Campaign-specific planning and D&D
features live in separately versioned Add-on API v3 packages.

## Current capabilities

- Browse and edit characters, locations, events, mysteries, factions, deities,
  artifacts, historical events, and companions.
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

## Technology

| Area | Choice |
|---|---|
| Host, storage, maintenance, native workers | Go 1.26 |
| Browser application and add-on UI | TypeScript 7, Lit 3, Vite 8 |
| Persistent metadata and campaign records | SQLite |
| Immutable media and package files | Hash-addressed files under `data/` |
| Deployment | One multi-stage Docker image; Node.js is build-only |

## Local development

Install Go 1.26 and Node.js 24 or newer, then run:

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

Open <http://localhost:3000>. Set `CODEX_SECURE_COOKIES=true` when the service
is behind HTTPS. See [self-hosting](docs/SELF_HOSTING.md) before operating real
campaign data.

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
