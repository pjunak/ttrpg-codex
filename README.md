# TTRPG Codex

A self-hostable, collaboratively-edited web codex for D&D and other
tabletop RPG campaigns. Players and the GM read and edit the same
characters, locations, events, mysteries, factions, and timeline —
every change propagates to every connected client in under a second.

> **Live example:** [tiamat.junak.eu](https://tiamat.junak.eu) — the
> maintainer's running D&D 5e campaign *O Barvách Draků*. Use it to
> see what a populated codex looks like; the code in this repo ships
> empty so you can fill it with your own world.

The UI ships in **English and Czech** — each user picks their language
from the dashboard (defaults to the browser language, falls back to
English), so a mixed-language group works out of the box. Visual themes
are switchable from Settings, and an addon system lets the DM install
extensions (rulebooks, character sheets, …) straight from GitHub — no
fork needed to customise a campaign.

## What you get

- **Wiki articles** for every entity, with Markdown bodies, an
  auto-generated outline (TOC), and `[[wiki-link]]` syntax that
  resolves across collections.
- **World map** (Leaflet) with sub-maps per location, custom marker
  artwork, attitude glows that signal stance toward the party,
  zoom-driven scaling, captured view presets ("Pohledy"), and
  event-path overlays so you can replay a sezení geographically.
- **Mind maps** (Cytoscape + a hand-rolled rope-physics integrator
  with a worst-offender crossing-reduction post-pass): faction graph,
  relationship graph, mystery graph.
- **Timeline kanban** organised by gaming session ("Sezení"), with
  drag-and-drop reordering and stacked column hovering.
- **Attitude glow system** — a single `attitudes` palette drives the
  visual halo on character portraits, location cards, faction badges,
  and map markers. Strength is per-attitude (one slider in Settings
  retints every glow at once); multi-attitude markers stripe colours
  rather than blending them muddily.
- **Snapshots + backup**: every save coalesces into a point-in-time
  snapshot; the Settings page exposes restore-to-snapshot, revert-
  last-N, manual snapshot, and full ZIP backup / restore.
- **Live sync** over Server-Sent Events. No polling, sub-second
  propagation, dirty-form guard so a teammate's edit can't stomp
  your in-progress changes.
- **Auth & roles** — read access is open. Editing requires a
  password: a **DM** password unlocks everything (including DM-only
  lore); an optional **player** password grants edit access to public
  content only. Set them at deploy time (`DM_PASSWORD` /
  `PLAYER_PASSWORD`) or rotate them later from Settings → Účet.
  Sessions are signed, rate-limited cookies.
- **Addons** — the DM installs extensions from a GitHub URL via a
  guided wizard (permission review → backup → test-gate → activate,
  with update checks and one-click rollback). Addons can add pages,
  article sections, editor fields, data collections, mind-map node
  kinds, and even server endpoints. See
  [`examples/addons/AUTHORING.md`](examples/addons/AUTHORING.md) to
  write one. Note the trust model: addon code runs **in-process,
  unsandboxed** — install only addons you trust to run on your server.

## Quick start (5 minutes)

You need [Docker](https://docs.docker.com/engine/install/) and
[Docker Compose](https://docs.docker.com/compose/) installed.
That's it — no Node toolchain on the host, no build step.

```bash
git clone https://github.com/pjunak/ttrpg-codex.git
cd ttrpg-codex

# Pick a strong DM password — anyone with it can edit everything.
# (EDIT_PASSWORD is the legacy alias for DM_PASSWORD; both work.)
echo "DM_PASSWORD=$(openssl rand -base64 24)" > .env

docker compose up -d
```

Open <http://localhost:3000>. The page loads empty — click any ✏ edit
pencil (or the 🔑 Přihlásit chip, top-right on the dashboard), paste
the password from `.env`, and you're editing.

For production deployment behind a reverse proxy (HTTPS, custom
domain, etc.), see [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

## Project structure

```
server.js                Express server + REST API
server-utils.cjs         Pure helpers (path safety, key validation)
tiler.js                 Map tile-pyramid generator (sharp)
docker-compose.yml       One-service compose file
data/                    Runtime data (gitignored, mounted as volume)
data-snapshots/          Point-in-time snapshots (gitignored)
web/
  index.html             SPA shell
  css/bundle.css         Single CSS entry point (@imports the rest)
  js/                    Vanilla ES6 modules — see ARCHITECTURE.md
  icons-defaults/        Bundled marker SVGs (game-icons.net, CC BY 3.0)
test/                    node --test unit + integration tests
```

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — the deep internal reference (written as an
  AI-assistant context file, equally useful to humans): every subsystem's
  contract, invariants, gotchas, known deferred issues. Start here before
  changing code.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — local dev setup, the IIFE
  module pattern, how to add a new entity collection, testing.
- **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** — Docker deployment
  runbook, reverse proxy, backups, snapshots, upgrades.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — tech stack, data
  model, routing, sync flow, security model.
- **[ATTRIBUTIONS.md](ATTRIBUTIONS.md)** — credits for the bundled
  marker icon set (game-icons.net, CC BY 3.0).

## Roadmap

- **Per-Pohled marker visibility rules** — let each saved map preset
  carry rules like "hide pin type X" or "only show pins with attitude Y".
- **More ruleset addons** — a D&D 5.5e (2024) toolkit (character
  sheets + Player's Handbook + Monster Manual) is being built on the
  addon framework; other systems can follow the same pattern.
- **Addon sandboxing** — addons currently run trusted and in-process;
  an iframe/Worker sandbox under strict CSP is a future hardening idea.
- **Bulk marker-icon import** — zip upload following
  `<pinTypeId>/<file>` for power users.

## License

A formal `LICENSE` file has not been added yet — until it is, treat
this code as "all rights reserved" and reach out before redistributing.
The maintainer's intent is permissive (MIT-style); a concrete license
file is on the to-do list.

Bundled marker icons are independently licensed under CC BY 3.0 via
[game-icons.net](https://game-icons.net/); attribution lives in
[ATTRIBUTIONS.md](ATTRIBUTIONS.md) and **must travel with any
redistribution** of those files to satisfy the license's attribution
clause.

## Acknowledgements

- [Cytoscape.js](https://js.cytoscape.org/) for the mind-map graph layer.
- [Leaflet](https://leafletjs.com/) for the world map.
- [EasyMDE](https://github.com/Ionaru/easy-markdown-editor) for the
  Markdown editor.
- [marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify)
  for sanitised Markdown rendering.
- [game-icons.net](https://game-icons.net/) for the bundled marker artwork.
