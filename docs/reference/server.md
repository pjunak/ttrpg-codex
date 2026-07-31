# Server: API, snapshots, security, tests, deploy — deep reference (ttrpg-codex)

> Canonical server contract for APIs, persistence, recovery, authorization,
> synchronization, and deployment.

## Snapshot system

Successful campaign mutations request a coalesced point-in-time recovery point
of the entire JSON dataset under `data-snapshots/snapshot-<ISO>.json`
(sibling of `data/`, NOT a subdirectory — keeps the data hash clean,
simplifies restore path policy, and stops backup zips from carrying
their own history). A one-time migration on server boot moves any
pre-existing `data/snapshots/*` files into the new sibling dir, then
removes the empty subdir. Snapshot shape:

```json
{
  "version":   1,
  "id":        "snapshot-2026-04-21T12-34-56-789Z.json",
  "createdAt": "2026-04-21T12:34:56.789Z",
  "dataHash":  "abc123…",
  "reason":    "save" | "manual" | "pre-restore",
  "access":    "public" | "dm",
  "files":     { "characters.json": [...], "locations.json": [...], … },
  "fileDigests": {
    "characters.json": "<sha256>",
    "locations.json": "<sha256>"
  }
}
```

Persistence, metadata projection, retention, restore, and transaction-snapshot
lookup live in `server/snapshot-service.cjs`. The complete route family is
registered by `server/snapshot-routes.cjs`. `server.js` composes their explicit
filesystem, lock, hash, broadcast, and addon-reconciliation dependencies and
keeps only the `_createSnapshot`, `_maybeSnapshot`, and
`_hasTransactionSnapshot` aliases needed by other server services.

Snapshot creation is fail-closed: every tracked campaign JSON file must be
readable, valid JSON, and contain an object or array. A broken source file
aborts the whole recovery point instead of silently omitting it. Version-1
snapshots bind the exact file inventory and canonical parsed values to
per-file SHA-256 digests; reads and restores reject a mismatch. Historical
snapshots without `version` and `fileDigests` remain readable.

## Startup migrations

`server/migrations.cjs` owns idempotent data passes. `_bootstrap()` awaits
`runStartupMigrations()` before listening, injecting the production atomic
writer into each pass. The registry runs under the core write lock. Failures
are isolated per migration so a later pass and server startup still proceed.
If any pass changes data, the server creates one post-migration snapshot
(`reason: "migration"`) and broadcasts once.

Current passes:

- `visibility-public-v1` backfills visibility and removes legacy secrets from
  visibility-bearing collections.
- `timeline-sitting-zero-v1` changes only `events[].sitting === 0` to `1`;
  positive, missing, and null values plus unrelated event fields are unchanged.
- `campaign-shape-v1` owns the retired browser migrations: captured-character
  status, attitude normalization/tombstones, map status and pin size,
  retired location/artifact settings, party-faction promotion, and question
  object promotion. It also converts legacy array-shaped `deletedDefaults`
  to the keyed-object storage shape. Its pure transform lives in
  `server/campaign-shape-migration.cjs`.

All passes are transformation-idempotent, so an already canonical dataset
causes no write, snapshot, or broadcast.

## Core write lock

Every core disk mutation uses the single FIFO `CoreWriteLock` from
`server/core-write-lock.cjs`; `withWriteLock` remains the server-local facade.
Lock acquisition is bounded to **10,000 ms** by default and may be configured
with `CODEX_WRITE_LOCK_TIMEOUT_MS`. A queued request that reaches the bound is
cancelled and receives
`503 { error: "Write lock acquisition timed out",
code: "WRITE_LOCK_TIMEOUT", timeoutMs }`. Cancelled waiters are skipped when
the active holder eventually settles, so they can never execute as ghost
writes.

The timeout applies only while waiting to acquire the lock. Once a callback
owns the lock it retains ownership until its promise fulfills or rejects;
timeout handling never releases a live callback or permits overlapping core
writes. Ordinary callback rejection advances the queue normally. Addon
`host.withLock` uses this same lock. Its 30-second timer is diagnostic only:
it logs a suspected addon hang but cannot release ownership early.

`access:"dm"` marks an automatic snapshot created solely by a DM-only addon
write; it remains fully available to the DM but is absent from the player
metadata projection.

## Addon collection transactions

API-v2 addons can negotiate `collections.transactions` and call
`host.store.transaction(collectionNames, callback, { timeoutMs? })`. The
capability requires `data:own` plus at least one manifest-declared collection.
Only the calling addon's enabled, registered declarations may appear in the
read set; bare names are resolved under that addon id, so same-named
collections in other addons remain isolated. Effective-role checks apply to
every declaration, including `access:"dm"`.

The browser facade performs a short-lived two-phase exchange with
`POST /api/addons/:id/transactions`: `begin` captures every requested
container and its logical SHA-256 revision under the existing core write
queue; the callback reads that snapshot and buffers explicit `put`/`delete`
operations; `commit` reacquires the same queue and rejects the whole request
with `TX_CONFLICT` if any read-set revision changed. The lease is random,
single-use, role-bound, and expires in 250–10,000 ms (5,000 ms default).
Callback failure sends only `cancel`. Nested facade transactions are rejected
with `TX_NESTED`; duplicate writes to the same `(collection,id)` are rejected
with `TX_DUPLICATE_WRITE`.

