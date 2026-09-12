# TTRPG Codex

TTRPG Codex is a self-hosted campaign archive for tabletop groups. Keep
characters, places, factions, events, maps and campaign notes together, with
separate DM and player views.

The Go host manages records, access, media, revisions and backups. Optional
add-ons provide story planning, searchable rules and character sheets. Each
add-on is installed as a built package after permission and compatibility review.

## What you can do

- Write linked Markdown articles, recover local drafts, and browse collections
  with search, filters, sorting and grouping.
- Explore campaign maps, timelines and relationships. Use quick search
  (Ctrl/Command+K) without closing an editor.
- Give players access to public records while keeping DM material private.
- Install and update add-ons from GitHub builds or releases, including private
  repositories with server-side credentials.
- Review changes and restore campaign recovery points or a verified backup.
- Use the interface in English or Czech without translating authored content.

Local drafts protect work in the same browser. Save commits it to the campaign;
downloaded backups protect it outside that browser and server.

## Run locally

Use the Go version in [go.mod](go.mod) and Node.js from [.nvmrc](.nvmrc).
Node 24 or newer is supported; development and CI use Node 26.

From the repository root:

```text
npm ci
npm --workspace @ttrpg-codex/frontend run build
```

Set `CODEX_DM_PASSWORD` in your shell, then start a separate development data
directory. For example, in PowerShell:

```powershell
$env:CODEX_DM_PASSWORD = 'choose-a-local-password'
go run ./cmd/codex -listen 127.0.0.1:3001 -data-dir data/development
```

Open [localhost:3001](http://127.0.0.1:3001). Passwords are saved on first start;
later changes go through **Settings → Server access**. See
[contributing](CONTRIBUTING.md) for the watch loop and complete test commands.

For a server, follow [self-hosting](docs/SELF_HOSTING.md). The supplied Compose
file expects an external reverse-proxy network and does not publish a localhost
port. The production image serves prebuilt assets; Node is build-only.

## Optional add-ons

These are independent repositories. Install only the capabilities your group uses.

| Package | Purpose |
| --- | --- |
| [DM Tools](../addon-dm-tools/README.md) | Private story planning and reviewed planning imports |
| [D&D 2024 Compendium](../addon-dnd-2024-compendium/README.md) | Searchable books and the complete D&D 2024 rules profile |
| [D&D Rules Engine](../addon-dnd-engine/README.md) | Rules calculations for compatible consumers |
| [D&D Character Sheets](../addon-dnd-character-sheets/README.md) | Reversible builds, bounded play, DM grants and retained character history |

An instance uses one ruleset. Additional source packages must declare support
for it; their books share the host's source-selection policy. Saved character
revisions remain readable without an installed rules engine.

## Find your next step

- [Documentation index](docs/README.md): guides and detailed references by task.
- [Self-hosting](docs/SELF_HOSTING.md): configuration, updates, add-ons and recovery.
- [Contributing](CONTRIBUTING.md): setup, code ownership and validation.
- [Architecture](docs/ARCHITECTURE.md): how the application fits together.
- [Add-on authoring](examples/addons/AUTHORING.md): the public Add-on API v3.
- [Suite backlog](docs/BACKLOG.md): outstanding work and accepted scope.

## License

The software and documentation use the [MIT License](LICENSE).
