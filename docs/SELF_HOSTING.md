# Self-hosting guide

Step-by-step instructions for running TTRPG Codex on your own server.
Aimed at someone who has never deployed a Docker app before; if you
already know your way around Compose + reverse proxies, skim to the
**At a glance** table.

## At a glance

| Topic | Value |
|---|---|
| Runtime | Node 26 inside a Docker container |
| Memory | 512 MB / 0.5 CPU (tile builds of large maps are the peak; idle use is far lower) |
| Disk | A few MB of code + however much your campaign grows; tile pyramids dominate (≈3-5× the source map image) |
| Persistent volumes | `./data` and `./data-snapshots` |
| Network | Listens on port 3000 inside the container |
| Auth | DM password (full access) + optional player password (public content only). Set via env vars or rotated in-app — see [Passwords & roles](#passwords--roles) |
| Required external services | None — JSON files on disk |

## 1. Install Docker

If you don't already have it:

- **Linux:** follow [Docker's official install guide](https://docs.docker.com/engine/install/)
  for your distribution. The convenience script (`curl -fsSL https://get.docker.com | sh`)
  works on most setups.
- **Windows / macOS:** install [Docker Desktop](https://docs.docker.com/desktop/).
- **Compose** ships with modern Docker installs (`docker compose`,
  no hyphen). If `docker compose version` fails, see the
  [Compose docs](https://docs.docker.com/compose/install/).

## 2. Clone and configure

```bash
git clone https://github.com/pjunak/ttrpg-codex.git
cd ttrpg-codex
```

Create a `.env` file with a strong **DM** password — anyone with this
password can edit (or destroy) your campaign:

```bash
echo "DM_PASSWORD=$(openssl rand -base64 24)" > .env
```

Save the password somewhere — your password manager, a sealed
envelope, whatever you trust.

### Passwords & roles

The app has three access levels:

| Role | How to get it | Can do |
|---|---|---|
| **Anonymous** | no login | Read all public content |
| **Player** | the player password | Read + edit **public** content; cannot see or edit DM-only lore |
| **DM** | the DM password | Everything, including DM-only entities and Settings |

Passwords come from two sources, checked in this order:

1. **`data/auth.json`** — credentials set in-app from **Settings →
   Účet** by a logged-in DM. These persist across restarts and take
   priority over the environment.
2. **Environment variables** — `DM_PASSWORD` and `PLAYER_PASSWORD`,
   consulted only when the matching role has no stored credential.
   `EDIT_PASSWORD` is a legacy alias for `DM_PASSWORD`.

To install addons from **private repositories** (and to raise GitHub's
anonymous rate limits) the server needs a GitHub token. The easiest path
needs no shell access at all: the DM opens the install wizard (Settings →
Doplňky → ＋ Instalovat z GitHubu) and pastes the token into its **🔑
Private repositories** section — it's stored server-side in
`data/secrets.json` and used for every install/update from then on.
Alternatively set the env var **`CODEX_GITHUB_TOKEN`** (or the
conventional `GITHUB_TOKEN`); a wizard-stored token takes precedence over
the env vars. Either way the token stays server-side only: never sent to
clients, never logged, and `secrets.json` is deliberately excluded from
backup ZIPs, snapshots and restore — a stored credential must never ride
into a shareable archive. A fine-grained personal access token with
**Contents: Read-only** on the addon repositories is all it needs. The
Addon Manager shows a 🔑 line telling the DM whether (and from where) a
token is configured.

A few consequences worth knowing:

- **A player password is optional.** Leave `PLAYER_PASSWORD` unset and
  player login is simply disabled — anonymous visitors already get the
  same public-only view.
- **Rotate without redeploying.** Sign in as DM, open Settings → Účet,
  and change either password. Changing the DM password rotates the
  cookie secret (invalidating old sessions) but re-issues your own so
  you stay logged in.
- **Never run with the default.** If neither `DM_PASSWORD` nor a stored
  credential is set, the DM password falls back to `"123"` and the
  server logs a loud warning at boot — anyone reading the open-source
  code could then compute a valid cookie. Set a real password before
  exposing the app.

## 3. Start the container

```bash
docker compose up -d
```

The `-d` flag runs the container in the background.

Check the logs:

```bash
docker compose logs -f ttrpg-codex
```

You should see `TTRPG Codex running on http://localhost:3000`. Hit
Ctrl-C to stop tailing the logs (the container keeps running).

Open <http://localhost:3000>. The page loads with no campaign data.
Click any **✏** edit pencil (or the **🔑 Přihlásit** chip in the
top-right of the dashboard), paste the password from `.env`, and start
filling in entities.

## 4. Put it behind a reverse proxy (production)

Exposing port 3000 directly to the internet works, but you'll want
HTTPS and a real domain. Two well-trodden options:

### Option A — Caddy (simplest, automatic HTTPS)

Caddy fetches and renews Let's Encrypt certificates automatically.
Read the [reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
for the full walkthrough; the relevant Caddyfile snippet:

```
codex.example.com {
    reverse_proxy ttrpg-codex:3000
}
```

The `docker-compose.yml` shipped here expects an external Docker
network called `proxy` so the Caddy container (deployed separately)
can reach `ttrpg-codex` by container name. Create it once:

```bash
docker network create proxy
```

Then start Caddy on the same network. Restart `ttrpg-codex` so it
joins the network too:

```bash
docker compose up -d
```

### Option B — nginx-proxy-manager (web UI for routes)

[nginx-proxy-manager](https://nginxproxymanager.com/setup/) gives
you a Caddy-equivalent flow with a point-and-click web UI for
configuring proxy hosts and Let's Encrypt certificates. Add
`ttrpg-codex:3000` as an upstream and let NPM handle the rest.

### Option C — Roll your own nginx / Apache / Traefik

If you already maintain a reverse proxy, point it at the container's
exposed port. The app sets `app.set('trust proxy', 1)` so `req.ip`
and the `secure` cookie attribute work correctly behind a single
hop of proxy.

## 5. Backups

Your campaign content lives in two volumes: `./data` (entities,
images, settings) and `./data-snapshots` (point-in-time history).
Two complementary strategies:

### Built-in snapshots

Every successful save coalesces into a snapshot under
`./data-snapshots/snapshot-<ISO>.json`. Retention: the most recent
50 snapshots plus the newest snapshot per UTC-day for the last 14
days. Manage them in the Settings → **Záloha** tab:

- **Vytvořit zálohu** — take a manual snapshot now (bypasses
  coalescing; rate-limited to one per 3 s).
- **Obnovit** on any snapshot — roll the entire dataset back to that
  point. The handler takes a fresh `pre-restore` snapshot first so
  the operation itself is undoable.
- **Vrátit poslední N změn** — restore the snapshot N positions
  before newest. n=1 = "undo the last change".

### Full ZIP backup

Settings → **Záloha** → **Stáhnout zálohu** triggers
`GET /api/backup` and downloads a ZIP containing the entire `data/`
directory. Same dialog accepts an upload to restore — both ZIP and
the JSON export from `Store.exportJSON()` are accepted.

For automated off-site backups, just rsync `./data` and `./data-snapshots`:

```bash
rsync -avz ./data/ ./data-snapshots/ user@offsite-host:/backups/codex/
```

A daily cron job is plenty for a typical campaign that updates a
handful of times per session.

## 6. Upgrades

Pull the latest code and rebuild:

```bash
git pull
docker compose up -d --build
```

The container restart preserves `./data` and `./data-snapshots`. If
a release introduces a schema migration, it runs idempotently on the
client's next page load — there's no manual migration step.

If you need to roll back, the previous Docker image is still cached;
`docker compose down && docker tag <previous-sha> ttrpg-codex && docker compose up -d`
will revive it. Or git-checkout the previous commit and rebuild.

## 7. Operational notes

### Monitoring

The Docker `HEALTHCHECK` probes `GET /api/version` every 30 s. The
endpoint exercises `_dataHash`, so a wedged data directory fails the
check.

`docker compose ps` shows health status; alert when it isn't `healthy`.

### Logs

```bash
docker compose logs -f ttrpg-codex
```

Notable lines:

- `TTRPG Codex running on http://localhost:3000` — server is up.
- `[snapshot] migrated legacy data/snapshots → data-snapshots` —
  one-time relocation from a pre-A3 deployment.
- `[tiles] sharp not installed — tile generation disabled` — the
  optional `sharp` dep failed to load; the app still runs but uses
  the slower single-image overlay instead of a tile pyramid.
- `⚠  DM password is UNSET` / `… is the default ("123")` — the
  deployment is world-editable. Set `DM_PASSWORD` (or change it from
  Settings → Účet) immediately.
- `ℹ  Player password is unset — player login is disabled.` — benign;
  set `PLAYER_PASSWORD` only if you want a separate player tier.

### Resource limits

The shipped `docker-compose.yml` caps the container at 512 MB / 0.5
CPU — sized so a tile-pyramid build of a large (up to 40 MB) world map
can't OOM the container. Adjust upward if your campaign grows to
thousands of entities. Tile generation is the only CPU/memory-heavy
operation; entity reads and writes are cheap.

### Permissions

The container runs as the default Node user (UID 1000 in the official
image). `./data` and `./data-snapshots` need to be writable by that
UID. If you run into permission errors:

```bash
sudo chown -R 1000:1000 ./data ./data-snapshots
```

## 8. Addons — what a host operator should know

The DM can install **addons** from GitHub URLs (Settings → **Doplňky**:
a wizard shows the requested permissions, takes a snapshot, runs the
addon's self-tests, then activates). Operationally relevant:

- **Trust model: addon code runs in-process, unsandboxed.** An addon
  granted `server:code` ships a Node module the server `require()`s —
  it has full host access. The permission review is transparency, not
  containment. Only install addons you'd trust to run on the server.
- **Data-only addons are hot.** An addon that declares `contentDir`
  (e.g. a rulebook) is served by the host itself — install/update needs
  **no restart**. Addons with server code load at boot; the DM
  "♻ Restartovat server" button (enabled by `CODEX_RESTARTABLE=1`,
  already set in the shipped compose) applies them without shell access.
- Addon code lives under `data/addons/`, addon data under
  `data/addon-data/` — both inside the existing volume, covered by the
  ZIP backup, and survive image upgrades.
- Private addon repo (or GitHub rate limits)? Paste a token into the
  install wizard's 🔑 section (Settings → Doplňky → ＋ Instalovat z
  GitHubu) — no shell needed. Env alternative: `CODEX_GITHUB_TOKEN`
  (the server also accepts plain `GITHUB_TOKEN`, but the shipped compose
  file only forwards `CODEX_GITHUB_TOKEN` into the container; a
  wizard-stored token wins over both). See §2.

## 9. Running multiple instances (separate campaigns)

The image is stateless — every per-campaign thing lives in the two volumes and
a handful of env vars — so you can run any number of independent codices side by
side. They share the image and **never share data**; each instance needs only
its own data directory, container name, and hostname.

A second instance is just another Compose service (or another stack behind your
reverse proxy):

```yaml
services:
  asurai:
    image: ghcr.io/pjunak/ttrpg-codex:latest   # same image as the first
    container_name: asurai
    restart: unless-stopped
    env_file: .env                              # its own .env (separate password)
    volumes:
      - ./asurai-data:/app/data                 # separate data dir
      - ./asurai-snapshots:/app/data-snapshots  # separate snapshot history
    networks: [proxy]
```

Point a second hostname at it in your reverse proxy (Caddy:
`asurai.example.com { reverse_proxy asurai:3000 }`). The `edit_session` cookie
is **host-scoped** — no `domain=` is set — so logins never leak between
hostnames even when the passwords match.

### Per-instance feature flags

Two optional env vars let instances diverge in behavior while sharing one image,
so a campaign-specific addon can be enabled on one site without affecting the
others:

| Variable         | Purpose                                                                                                          |
|------------------|------------------------------------------------------------------------------------------------------------------|
| `CODEX_INSTANCE` | A label for the instance — logged at boot and returned by `GET /api/version`. Defaults to `default`.             |
| `CODEX_FEATURES` | Space/comma-separated addon flags enabled for *this* instance only. Empty (the default) = baseline behavior.     |
| `CODEX_RESTARTABLE` | `1` enables `POST /api/restart` + the DM "♻ Restartovat server" button (Settings → Server). Also auto-detected inside Docker via `/.dockerenv`. Only enable when a supervisor (`restart: unless-stopped`, systemd, pm2) brings the process back. |
| `CODEX_DATA_DIR` / `CODEX_SNAPSHOTS_DIR` | Override the data / snapshot directories (default `./data` and `./data-snapshots` next to `server.js`). The seam for non-Docker hosting. |
| `CODEX_SNAPSHOT_MIN_INTERVAL_MS` | Minimum interval between *manual* snapshots (default `3000`). |
| `CODEX_GITHUB_TOKEN` | Optional. Used by addon installs/updates for the GitHub API — raises rate limits and allows private addon repos. (`GITHUB_TOKEN` is accepted too, but is not forwarded by the shipped compose file; a token stored via the install wizard takes precedence over both.) |

`GET /api/version` returns `{ hash, instance, features, canRestart }`, so you
can confirm which instance and feature set a running container serves:

```bash
curl -s https://asurai.example.com/api/version
# {"hash":"…","instance":"asurai","features":[],"canRestart":true}
```

## Troubleshooting

**Page loads but the password is rejected.**
Check the server logs for the password warnings at boot. If you set the
password in `.env`, make sure Compose loaded it (`docker compose config
| grep -E 'DM_PASSWORD|PLAYER_PASSWORD|EDIT_PASSWORD'`). Note that a
credential stored in-app (`data/auth.json`, set via Settings → Účet)
**overrides** the env var — if you changed it there, the old `.env`
value no longer applies.

**Markers don't appear on the world map.**
Open the browser console. A common cause is missing tile pyramids — if
the logs say `sharp not installed`, the fallback `imageOverlay` should
still work; if it doesn't, check that `data/maps/swordcoast/sword_coast.{jpg,png}`
exists.

**The app loses my edits when I refresh.**
The dirty-form guard tries to prevent this — confirm dialogs warn
before navigating away, and CodeMirror autosaves to `localStorage`
every 500 ms. If you lost work, check Settings → **Záloha** for a
recent snapshot.

**`docker compose up` fails with `network "proxy" not found`.**
Create it: `docker network create proxy`. Or remove the `networks`
section from `docker-compose.yml` if you're not using a reverse proxy.

**Saves silently fail.**
The client shows a red banner "⚠ Uložení na server selhalo…" when a
PATCH gives up after 3 retries. Check the server logs; common causes
are a full disk or a permissions error on `./data`.

## Going further

- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — how the app is built;
  read this if you want to extend it.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — local dev setup, the IIFE
  module pattern, how to add a new entity collection.