Limits are 16 collections, 256 operations, 2 MiB total operation JSON, and
256 KiB per record. Transaction values must be finite, JSON-compatible plain
objects; forbidden prototype keys are rejected recursively. List and keyed
containers share `tx.collection(name).{list,get,put,remove}`. `put` requires
an explicit id.

The core queue remains the only write serializer. A separate
`PublicationBarrier` is a reader/writer visibility barrier, not a competing
write lock: ordinary dataset reads, role-scoped hash reads, and server-addon
collection reads take shared access; only the short multi-file publication
window takes exclusive access. Preparation and staging do not block readers.
Backup staging also uses the core queue, so it cannot race publication.

Durability lives under ignored `data/.runtime/transactions/tx-<random>/`.
Each changed collection has fsynced original and next JSON staging files. A
fsynced `journal.json` moves through `prepared`, `publishing`, and `committed`;
runtime publication copies each staged next file to a sibling temp, fsyncs it,
renames it over the target, then fsyncs the directory where the platform
supports directory handles. A runtime publication failure changes the journal
to `rolling-back` and restores every original before releasing the barrier.
If that restoration itself fails, the barrier is poisoned and the process
exits so no uncertain dataset is served; the `rolling-back` journal remains
for startup recovery.
Startup recovery runs before migrations, addon loading, or `listen()`:
`prepared`/`publishing` journals are idempotently rolled forward and
`rolling-back` journals are rolled back. A durable `committed` or `rolled-back`
journal is never replayed over later data; recovery applies any missing
post-commit effects and removes the completed journal. Journal-less preparation
directories are safe to remove. A malformed journal stops startup instead of
guessing whether publication began; no collection request is served until an
operator restores the journal/staged files or a known-good backup. Recovery
records its post-commit effects durably before removing the journal.
Transaction snapshots carry the internal commit id, so retrying recovery after
a crash recognizes an already-created snapshot instead of duplicating it.

The durability boundary is the local filesystem's same-volume rename and
fsync implementation. POSIX filesystems provide the intended rename and
directory-fsync guarantees. Windows provides atomic replacement through the
supported Node rename path with sharing-violation retries, but directory
fsync is not uniformly available and is best-effort. Network filesystems with
weaker rename/fsync semantics are outside the guarantee.

One successful logical commit invalidates role hashes once, creates at most
one coalesced `transaction` snapshot, and emits at most one `data-changed`
event per relevant audience. All-DM writes notify only DM connections; mixed
transactions notify players with the public projection hash and DMs with the
complete hash. Failed preparation/rollback emits no success event. A client
disconnect or deadline before the durable prepared journal cancels the
commit; after that durable commit point, recovery completes it and reconnect
hash comparison reveals the result even if the response/event was lost.

## Campaign restore publication

`POST /api/restore` uses `server/campaign-restore.cjs` rather than writing
uploaded entries into the live tree. ZIP scanning/extraction and complete JSON
shape validation happen first in a campaign-scoped OS-temp candidate directory
outside `data/` and outside the core write lock. Policy-refused ZIP entries are
reported as skipped; duplicate allowed paths or any extraction failure reject
the whole candidate.

After validation, the route acquires the core write lock, takes the
`pre-restore` snapshot, materializes the complete future campaign JSON overlay
by copying live authoritative files that the upload omitted, and runs the same
ordered migration set used at startup against that isolated tree. The
post-migration JSON shapes are validated again. A malformed supplied or live
campaign file, or a failed migration, aborts without changing live data.
`server/restore-candidate.cjs` owns this preparation boundary; generated/media
files remain opaque payloads. The prepared path set then goes to
`CampaignRestoreManager`, which durably stages both next files and any existing
originals under
`data/.runtime/restores/restore-<random>/`. Its fsynced journal follows the same
`prepared` → `publishing` → `committed` or `rolling-back` → `rolled-back`
contract as collection transactions. Publication holds the exclusive
`PublicationBarrier`; API dataset/hash readers and runtime static campaign
files (`/portraits`, `/maps`, `/icons`, `/branding`) cannot observe a mixed
old/new tree. A failed publication restores every original and removes targets
that did not exist before the restore.

Startup recovers restore journals before migrations or addon loading:
unfinished publication rolls forward, unfinished rollback rolls back, and
completed journals receive only missing idempotent effects/cleanup rather than
replaying old files. Malformed durable journals stop startup. Effects always
invalidate hashes/import previews. A live request also reconciles
`addons.json`, schedules map-tile rebuilding when needed, and broadcasts once;
startup recovery leaves add-on loading and the tile sweep to their normal later
bootstrap stages. Candidate and upload temporary files are cleaned on every
terminal path.

Restore preserves its historical overlay semantics: files absent from the ZIP
or JSON document retain their existing values. Authoritative JSON may still be
republished when a migration changes it as part of the complete candidate
state. The guarantee assumes local-filesystem same-volume atomic replacement
for the runtime journal and live `data/` tree; the upload/candidate directory
may be on another volume because it is copied into the runtime journal before
publication.

