# Server: API, snapshots, security, tests, deploy — deep reference (ttrpg-codex)

> Moved verbatim out of AGENTS.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as AGENTS.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## Snapshot system

Every successful `PATCH /api/data` writes a point-in-time snapshot of
the entire JSON dataset under `data-snapshots/snapshot-<ISO>.json`
(sibling of `data/`, NOT a subdirectory — keeps the data hash clean,
simplifies `_safeJoinDataDir`, and stops backup zips from carrying
their own history). A one-time migration on server boot moves any
pre-existing `data/snapshots/*` files into the new sibling dir, then
removes the empty subdir. Snapshot shape:

```json
{
  "id":        "snapshot-2026-04-21T12-34-56-789Z.json",
  "createdAt": "2026-04-21T12:34:56.789Z",
  "dataHash":  "abc123…",
  "reason":    "save" | "manual" | "pre-restore",
  "files":    { "characters.json": [...], "locations.json": [...], … }
}
```

Helpers all live in `server.js` at the top (after `_atomicWrite`):
`_snapshotFiles` · `_readSnapshot` · `_snapshotMeta` ·
`_lastSnapshotTime` · `_createSnapshot(reason)` · `_pruneSnapshots` ·
`_maybeSnapshot(reason)` · `_restoreSnapshot(id)`.

**Coalescing:** `_maybeSnapshot` skips the write if the previous
snapshot is < 60 s old (`SNAPSHOT_COALESCE_MS`). Burst writes from a
single logical action (e.g. `saveLocation`'s peer cascade, or a user
mashing save) produce one snapshot covering the group.

**Retention:** `_pruneSnapshots` keeps the most recent 50 snapshots
(`SNAPSHOT_RECENT_KEEP`) plus the newest snapshot per UTC-day for
the last 14 days (`SNAPSHOT_DAILY_DAYS`). Called at the end of every
`_createSnapshot`.

**Restore:** `_restoreSnapshot(id)` takes a `pre-restore` snapshot
first (so the restore operation itself is undoable), then overwrites
every JSON file in `data/` with the snapshot's contents. Any JSON
file present today that the snapshot didn't have is deleted (handles
collections added since the snapshot). `_broadcastDataChanged` fires
so all connected clients refetch.

**Revert-last-N:** `/api/snapshots/revert-last/:n` computes the target
snapshot as `files[files.length - 1 - n]` (snapshots are newest-last
in the ascending list), then calls `_restoreSnapshot`.

## API

Auth column legend: `—` no auth · `any` any authenticated role · `dm`
DM only. The legacy `✓` marker (= DM only) has been replaced throughout
with `dm` for clarity now that some endpoints accept any authed role.

**Privileged-endpoint gate.** The DM-only endpoints that gate on the
SIGNED `realRole` claim (addon install/manage, twin ops, password
rotation, view-as) all route through the **`requireRealDM(msg?)`**
middleware factory in `server.js` (registered as route middleware,
e.g. `app.post(path, requireRealDM('…'), handler)`) rather than an
inline `if (req.realRole !== 'dm')`. The optional `msg` preserves each
route's exact Czech 403 text (defaults to `'Pouze pro DM'`). Centralising
it means a new privileged endpoint can't silently ship ungated. (Distinct
from `requireAuth` = `requireRole('dm')`, which gates on the EFFECTIVE
role, and `requireAnyRole`.)

