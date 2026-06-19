# TTRPG Codex

A self-hostable, collaboratively-edited web codex for D&D and other
tabletop RPG campaigns. Players and the GM read and edit the same
characters, locations, events, mysteries, factions, and timeline —
every change propagates to every connected client in under a second.

> **Live example:** [tiamat.junak.eu](https://tiamat.junak.eu) — the
> maintainer's running D&D 5e campaign *O Barvách Draků*. Use it to
> see what a populated codex looks like; the code in this repo ships
> empty so you can fill it with your own world.

The repo is currently Czech-default in the UI. Plugin-based
internationalisation, theme selection, and ruleset packs are on the
roadmap so you won't have to fork the code to customise a campaign;
until that lands, expect to translate UI strings yourself if you want
something other than Czech.

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

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — local dev setup, the IIFE
  module pattern, how to add a new entity collection, testing.
- **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** — Docker deployment
  runbook, reverse proxy, backups, snapshots, upgrades.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — tech stack, data
  model, routing, sync flow, security model.
- **[ATTRIBUTIONS.md](ATTRIBUTIONS.md)** — credits for the bundled
  marker icon set (game-icons.net, CC BY 3.0).

## Roadmap

- **i18n plugin** — separate UI strings from layout so non-Czech
  campaigns don't need a fork.
- **Theme manager** — colour palette + typography swap from Settings.
- **Ruleset packs** — install D&D 5e / Pathfinder / Cyberpunk Red /
  custom rulesets as plugins, each contributing entity collections,
  dice helpers, and seed defaults.
- **Per-Pohled marker visibility rules** — let each saved map preset
  carry rules like "hide pin type X" or "only show pins with attitude Y".

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