## Content-import provider jobs

Core registers the built-in `(core, campaign-bundle)` provider and owns the
DM-only `#/import` Import Center. Campaign bundle schema v1 creates characters,
locations, and relationships with explicit visibility, preview-reserved IDs,
typed local/stored references, derived connection symmetry, exact before/after
writes, a player projection, and map-placement evidence. It accepts no core
updates, deletes, media, twins, settings, auth, backups, or registry changes.
The current schema and campaign inventory are discoverable through the API.
The review UI recognizes DM Tools planning schema v2 directly. Contributed
`planning_items` provide nested plotline/quest ownership and typed
event/branch presentation; `planning_flow_links` of kind `continues` or
`option` are the only chronological/decision-flow authority. Named planning
references and core relationships remain supporting context. The legacy
`planning_links` `precedes`/`branches` preview shape remains readable, but the
browser never invents time, causality, or choice from prose, tags, array order,
or ownership. The questline diagram precedes diagnostics and selecting one of
its nodes opens that planning item's before/after review form. Every
materialized change expands into a read-only current-value form and, where the
original input record is identifiable, an editable source form.
Source edits and directly imported map-marker moves stay local and disable
commit. **Revalidate all edits** serializes the modified source into a new
input, creates a new job, and obtains a fresh plan/token; the prior job remains
intact until replacement preview succeeds. The client never mutates a
server-held plan, and commit remains bound to one exact validated preview
token.

API-v2 server addons negotiate
`imports.providers` and register versioned descriptors. Provider identity is
`(addonId, providerId)`. Provider API v1 accepts JSON, permits explicitly
granted core reads, and commits only to the provider addon's own declared
collections. Core writes and cross-addon access are unsupported and rejected.

`server/import-contract.cjs` is the shared live/harness authority for strict
raw JSON parsing, descriptors, collection references, provider output,
protected fields, diagnostics, stable plan digests, and limits.
`server/import-jobs.cjs` owns the explicit ephemeral state machine:

```text
created -> validating -> preview-ready -> committing -> completed
                 \-> failed/cancelled/expired
```

The upload is disk-staged under
`<os.tmpdir>/ttrpg-codex-imports/campaign-<data-dir-hash>/`, outside campaign
data. `CODEX_IMPORT_TEMP_DIR` replaces only the parent; cleanup remains
confined to the host-owned campaign child.
Startup removes and recreates that exact root, so all pre-restart previews are
invalidated. The file is also removed after preview parsing, failure,
cancellation, expiry, provider unload, and service disposal. MIME type and
extension are metadata hints only; the provider/strict parser validates
content. Provider v1 has no archive format.

Preview requires both verified `realRole:"dm"` and effective `role:"dm"`.
The initiating browser receives a random HttpOnly import-session cookie, and
jobs/tokens are random and owner-bound. The strict parser enforces byte,
nesting, array-record, string, and node limits before provider code. It parses
raw JSON itself so nested duplicate keys—including escape-equivalent keys—are
rejected before ordinary object construction. `__proto__`, `prototype`, and
`constructor` are forbidden recursively.

Declared read/write collections are captured consistently under the core write
queue. Provider work runs after releasing it and receives only cloned parsed
input, cloned declared reads/revisions, harmless metadata, stats, and an abort
signal. Preview creates no write, revision, snapshot, hash invalidation, or SSE
event. Host validation converts output to plan version 1, rejects undeclared
targets/deletes/duplicates/non-JSON values/protected metadata, and stores the
normalized plan in memory. The client receives a copy plus a random token
whose server-held digest includes the exact plan.

Commit accepts only the token. It consumes it before attempting publication,
checks owner/expiry/provider package/schema and every participating base
revision, and never reruns provider code. Ordinary addon providers commit
through their owned collection transaction. The host campaign provider uses
the scoped campaign journal: core-only plans stage core collection files,
while plans with registered addon contributions stage the allowlisted core and
DM-only addon paths together. Both paths provide old-or-new crash recovery,
one logical snapshot, and one role-scoped event. Contributor code runs only
during preview and never during commit. Any conflict or ambiguous failure
requires a new preview.
The completed commit summary remains on the owner-bound job until expiry and
is included by `GET /api/content-import/jobs/:jobId`. A browser that loses the
commit response checks that status and result; it never resubmits the
single-use token automatically.

Limits include 2 MiB host input, 32 nesting levels, 10,000 array records,
256 operations, five-minute job lifetime, 128 total jobs, 32 outstanding jobs
and four concurrent previews per addon, 16 outstanding jobs and two concurrent
previews per provider, addon/provider token buckets, and provider-declared
lower bounds. Provider
work is timeout/cancellation raced with an `AbortSignal`; a late result is
ignored. Disable/update/remove/content-revision changes unregister the provider
and invalidate its jobs without affecting unrelated providers.

**Coalescing:** `_maybeSnapshot` skips the write if the previous
snapshot is < 60 s old (`SNAPSHOT_COALESCE_MS`). Burst writes from a
single logical action (e.g. `saveLocation`'s peer cascade, or a user
mashing save) produce one snapshot covering the group.