**Terminal error handler + JSON 404 for `/api`.** A 4-arg
`app.use((err,req,res,_next)=>…)` is registered LAST (after the SPA
fallback) so anything passed to `next(err)` returns clean JSON, not a raw
HTML 500: multer upload errors (`LIMIT_FILE_SIZE`/`LIMIT_FILE_COUNT` on the
portrait/localmap/icons/worldmap/logo/restore uploads — surfaced during
PARSE, before the route body) → 400 `Upload error: <code>` (best-effort
unlink of any partially-written disk file); an oversized `express.json`
body (`entity.too.large`) → 413; malformed JSON (`entity.parse.failed` /
`SyntaxError`) → 400. Before the SPA fallback, a catch-all
`app.use('/api', …)` (after ALL real `/api` routes + the
`/api/addon/:id/*` dispatcher) returns `404 {error:'Not found'}` for any
unmatched `/api/*` path (every method) so a wrong/renamed endpoint gives an
honest JSON 404 instead of `200` + `index.html`. Covered by
`test/integration-errors.test.cjs`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/data` | — | Full campaign JSON, role-filtered. Anonymous + player callers get `filterForRole(...)` applied (DM-only entities dropped, `linkedTwinId` stripped — see `server/visibility.cjs`). DM callers get identity. |
| ~~POST~~ | ~~`/api/data`~~ | — | **REMOVED.** Was a "replace whole dataset" endpoint used by the old `Store._persist()` for migrations + first-install seeding. Now everything goes through PATCH per-entity. Migrations sync each touched record individually; the empty-server case keeps defaults locally and lazily creates files on the first user edit. |
| PATCH | `/api/data` | any | `{ type, action, payload }`. action is `save`\|`delete`. Validates `type`, `relationship.type`, `character.status`. **Keyed-object collections** (treated as object on disk, `container[payload.id] = payload.data`): `factions`, `settings`, `campaign`, `deletedDefaults`. Everything else is a per-entity list. Player saves go through `_sanitizePlayerEntity` (server.js) which forces `visibility: 'public'`, preserves `linkedTwinId`, and strips `secrets`. DM-only writes for `settings` / `campaign` types (per `DM_ONLY_WRITE_TYPES`). |
| POST | `/api/twin` | dm | DM-only. `{ action: 'create' \| 'link' \| 'unlink', type, sourceId, targetId? }`. Manages twin entity pairs: `create` clones the source into the opposite visibility space and bidirectionally sets `linkedTwinId`; `link` marries two existing entities (one public, one DM-only); `unlink` clears the pair. Atomicity: both sides written inside one `withWriteLock` pass. Broadcasts `data-changed`. See "Twin entity model" section. |
| GET | `/api/version` | — | `{ hash, instance, features, canRestart }`. `hash` = dataset hash (health-check + legacy change-poll). `instance`/`features` echo the `CODEX_INSTANCE` / `CODEX_FEATURES` env — the per-instance addon seam (see **Deployed surface area → Multiple instances**). `canRestart` = whether the server may restart itself (gates the DM "restart server" button; mirrors `RESTARTABLE`). |
| POST | `/api/restart` | dm | DM-only on **realRole**. Restart the server process by exiting cleanly so the supervisor (Docker `restart: unless-stopped` / systemd / pm2) brings it back up — the only way to reload in-process addon **server code** after an install/update/rollback without a manual `docker restart`. **400** when not `RESTARTABLE` (`CODEX_RESTARTABLE=1` or `/.dockerenv` detected) — exiting bare would just take the wiki down. Responds first, drains the write lock, then `process.exit(0)`; the client (`Settings.restartServer`) shows a full-screen overlay that polls `/api/version` (down→up) and reloads. No Docker-socket access. |
| POST | `/api/addons/update-all` | dm | DM-only on **realRole**. Update EVERY addon from a real GitHub repo to its latest commit in one shot — the per-addon update flow, looped (re-resolve stored ref→latest SHA, stage+promote via the same green-gate / content-hash / kept-versions pipeline a single install uses). Local (dev-installed, `repo:'local'`) addons are skipped. Returns `{ ok, updated[], skipped[], errors[], serverChanged }` (`serverChanged` = any updated addon ships server code → the client suggests a restart). Broadcasts `addons-changed`. |
| GET | `/api/events` | — | SSE. Emits `hello` on connect and `data-changed` `{ hash, at }` after every write. Client uses `EventSource`. No polling. |
| POST | `/api/login` | — | `{ password }` sets `edit_session` cookie. Tries DM credential first, then player. |
| POST | `/api/logout` | — | Clear `edit_session` cookie. Idempotent. |
| GET | `/api/auth` | — | `{ role, realRole }`. Anonymous = both null. |
| POST | `/api/view-as` | dm | DM-only. Re-issue cookie with effective role=`player` (realRole=`dm` preserved). |
| POST | `/api/view-as-dm` | dm | DM-only. Flip effective role back to `dm` from an active impersonation. |
| GET | `/api/passwords` | dm | DM-only. Report presence flags for DM/player credentials (`{stored, updatedAt, envFallback, isDefault?, disabled?}`). Never reveals hash/salt. |
| POST | `/api/passwords` | dm | DM-only. `{ role: 'dm' \| 'player', newPassword, currentPassword }`. Validates `currentPassword` against the active DM credential, writes `{salt, hash, updatedAt}` to `data/auth.json` via `withWriteLock`. Empty `newPassword` is allowed only for `role:'player'` (clears the stored credential). Re-issues the caller's cookie on DM-password change so they stay logged in. |
| POST | `/api/portrait/:charId` | any | Upload portrait multipart. |
| DELETE | `/api/portrait/:identifier` | any | Delete portrait file or dir. |
| POST | `/api/localmap/:locId` | any | Upload a Location's `localMap` image (multipart field `localmap`). Saves to `data/maps/local/{locId}/map.{ext}`. Returns `{ url }`. Also schedules async tile-pyramid build via `tiler.buildFor`. |
| POST | `/api/worldmap` | dm | Upload the world map (multipart field `worldmap`). Saves to `data/maps/swordcoast/sword_coast.{ext}`, replaces any existing world-map file with a different extension, returns `{ url }`, and schedules a tile-pyramid rebuild. Max 40 MB. DM-only because the world map is a shared backdrop. |
| POST | `/api/logo` | dm | Upload the site logo (multipart field `logo`). Saves to `data/branding/logo.{ext}`, replaces any existing logo of a different extension, returns `{ url }`. Max 5 MB. DM-only (shared chrome). Client stores the URL in `settings.branding.logoUrl`. |
| DELETE | `/api/logo` | dm | Remove the custom logo so the bundled default (`web/branding/logo-default.svg`) takes over. Idempotent. DM-only. |
| GET | `/branding/:file` | — | Static-served from `data/branding/` with `fallthrough: true`, so `/branding/logo-default.svg` (which lives in `web/branding/`) passes through to the WEB_DIR handler. `maxAge: '7d'`. |
| POST | `/api/icons/:pinTypeId` | dm | Upload up to 16 marker-icon variants for a pin type (multipart field `icons`, repeated). Saves to `data/icons/<pinTypeId>/<sanitized>.<ext>`. Mimetype whitelist: svg / png / jpeg / webp; 2 MB / file cap. Uses multer **memoryStorage** — files are buffered in RAM during parse and only written to disk INSIDE `withWriteLock` AFTER `pinTypeId` is validated against the live `settings.pinTypes` list, so a concurrent settings PATCH deleting the pin type can't race a file onto disk (an unknown id is rejected with no disk side-effect). Filename collisions resolve deterministically (`slug`, `slug-2`, …) against both the dir and names taken earlier in the same batch. Returns `{ files: [{id, url, name}] }`. |
| DELETE | `/api/icons/:pinTypeId/:filename` | dm | Remove one marker-icon variant. Path validated via `_safeJoinIn`; symlinks rejected. Inside `withWriteLock`. |
| DELETE | `/api/icons/:pinTypeId` | dm | Recursively remove the whole `data/icons/<pinTypeId>/` folder. Called by `Store.deleteEnumItem('pinTypes', …)` to clean up after a pin-type delete. Inside `withWriteLock`. |
| GET | `/icons/:pinTypeId/:filename` | — | Static-served from `data/icons/`. `maxAge: '7d'`. |
| GET | `/maps/tiles/:mapId/tiles.json` | — | Per-map manifest `{ width, height, tileSize, minZoom, maxZoom, ext? }` written by the tiler. Missing = client falls back to imageOverlay. |
| GET | `/maps/tiles/:mapId/:z/:x/:y.:ext` | — | Individual 256 px tile. Served as static files (`maxAge: '7d'`). |
| GET | `/api/backup` | dm | Download `data/` as zip (`archive.directory(DATA_DIR,'data')` — blanket include, so addon-data + the `addons.json` registry + addon code under `data/addons/` are all in it). DM-only because the raw JSON contains DM-only entities (`visibility: 'dm'`); a player download would bypass the visibility filter. ⚠ **archiver v8 is ESM** — `require('archiver')` returns `{ZipArchive,…}`, not a callable; the route uses `new archiver.ZipArchive(opts)` (version-tolerant fallback to the old `archiver('zip')` factory). A naive bump back to the factory call would 500 the whole endpoint. |
| POST | `/api/restore` | dm | Replace `data/` from an uploaded backup (multipart field `backup`). Accepts `.zip` produced by `/api/backup` (entries under `data/...`) **or** a `.json` document in the `Store.exportJSON()` shape. Takes a `pre-restore` snapshot first, writes each entry safely under `DATA_DIR` (path-traversal protected via `_safeJoinDataDir`), broadcasts `data-changed`. Triggers `_backgroundTileSweep()` after a ZIP restore so map tiles regenerate. 200 MB hard cap. Streams entries via `yauzl` (disk-staged, constant memory; two-pass zip-bomb scan — the old buffering `adm-zip` path is gone). `_safeJoinDataDir` also refuses `auth.json` and anything under `data/addons/` (addon CODE — the anti-RCE guard); refused entries are counted, not fatal. Responds `{ ok, format, restored, skipped }`. Covered by `test/integration-restore.test.cjs`. |
| GET | `/api/snapshots` | any | List point-in-time snapshots. Returns `{ snapshots: [{id, createdAt, dataHash, reason, size}] }` newest-first. Only metadata — contents never leave the server. |
| POST | `/api/snapshots` | any | Take a manual snapshot now. Returns `{ ok, id }`. Bypasses the 60 s coalesce window. Players can pin a known-good point before a risky edit. Rate-limited: min 3 s between manual snapshots (`CODEX_SNAPSHOT_MIN_INTERVAL_MS`; the test helper sets 0) — a manual snapshot holds the write lock for a full-dataset copy. |
| POST | `/api/snapshots/:id/restore` | dm | Restore a specific snapshot. Takes a `pre-restore` snapshot first, overwrites `data/` JSON files, broadcasts `data-changed`. |
| POST | `/api/snapshots/revert-last/:n` | dm | Restore the snapshot N positions back from the newest, effectively undoing the last N changes. |
| DELETE | `/api/snapshots/:id` | dm | Delete one snapshot file. |
| GET | `/api/addons` | — | List installed addons (the registry's public projection): `{ apiVersion, instance, addons:[{id, name, version, apiVersion, enabled, state, activeHash, permissions, dependencies, collections, server, serverState, versions:[{contentHash,version,installedAt}], entryUrl}], resolutions }`. Readable by any caller because client boot loads addons before login; reveals enough to import + **scope the host facade** (the granted `permissions`), wire addon collections, apply fragment-override `resolutions`, show server-code load state + version history (rollback), + show status — never the `sources.allow` allowlist or the repo url. For the **real DM only** the payload adds `githubTokenConfigured` (boolean — is `CODEX_GITHUB_TOKEN`/`GITHUB_TOKEN` set, i.e. can private repos install; drives the Manager's 🔑 line; never the token itself). See **Addon framework**. |
| ANY | `/api/addon/:id/*` | — | **Namespaced server-addon routes** (Phase 7, singular). A stable dispatcher (before the SPA fallback) delegates to the enabled addon's `express.Router()` built by its `init(serverHost)`. `req.role`/`realRole` are stamped (the addon self-gates); an unmatched sub-path or a disabled/absent/errored addon → JSON 404. Each addon's routes are isolated under its own id. **When the addon has NO live router but declares manifest `contentDir`, the HOST answers the four GET content endpoints itself** (`/content`, `/content/:kind`, `/item/:kind/:id`, `/kinds`) from the addon's bundled per-record JSON tree — no addon server code, no `server:code` grant, HOT-rebuilt on every registry mutation (`_applyAddonContent`; cached per `activeHash`), so installing/updating a book addon needs no restart. A live router takes precedence entirely. See **Server-side addons**. |
| POST | `/api/addons/install` | dm | DM-only on **realRole** (like twin ops). `{ repo, ref?, sha? }`. `repo` is a pasted GitHub URL or `owner/name` (parsed by `AddonBroker.parseRepoInput`, which also extracts a `/tree/<ref>`). When the wizard passes the previewed `sha`, install **pins to that exact commit** (what installs == what was reviewed) while storing the original `ref` for future update checks. **Auto-records** the repo in `sources.allow`. Fetches the GitHub zipball, validates + content-hashes, stages, runs the server **test green-gate** (Phase 8), then atomic-promotes to `data/addons/<id>/<hash>/` + appends to `versions[]` (kept for rollback), updates `data/addons.json`, broadcasts `addons-changed`. Upsert by id = update. |
| POST | `/api/addons/preview` | dm | DM-only on **realRole**. `{ repo, ref? }`. Resolves + fetches **just `addon.json`** (GitHub contents API — no download/install) via `AddonBroker.fetchManifest`, validates it, returns `{ repo, ref, sha, ok, errors, manifest:{…} }` so the wizard shows the requested permissions for DM review BEFORE granting. The returned `ref` (original branch/tag) + `sha` (exact commit) both feed back into install. |
| POST | `/api/addons/check-updates` | dm | DM-only on **realRole** (Phase 9). PURE READ — for each addon from a real GitHub repo, re-resolve its stored `ref`→latest SHA and diff vs installed `sha`; returns `{ checkedAt, updates:[{id, status:'ok'\|'local'\|'error', hasUpdate, repo, currentSha, latestSha}] }`. Per-addon failures isolated. Never downloads — applying an update opens the wizard. |
| POST | `/api/addons/:id/rollback` | dm | DM-only on **realRole** (Phase 9). `{ hash? }`. Content-addressed rollback: flip `activeHash` to a kept prior `versions[]` entry (`hash` targets one; omitted → the one before active) + restore that version's structural fields (`entry`/`server`/`serverDeps`/`collections`/`dependencies`). Instant + offline (the code dir survives). 400 if <2 versions or the target code dir is gone; broadcasts `addons-changed`. Server code change → drops the live router (restart-to-load). |
| POST | `/api/addons/sources` | dm | DM-only on **realRole**. `{ repo, action? }` — add (default) or `remove` a recorded source (`owner/name` or `owner/*`) in `sources.allow`. Mostly auto-managed by install; this is the advanced manual lever. Broadcasts `addons-changed`. |
| POST | `/api/addons/resolve` | dm | DM-only on **realRole**. `{ target, winner }` — resolve a fragment-override conflict: `winner` = an addonId (that addon's exclusive op wins), `null` (force the built-in), or absent/empty (clear → back to auto). Writes `resolutions[target]` in `data/addons.json` (prototype-key-guarded), broadcasts `addons-changed`. See **Fragment overrides**. |
| POST | `/api/addons/:id/enable` · `/disable` | dm | DM-only on **realRole**. Flip `enabled` on an installed addon; broadcasts `addons-changed` (clients live-reconcile). 404 if unknown. |
| POST | `/api/addons/:id/content-groups` | dm | DM-only on **realRole**. `{ disabled: string[] }` — replace wholesale which manifest `contentGroups` values are disabled for a content addon (registry key `disabledContentGroups`). Hot: `_applyAddonContent` re-filters the served tree from the in-memory raw cache, then BOTH `addons-changed` (Manager refresh) and `data-changed` (content consumers refetch) broadcast. 400 if the addon declares no `contentGroups`; unknown group ids are stored as-is (match nothing — forward-compatible). |
| DELETE | `/api/addons/:id` | dm | DM-only on **realRole**. Remove an addon: drop it from the registry (clearing any `resolutions` pointing at it) + delete its code dir `data/addons/<id>/`. Per-addon DATA `data/addon-data/<id>/` is **kept** unless `?purge=1`, so a re-install restores content. Broadcasts `addons-changed`. |

## Write serialisation

All routes that mutate disk state run inside `withWriteLock(async
() => { … })` — a Promise-chain mutex that serialises PATCH
`/api/data`, the snapshot create/restore/revert endpoints, and
`/api/restore`. Two clients hitting save at once no longer
interleave read-modify-write cycles on the same JSON file.

Every helper that touches the data dir is async: `_atomicWrite`,
`_createSnapshot`, `_restoreSnapshot`, `_pruneSnapshots`,
`_dataHash`, `_broadcastDataChanged`, `_backgroundTileSweep`. Don't
call them outside the mutex on a write path. `_atomicWrite` retries
the rename a few times on EBUSY/EPERM/EACCES so the Windows
filesystem race during `_createSnapshot` doesn't break the write.

## Path-safety helper

`server.js` exposes `_safeJoinIn(dir, rel)`: resolves `rel` inside
`dir` and returns the absolute path only if the result is genuinely
contained — rejects traversal (`..`), absolute paths, null bytes,
*and* symlink escapes (every existing prefix is `realpath`-checked).
Used by:
- portrait migration (PATCH `/api/data` for characters with a
  non-canonical `payload.portrait`),
- `_safeJoinDataDir` (restore zip entry validation). Snapshots now
  live in a sibling `data-snapshots/` so they're already unreachable
  through DATA_DIR; the explicit snap-root check is kept as
  defence-in-depth in case a future refactor moves them back.

Anywhere we accept caller-supplied path fragments (zip entries,
URLs in JSON payloads, multer charId/locId) MUST go through one of
these helpers — do not hand-roll a startsWith check, the symlink
case is easy to miss.

## Prototype-pollution guard

Keyed-object collections (`factions`, `settings`, `campaign`,
`deletedDefaults`) write the payload via `container[payload.id] = …`.
The PATCH handler calls `_isForbiddenKey(payload.id)` first and
returns 400 for `__proto__` / `constructor` / `prototype`. New
keyed-object collections must add the same guard.

## CDN scripts and SRI

Every `<script>` and `<link rel="stylesheet">` in `web/index.html`
that points at a CDN carries a pinned `integrity="sha384-…"` hash
plus `crossorigin="anonymous"`. A CDN compromise can't silently
inject code — the browser refuses to execute / apply a script whose
hash doesn't match. **Known exception:** the Google Fonts stylesheet
(`fonts.googleapis.com`) — its responses vary per user-agent, so SRI
is impossible there; the eventual fix is self-hosting the three font
families under `web/fonts/` (also removes a third-party runtime
dependency).

CDN delivery is a **settled decision** (2026-07-03): offline/local play
is out of scope, so do not vendor these libraries.

When bumping a library version, **regenerate the SRI hash too** or
the page will hard-fail to load. Easiest:
```
curl -sL <new-url> | openssl dgst -sha384 -binary | openssl base64 -A
```
cdnjs and jsdelivr also publish SRI hashes on their package pages.

## Tests

`test/` contains `node --test` tests, runnable via `npm test`. CI
(`.github/workflows/build-and-dispatch.yml`) runs the same suite as a
`test` job gating the image build + deploy dispatch.
Coverage today:

**Unit tests** (pure-function tests with no external dependencies):
- `test/utils.test.mjs` — pure helpers in `web/js/utils.js` (slugify,
  extractOutline, esc, escapeRe, norm, expandWikiLinks).
- `test/store.test.mjs` — client-side `Store` smoke (id generation,
  default getters, searchAll shape, exportJSON round-trip). Provides
  minimal `window`/`localStorage`/`document` polyfills before import
  so Store's IIFE doesn't crash; doesn't exercise the load/save fetch
  paths.
- `test/server-utils.test.cjs` — `isForbiddenKey`, `safeJoinIn`
  (traversal / absolute / null-byte / symlink-escape / good paths),
  `pickKeptSnapshots` (recent + daily-window pruning policy),
  `hashPassword` / `verifyPassword` round-trip + timing safety.
- `test/visibility.test.cjs` — `filterForRole` (DM vs player on every
  visibility-bearing collection shape) and `stripEntityForRole`
  (the `linkedTwinId` scrub for non-DM payloads).
- `test/sidebar-layout.test.mjs` — `Store.getSidebarLayout` registry
  reconciliation (default seed, drop dead routes, re-home new routes,
  dedupe, hidden bucket), `setSidebarLayout` normalization, and the
  `hiddenSidebarPages` back-compat shims.
- `test/pets.test.mjs` — pets (Mazlíčci) CRUD, `ownerId` normalization,
  `getPetsForOwner` / `getPetOwner`, undo, and the orphan-on-owner-delete
  cascade (`deleteCharacter` / `deleteFaction` → `ownerType:'none'`).
- `test/store-logic.test.mjs` — domain helpers: `isQuestionAnswered`,
  `questionText` / `questionAnswer`, `isMysterySolved`, `getOpenQuestions`,
  `getEffectiveAttitudes` (party shortcut + faction inheritance).
- `test/enums.test.mjs` — settings-enum management: `findEnumUsages`
  (scalar + object-array shapes) and `deleteEnumItem`'s three paths
  (refuse-when-used / force / replaceWith remap).
- `test/i18n.test.mjs` — the i18n engine (`web/js/i18n.js`): locale
  detection + fallback, `t()` interpolation + missing-key fallback,
  `plural()` Czech one/few/other vs English one/other (pinned against
  `Intl.PluralRules`), `relativeTime` guards, and a **catalog-parity**
  check (cs covers every en key, with the Czech plural buckets).
- `test/i18n-keys.test.mjs` — every LITERAL `I18n.t('…')` / `plural('…')`
  key in the browser sources + every `data-i18n`/`data-i18n-title`
  attribute in index.html exists in en.json (dynamic keys skipped).
- `test/design-system.test.mjs` — tripwire over the shared design-system
  components addons build on (`.codex-link-row/-tile` target size +
  focus ring, `.codex-skel`, the `iconGlyph` facade): asserts the
  load-bearing CSS properties exist so a host refactor can't silently
  regress every consuming addon.

**Integration tests** (boot the Express app against a tempdir
`CODEX_DATA_DIR`, exercise endpoints, assert on disk + responses):
- `test/integration-auth.test.cjs` — login flow, view-as toggles,
  role gate edges.
- `test/integration-passwords.test.cjs` — `/api/passwords` rotation:
  realRole gating, wrong-current rejection, DM rotation invalidates
  outstanding cookies while re-issuing the caller's, `auth.json`
  salted-hash shape, player set / clear-to-env-fallback, length
  validation.
- `test/integration-visibility.test.cjs` — `GET /api/data` filters
  DM-only entities for player callers; the strip is byte-level (the
  field is gone from the JSON, not just hidden).
- `test/integration-player-edits.test.cjs` — `_sanitizePlayerEntity`
  applied to player saves; visibility + `linkedTwinId` preserved or
  forced; secrets stripped; settings/campaign rejected.
- `test/integration-twins.test.cjs` — `POST /api/twin` create / link
  / unlink flows + cross-half cascade on delete.
- `test/integration-migration.test.cjs` — `runVisibilityMigration`
  stamps `visibility: 'public'` on legacy records and is idempotent
  on subsequent boots.
- `test/integration-sse.test.cjs` — `/api/events` emits `hello` and
  `data-changed` with the correct hash.
- `test/integration-snapshots.test.cjs` — snapshot/restore system:
  manual `POST /api/snapshots` bypasses the 60 s coalesce window;
  restore round-trip rolls `data/` back and records a `pre-restore`
  snapshot; role gating (list/create open to any role, restore/
  revert-last/delete DM-only; anonymous locked out); delete + 404
  paths. Uses manual snapshots as restore points so it never depends
  on wall-clock timing.
- `test/integration-restore.test.cjs` — `POST /api/restore` guards:
  backup-ZIP round-trip, `auth.json` never overwritten, addon-code
  entries under `data/addons/` refused (counted in `skipped`), auth
  required. The coverage for the `_safeJoinDataDir` anti-RCE guard.
- `test/integration-pets.test.cjs` — the `pets` collection is a plain
  PUBLIC list type (in `ALLOWED_TYPES` + `ALL_TYPES` only): any authed
  role can save / delete, `GET /api/data` returns pets to every caller
  (no visibility filtering), anonymous writes are 401.
- `test/integration-errors.test.cjs` — the terminal error handler +
  the `/api` JSON 404: an oversized upload → 400 `Upload error:
  LIMIT_FILE_SIZE`, an oversized `express.json` body → 413, malformed
  JSON → 400, an unknown `/api/*` path (GET + non-GET) → 404 JSON, and
  the guards that a real `/api` route isn't shadowed + a non-`/api` deep
  link still serves the SPA index.
- `test/helpers/` — shared bootstrap utilities for integration tests
  (start ephemeral server on a tempdir, drive HTTP, parse SSE).

To enable ESM imports of browser sources from a Node test,
`web/js/package.json` declares `{"type": "module"}` — that flag scopes
only to that directory and doesn't affect the CommonJS `server.js` /
`tiler.js` / `server-utils.cjs`.

Add new tests as `test/<name>.test.mjs` (browser-side, ESM) or
`test/<name>.test.cjs` (server-side, CommonJS). Server-side helpers
that need testing should be extracted into a separate CommonJS
module first — `server.js` itself starts the listener at import
time and isn't suitable for direct test imports. The pattern in use:
`server-utils.cjs` exports the side-effect-free helpers, server.js
re-binds them under their `_`-prefixed legacy names, tests import
the canonical names.

## Deployed surface area

The Dockerfile copies `package.json`, `server.js`,
`server-utils.cjs`, `tiler.js`, the `server/` directory, and `web/`.
- **Forgetting `tiler.js`** silently disables tile generation —
  `server.js` swallows the require error and falls back to a
  single-image overlay.
- **Forgetting `server-utils.cjs`** crashes the server at startup
  with `Cannot find module './server-utils.cjs'` (it's `require()`-d
  at the top of `server.js`, no fallback).
- **Forgetting the `server/` directory** crashes the server too —
  `server.js` requires `./server/visibility.cjs`,
  `./server/migrations.cjs`, `./server/addons.cjs`,
  `./server/addon-testing.cjs`, and `./server/addon-content.cjs` at
  module-load time. All are critical
  (role-aware filtering, the startup visibility-stamp migration, the
  addon broker, and the addon test green-gate respectively). `COPY
  server ./server` covers the whole dir.

Verify all four are COPYed when adding any new top-level server-side
module. The `web/icons-defaults/` directory ships the bundled
game-icons SVG markers (CC BY 3.0 — see `ATTRIBUTIONS.md`); it's part
of `web/` so the existing `COPY web ./web` covers it. The
`web/branding/logo-default.svg` placeholder logo ships the same way
(custom-uploaded logos live in the `data/branding/` volume instead).

`HEALTHCHECK` probes `GET /api/version` every 30 s. The endpoint
exercises `_dataHash` so a wedged data dir fails the check.

**Multiple instances, one image.** The image is stateless — all
per-deploy state lives in the `data/` + `data-snapshots/` volumes — so
several campaigns run the same image side by side (e.g. `tiamat` +
`asurai`), each with its own volumes, passwords, and hostname. Two
optional env vars let instances diverge without forking the code:
`CODEX_INSTANCE` (a label, surfaced in the boot log + `/api/version`)
and `CODEX_FEATURES` (space/comma list of per-instance addon flags;
empty = baseline behavior). Both are read once at boot into
module-level `INSTANCE` / `FEATURES` in `server.js`; a future addon
gates on `FEATURES` server-side (and the `/api/version` field
client-side). A third, `CODEX_RESTARTABLE=1` (also auto-detected via
`/.dockerenv`), sets module-level `RESTARTABLE` → enables `POST
/api/restart` + the DM "restart server" button; the compose sets it
explicitly alongside `restart: unless-stopped`. The `edit_session` cookie sets no `domain=`, so it's
host-scoped and sessions never bleed across hostnames even with
identical passwords. Deploy topology (per-stack compose + Caddy route)
lives in the infra repo, one `stacks/<instance>/` dir per campaign.