**Retention:** `_pruneSnapshots` keeps the most recent 50 snapshots
(`SNAPSHOT_RECENT_KEEP`) plus the newest snapshot per UTC-day for
the last 14 days (`SNAPSHOT_DAILY_DAYS`). Called at the end of every
`_createSnapshot`. Addon code hashes referenced by any retained snapshot's
`addons.json` remain protected from the normal on-disk version prune, so
restoring an older registry cannot select already-deleted addon code.

**Restore:** `_restoreSnapshot(id)` validates the recovery point and takes a
complete `pre-restore` snapshot first. It stages the selected file set outside
`data/`, then publishes writes and deletions as one durable
`CampaignRestoreManager` journal behind the exclusive publication barrier.
Any JSON file present today that the snapshot did not have is removed in the
same operation. Failure rolls all files back; startup completes an interrupted
publication or rollback before listening. Post-commit effects invalidate
role-scoped hashes, reconcile addon registrations, and notify clients once.

**Revert-last-N:** `/api/snapshots/revert-last/:n` computes the target
snapshot as `files[files.length - 1 - n]` (snapshots are newest-last
in the ascending list), then calls `_restoreSnapshot`. Because automatic
recovery points coalesce bursts, N counts retained recovery points, not
individual edits.

## API

Auth column legend: `—` no auth · `any` any authenticated role · `dm`
DM only. The legacy `✓` marker (= DM only) has been replaced throughout
with `dm` for clarity now that some endpoints accept any authed role.

`server/auth.cjs` owns credential caching/persistence, cookie parsing and
issuance, role middleware/gates, login throttling, startup configuration
diagnostics, and all auth/password routes. `server.js` composes that service
with the durable writer and core write lock. `server/live-sync.cjs` similarly
owns the role-scoped SSE connection registry, caps, handshake, keepalive,
cleanup, and broadcasts; callers only publish named events or data changes.

**Privileged-endpoint gate.** The DM-only endpoints that gate on the
verified `realRole` (addon install/manage, twin ops, password
rotation, view-as) all route through the **`requireRealDM(msg?)`**
middleware factory in `server.js` (registered as route middleware,
e.g. `app.post(path, requireRealDM('…'), handler)`) rather than an
inline `if (req.realRole !== 'dm')`. The optional `msg` preserves each
route's exact Czech 403 text (defaults to `'Pouze pro DM'`). Centralising
it means a new privileged endpoint can't silently ship ungated. (Distinct
from `requireDM` = `requireRole('dm')`, which gates on the EFFECTIVE
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
| GET | `/api/data` | — | Full campaign JSON, role-filtered. Anonymous + player callers get `filterDatasetForRole(...)`: DM-only entities are dropped, `linkedTwinId` is stripped, every documented core reference is closed over surviving IDs, and API-v2 addon collections with `access:"dm"` are omitted before serialization. DM callers get strict identity. |
| PATCH | `/api/data` | any | `{ type, action, payload, baseRevision? }`. action is `save`\|`delete`. Validates the collection/action shape. When supplied, the 16-hex `baseRevision` must match the exact role-visible target record while the write lock is held; stale writes return `409 {code:"WRITE_CONFLICT", currentRevision}`. Successful responses include the new `revision`. Omission remains compatible with older clients. **Keyed-object collections** (treated as object on disk, `container[payload.id] = payload.data`): `factions`, `settings`, `campaign`, `deletedDefaults`, and keyed addon declarations. Player saves go through `_sanitizePlayerEntity`. Location saves and character/location/faction deletes delegate to the server-owned compound mutation service, which journal-publishes all invariant updates atomically. API-v2 addon collections with `access:"dm"` accept effective-DM requests only; a player receives the same generic 404 for a hidden declaration and an undeclared guessed addon type. |
| DELETE | `/api/campaign/enums/:category/:id` | dm | Atomically remove one settings enum item with `{replaceWith?, force?, tombstone?, baseRevision?}`. The revision covers the loaded enum category; stale requests return `WRITE_CONFLICT`. The server rechecks scalar/object-array usages and publishes definition, replacements, and tombstone through the core compound-mutation journal. |
| POST | `/api/addons/:id/transactions` | any | API-v2 `collections.transactions` transport. `{mode:"begin",collections,timeoutMs?}` returns a consistent snapshot, revisions, deadline, and opaque single-use id; `{mode:"commit",transactionId,operations}` performs revision-checked atomic publication; `{mode:"cancel",transactionId}` drops an unused lease. Every collection must be declared/owned, enabled, role-authorized, and covered by `data:own`. Structured failures use `TX_*` codes. Addons consume `host.store.transaction(...)`, not this transport directly. |
| GET | `/api/content-import/providers` | dm | Real and effective DM only. Lists active versioned provider declarations and host job/input limits. No job state is exposed. |
| GET | `/api/content-import/schemas/:schemaId` | dm | Return a registered host import JSON Schema. Version 1 publishes `campaign-bundle-v1`; unknown ids return 404. |
| GET | `/api/content-import/inventory` | dm-real | Return revisioned campaign identities for `characters`, `locations`, and `relationships`, plus active provider descriptors. `collections=` narrows the set and `includeBodies=true` includes cloned records for offline generation. |
| POST | `/api/content-import/jobs` | dm | Real and effective DM only. Multipart field `input` plus `addonId`, `providerId`, and `format`. Creates an owner-bound ephemeral job and stages at most 2 MiB outside campaign data. MIME/extension are hints, not trust decisions. |
| GET | `/api/content-import/jobs/:jobId` | dm | Return the initiating import session's safe job state. Wrong session and unknown id both return the same 404. |
| POST | `/api/content-import/jobs/:jobId/preview` | dm | Strict-parse and run the registered provider under timeout/cancellation, validate a normalized read-only plan, delete staged input, and return the server-bound preview token. |
| POST | `/api/content-import/jobs/:jobId/commit` | dm | `{previewToken}` only. Consumes the token, verifies provider/package/schema/base revisions, and commits the exact stored operations atomically. Stale state is `409 IMPORT_REVISION_CONFLICT`; provider transformation is never rerun. |
| DELETE | `/api/content-import/jobs/:jobId` | dm | Abort provider work, invalidate any preview token, mark the owner-bound job cancelled, and remove staged input. |
| POST | `/api/twin` | dm | DM-only. `{ action: 'create' \| 'link' \| 'unlink', type, sourceId, targetId? }`. Manages twin entity pairs: `create` clones the source into the opposite visibility space and bidirectionally sets `linkedTwinId`; `link` marries two existing entities (one public, one DM-only); `unlink` clears the pair. Atomicity: both sides written inside one `withWriteLock` pass. Broadcasts `data-changed`. See "Twin entity model" section. |
| GET | `/api/version` | — | `{ hash, instance, features, canRestart }`. `hash` is role-scoped: DM hashes cover all tracked data, while player/anonymous hashes cover only their authorized `/api/data` projection and therefore do not change for DM-only addon writes. |
| POST | `/api/restart` | dm | DM-only on **realRole**. Restart the server process by exiting cleanly so the supervisor (Docker `restart: unless-stopped` / systemd / pm2) brings it back up — the only way to reload in-process addon **server code** after an install/update/rollback without a manual `docker restart`. **400** when not `RESTARTABLE` (`CODEX_RESTARTABLE=1` or `/.dockerenv` detected) — exiting bare would just take the wiki down. Responds first, drains the write lock, then `process.exit(0)`; the client (`Settings.restartServer`) shows a full-screen overlay that polls `/api/version` (down→up) and reloads. No Docker-socket access. |
| POST | `/api/addons/update-all` | dm | DM-only on **realRole**. Update EVERY addon from a real GitHub repo to its latest commit in one shot — the per-addon update flow, looped (re-resolve stored ref→latest SHA, stage+promote via the same green-gate / content-hash / kept-versions pipeline a single install uses). Local (dev-installed, `repo:'local'`) addons are skipped. Returns `{ ok, updated[], skipped[], errors[], serverChanged }` (`serverChanged` = any updated addon ships server code → the client suggests a restart). Broadcasts `addons-changed`. |
| GET | `/api/events` | — | Role-scoped SSE. `hello` carries the caller's authorized hash. Public writes emit `data-changed {hash,at}` to every role with its own hash; DM-only addon writes emit only to effective-DM connections. The client accepts updates through its single-flight coordinator. |
| POST | `/api/login` | — | `{ password }` sets `edit_session` cookie. Tries DM credential first, then player. |
| POST | `/api/logout` | — | Clear `edit_session` cookie. Idempotent. |
| GET | `/api/auth` | — | `{ role, realRole }`. Anonymous = both null. |
| POST | `/api/view-as` | dm | DM-only. Re-issue cookie with effective role=`player` (realRole=`dm` preserved). |
| POST | `/api/view-as-dm` | dm | DM-only. Flip effective role back to `dm` from an active impersonation. |
| GET | `/api/passwords` | dm | DM-only. Report presence flags for DM/player credentials (`{stored, updatedAt, envFallback, isDefault?, disabled?}`). Never reveals hash/salt. |
| POST | `/api/passwords` | dm | DM-only. `{ role: 'dm' \| 'player', newPassword, currentPassword }`. Validates `currentPassword` against the active DM credential, writes `{salt, hash, updatedAt}` to `data/auth.json` via `withWriteLock`. Empty `newPassword` is allowed only for `role:'player'` (clears the stored credential). Re-issues the caller's cookie on DM-password change so they stay logged in. |
| POST | `/api/portrait/:charId` | any | Stage and journal-replace a portrait multipart upload under the core lock and static publication barrier. |
| DELETE | `/api/portrait/:identifier` | any | Journal-remove a portrait file or one character's portrait files. |
| POST | `/api/localmap/:locId` | any | Atomically replace `data/maps/local/{locId}/map.{ext}`, return `{url}`, then schedule an immutable tile-generation build. |
| POST | `/api/worldmap` | dm | Atomically replace `data/maps/swordcoast/sword_coast.{ext}` and remove the prior extension in the same media journal, return `{url}`, then schedule an immutable tile-generation build. Max 40 MB. |
| POST | `/api/logo` | dm | Atomically replace `data/branding/logo.{ext}` through the media journal. Max 5 MB. DM-only. |
| DELETE | `/api/logo` | dm | Journal-remove the custom logo so the bundled default takes over. Idempotent. |
| GET | `/branding/:file` | — | Static-served from `data/branding/` with `fallthrough: true`, so `/branding/logo-default.svg` (which lives in `web/branding/`) passes through to the WEB_DIR handler. `maxAge: '7d'`. |
| POST | `/api/icons/:pinTypeId` | dm | Upload up to 16 marker-icon variants (svg/png/jpeg/webp, 2 MB each). The bounded memory batch is validated under the core lock, collision-resolved, then journal-published atomically. |
| DELETE | `/api/icons/:pinTypeId/:filename` | dm | Journal-remove one validated marker-icon variant. |
| DELETE | `/api/icons/:pinTypeId` | dm | Journal-remove every regular file in the pin-type directory; unexpected nested/symlink entries fail closed. |
| GET | `/icons/:pinTypeId/:filename` | — | Static-served from `data/icons/`. `maxAge: '7d'`. |
| GET | `/maps/tiles/:mapId/tiles.json` | — | Atomically replaced manifest `{width,height,tileSize,minZoom,maxZoom,ext,generation,srcHash}`. Missing/invalid falls back to `imageOverlay`; legacy generation-less manifests remain readable. |
| GET | `/maps/tiles/:mapId/:generation/:z/:x/:y.:ext` | — | Tile from one immutable `g-<sourceHash>` generation. Three complete generations are retained. |
| GET | `/api/backup` | dm | Download a point-in-time copy of `data/` as ZIP. The server creates an OS-temp staging directory outside campaign data, copies the complete tree under the core write lock (excluding `secrets.json` and `.runtime/`), releases the lock, then compresses/streams the staged `data/` tree. Addon data, registry, addon code, `auth.json`, paths, and restore format remain unchanged. Staging is removed after success, copy/archive failure, stream error, or client abort. DM-only because raw JSON contains DM-only entities. ⚠ **archiver v8 is ESM** — the route retains the `new archiver.ZipArchive(opts)` / legacy factory compatibility path. |
| POST | `/api/restore` | dm | Publish an uploaded backup overlay (multipart field `backup`). Accepts a `/api/backup` ZIP (`data/...`) or `Store.exportJSON()` document. Upload and complete candidate validation happen in campaign-scoped OS temp storage before the core write lock; the locked phase takes a `pre-restore` snapshot and journal-publishes the file set through `CampaignRestoreManager` and the exclusive publication barrier. Failure rolls every file back; startup completes an interrupted publication/rollback before listening. ZIP policy refuses `auth.json`, `secrets.json`, `data/addons/**`, `.runtime/**`, traversal/symlink escapes, and snapshot paths; refused policy entries are counted, while duplicate allowed paths or extraction errors reject the whole candidate. 200 MB upload, 200 MB per expanded entry, 1 GB total expanded, and 50,000-entry limits. Responds `{ok,format,restored,skipped?}` and preserves overlay semantics for files absent from the input. |
| GET | `/api/snapshots` | any | List point-in-time snapshots. DM gets `{id,createdAt,dataHash,reason,access,size}`. Player projections omit snapshots created solely by DM-only addon writes and omit every hash/size. Contents never leave the server. |
| POST | `/api/snapshots` | any | Take a manual snapshot now. Returns `{ ok, id }`. Bypasses the 60 s coalesce window. Players can pin a known-good point before a risky edit. Rate-limited: min 3 s between manual snapshots (`CODEX_SNAPSHOT_MIN_INTERVAL_MS`; the test helper sets 0) — a manual snapshot holds the write lock for a full-dataset copy. |
| POST | `/api/snapshots/:id/restore` | dm | Restore a validated snapshot through the durable campaign journal. Takes a complete `pre-restore` snapshot first; failure aborts or rolls back the whole publication. |
| POST | `/api/snapshots/revert-last/:n` | dm | Restore the snapshot N recovery points back from the newest. Automatic coalescing means N is not an edit count. |
| DELETE | `/api/snapshots/:id` | dm | Delete one snapshot file. |
| GET | `/api/addons` | — | Role-scoped installed-addon projection. It includes compatibility/lifecycle metadata needed for client boot. Effective DM callers receive normalized collection `{name,keyed,access}` declarations; player/anonymous/view-as callers receive public declarations only, so hidden collection names and shapes are absent. Invalid declarative content reports a blocked/content-error state; detailed file diagnostics are DM-only. |
| ANY | `/api/addon/:id/*` | — | **Namespaced server-addon routes** (singular). A stable dispatcher (before the SPA fallback) delegates to the enabled addon's `express.Router()` built by its `init(serverHost)`. `req.role`/`realRole` are stamped (the addon self-gates); an unmatched sub-path or a disabled/absent/errored addon → JSON 404. Each addon's routes are isolated under its own id. **When the addon has no live router but declares manifest `contentDir`, the host answers the four GET content endpoints itself** (`/content`, `/content/:kind`, `/item/:kind/:id`, `/kinds`) from the bundled per-record JSON tree. Content trees are accepted atomically: malformed JSON/records, missing ids, duplicate `(kind,id)` identities, unreadable paths, or symlinks block only that addon. A live router takes precedence entirely for a valid package. |
| POST | `/api/addons/install` | dm | DM-only on **realRole**. `{ repo, ref?, sha? }`. `repo` is a pasted GitHub URL or `owner/name`. When the wizard passes the previewed `sha`, installation pins to that exact reviewed commit while retaining the original ref for future update checks. The host bounds and scans the ZIP before writing, validates the manifest/locales/content tree, content-hashes the staged package, runs declared server tests, atomically promotes the package, updates `data/addons.json`, and broadcasts `addons-changed`. Upsert by id is an update. |
| POST | `/api/addons/preview` | dm | DM-only on **realRole**. `{ repo, ref? }`. Resolves + fetches **just `addon.json`** (GitHub contents API — no download/install) via `AddonBroker.fetchManifest`, validates it, returns `{ repo, ref, sha, ok, errors, manifest:{…} }` so the wizard shows the requested permissions for DM review BEFORE granting. The returned `ref` (original branch/tag) + `sha` (exact commit) both feed back into install. |
| POST | `/api/addons/check-updates` | dm | DM-only on **realRole**. Pure read: resolve each GitHub addon's stored ref to its latest SHA and compare with the installed SHA. Per-addon failures are isolated; applying an update still opens the review wizard. |
| POST | `/api/addons/:id/rollback` | dm | DM-only on **realRole**. `{ hash? }`. Flip `activeHash` to a retained version and restore that version's manifest-derived metadata. Returns 400 if no usable prior version exists; server-code changes require restart. |
| POST | `/api/addons/sources` | dm | DM-only on **realRole**. `{ repo, action? }` — add (default) or `remove` a recorded source (`owner/name` or `owner/*`) in `sources.allow`. Mostly auto-managed by install; this is the advanced manual lever. Broadcasts `addons-changed`. |
| POST | `/api/addons/resolve` | dm | DM-only on **realRole**. `{ target, winner }` — resolve a fragment-override conflict: `winner` = an addonId (that addon's exclusive op wins), `null` (force the built-in), or absent/empty (clear → back to auto). Writes `resolutions[target]` in `data/addons.json` (prototype-key-guarded), broadcasts `addons-changed`. See **Fragment overrides**. |
| POST | `/api/addons/:id/enable` · `/disable` | dm | DM-only on **realRole**. Flip `enabled` on an installed addon; broadcasts `addons-changed` (clients live-reconcile). 404 if unknown. |
| POST | `/api/addons/github-token` | dm | DM-only on **realRole**. `{ token }` — set (non-empty; shape-validated: printable ASCII, no spaces, 8–255 chars) or clear (empty/absent) the **stored GitHub token** in `data/secrets.json`. The stored token wins over the env vars (`_githubToken`). Replies `{ ok, configured, source }` — NEVER the value; the file is excluded from backup/snapshots/hash/restore (`NON_DATA_JSON_FILES` + the `/api/backup` filter). Broadcasts `addons-changed`. Set from the install wizard's 🔑 section. |
| POST | `/api/addons/:id/content-groups` | dm | DM-only on **realRole**. `{ disabled: string[] }` — replace wholesale which manifest `contentGroups` values are disabled for a content addon (registry key `disabledContentGroups`). Hot: `_applyAddonContent` re-filters the served tree from the in-memory raw cache, changing `contentRevision`; `addons-changed` makes clients dispose/re-register the addon and its loaded consumers, while `data-changed` refreshes campaign data. No browser reload is required. 400 if the addon declares no `contentGroups`; unknown group ids are stored as-is (match nothing — forward-compatible). |
| DELETE | `/api/addons/:id` | dm | DM-only on **realRole**. Remove an addon: drop it from the registry (clearing any `resolutions` pointing at it) + delete its code dir `data/addons/<id>/`. Per-addon DATA `data/addon-data/<id>/` is **kept** unless `?purge=1`, so a re-install restores content. Broadcasts `addons-changed`. |

## Visibility closure

`server/visibility.cjs:filterDatasetForRole` treats the player payload as a
closed graph, not as independently filtered collection buckets. It is a pure
two-pass transform:

1. Drop `visibility:'dm'` records from every core visibility-bearing
   collection and strip `linkedTwinId` from survivors.
2. Build survivor-ID sets, then remove every reference that no longer resolves:
   relationship endpoints (including location-target relationship types),
   character faction/location/location-role fields, location parent/connection/
   legacy-character fields, event/mystery/history character+location arrays,
   event map parents, artifact owners/locations, pet owners, saved local-map
   views/configs, and hidden scalar values in `lastChange.fields`.

The reserved `character.faction` values `neutral` and `party` remain valid even
though they are not records in `factions.json`. Invalid optional scalar fields
are omitted; invalid ID-array entries are removed; pets whose character/faction
owner is hidden become `{ownerType:'none', ownerId:''}` in the player projection.
The source dataset is never mutated. A DM call returns the original dataset by
identity, which is both the behavior and the regression-test contract.

Addon API-v1 collection declarations expose only `{name,keyed}` and remain
public/schema-opaque. Do not guess at references inside them. API-v2
`access:"dm"` declarations require the negotiated `collections.dm`
capability; their metadata and containers are removed before the player
projection is serialized. The host still does not infer arbitrary
cross-collection references inside addon records.

## Write serialisation

All routes that mutate disk state run inside `withWriteLock(async
() => { … })` — the bounded FIFO mutex serialises PATCH `/api/data`,
snapshot mutation, backup staging, restore publication, add-on registry
changes, add-on-owned transactions, core compound mutations, and media
publication. Expensive restore validation and multipart parsing stay outside
the lock; only their staged publication phases own it.

`server/durable-files.cjs` owns the fsync, unique same-directory temporary
file, sharing-violation retry, durable copy, durable JSON write, and durable
unlink primitives shared by ordinary core mutations, addon transactions, and campaign
restore. `server/media-publication.cjs` composes those primitives with a
dedicated recoverable journal for portraits, maps, logos, and icon batches;
runtime static reads share the publication barrier. `server.js` wraps
`durableWrite` only to invalidate role-scoped data hashes after successful JSON
publication. Do not bypass the lock or publication manager for a multi-file
write.

`server/campaign-mutations.cjs` is the authoritative boundary for core
cross-record invariants. It owns twin pairing, undirected location connection
symmetry, and character/location/faction delete cascades. A compound result is
journal-published through `data/.runtime/mutations/` behind the same
publication barrier, so readers see either the old campaign graph or the
complete new graph. The browser mirrors those transforms for immediate
rendering but sends only the primary PATCH; it does not persist peers one by
one. Startup recovers an interrupted compound publication before migrations
or listening.

## Path-safety helper

`server.js` exposes `_safeJoinIn(dir, rel)`: resolves `rel` inside
`dir` and returns the absolute path only if the result is genuinely
contained — rejects traversal (`..`), absolute paths, null bytes,
*and* symlink escapes (every existing prefix is `realpath`-checked).
Used by:
- portrait migration (PATCH `/api/data` for characters with a
  non-canonical `payload.portrait`),
- `_restoreRelativePath` (restore zip entry policy validation). Snapshots now
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

The production dependency graph is expected to pass `npm audit --omit=dev`.
`package.json` pins transitive `brace-expansion` to `5.0.8` through an npm
override because `archiver` reaches it through `readdir-glob` / `minimatch`;
keep the override until that chain declares a non-vulnerable version directly.
The backup integration tests guard compatibility with the overridden graph.

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

Run the repository gate from the host root:

```powershell
npm run check
```

`npm run check:ci` applies the same zero-warning lint rules and full suite
with file concurrency capped for CI. Browser-module tests use `*.test.mjs`;
server and integration tests use `*.test.cjs`. Integration suites boot the
real Express app against isolated temporary data and drive it over HTTP.

The test filenames are the maintained inventory; do not duplicate an exhaustive
list here. Coverage is organized around these contracts:

- pure helpers, revisions, descriptors, parsers, migrations, and UI state;
- Store loading/transport/retry behavior and SSE single-flight coordination;
- auth, role projection, visibility closure, and player-write sanitization;
- durable single-file writes, compound mutations, media publication,
  transactions, restore journals, snapshots, backup staging, and crash recovery;
- addon compatibility, registration, permissions, lifecycle, archives,
  localization, content groups, imports, graph isolation, and update/rollback;
- maps, timeline ordering, Settings controllers, drafts/login/lore controllers,
  i18n keys, and design-system residue.

When adding a contract, add a focused unit test and an integration test whenever
the behavior crosses HTTP, roles, disk publication, restart recovery, or addon
lifecycle. Extract side-effect-free server logic into a CommonJS module instead
of importing `server.js`, which starts the listener.

`web/js/package.json` declares `{"type":"module"}` only for browser-source
imports in Node tests; the server remains CommonJS. CI also checks the host
revision against DM Tools and Character Sheets, and runs the private Compendium
suite when `ADDON_SUITE_TOKEN` is configured.

## Deployed surface area

The Dockerfile copies the package manifests, `server.js`,
`server-utils.cjs`, `tiler.js`, the complete `server/` directory, the
startup-loaded `schemas/` directory, and `web/`.
Keep server services under `server/` so `COPY server ./server` remains the
deployment boundary; a new top-level runtime file needs an explicit Dockerfile
entry. Import schemas are read synchronously before bootstrap and therefore
must remain inside the image; `test/docker-runtime-assets.test.cjs` guards that
boundary. `tiler.js` is the only optional-at-runtime module: failure to load it
degrades maps to a single-image overlay.

The `web/icons-defaults/` directory ships the bundled
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
and `CODEX_FEATURES` (an opaque space/comma list returned by
`/api/version`; it has no built-in behavior). Both are read once at boot.
A third, `CODEX_RESTARTABLE=1` (also auto-detected via
`/.dockerenv`), sets module-level `RESTARTABLE` → enables `POST
/api/restart` + the DM "restart server" button; the compose sets it
explicitly alongside `restart: unless-stopped`. The `edit_session` cookie sets no `domain=`, so it's
host-scoped and sessions never bleed across hostnames even with
identical passwords. Deploy topology (per-stack compose + Caddy route)
lives in the infra repo, one `stacks/<instance>/` dir per campaign.
