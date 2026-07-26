const express      = require('express');
const helmet       = require('helmet');
const multer       = require('multer');
const archiver     = require('archiver');
const fs           = require('fs');
const fsp          = fs.promises;
const os           = require('os');
const path         = require('path');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');

const {
  isForbiddenKey, safeJoinIn, pickKeptSnapshots,
} = require('./server-utils.cjs');
const { createAuthService } = require('./server/auth.cjs');
const { CoreWriteLock, WriteLockTimeoutError } = require('./server/core-write-lock.cjs');
const { PublicationBarrier } = require('./server/publication-barrier.cjs');
const {
  CollectionTransactionManager,
  TransactionError,
  revisionOf,
} = require('./server/collection-transactions.cjs');
const { ImportError, LIMITS: IMPORT_LIMITS, collectionRefKey } = require('./server/import-contract.cjs');
const { ImportJobManager } = require('./server/import-jobs.cjs');
const {
  createByteLimiter,
  openEntryStream,
  walkZipEntries,
} = require('./server/zip-reader.cjs');
const {
  createSnapshotService,
  isSnapshotFileKey,
} = require('./server/snapshot-service.cjs');
const { registerSnapshotRoutes } = require('./server/snapshot-routes.cjs');
const { CampaignRestoreManager } = require('./server/campaign-restore.cjs');
const {
  CampaignMutationError,
  CampaignMutationService,
} = require('./server/campaign-mutations.cjs');
const { writeRevision } = require('./server/write-revision.cjs');
const { durableWrite } = require('./server/durable-files.cjs');
const {
  MediaPublicationService,
  acceptsImage,
  createUploadStorage,
  imageExtension,
} = require('./server/media-publication.cjs');
const { createLiveSyncService } = require('./server/live-sync.cjs');

// Role-aware filtering of the dataset (`server/visibility.cjs`) and
// the startup migration that backfills `visibility:'public'` on every
// pre-existing record (`server/migrations.cjs`). Both are pure-ish
// (visibility is pure; migrations only touch DATA_DIR through the
// caller-supplied writer) so they're importable from node --test.
const {
  filterDatasetForRole,
  VISIBILITY_BEARING,
} = require('./server/visibility.cjs');
const {
  CAMPAIGN_MIGRATIONS,
} = require('./server/migrations.cjs');
const {
  RestoreCandidateError,
  prepareRestoreCandidate,
  validateRestoreCandidate,
} = require('./server/restore-candidate.cjs');

// Addon framework broker — pure/injectable helpers (manifest validation,
// allowlist matching, content hashing, GitHub fetches) plus the streaming
// untrusted-archive extractor used by production installs.
// See server/addons.cjs. No module-level side effects.
const AddonBroker = require('./server/addons.cjs');
const AddonArchive = require('./server/addon-archive.cjs');
const AddonTesting = require('./server/addon-testing.cjs');
const AddonContent = require('./server/addon-content.cjs');
const AddonLocalization = require('./server/addon-localization.cjs');

const app  = express();
const PORT = process.env.PORT || 3000;

// Per-instance identity + addon flags. Multiple containers run the SAME
// image off isolated data volumes (e.g. tiamat + asurai); these env vars let
// one instance enable behavior the other doesn't, so a campaign-specific
// addon on one site can't affect the other. `CODEX_INSTANCE` is a display
// label (surfaced in logs + GET /api/version); `CODEX_FEATURES` is a
// space/comma-separated flag list. Empty FEATURES = baseline behavior, so an
// instance that sets neither is byte-for-byte the current app.
const INSTANCE = process.env.CODEX_INSTANCE || 'default';
const FEATURES = (process.env.CODEX_FEATURES || '').split(/[\s,]+/).filter(Boolean);

// Whether the server may restart ITSELF by exiting and letting a process
// supervisor bring it back up. True under Docker (the compose sets
// `restart: unless-stopped`) or when an operator opts in via CODEX_RESTARTABLE=1
// (systemd/pm2 with auto-restart). This gates the DM "restart server" button +
// POST /api/restart — exiting WITHOUT a supervisor would just take the wiki down,
// so both hide/refuse when this is false. It's the only way to reload in-process
// addon SERVER code after an install/update/rollback without a manual restart.
const RESTARTABLE = process.env.CODEX_RESTARTABLE === '1' || fs.existsSync('/.dockerenv');

// Global safety net for the single-process server. Every mutating endpoint
// already try/catches inside its `withWriteLock` callback, but those promises
// are fire-and-forget — so a future uncaught throw on a write path would
// otherwise terminate the process silently (Node ≥15 exits on an unhandled
// rejection). Log loudly. We KEEP RUNNING on a stray rejection (a hobby
// self-host shouldn't drop the wiki mid-session over one bad async path) but
// EXIT on a truly uncaught exception (the process state is undefined) so the
// container restart policy can recover cleanly.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

// Trust the first reverse-proxy hop so req.ip / cookie `secure` work
// correctly when deployed behind nginx/Caddy/Traefik (the standard
// docker-compose layout uses an external `proxy` network).
app.set('trust proxy', 1);

// Re-bind the imported helpers under the `_`-prefix names that the
// rest of this file was written against. Keeps the diff at the call
// sites minimal while still letting tests import the canonical names
// from server-utils.cjs.
const _isForbiddenKey = isForbiddenKey;

// All on-disk paths derive from these two roots so integration tests
// can override CODEX_DATA_DIR / CODEX_SNAPSHOTS_DIR to a tempdir and
// run the server against an isolated dataset.
const DATA_DIR       = process.env.CODEX_DATA_DIR
                       || path.join(__dirname, 'data');
const PORTRAITS_DIR  = path.join(DATA_DIR, 'portraits');
const MAPS_DIR       = path.join(DATA_DIR, 'maps');
const LOCAL_MAPS_DIR = path.join(MAPS_DIR, 'local');
const TILES_DIR      = path.join(MAPS_DIR, 'tiles');
const SWORDCOAST_DIR = path.join(MAPS_DIR, 'swordcoast');
const ICONS_DIR      = path.join(DATA_DIR, 'icons');
// Site branding (custom logo). The uploaded file lives here as
// `logo.<ext>`; the bundled placeholder ships in `web/branding/`
// and is reached through fallthrough on the static mount below.
const BRANDING_DIR   = path.join(DATA_DIR, 'branding');
// Snapshots live OUTSIDE data/ so:
//   - the data hash and the backup zip don't have to keep stepping
//     around them.
//   - the restore zip can never inadvertently plant or overwrite a
//     legitimate snapshot via restore path policy.
//   - "data/" stays a clean reflection of the campaign content.
// One-time migration below moves any pre-existing data/snapshots/* up.
const SNAPSHOTS_DIR  = process.env.CODEX_SNAPSHOTS_DIR
                       || path.join(__dirname, 'data-snapshots');
const BACKUP_STAGING_ROOT = process.env.CODEX_BACKUP_STAGING_DIR
                            || path.join(os.tmpdir(), 'ttrpg-codex-backups');
const LEGACY_SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const WEB_DIR        = path.join(__dirname, 'web');

// Addon framework: installed addon CODE is laid down content-addressed
// under data/addons/<id>/<hash>/ and served same-origin from /addons.
// Each addon's own runtime DATA lives isolated under data/addon-data/<id>/.
// The registry (installed/enabled/permissions/allowlist) is the top-level
// data/addons.json so it rides snapshots + the data hash like a collection.
const ADDONS_DIR           = path.join(DATA_DIR, 'addons');
const ADDON_DATA_DIR       = path.join(DATA_DIR, 'addon-data');
const ADDONS_REGISTRY_FILE = path.join(DATA_DIR, 'addons.json');
const TRANSACTION_RUNTIME_DIR = path.join(DATA_DIR, '.runtime', 'transactions');
const RESTORE_RUNTIME_DIR = path.join(DATA_DIR, '.runtime', 'restores');
const MEDIA_RUNTIME_DIR = path.join(DATA_DIR, '.runtime', 'media');
const MUTATION_RUNTIME_DIR = path.join(DATA_DIR, '.runtime', 'mutations');
const IMPORT_TEMP_BASE = process.env.CODEX_IMPORT_TEMP_DIR
  || path.join(os.tmpdir(), 'ttrpg-codex-imports');
const IMPORT_TEMP_ROOT = path.join(
  IMPORT_TEMP_BASE,
  `campaign-${crypto.createHash('sha256')
    .update(path.resolve(DATA_DIR))
    .digest('hex')
    .slice(0, 16)}`,
);
const RESTORE_STAGING_BASE = process.env.CODEX_RESTORE_STAGING_DIR
  || path.join(os.tmpdir(), 'ttrpg-codex-restores');
const RESTORE_STAGING_ROOT = path.join(
  RESTORE_STAGING_BASE,
  `campaign-${crypto.createHash('sha256')
    .update(path.resolve(DATA_DIR))
    .digest('hex')
    .slice(0, 16)}`,
);
const MEDIA_STAGING_BASE = process.env.CODEX_MEDIA_STAGING_DIR
  || path.join(os.tmpdir(), 'ttrpg-codex-media');
const MEDIA_STAGING_ROOT = path.join(
  MEDIA_STAGING_BASE,
  `campaign-${crypto.createHash('sha256')
    .update(path.resolve(DATA_DIR))
    .digest('hex')
    .slice(0, 16)}`,
);
const MUTATION_STAGING_BASE = process.env.CODEX_MUTATION_STAGING_DIR
  || path.join(os.tmpdir(), 'ttrpg-codex-mutations');
const MUTATION_STAGING_ROOT = path.join(
  MUTATION_STAGING_BASE,
  `campaign-${crypto.createHash('sha256')
    .update(path.resolve(DATA_DIR))
    .digest('hex')
    .slice(0, 16)}`,
);

fs.mkdirSync(DATA_DIR,       { recursive: true });
fs.mkdirSync(PORTRAITS_DIR,  { recursive: true });
fs.mkdirSync(LOCAL_MAPS_DIR, { recursive: true });
fs.mkdirSync(TILES_DIR,      { recursive: true });
fs.mkdirSync(SWORDCOAST_DIR, { recursive: true });
fs.mkdirSync(ICONS_DIR,      { recursive: true });
fs.mkdirSync(SNAPSHOTS_DIR,  { recursive: true });
fs.mkdirSync(ADDONS_DIR,     { recursive: true });
fs.mkdirSync(ADDON_DATA_DIR, { recursive: true });
fs.mkdirSync(TRANSACTION_RUNTIME_DIR, { recursive: true });
fs.mkdirSync(RESTORE_RUNTIME_DIR, { recursive: true });
fs.mkdirSync(MEDIA_RUNTIME_DIR, { recursive: true });
fs.mkdirSync(MUTATION_RUNTIME_DIR, { recursive: true });

// Idempotent relocation: any leftover snapshots inside data/ are
// moved to the sibling directory.
try {
  if (fs.existsSync(LEGACY_SNAPSHOTS_DIR)) {
    const list = fs.readdirSync(LEGACY_SNAPSHOTS_DIR);
    for (const f of list) {
      if (!/^snapshot-.*\.json$/.test(f)) continue;
      const src = path.join(LEGACY_SNAPSHOTS_DIR, f);
      const dst = path.join(SNAPSHOTS_DIR, f);
      try {
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
        else fs.unlinkSync(src);
      } catch (e) { console.warn(`[snapshot migrate] ${f}: ${e.message}`); }
    }
    try { fs.rmdirSync(LEGACY_SNAPSHOTS_DIR); } catch (_) {}
    console.log('[snapshot] migrated legacy data/snapshots → data-snapshots');
  }
} catch (e) { console.warn('[snapshot migrate]', e.message); }

// CSP remains off while the UI relies on inline style attributes. All scripts
// are external modules, so script policy can be enabled independently later.
// CDN fonts and scripts do not consistently send explicit CORP headers.
app.use(helmet({
  contentSecurityPolicy:     false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
const _auth = createAuthService({
  dataDir: DATA_DIR,
  atomicWrite: _writeJsonFile,
  withWriteLock,
});
const {
  attachRole,
  registerRoutes: registerAuthRoutes,
  requireAnyRole,
  requireDM,
  requireRealDM,
} = _auth;
app.use(attachRole);

// ── data/secrets.json — server-held secrets settable from the UI ──
// Today one key: { githubToken } (set/cleared by the DM from the addon
// install wizard). Same posture as auth.json (NON_DATA_JSON_FILES → no
// snapshots, no data hash, restore refuses it) PLUS excluded from the
// /api/backup ZIP: a stored token is a live plaintext credential and must
// never ride into a shareable archive. Never sent to a client, never logged.
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
let _secretsCache = null;
function _clearSecretsCache() { _secretsCache = null; }
function _loadSecrets() {
  if (_secretsCache) return _secretsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    _secretsCache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[secrets] failed to read secrets.json:', e.message);
    _secretsCache = {};
  }
  return _secretsCache;
}
async function _writeSecrets(next) {
  await _writeJsonFile(SECRETS_FILE, JSON.stringify(next, null, 2));
  try { await fsp.chmod(SECRETS_FILE, 0o600); } catch (_) {}
  _clearSecretsCache();
}

function publicationRead(req, res, next) {
  let release;
  const completed = new Promise(resolve => { release = resolve; });
  const done = () => {
    res.off('finish', done);
    res.off('close', done);
    release();
  };
  res.once('finish', done);
  res.once('close', done);
  _publicationBarrier.read(async () => {
    if (res.destroyed) return;
    next();
    await completed;
  }).catch(next);
}

app.use('/portraits', publicationRead, express.static(PORTRAITS_DIR));
app.use('/maps',      publicationRead, express.static(MAPS_DIR));
app.use('/icons',     publicationRead, express.static(ICONS_DIR, { maxAge: '7d', fallthrough: true }));
// Custom-uploaded logo. fallthrough: true so a request for the bundled
// default (`/branding/logo-default.svg`) — which lives in WEB_DIR, not
// here — passes through to the WEB_DIR static handler below.
app.use('/branding',  publicationRead, express.static(BRANDING_DIR, { maxAge: '7d', fallthrough: true }));
// Installed addon code, served same-origin (CSP-clean) at
// /addons/<id>/<hash>/…. Content-addressed paths are immutable so a long
// cache is safe; fallthrough:false → a missing addon file returns a clean
// 404 rather than the SPA index.html.
app.use('/addons',    express.static(ADDONS_DIR, { maxAge: '7d', fallthrough: false }));
app.use(express.static(WEB_DIR));

function _imageFilter(_req, file, cb) {
  cb(null, acceptsImage(file));
}

const mediaUploadStorage = createUploadStorage(multer, MEDIA_STAGING_ROOT);
const uploadChar = multer({
  storage: mediaUploadStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: _imageFilter,
});
const uploadLocalMap = multer({
  storage: mediaUploadStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: _imageFilter,
});

// ── Marker icon uploads ─────────────────────────────────────────
// Filenames are slugified on write so a file like "Castle Burning.png"
// lands at "castle_burning.png" and round-trips through URLs without
// encoding hazards. Per-pin-type strategy lives in-band on
// `settings.pinTypes[i].iconConfig`, not on disk metadata.
function _iconMimeOk(_req, file, cb) {
  const ok = file.mimetype === 'image/svg+xml'
          || file.mimetype === 'image/png'
          || file.mimetype === 'image/jpeg'
          || file.mimetype === 'image/webp';
  cb(null, ok);
}
function _slugifyIconName(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const slug = base.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'icon';
  return slug;
}
// The accepted extension for an upload's original name (defaults to .png).
function _iconExt(originalname) {
  return (path.extname(originalname || '').toLowerCase().match(/^\.(svg|png|jpe?g|webp)$/) || ['.png'])[0];
}
// Icons use IN-MEMORY storage (not diskStorage) so nothing lands on disk
// during the multer PARSE phase, which runs OUTSIDE withWriteLock. The route
// body validates the pin type and writes each buffer to disk INSIDE the lock,
// so a concurrent settings PATCH that deletes the pin type can't race a file
// onto disk after the existence check. 2 MB/file, 16 files.
const uploadIcons = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 2 * 1024 * 1024, files: 16 },
  fileFilter: _iconMimeOk,
});

// ── Write serialisation ─────────────────────────────────────────
// Single-host single-process app, so one FIFO mutex prevents concurrent
// read-modify-write cycles. Acquisition is bounded; a timed-out waiter is
// cancelled and skipped rather than remaining in the queue as a ghost write.
const WRITE_LOCK_TIMEOUT_MS = Math.max(
  1,
  Number(process.env.CODEX_WRITE_LOCK_TIMEOUT_MS) || 10_000,
);
const _coreWriteLock = new CoreWriteLock({ timeoutMs: WRITE_LOCK_TIMEOUT_MS });
const _publicationBarrier = new PublicationBarrier();
function withWriteLock(fn) {
  return _coreWriteLock.run(fn);
}
function _sendWriteLockTimeout(res, err) {
  if (!(err instanceof WriteLockTimeoutError)) return false;
  if (!res.headersSent) {
    res.status(503).json({
      error: 'Write lock acquisition timed out',
      code: err.code,
      timeoutMs: err.timeoutMs,
    });
  }
  return true;
}
function _runWriteRequest(res, fn, onTimeout) {
  return withWriteLock(fn).catch(async err => {
    if (!(err instanceof WriteLockTimeoutError)) throw err;
    if (onTimeout) await onTimeout();
    _sendWriteLockTimeout(res, err);
  });
}

async function _writeJsonFile(filePath, content) {
  await durableWrite(filePath, content);
  _maybeBustDataHash(filePath);
}

// ── Path-safety helper ──────────────────────────────────────────
// Imported from server-utils.cjs (this re-bind keeps the legacy
// `_`-prefix name used throughout the rest of this file).
const _safeJoinIn = safeJoinIn;

// `auth.json` and `secrets.json` are deployment config, not campaign data.
// We intentionally exclude them from snapshots (so restoring an old snapshot
// doesn't silently roll back a password change), from the data hash (so a
// password rotation doesn't trigger a no-op SSE refetch), and from ZIP
// restore (`_restoreRelativePath` — same rationale as snapshots). `auth.json`
// still ships inside the full backup zip for disaster-recovery inspection
// (salted hashes only); `secrets.json` (the DM-stored GitHub token — a LIVE
// plaintext credential) is additionally excluded from the backup ZIP itself
// (see /api/backup).
const NON_DATA_JSON_FILES = new Set(['auth.json', 'secrets.json']);

const _snapshots = createSnapshotService({
  snapshotsDir: SNAPSHOTS_DIR,
  atomicWrite: _writeJsonFile,
  trackedDataFiles: _trackedDataFiles,
  dataHash: _dataHash,
  pickKeptSnapshots,
  publishRestore: _publishSnapshotRestore,
});
const _createSnapshot = _snapshots.create;
const _maybeSnapshot = _snapshots.maybeCreate;
const _hasTransactionSnapshot = _snapshots.hasTransaction;

// ── Data hash (with cache) ───────────────────────────────────────
// Content-hashed — previous mtime+size version gave false positives
// on filesystems with low-res mtime (e.g. Docker on Windows) and false
// negatives on touch(1). We hash the concatenated JSON file contents,
// which is cheap enough for our ~100 KB dataset.
//
// Cached so SSE broadcasts (one per write) don't re-read every JSON
// file on disk to compute the same hex digest. `_writeJsonFile` clears
// the cache for ordinary writes; restore post-commit effects invalidate
// both role-scoped values after the complete file set becomes visible.
const _cachedDataHash = { dm: null, player: null };
const _DATA_DIR_RESOLVED       = path.resolve(DATA_DIR);
const _SNAPSHOTS_DIR_RESOLVED  = path.resolve(SNAPSHOTS_DIR);
const _ADDON_DATA_DIR_RESOLVED = path.resolve(ADDON_DATA_DIR);

// The set of JSON files that constitute "the data" — what snapshots
// capture, what the data hash digests, and what a restore reconciles
// against. Two roots: the top level of DATA_DIR (core collections) plus
// every addon's isolated dir under ADDON_DATA_DIR (addon-owned
// collections). `key` is the stable identity used as the snapshot-map
// key (a bare filename for core, `addon-data/<id>/<name>.json` for
// addons); `abs` is the on-disk path. Excludes NON_DATA_JSON_FILES,
// snapshots (sibling dir), and addon CODE under ADDONS_DIR (content-
// addressed, deliberately not snapshotted). Single source of truth so
// the three consumers never disagree about what counts.
async function _trackedDataFiles() {
  const out = [];
  try {
    for (const f of await fsp.readdir(DATA_DIR)) {
      if (!f.endsWith('.json') || NON_DATA_JSON_FILES.has(f)) continue;
      out.push({ key: f, abs: path.join(DATA_DIR, f) });
    }
  } catch (_) { /* data dir missing is OK */ }
  try {
    for (const id of await fsp.readdir(ADDON_DATA_DIR)) {
      const idDir = path.join(ADDON_DATA_DIR, id);
      let st; try { st = await fsp.stat(idDir); } catch { continue; }
      if (!st.isDirectory()) continue;
      let names; try { names = await fsp.readdir(idDir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        out.push({ key: `addon-data/${id}/${n}`, abs: path.join(idDir, n) });
      }
    }
  } catch (_) { /* no addon-data yet is OK */ }
  return out;
}
function _invalidateDataHash() {
  _cachedDataHash.dm = null;
  _cachedDataHash.player = null;
}
function _maybeBustDataHash(filePath) {
  try {
    if (!filePath.endsWith('.json')) return;
    const resolved = path.resolve(filePath);
    // Addon-owned collections under data/addon-data/** contribute to the
    // hash now, so a write there must bust the cache (else other clients
    // dedupe the SSE event and never refetch the addon's change).
    if (resolved === _ADDON_DATA_DIR_RESOLVED ||
        resolved.startsWith(_ADDON_DATA_DIR_RESOLVED + path.sep)) {
      _invalidateDataHash();
      return;
    }
    const dir = path.dirname(resolved);
    // Only the top level of DATA_DIR contributes to the hash; snapshots
    // and any other nested dir do not.
    if (dir !== _DATA_DIR_RESOLVED) return;
    if (dir.startsWith(_SNAPSHOTS_DIR_RESOLVED)) return;
    // Files explicitly excluded from the data hash (e.g. auth.json)
    // shouldn't invalidate the cache either — otherwise a password
    // change would trigger a no-op SSE refetch.
    if (NON_DATA_JSON_FILES.has(path.basename(filePath))) return;
    _invalidateDataHash();
  } catch (_) { _invalidateDataHash(); }
}

/**
 * Compute a 16-hex-digit hash over every JSON file at the top level of
 * `DATA_DIR`. Used as the change-token broadcast over SSE: clients
 * compare it to their last seen hash to dedupe duplicate `data-changed`
 * events. Cached until the next mutation invalidates it via
 * `_maybeBustDataHash`.
 *
 * @returns {Promise<string>} 16-char SHA-1 prefix or `'none'` on read failure.
 */
async function _dataHashUnlocked(role = 'dm') {
  const scope = role === 'dm' ? 'dm' : 'player';
  if (_cachedDataHash[scope] !== null) return _cachedDataHash[scope];
  try {
    const h = crypto.createHash('sha1');
    if (scope === 'player') {
      const { campaign, foundAny } = await _readDatasetForRole('player');
      h.update(JSON.stringify(foundAny ? campaign : null));
      _cachedDataHash.player = h.digest('hex').slice(0, 16);
      return _cachedDataHash.player;
    }
    // Digest core + addon-owned data together, ordered by stable key. When
    // no addon data exists the addon walk yields nothing, so the digest is
    // byte-identical to the pre-addon behaviour (key === filename for core).
    const list = (await _trackedDataFiles())
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { key, abs } of list) {
      h.update(key);
      h.update('\0');
      h.update(await fsp.readFile(abs));
      h.update('\0');
    }
    _cachedDataHash.dm = h.digest('hex').slice(0, 16);
    return _cachedDataHash.dm;
  } catch {
    return 'none';
  }
}

function getFile(type) {
  // Addon-owned collections (`addon:<id>:<name>`) live isolated under the
  // addon's data directory. Normal uninstall preserves them; explicit purge
  // removes them. The validated id/name parts are routed through _safeJoinIn
  // as defence in depth.
  const addon = AddonBroker.parseAddonType(type);
  if (addon) {
    const p = _safeJoinIn(ADDON_DATA_DIR, `${addon.id}/${addon.name}.json`);
    if (p) return p;
  }
  const safeType = (type || '').replace(/[^a-z0-9_]/gi, '');
  return path.join(DATA_DIR, safeType + '.json');
}

// ── Startup migrations ───────────────────────────────────────────
// Each idempotent pass uses the production atomic writer. Successful
// changes across all passes produce one post-migration snapshot and
// one broadcast; a failing pass is isolated so later migrations and
// server startup can continue.
async function runStartupMigrations() {
  const { changed, results } = await withWriteLock(async () => {
    const completed = [];
    for (const { id, run } of CAMPAIGN_MIGRATIONS) {
      try {
        const result = await run(DATA_DIR, { atomicWrite: _writeJsonFile });
        completed.push(result);
        if (result.changed > 0) {
          console.log(`[migration] ${id}: changed ${result.changed} record(s)`);
        }
      } catch (e) {
        console.warn(`[migration] ${id} failed:`, e.message);
      }
    }
    return {
      changed: completed.reduce((total, result) => total + result.changed, 0),
      results: completed,
    };
  });
  if (changed > 0) {
    try { await _createSnapshot('migration'); }
    catch (e) { console.warn('[migration] snapshot failed:', e.message); }
    await _broadcastDataChanged();
  }
  return { changed, results };
}
function _dataHash(role = 'dm') {
  return _publicationBarrier.read(() => _dataHashUnlocked(role));
}

const _liveSync = createLiveSyncService({ dataHash: _dataHash });
const {
  broadcast: _broadcast,
  broadcastDataChanged: _broadcastDataChanged,
  registerRoute: registerLiveSyncRoute,
} = _liveSync;

// ── Allowed collections ──────────────────────────────────────────
// Defense in depth: reject unknown collection names at the API
// boundary. Clients should never produce these, but a buggy build or
// a hand-crafted PATCH could. Enum validation (relationship type,
// character status, artifact state, pin type, etc.) lives in the
// client-side `settings` collection — the server trusts sent ids.
const ALLOWED_TYPES = new Set([
  'characters', 'relationships', 'locations', 'events',
  'mysteries', 'factions', 'deletedDefaults',
  'pantheon', 'artifacts', 'settings',
  'historicalEvents', 'campaign', 'pets',
]);
const ALL_TYPES = [
  'characters', 'relationships', 'locations', 'events',
  'mysteries', 'factions', 'deletedDefaults',
  'pantheon', 'artifacts', 'settings',
  'historicalEvents', 'campaign', 'pets',
];

/**
 * GET /api/data
 *
 * Read every collection's JSON file and merge into a single object
 * keyed by collection name. Returns `null` (200) when no JSON file
 * exists yet — clients treat that as "fresh install, use defaults".
 *
 * Response is filtered by the caller's role (req.role, stamped by
 * attachRole). For DM-role callers it's identity; for player or
 * anonymous callers, DM-only entities are dropped and documented
 * cross-collection references are closed over the surviving entity
 * graph. Players literally cannot see DM content via DevTools.
 *
 * Auth: none required (anonymous callers get the same view as a
 * player). Editing requires the `edit_session` cookie + DM role.
 */
app.get('/api/data', async (req, res) => {
  try {
    const role = req.role === 'dm' ? 'dm' : 'player';
    const { campaign, foundAny } = await _publicationBarrier.read(
      () => _readDatasetForRole(role),
    );
    if (!foundAny) return res.json(null);
    res.type('application/json').send(JSON.stringify(campaign));
  } catch (e) {
    console.error('GET /api/data:', e);
    res.status(500).json({ error: 'Read error' });
  }
});

registerAuthRoutes(app);

// Collections stored as keyed objects on disk (factions, settings,
// campaign, deletedDefaults). Everything else is a plain entity-list
// array. `deletedDefaults` was historically a string array but was
// converted to a keyed-object so individual tombstones can round-trip
// through the per-entity PATCH path (no whole-collection wipe needed).
const KEYED_OBJ_TYPES = new Set(['factions', 'settings', 'campaign', 'deletedDefaults']);
const CORE_RESTORE_SHAPES = Object.freeze(Object.fromEntries(
  ALL_TYPES.map(type => [
    type,
    type === 'deletedDefaults'
      ? 'object-or-legacy-array'
      : KEYED_OBJ_TYPES.has(type) ? 'object' : 'array',
  ]),
));

// Types DMs alone can write to. Players are collaborative editors of
// in-world content; they don't get to rename the campaign or reshape
// the enum vocabulary (which affects everyone instantly).
const DM_ONLY_WRITE_TYPES = new Set(['settings', 'campaign']);

// ── Addon-owned collections (dynamic type registration) ──────────
// Enabled addons may declare their own collections in addon.json. Each
// becomes a colon-namespaced wire type `addon:<id>:<name>` that rides the
// generic GET/PATCH /api/data path (file on disk: data/addon-data/<id>/
// <name>.json). We track exactly which types we added so re-applying after an
// install/enable/disable is a clean swap, never an accumulation. Metadata
// remains keyed by the full wire type so authorization never infers ownership
// or access from a bare collection name.
const _addonCollections = new Map();
function _applyAddonCollections(reg) {
  // Drop everything we added last time.
  for (const t of _addonCollections.keys()) {
    ALLOWED_TYPES.delete(t);
    KEYED_OBJ_TYPES.delete(t);
    const i = ALL_TYPES.indexOf(t);
    if (i >= 0) ALL_TYPES.splice(i, 1);
  }
  _addonCollections.clear();
  if (!reg || !Array.isArray(reg.addons)) {
    _reconcileImportProviders([]);
    return;
  }
  for (const a of reg.addons) {
    // Re-validate id + collection name from the PERSISTED registry (which could
    // be legacy-shaped or hand-edited) so a corrupt entry can't inject a junk
    // wire type into ALLOWED_TYPES / the data-hash walk.
    if (!a || !a.enabled || !AddonBroker.ID_RE.test(a.id || '')) continue;
    const declarations = AddonBroker.normalizeCollections(a.collections, a.apiVersion, a.capabilities);
    for (const c of declarations) {
      const t = AddonBroker.addonCollectionType(a.id, c.name);
      ALLOWED_TYPES.add(t);
      if (!ALL_TYPES.includes(t)) ALL_TYPES.push(t);
      if (c.keyed) KEYED_OBJ_TYPES.add(t);
      _addonCollections.set(t, {
        addonId: a.id,
        name: c.name,
        keyed: !!c.keyed,
        access: c.access === 'dm' ? 'dm' : 'public',
        apiVersion: a.apiVersion,
        capabilities: a.capabilities,
        grantedPermissions: Array.isArray(a.grantedPermissions) ? a.grantedPermissions : [],
      });
    }
  }
  _reconcileImportProviders(reg.addons);
}

function _resolveTransactionCollection(addonId, name, role) {
  const type = AddonBroker.addonCollectionType(addonId, name);
  const meta = _addonCollections.get(type);
  const declaredCapabilities = [
    ...(meta?.capabilities?.required || []),
    ...(meta?.capabilities?.optional || []),
  ];
  if (!meta || meta.addonId !== addonId || meta.apiVersion !== 2
      || !declaredCapabilities.includes('collections.transactions')
      || !meta.grantedPermissions.includes('data:own')
      || !_addonCollectionAvailable(meta, role)) {
    throw new TransactionError('TX_NOT_FOUND', 'Collection not found', 404);
  }
  return {
    addonId,
    name,
    keyed: meta.keyed,
    access: meta.access,
    path: getFile(type),
  };
}

function requireImportDM(req, res, next) {
  if (req.realRole === 'dm' && req.role === 'dm') return next();
  return res.status(403).json({ error: 'DM role required', code: 'IMPORT_FORBIDDEN' });
}

async function _transactionFault(phase) {
  if (process.env.NODE_ENV !== 'test') return;
  if (process.env.CODEX_TX_CRASH_PHASE === phase) process.exit(86);
  if (process.env.CODEX_TX_FAIL_PHASE === phase) {
    throw new Error(`Injected transaction failure at ${phase}`);
  }
  if (process.env.CODEX_TX_PAUSE_PHASE === phase && process.env.CODEX_TX_CONTROL_DIR) {
    const controlDir = path.resolve(process.env.CODEX_TX_CONTROL_DIR);
    await fsp.mkdir(controlDir, { recursive: true });
    const stem = phase.replace(/[^a-z0-9_-]/gi, '_');
    await fsp.writeFile(path.join(controlDir, `${stem}.reached`), '', 'utf8');
    const release = path.join(controlDir, `${stem}.release`);
    while (true) {
      try {
        await fsp.access(release);
        break;
      } catch {
        await new Promise(resolve => { setTimeout(resolve, 10); });
      }
    }
  }
}

async function _restoreFault(phase) {
  if (process.env.NODE_ENV !== 'test') return;
  if (process.env.CODEX_RESTORE_CRASH_PHASE === phase) process.exit(87);
  if (process.env.CODEX_RESTORE_FAIL_PHASE === phase) {
    throw new Error(`Injected restore failure at ${phase}`);
  }
  if (process.env.CODEX_RESTORE_PAUSE_PHASE === phase && process.env.CODEX_RESTORE_CONTROL_DIR) {
    const controlDir = path.resolve(process.env.CODEX_RESTORE_CONTROL_DIR);
    await fsp.mkdir(controlDir, { recursive: true });
    const stem = phase.replace(/[^a-z0-9_-]/gi, '_');
    await fsp.writeFile(path.join(controlDir, `${stem}.reached`), '', 'utf8');
    const release = path.join(controlDir, `${stem}.release`);
    while (true) {
      try {
        await fsp.access(release);
        break;
      } catch {
        await new Promise(resolve => { setTimeout(resolve, 10); });
      }
    }
  }
}

async function _campaignMutationFault(phase) {
  if (process.env.NODE_ENV !== 'test') return;
  if (process.env.CODEX_MUTATION_CRASH_PHASE === phase) process.exit(88);
  if (process.env.CODEX_MUTATION_FAIL_PHASE === phase) {
    throw new Error(`Injected campaign mutation failure at ${phase}`);
  }
}

const _collectionTransactions = new CollectionTransactionManager({
  runtimeDir: TRANSACTION_RUNTIME_DIR,
  addonDataDir: ADDON_DATA_DIR,
  publicationBarrier: _publicationBarrier,
  resolveCollection: _resolveTransactionCollection,
  fault: _transactionFault,
  onFatal: error => {
    console.error('[transaction] fatal publication state:', error);
    setImmediate(() => process.exit(1));
  },
  onCommit: async ({ commitId, access }) => {
    _invalidateDataHash();
    await _maybeSnapshot('transaction', access, { transactionCommitId: commitId });
    await _broadcastDataChanged(access);
  },
  onRecoveredCommit: async ({ commitId, access }) => {
    _invalidateDataHash();
    if (await _hasTransactionSnapshot(commitId)) return;
    try {
      await _createSnapshot(
        'transaction-recovery',
        access,
        { transactionCommitId: commitId },
      );
    }
    catch (error) { console.warn('[transaction recovery] snapshot failed:', error.message); }
  },
});

const CORE_IMPORT_COLLECTIONS = new Set([
  'characters', 'relationships', 'locations', 'events', 'mysteries',
  'factions', 'deletedDefaults', 'pantheon', 'artifacts', 'settings',
  'historicalEvents', 'campaign', 'pets',
]);

async function _readImportSnapshot(provider, refs) {
  const values = Object.create(null);
  const revisions = Object.create(null);
  const targetTypes = new Map();
  for (const ref of refs) {
    const key = collectionRefKey(ref);
    let descriptor;
    if (ref.scope === 'core') {
      if (!CORE_IMPORT_COLLECTIONS.has(ref.collection)) {
        throw new ImportError('IMPORT_PROVIDER_UNDECLARED', 'Import collection is unavailable', 404);
      }
      descriptor = {
        path: getFile(ref.collection),
        keyed: KEYED_OBJ_TYPES.has(ref.collection),
        access: 'public',
      };
      targetTypes.set(key, 'core');
    } else {
      if (ref.addonId !== provider.addonId) {
        throw new ImportError('IMPORT_PROVIDER_FOREIGN', 'Cross-addon collection access is unavailable', 404);
      }
      descriptor = _resolveTransactionCollection(provider.addonId, ref.collection, 'dm');
      targetTypes.set(key, descriptor.keyed ? 'addon-keyed' : 'addon-list');
    }
    const fallback = descriptor.keyed ? {} : [];
    const value = await _readJsonOr(descriptor.path, fallback);
    const validShape = descriptor.keyed
      ? (value && typeof value === 'object' && !Array.isArray(value))
      : Array.isArray(value);
    if (!validShape) {
      throw new ImportError('IMPORT_STORAGE_INVALID', 'Import collection has an invalid stored shape', 500);
    }
    values[key] = structuredClone(value);
    revisions[key] = revisionOf(value);
  }
  return { values, revisions, targetTypes };
}

async function _snapshotImportCollections({ provider, refs }) {
  return withWriteLock(() => _readImportSnapshot(provider, refs));
}

async function _commitImportOperations({ provider, plan, clientAborted }) {
  return withWriteLock(async () => {
    if (clientAborted()) throw new ImportError('IMPORT_CANCELLED', 'Client disconnected before commit', 409);
    const refs = [...new Map([...plan.readSet, ...plan.writeSet]
      .map(ref => [collectionRefKey(ref), ref])).values()];
    const current = await _readImportSnapshot(provider, refs);
    for (const ref of refs) {
      const key = collectionRefKey(ref);
      if (current.revisions[key] !== plan.baseRevisions[key]) {
        throw new ImportError(
          'IMPORT_REVISION_CONFLICT',
          'Import preview is stale; create a new preview',
          409,
          { collection: key },
        );
      }
    }
    const writeNames = [...new Set(plan.writeSet.map(ref => ref.collection))];
    const transaction = await _collectionTransactions.begin({
      addonId: provider.addonId,
      role: 'dm',
      collections: writeNames,
      timeoutMs: Math.max(250, Math.min(provider.limits.timeoutMs, 10_000)),
    });
    try {
      return await _collectionTransactions.commit({
        addonId: provider.addonId,
        role: 'dm',
        transactionId: transaction.transactionId,
        operations: plan.operations.map(operation => ({
          collection: operation.target.collection,
          op: 'put',
          id: operation.id,
          value: operation.value,
        })),
        clientAborted,
      });
    } catch (error) {
      _collectionTransactions.cancel({
        addonId: provider.addonId,
        transactionId: transaction.transactionId,
      });
      throw error;
    }
  });
}

const _importJobs = new ImportJobManager({
  coreCollections: CORE_IMPORT_COLLECTIONS,
  snapshotCollections: _snapshotImportCollections,
  commitOperations: _commitImportOperations,
});

async function _applyCampaignRestoreEffects({ paths }, { broadcast, reconcile }) {
  _invalidateDataHash();
  _importJobs.invalidateJobs('campaign-restored');
  if (reconcile && paths.includes('addons.json')) await _reconcileAddonsFromDisk();
  if (broadcast && paths.some(relativePath => relativePath.startsWith('maps/'))) {
    _backgroundTileSweep().catch(error => console.warn('[restore tiles]', error.message));
  }
  if (broadcast) await _broadcastDataChanged();
}

const _campaignRestores = new CampaignRestoreManager({
  dataDir: DATA_DIR,
  runtimeDir: RESTORE_RUNTIME_DIR,
  publicationBarrier: _publicationBarrier,
  maxEntries: 50_000,
  fault: _restoreFault,
  onFatal: error => {
    console.error('[restore] fatal publication state:', error);
    setImmediate(() => process.exit(1));
  },
  onCommit: result => _applyCampaignRestoreEffects(result, {
    broadcast: true,
    reconcile: true,
  }),
  onRecoveredCommit: result => _applyCampaignRestoreEffects(result, {
    broadcast: false,
    reconcile: false,
  }),
});

const _mediaPublications = new CampaignRestoreManager({
  dataDir: DATA_DIR,
  runtimeDir: MEDIA_RUNTIME_DIR,
  publicationBarrier: _publicationBarrier,
  maxEntries: 1024,
  onFatal: error => {
    console.error('[media] fatal publication state:', error);
    setImmediate(() => process.exit(1));
  },
});
const _mediaFiles = new MediaPublicationService({
  dataDir: DATA_DIR,
  stagingRoot: MEDIA_STAGING_ROOT,
  manager: _mediaPublications,
});

const _campaignMutationPublications = new CampaignRestoreManager({
  dataDir: DATA_DIR,
  runtimeDir: MUTATION_RUNTIME_DIR,
  publicationBarrier: _publicationBarrier,
  maxEntries: ALL_TYPES.length,
  fault: _campaignMutationFault,
  onFatal: error => {
    console.error('[campaign mutation] fatal publication state:', error);
    setImmediate(() => process.exit(1));
  },
});

async function _publishCampaignCollections(collections) {
  const entries = Object.entries(collections);
  if (!entries.length) return;
  if (entries.length === 1) {
    const [type, value] = entries[0];
    await _writeJsonFile(getFile(type), JSON.stringify(value, null, 2));
    return;
  }

  const candidateDir = await fsp.mkdtemp(path.join(MUTATION_STAGING_ROOT, 'mutation-'));
  try {
    const paths = [];
    for (const [type, value] of entries) {
      const target = getFile(type);
      const relativePath = path.relative(DATA_DIR, target).replace(/\\/g, '/');
      const staged = path.join(candidateDir, ...relativePath.split('/'));
      await fsp.mkdir(path.dirname(staged), { recursive: true });
      await fsp.writeFile(staged, JSON.stringify(value, null, 2), 'utf8');
      paths.push(relativePath);
    }
    await _campaignMutationPublications.commit({ candidateDir, paths });
    _invalidateDataHash();
  } finally {
    await fsp.rm(candidateDir, { recursive: true, force: true }).catch(() => {});
  }
}

const _campaignMutations = new CampaignMutationService({
  readCollection: type => _readJsonOr(
    getFile(type),
    KEYED_OBJ_TYPES.has(type) ? {} : [],
  ),
  publishCollections: _publishCampaignCollections,
  createId: _generateId,
});

function _reconcileImportProviders(entries) {
  _importJobs.reconcilePackages((entries || []).map(entry => ({
    id: entry?.id,
    enabled: !!entry?.enabled,
    packageRevision: entry
      ? AddonBroker.contentRevision(entry, crypto)
      : '',
  })));
}

function _addonCollectionAvailable(meta, role) {
  return !meta || meta.access !== 'dm' || role === 'dm';
}

async function _readDatasetForRole(role) {
  const effectiveRole = role === 'dm' ? 'dm' : 'player';
  const campaign = {};
  let foundAny = false;
  for (const type of ALL_TYPES) {
    const meta = _addonCollections.get(type);
    if (!_addonCollectionAvailable(meta, effectiveRole)) continue;
    try {
      campaign[type] = JSON.parse(await fsp.readFile(getFile(type), 'utf8'));
      foundAny = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return {
    campaign: filterDatasetForRole(campaign, effectiveRole),
    foundAny,
  };
}

// Read a JSON collection file and return parsed contents, or `fallback`
// if the file is missing. Used inside the PATCH handler.
async function _readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function _patchRecord(type, payload, container) {
  if (Array.isArray(container)) {
    if (type === 'relationships') {
      return container.find(record =>
        record?.source === payload?.source
        && record?.target === payload?.target
        && record?.type === payload?.type) || null;
    }
    return container.find(record => record?.id === payload?.id) || null;
  }
  if (KEYED_OBJ_TYPES.has(type) && container && typeof container === 'object') {
    return container[payload?.id] ?? null;
  }
  return null;
}

async function _patchRecordRevision(role, type, payload, knownContainer) {
  let container = knownContainer;
  if (role === 'player') {
    const { campaign } = await _readDatasetForRole('player');
    container = campaign[type] ?? (KEYED_OBJ_TYPES.has(type) ? {} : []);
  } else if (container === undefined) {
    container = await _readJsonOr(
      getFile(type),
      KEYED_OBJ_TYPES.has(type) ? {} : [],
    );
  }
  return writeRevision(_patchRecord(type, payload, container));
}

function _validWriteRevision(value) {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

// ─ Player save sanitization ──────────────────────────────────────
// Players write to public content but never touch DM-only fields,
// secret-flagged fields, [secret] markers, or visibility flags. This
// function takes the player's submitted entity + the existing on-disk
// version and returns a sanitised payload to actually persist.
//
// Rules (twin-entity model):
//   - `visibility` is forced to existing.visibility (or 'public' for
//     a fresh entity). Players can NEVER change visibility.
//   - `linkedTwinId` is preserved from existing (player payloads don't
//     carry it — server-side strip — so omission would silently break
//     the link without this).
//   - `secrets` is unconditionally stripped from the payload. There
//     are no per-field secret toggles; even if a stale client sends
//     the field, it never persists.
//
// DM content (the lore behind a public entity) lives in a sibling
// DM-only twin entity linked via `linkedTwinId`. There's no marker
// collision to defend against — the public entity has only public
// content by construction.
function _sanitizePlayerEntity(_type, payload, existing) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  const isNew = !existing;
  out.visibility = isNew ? 'public' : (existing.visibility || 'public');
  // Preserve linkedTwinId verbatim. Players don't see the field, so
  // they can't intentionally manage it; the existing value must
  // survive every player save so the DM-side link isn't silently
  // dropped on the next player edit.
  if (existing && existing.linkedTwinId !== undefined) {
    out.linkedTwinId = existing.linkedTwinId;
  } else {
    delete out.linkedTwinId;
  }
  // Legacy field — refuse to persist even if a stale client sends it.
  delete out.secrets;
  // Per-entity addonData: shallow-merge the player's incoming
  // namespaces OVER the existing ones, so a normal player edit (whose form
  // doesn't surface every addon's fields) can't DROP an addon's data by
  // omission. A player can still update a namespace they DO send (active
  // sheets stay player-editable), but never wipe one. Object spread is
  // prototype-safe (own-property assignment, no __proto__ walk). Per-field
  // DM-locking of addon data would need ownership metadata — deferred.
  const exAD = (existing && existing.addonData && typeof existing.addonData === 'object' && !Array.isArray(existing.addonData)) ? existing.addonData : null;
  const inAD = (payload.addonData && typeof payload.addonData === 'object' && !Array.isArray(payload.addonData)) ? payload.addonData : null;
  if (exAD || inAD) out.addonData = { ...(exAD || {}), ...(inAD || {}) };
  else delete out.addonData;
  return out;
}

// ─ Portrait path migration ───────────────────────────────────────
// On a character save, move a portrait that isn't already at the
// canonical per-character path (`/portraits/<charId>/portrait.<ext>`)
// into that subfolder and return the canonical URL. Both the source URL
// fragment AND the destination char id come from the (authenticated)
// client, so each is run through `_safeJoinIn` before any filesystem
// operation. The helper refuses traversal (`..`), absolute paths, null
// bytes, and (via realpath on each existing prefix) symlink escapes —
// without it, an authed editor could send a portrait URL like
// `/portraits/../../etc/passwd` or a crafted charId of `../foo` and have
// us rename arbitrary files into a controlled location. Auth is the
// first line of defence; this is the second.
//
// Returns the canonical URL on a successful move, else the cleaned
// (query-stripped) URL unchanged. Never throws — a migration miss just
// leaves the portrait pointing where it was.
async function _migratePortraitPath(charId, portraitUrl) {
  const cleanUrl       = String(portraitUrl).split('?')[0];
  const expectedPrefix = `/portraits/${charId}/portrait.`;
  if (cleanUrl.startsWith(expectedPrefix)) return cleanUrl;

  const relPath = cleanUrl.replace(/^\/portraits\//, '');
  const srcFile = _safeJoinIn(PORTRAITS_DIR, relPath);
  const destDir = _safeJoinIn(PORTRAITS_DIR, charId);
  if (srcFile && destDir) {
    try {
      const srcStat = await fsp.lstat(srcFile);
      if (srcStat.isFile()) {
        const ext      = path.extname(srcFile).toLowerCase() || '.jpg';
        const destFile = path.join(destDir, `portrait${ext}`);
        await fsp.mkdir(destDir, { recursive: true });
        try {
          const existingFiles = await fsp.readdir(destDir);
          await Promise.all(existingFiles.filter(f => /^portrait\./i.test(f))
            .map(f => fsp.unlink(path.join(destDir, f)).catch(() => {})));
        } catch (_) {}
        await fsp.rename(srcFile, destFile);
        const srcDir = path.dirname(srcFile);
        if (srcDir !== PORTRAITS_DIR) {
          try {
            const remaining = await fsp.readdir(srcDir);
            if (remaining.length === 0) await fsp.rmdir(srcDir);
          } catch (_) {}
        }
        return `/portraits/${charId}/portrait${ext}`;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[portrait] Migration failed for ${charId}:`, e.message);
      }
    }
  }
  return cleanUrl;
}

// Player gate for PATCH /api/data. Authed = either role. Settings /
// campaign reserved for DM. DM-only entity edits (visibility:'dm' on
// disk) are also off-limits to players — they can't see the entity,
// so their save would only be there to tamper.
//
// Note: a player who submits visibility:'dm' on a NEW entity is NOT
// rejected here — the sanitizer below forces the value to 'public'.
// Coercion is friendlier than rejection for new entities (no error
// toast for a malformed client payload) and the security outcome is
// identical (the entity gets stored as public).
function _playerCanWrite(type, action, payload, existing) {
  if (DM_ONLY_WRITE_TYPES.has(type))            return false;
  if (existing && existing.visibility === 'dm') return false;
  return true;
}

// Entity ids are generated here because the same format is also part of the
// browser Store contract. Twin invariants and persistence live in
// CampaignMutationService.
function _generateId(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 30);
  const suffix = Math.random().toString(36).slice(2, 8);
  return (base || 'e') + '_' + suffix;
}
/**
 * POST /api/twin — Create, link, or unlink a twin entity. DM-only via
 * `req.realRole === 'dm'` (impersonating players cannot manage
 * twins; the write tier is gated on the underlying signed claim,
 * not the effective role).
 *
 * Body shape:
 *   { action: 'create', type: <collection>, sourceId: <id> }
 *   { action: 'link', type: <collection>, sourceId: <id>, targetId: <id> }
 *   { action: 'unlink', type: <collection>, sourceId: <id> }
 *
 * CampaignMutationService owns the bidirectional invariant. Both sides share
 * one collection file and become durable in one replacement; this route owns
 * the lock, snapshot, response, and single broadcast.
 */
app.post('/api/twin', requireRealDM(), (req, res) => {
  _runWriteRequest(res, async () => {
    try {
      const { action, type, sourceId, targetId } = req.body || {};
      if (action !== 'create' && action !== 'unlink' && action !== 'link') {
        return res.status(400).json({ error: `Unknown action: ${action}` });
      }
      if (!VISIBILITY_BEARING.has(type)) {
        return res.status(400).json({ error: `Twin not supported for type: ${type}` });
      }
      if (type === 'relationships') {
        // Relationships are tuple-keyed and rarely benefit from twins.
        // The data model is supported in VISIBILITY_BEARING for the
        // entity-level filter; twin pairing is intentionally not.
        return res.status(400).json({ error: 'Twins for relationships are not supported.' });
      }
      if (typeof sourceId !== 'string' || !sourceId) {
        return res.status(400).json({ error: 'Missing sourceId' });
      }
      const result = await _campaignMutations.mutateTwin({
        action,
        type,
        sourceId,
        targetId,
        keyed: KEYED_OBJ_TYPES.has(type),
      });
      await _maybeSnapshot('save');
      await _broadcastDataChanged();
      return res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof CampaignMutationError) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error('POST /api/twin:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Twin op failed' });
    }
  });
});

/**
 * PATCH /api/data — Save or delete a single entity.
 *
 * Body: `{ type: string, action: 'save' | 'delete', payload: object }`.
 *  - `type` is a collection name (validated against ALLOWED_TYPES).
 *  - For keyed-object collections (`factions`, `settings`, `campaign`,
 *    `deletedDefaults`), `payload.id` is the key and `payload.data`
 *    is the value to write.
 *  - For entity lists, `payload` IS the entity (matched on `id`,
 *    or for relationships on `(source, target, type)`).
 *
 * Side effects: takes a coalesced snapshot, broadcasts `data-changed`
 * over SSE so other clients refetch. Auto-migrates portrait paths to
 * the canonical per-character subfolder (with path-traversal guards).
 *
 * Auth: any authenticated role (DM or player). DMs have full access;
 * players are limited to public content — settings/campaign types are
 * rejected, DM-only entities are off-limits, and payloads are passed
 * through `_sanitizePlayerEntity` so they can't flip visibility, set
 * secrets, or overwrite [secret] marker regions.
 */
app.patch('/api/data', (req, res) => {
  if (req.role !== 'dm' && req.role !== 'player') {
    return res.status(401).json({ error: 'Neznámé nebo chybějící heslo.' });
  }
  _runWriteRequest(res, async () => {
    try {
      const { type, action, payload, baseRevision } = req.body || {};

      const parsedAddonType = AddonBroker.parseAddonType(type);
      const addonCollection = parsedAddonType ? _addonCollections.get(type) : null;
      // A player gets the same response for a hidden collection and an
      // undeclared guessed addon type. Do this before action/payload checks so
      // validation details cannot become an existence oracle.
      if (req.role !== 'dm' && parsedAddonType
          && (!addonCollection || !_addonCollectionAvailable(addonCollection, req.role))) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (!ALLOWED_TYPES.has(type)) {
        return res.status(400).json({ error: `Unknown collection: ${type}` });
      }
      if (action !== 'save' && action !== 'delete') {
        return res.status(400).json({ error: `Unknown action: ${action}` });
      }
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Missing payload' });
      }
      // PCs (faction === 'party') cannot be marked DM-only — a hidden
      // PC isn't a coherent product state, the player can't see their
      // own character. Defence in depth; the client also enforces.
      if (type === 'characters' && action === 'save'
          && payload.faction === 'party' && payload.visibility === 'dm') {
        return res.status(400).json({ error: 'PCs cannot be marked DM-only.' });
      }

      const p = getFile(type);
      // Keyed-object collections: factions (id → record), settings
      // (category → array), and campaign (single 'main' record).
      // Everything else is an entity list.
      const emptyContainer = KEYED_OBJ_TYPES.has(type) ? {} : [];
      let container = await _readJsonOr(p, emptyContainer);

      // Look up the existing record (if any) — used both for the
      // player gating below and for the visibility-flip + delete-
      // cascade guards. Different lookup per collection shape.
      let existing = _patchRecord(type, payload, container);

      if (baseRevision !== undefined) {
        if (!_validWriteRevision(baseRevision)) {
          return res.status(400).json({ error: 'Invalid base revision' });
        }
        const currentRevision = await _patchRecordRevision(
          req.role,
          type,
          payload,
          container,
        );
        if (baseRevision !== currentRevision) {
          return res.status(409).json({
            error: 'The record changed after it was loaded',
            code: 'WRITE_CONFLICT',
            currentRevision,
          });
        }
      }

      // Player role gating + payload sanitization. Done after the
      // basic shape validation so 400 vs 403 errors stay meaningful.
      // DM saves bypass this entirely (full edit access).
      if (req.role === 'player') {
        if (!_playerCanWrite(type, action, payload, existing)) {
          return res.status(403).json({
            error: type === 'settings' || type === 'campaign'
              ? 'Tato sekce je dostupná pouze DM.'
              : 'Tato entita obsahuje DM obsah — může ji upravovat jen DM.',
          });
        }

        // Sanitize the payload before persisting. Visibility-bearing
        // collections only — settings/campaign are already rejected
        // above, deletedDefaults / non-visibility-bearing types pass
        // through unchanged (they don't carry visibility / linkedTwinId).
        if (action === 'save' && VISIBILITY_BEARING.has(type)) {
          if (KEYED_OBJ_TYPES.has(type)) {
            // factions: payload.data is the record
            payload.data = _sanitizePlayerEntity(type, payload.data, existing);
          } else {
            // The PATCH protocol passes the entity directly as payload
            // for list-shaped collections. Mutate in-place via reassign.
            const sanitized = _sanitizePlayerEntity(type, payload, existing);
            for (const k of Object.keys(payload)) delete payload[k];
            Object.assign(payload, sanitized);
          }
        }
      }

      // Visibility-flip guard. An entity with a linked twin can't
      // have its visibility flipped — the twin pair is defined as
      // one-public + one-DM, so flipping would leave both sides in
      // the same space (incoherent). The DM has to explicitly
      // unlink the twin first via POST /api/twin. Applies to BOTH
      // roles (DM and player); player wouldn't reach this anyway
      // because of the gating above, but the rule is structural.
      if (action === 'save' && VISIBILITY_BEARING.has(type) && existing && existing.linkedTwinId) {
        const incoming = KEYED_OBJ_TYPES.has(type) ? (payload.data || {}) : payload;
        const incomingVis = incoming.visibility;
        if (incomingVis && incomingVis !== existing.visibility) {
          return res.status(400).json({
            error: 'Tato entita má spárovaný twin — odpárujte ho před změnou viditelnosti.',
          });
        }
      }

      // Auto-migrate portrait to the canonical per-character subfolder
      // on save. The path-safety reasoning lives in _migratePortraitPath.
      if (type === 'characters' && action === 'save' && payload?.id && payload?.portrait) {
        payload.portrait = await _migratePortraitPath(payload.id, payload.portrait);
      }

      if (type === 'locations' && action === 'save') {
        await _campaignMutations.saveLocation(payload, {
          editablePeer: req.role === 'player'
            ? peer => peer?.visibility !== 'dm'
            : undefined,
        });
        await _maybeSnapshot('save');
        await _broadcastDataChanged();
        return res.json({
          ok: true,
          revision: await _patchRecordRevision(req.role, type, payload),
        });
      }
      if (action === 'delete' && ['characters', 'locations', 'factions'].includes(type)) {
        await _campaignMutations.deleteEntity(type, payload.id);
        await _maybeSnapshot('save');
        await _broadcastDataChanged();
        return res.json({
          ok: true,
          revision: await _patchRecordRevision(req.role, type, payload),
        });
      }

      if (action === 'save') {
        if (Array.isArray(container)) {
          if (type === 'relationships') {
            const k   = r => `${r.source}||${r.target}||${r.type}`;
            const idx = container.findIndex(r => k(r) === k(payload));
            if (idx >= 0) container[idx] = payload; else container.push(payload);
          } else {
            const idx = container.findIndex(x => x.id === payload.id);
            if (idx >= 0) container[idx] = payload; else container.push(payload);
          }
        } else {
          // Keyed-object collection: reject ids that would write to the
          // prototype chain (`__proto__`, `constructor`, `prototype`).
          if (_isForbiddenKey(payload.id)) {
            return res.status(400).json({ error: `Forbidden id: ${payload.id}` });
          }
          container[payload.id] = payload.data;
        }
      } else if (action === 'delete') {
        // Twin orphan-clear: if the entity being deleted had a twin,
        // the surviving twin's `linkedTwinId` is cleared so it doesn't
        // dangle. Twins live in the same collection so this is a
        // simple lookup in the just-loaded container. Runs BEFORE
        // the actual delete + filter so we can still read `existing`.
        if (existing && existing.linkedTwinId && VISIBILITY_BEARING.has(type)) {
          if (Array.isArray(container)) {
            const twin = container.find(x => x && x.id === existing.linkedTwinId);
            if (twin) delete twin.linkedTwinId;
          } else if (KEYED_OBJ_TYPES.has(type)) {
            const twin = container[existing.linkedTwinId];
            if (twin) delete twin.linkedTwinId;
          }
        }
        if (Array.isArray(container)) {
          if (type === 'relationships') {
            container = container.filter(r => !(r.source === payload.source && r.target === payload.target && r.type === payload.type));
          } else {
            container = container.filter(x => x.id !== payload.id);
          }
        } else {
          if (_isForbiddenKey(payload.id)) {
            return res.status(400).json({ error: `Forbidden id: ${payload.id}` });
          }
          delete container[payload.id];
        }
      }

      await _writeJsonFile(p, JSON.stringify(container, null, 2));
      const access = addonCollection?.access === 'dm' ? 'dm' : 'public';
      await _maybeSnapshot('save', access);
      await _broadcastDataChanged(access);
      res.json({
        ok: true,
        revision: await _patchRecordRevision(req.role, type, payload, container),
      });
    } catch (e) {
      if (e instanceof CampaignMutationError) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error('PATCH /api/data:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Patch error' });
    }
  });
});

app.delete('/api/campaign/enums/:category/:id', requireDM, (req, res) => {
  _runWriteRequest(res, async () => {
    try {
      const baseRevision = req.body?.baseRevision;
      const settingsBefore = await _readJsonOr(getFile('settings'), {});
      const currentRevision = writeRevision(
        settingsBefore[req.params.category] ?? null,
      );
      if (baseRevision !== undefined) {
        if (!_validWriteRevision(baseRevision)) {
          return res.status(400).json({ error: 'Invalid base revision' });
        }
        if (baseRevision !== currentRevision) {
          return res.status(409).json({
            error: 'The enum changed after it was loaded',
            code: 'WRITE_CONFLICT',
            currentRevision,
          });
        }
      }
      const result = await _campaignMutations.deleteEnumItem({
        category: req.params.category,
        id: req.params.id,
        replaceWith: req.body?.replaceWith || '',
        force: req.body?.force === true,
        tombstone: req.body?.tombstone === true,
      });
      await _maybeSnapshot('save');
      await _broadcastDataChanged();
      const settings = await _readJsonOr(getFile('settings'), {});
      res.json({
        ok: true,
        usages: result.usages,
        revision: writeRevision(settings[req.params.category] ?? null),
      });
    } catch (error) {
      if (error instanceof CampaignMutationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.usages ? { usages: error.usages } : {}),
        });
      }
      console.error('DELETE /api/campaign/enums:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Enum delete failed' });
    }
  });
});

/**
 * POST /api/addons/:id/transactions
 *
 * API-v2 addon-owned multi-collection transactions. `begin` captures one
 * consistent snapshot and issues a short-lived, single-use lease. Addon code
 * buffers changes locally, then `commit` applies explicit put/delete
 * operations only if every read-set revision is still current.
 */
app.post('/api/addons/:id/transactions', async (req, res) => {
  if (req.role !== 'dm' && req.role !== 'player') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const addonId = String(req.params.id || '');
  if (!AddonBroker.ID_RE.test(addonId)) return res.status(404).json({ error: 'Not found' });
  let clientAborted = false;
  req.once('aborted', () => { clientAborted = true; });
  res.once('close', () => {
    if (!res.writableEnded) clientAborted = true;
  });

  try {
    const mode = req.body?.mode;
    let result;
    if (mode === 'begin') {
      result = await withWriteLock(() => {
        if (clientAborted) throw new TransactionError('TX_EXPIRED', 'Client disconnected', 409);
        return _collectionTransactions.begin({
          addonId,
          role: req.role,
          collections: req.body.collections,
          timeoutMs: req.body.timeoutMs,
        });
      });
    } else if (mode === 'commit') {
      result = await withWriteLock(() => _collectionTransactions.commit({
        addonId,
        role: req.role,
        transactionId: req.body.transactionId,
        operations: req.body.operations,
        clientAborted: () => clientAborted,
      }));
    } else if (mode === 'cancel') {
      result = _collectionTransactions.cancel({
        addonId,
        transactionId: req.body?.transactionId,
      });
    } else {
      throw new TransactionError('TX_VALIDATION', 'mode must be "begin", "commit", or "cancel"');
    }
    if (!clientAborted && !res.headersSent) res.json(result);
  } catch (error) {
    if (_sendWriteLockTimeout(res, error)) return;
    if (error instanceof TransactionError) {
      if (!clientAborted && !res.headersSent) {
        const body = { error: error.message, code: error.code };
        if (error.details !== undefined) body.details = error.details;
        res.status(error.status).json(body);
      }
      return;
    }
    console.error(`POST /api/addons/${addonId}/transactions:`, error);
    if (!clientAborted && !res.headersSent) {
      res.status(500).json({ error: 'Transaction failed', code: 'TX_INTERNAL' });
    }
  }
});

const IMPORT_SESSION_COOKIE = 'codex_import_session';
const importUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(IMPORT_TEMP_ROOT, { recursive: true }, error => cb(error, IMPORT_TEMP_ROOT));
    },
    filename: (_req, _file, cb) => cb(null, `input-${crypto.randomBytes(16).toString('hex')}.tmp`),
  }),
  limits: {
    fileSize: IMPORT_LIMITS.maxInputBytes,
    files: 1,
    fields: 8,
  },
});

function _importOwner(req, res, create = false) {
  let token = req.cookies?.[IMPORT_SESSION_COOKIE];
  if (!/^[0-9a-f]{64}$/.test(token || '')) {
    if (!create) return '';
    token = crypto.randomBytes(32).toString('hex');
  }
  res.cookie(IMPORT_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/content-import',
    maxAge: IMPORT_LIMITS.jobTtlMs,
  });
  return crypto.createHash('sha256').update(token).digest('hex');
}

function _sendImportError(res, error) {
  if (_sendWriteLockTimeout(res, error)) return;
  const normalized = error instanceof ImportError
    ? error
    : new ImportError('IMPORT_INTERNAL', 'Import operation failed', 500);
  const body = { error: normalized.message, code: normalized.code };
  if (normalized.details !== undefined) body.details = normalized.details;
  if (!res.headersSent) res.status(normalized.status).json(body);
}

app.get('/api/content-import/providers', requireImportDM, (_req, res) => {
  res.json({
    version: 1,
    providers: _importJobs.listProviders(),
    limits: {
      maxInputBytes: IMPORT_LIMITS.maxInputBytes,
      jobTtlMs: IMPORT_LIMITS.jobTtlMs,
      maxJobs: IMPORT_LIMITS.maxJobs,
    },
  });
});

app.post(
  '/api/content-import/jobs',
  requireImportDM,
  importUpload.single('input'),
  async (req, res) => {
    const inputPath = req.file?.path;
    try {
      if (!req.file) throw new ImportError('IMPORT_INPUT_INVALID', 'Import input is required');
      const job = _importJobs.createJob({
        addonId: String(req.body?.addonId || ''),
        providerId: String(req.body?.providerId || ''),
        owner: _importOwner(req, res, true),
        format: String(req.body?.format || ''),
        input: {
          path: req.file.path,
          size: req.file.size,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
        },
      });
      res.status(201).json({ version: 1, job });
    } catch (error) {
      if (inputPath) await fsp.unlink(inputPath).catch(() => {});
      _sendImportError(res, error);
    }
  },
);

app.get('/api/content-import/jobs/:jobId', requireImportDM, (req, res) => {
  try {
    res.json({ version: 1, job: _importJobs.getJob(req.params.jobId, _importOwner(req, res)) });
  } catch (error) {
    _sendImportError(res, error);
  }
});

app.post('/api/content-import/jobs/:jobId/preview', requireImportDM, async (req, res) => {
  const owner = _importOwner(req, res);
  let disconnected = false;
  req.once('aborted', () => { disconnected = true; });
  res.once('close', () => {
    if (!res.writableEnded) {
      disconnected = true;
      _importJobs.cancel(req.params.jobId, owner, 'Client disconnected during preview').catch(() => {});
    }
  });
  try {
    const result = await _importJobs.preview(req.params.jobId, owner);
    if (!disconnected && !res.headersSent) res.json(result);
  } catch (error) {
    if (!disconnected) _sendImportError(res, error);
  }
});

app.post('/api/content-import/jobs/:jobId/commit', requireImportDM, async (req, res) => {
  const owner = _importOwner(req, res);
  let disconnected = false;
  req.once('aborted', () => { disconnected = true; });
  res.once('close', () => {
    if (!res.writableEnded) disconnected = true;
  });
  try {
    const result = await _importJobs.commit(
      req.params.jobId,
      owner,
      req.body?.previewToken,
      { clientAborted: () => disconnected },
    );
    if (!disconnected && !res.headersSent) res.json(result);
  } catch (error) {
    if (!disconnected) _sendImportError(res, error);
  }
});

app.delete('/api/content-import/jobs/:jobId', requireImportDM, async (req, res) => {
  try {
    const job = await _importJobs.cancel(req.params.jobId, _importOwner(req, res));
    res.json({ version: 1, job });
  } catch (error) {
    _sendImportError(res, error);
  }
});

/**
 * GET /api/version — Returns the current dataset hash. Useful for
 * health-check probes (the Dockerfile HEALTHCHECK pings this), and
 * historically for clients to poll for changes before SSE existed.
 */
app.get('/api/version', async (req, res) => {
  const role = req.role === 'dm' ? 'dm' : 'player';
  res.json({ hash: await _dataHash(role), instance: INSTANCE, features: FEATURES, canRestart: RESTARTABLE });
});

// DM-only (realRole): restart the server process. With a supervisor (Docker
// `restart: unless-stopped`, systemd, pm2…) a clean exit causes an automatic
// restart that reloads in-process addon SERVER code — the only way to pick up a
// server-addon install/update/rollback without a manual `docker restart`. Refused
// when not RESTARTABLE (exiting bare would just kill the wiki). We respond FIRST,
// then drain the write lock (so no save is mid-flight) and exit; the client polls
// /api/version until the server is back and reloads. No Docker-socket access is
// needed — we just exit and let the existing restart policy recover.
app.post('/api/restart', requireRealDM('Jen DM může restartovat server.'), (req, res) => {
  if (!RESTARTABLE) {
    return res.status(400).json({ error: 'Restart není dostupný — server neběží pod správcem procesů (Docker restart: unless-stopped).' });
  }
  console.log('[restart] DM-requested restart — draining writes, then exiting for the supervisor to bring the process back up.');
  res.json({ ok: true });
  // Flush the response, then take the write lock so any in-flight save completes
  // before we terminate. Both resolve + reject exit (a stuck lock shouldn't block).
  setTimeout(() => {
    withWriteLock(async () => {}).then(() => process.exit(0), () => process.exit(0));
  }, 200);
});

// ── Addon framework ──────────────────────────────────────────────
// The server is the addon broker (see server/addons.cjs). Install
// fetches a GitHub repo at a pinned commit, validates + content-hashes
// it, and lays the code down under data/addons/<id>/<hash>/; the client
// imports it same-origin. Management ops are DM-only and gate on
// realRole (the signed claim) so an impersonating DM can't manage
// addons. Updates run through the wizard (later phase) — no auto-update.
const ADDON_MAX_FILES     = 10_000;
const ADDON_MAX_ARCHIVE_BYTES = 30 * 1024 * 1024; // compressed download cap
const ADDON_MAX_ENTRY_BYTES = 10 * 1024 * 1024;   // one expanded file
const ADDON_MAX_BYTES     = 25 * 1024 * 1024;   // 25 MB extracted cap
const ADDON_MAX_COMPRESSION_RATIO = 100;
const ADDON_VERSIONS_KEEP = 5;                  // content-addressed history kept per addon
// Diagnostic threshold for host.withLock critical sections. It deliberately
// does not release ownership: JavaScript promises cannot cancel a running
// callback, so early release would allow concurrent writes.
const ADDON_LOCK_WARNING_MS = 30_000;

// Server-side GitHub credential for the broker. Two sources: the DM-stored
// token (data/secrets.json, set from the install wizard via
// POST /api/addons/github-token) and the env vars — `CODEX_GITHUB_TOKEN` is
// the documented name (matches the other CODEX_* knobs); plain
// `GITHUB_TOKEN` keeps working as an alias (the pre-existing name, and what
// CI environments export). With a token set, every api.github.com request
// the broker makes carries `Authorization: Bearer <token>` — which raises
// rate limits and makes PRIVATE addon repos installable/updatable. The
// token never leaves the process: it is never logged, never sent to a
// client, and secrets.json is excluded from the backup ZIP + snapshots +
// the data hash + restore (NON_DATA_JSON_FILES and the /api/backup filter);
// the addon-test runner's explicit child-env allowlist also excludes both
// token names from addon-controlled test processes.
function _githubToken() {
  const stored = _loadSecrets().githubToken;
  if (typeof stored === 'string' && stored) return stored;
  return process.env.CODEX_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}
// 'stored' | 'env' | null — tells the Manager/wizard WHERE the active token
// comes from (never the token itself). Stored (wizard-set, data/secrets.json)
// wins over env: it's the most recent explicit intent, and lets a DM fix a
// wrong env token without shell access.
function _githubTokenSource() {
  const stored = _loadSecrets().githubToken;
  if (typeof stored === 'string' && stored) return 'stored';
  return (process.env.CODEX_GITHUB_TOKEN || process.env.GITHUB_TOKEN) ? 'env' : null;
}

async function _readAddonsRegistry() {
  try {
    const raw = await fsp.readFile(ADDONS_REGISTRY_FILE, 'utf8');
    return AddonBroker.normalizeRegistry(JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[addons] registry read failed, using empty:', e.message);
      // Preserve the unreadable file so the next write doesn't silently destroy
      // a possibly-recoverable registry (a JSON syntax error would otherwise
      // wipe every installed addon on the next install/enable). Keep only the
      // newest few — these otherwise accumulate forever in DATA_DIR and ride
      // along into every /api/backup ZIP.
      try {
        await fsp.rename(ADDONS_REGISTRY_FILE, ADDONS_REGISTRY_FILE + '.corrupt-' + Date.now());
        const dir  = path.dirname(ADDONS_REGISTRY_FILE);
        const base = path.basename(ADDONS_REGISTRY_FILE) + '.corrupt-';
        const old  = (await fsp.readdir(dir))
          .filter(f => f.startsWith(base))
          .sort()             // timestamp suffix → lexicographic == chronological
          .slice(0, -3);      // keep the newest 3
        for (const f of old) await fsp.unlink(path.join(dir, f)).catch(() => {});
      } catch (_) { /* best-effort */ }
    }
    return AddonBroker.defaultRegistry();
  }
}
async function _writeAddonsRegistry(reg) {
  await _writeJsonFile(ADDONS_REGISTRY_FILE, JSON.stringify(reg, null, 2));
}
async function _repairLegacyAddonRegistry() {
  return withWriteLock(async () => {
    let raw;
    try {
      raw = await fsp.readFile(ADDONS_REGISTRY_FILE, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }
    const reg = JSON.parse(raw);
    const repaired = AddonBroker.repairLegacyInstalledMetadata(reg);
    if (repaired) await _writeAddonsRegistry(reg);
    return repaired;
  });
}

// Shape the registry into the public list the client boot consumes.
// Readable by anyone (boot is pre-login); exposes only enough to import
// + show status, never the allowlist or grants.
function _publicAddonList(reg, role = 'player') {
  return reg.addons.map(a => {
    const content = _addonContent.get(a.id);
    const contentError = _addonContentErrors.get(a.id);
    const contentBlocked = !!a.enabled && contentError?.hash === a.activeHash;
    return {
      id:         a.id,
      name:       a.name || a.id,
      version:    a.version || '',
      apiVersion: a.apiVersion,
      hostVersion: a.hostVersion,
      capabilities: role === 'dm'
        ? (a.capabilities || undefined)
        : _playerAddonCapabilities(a.capabilities),
      enabled:    !!a.enabled,
      state:      contentBlocked ? 'blocked' : (a.state || (a.enabled ? 'ok' : 'disabled')),
      activeHash: a.activeHash || null,
      contentRevision: AddonBroker.contentRevision(a, crypto),
      // Granted permissions — the client needs these to build the addon's
      // SCOPED host facade (not secret; they describe what the addon can do).
      permissions: Array.isArray(a.grantedPermissions) ? a.grantedPermissions : [],
      dependencies: (a.dependencies && typeof a.dependencies === 'object') ? a.dependencies : {},
      // Soft deps — ordering-only (load after, if present); never block. The
      // client needs these so host.use() permits them and planLoadOrder orders.
      optionalDependencies: (a.optionalDependencies && typeof a.optionalDependencies === 'object') ? a.optionalDependencies : {},
      // Declared addon-owned collections — the client host calls
      // registerCollection against these to wire its scoped CRUD.
      collections: AddonBroker.normalizeCollections(a.collections, a.apiVersion, a.capabilities)
        .filter(collection => role === 'dm' || collection.access === 'public'),
      // Server-side code: whether it ships one, and its live load state.
      server:      !!a.server,
      serverState: contentBlocked && a.server ? 'blocked' : _serverStateFor(a),
      // Host-served declarative content (manifest `contentDir`) — data addons
      // (rulebooks) with no server code; the host serves /api/addon/<id>/content.
      contentDir:  a.contentDir || null,
      contentState: a.contentDir ? (contentBlocked ? 'error' : (content ? 'loaded' : 'unavailable')) : null,
      ...(role === 'dm' && contentBlocked ? {
        contentError: {
          code: contentError.code,
          message: contentError.message,
          diagnostics: contentError.diagnostics,
        },
      } : {}),
      locales:     AddonBroker.normalizeLocales(a.locales),
      // Content-group toggles (manifest `contentGroups`) — the Manager's
      // per-group checkboxes. Values come from the live content cache (counted
      // over the UNFILTERED tree so a disabled group still shows its size);
      // null for addons that don't declare groups or aren't serving content.
      contentGroups: (content && content.groups) ? content.groups : null,
      // Kept version history drives the rollback affordance. Trimmed
      // (no sha) to what the Manager needs. activeHash marks the live one.
      versions: Array.isArray(a.versions)
        ? a.versions.map(v => ({ contentHash: v.contentHash, version: v.version, installedAt: v.installedAt }))
        : [],
      entryUrl:   (!contentBlocked && a.enabled && a.activeHash && a.entry)
                    ? `/addons/${a.id}/${a.activeHash}/${a.entry}`
                    : null,
    };
  });
}

function _playerAddonCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return undefined;
  }
  const required = Array.isArray(capabilities.required)
    ? capabilities.required.filter(id => id !== 'collections.dm' && id !== 'imports.providers')
    : [];
  const optional = Array.isArray(capabilities.optional)
    ? capabilities.optional.filter(id => id !== 'collections.dm' && id !== 'imports.providers')
    : [];
  return required.length || optional.length ? { required, optional } : undefined;
}

// ── Server-side addon code ───────────────────────────────────────
// An addon with a `server` entry + granted `server:code` may ship a Node
// module the server loads IN-PROCESS (full trust — the permission is
// transparency, not containment; install is DM-only + SHA-pinned). Its routes
// live under the namespaced prefix `/api/addon/<id>/*` (singular — distinct
// from the plural `/api/addons` management namespace, so they can never
// collide). Loading happens at BOOT (restart-to-load v1); a runtime
// enable/disable/install is surfaced as "restart needed" rather than hot-
// swapping require()'d code into a live process.
const _addonServers    = new Map();   // id -> { id, router, state, hash }   (live routers, request-time)
const _serverLoadState = new Map();   // id -> { state, error }              (boot load outcome, for the Manager)

// ── Host-served declarative addon content (manifest `contentDir`) ──
// A data addon (rulebooks…) declares a per-record JSON tree and the HOST
// serves it at /api/addon/<id>/{content,content/:kind,item/:kind/:id,kinds} —
// no addon server code, no `server:code` grant, and (unlike server code,
// which is restart-to-load) fully HOT: rebuilt on every registry mutation,
// so installing/updating a book addon needs no restart. Content-addressed:
// the cache keys on activeHash, so an unchanged hash never re-reads disk.
// Cache entry: { hash, offKey, groups, _raw, content, index, kinds, count }.
// `content/index/kinds/count` are the SERVED view — already filtered by the
// DM's per-addon content-group toggles — so the /content aggregate, per-kind
// lists, /item lookups and /kinds all agree by construction (the one-code-
// path rule filterContentTree documents). `_raw` keeps the unfiltered tree
// so flipping a toggle re-filters in memory without re-reading disk, and
// `groups` carries {field, label, values, disabled} for the Manager UI —
// values counted from the RAW tree so a disabled group still lists with its
// true size. `offKey` is the cache key half that tracks the off-list.
const _addonContent = new Map();
const _addonContentErrors = new Map();
function _applyAddonContent(reg) {
  const seen = new Set();
  for (const a of (reg && Array.isArray(reg.addons)) ? reg.addons : []) {
    if (!a || !a.enabled || !a.contentDir || !a.activeHash) continue;
    if (!AddonBroker.ID_RE.test(a.id) || typeof a.contentDir !== 'string') continue;
    seen.add(a.id);
    const cg       = (a.contentGroups && a.contentGroups.field) ? a.contentGroups : null;
    const disabled = cg ? AddonBroker.normalizeDisabledContentGroups(a.disabledContentGroups) : [];
    const offKey   = cg ? JSON.stringify([...disabled].sort()) : '';
    const cached   = _addonContent.get(a.id);
    const cachedError = _addonContentErrors.get(a.id);
    if (cachedError && cachedError.hash === a.activeHash) continue;
    if (cached && cached.hash === a.activeHash && cached.offKey === offKey) continue;
    // Same code version, different toggle state → re-filter the cached raw
    // tree; only a version change re-reads disk.
    let raw = (cached && cached.hash === a.activeHash) ? cached._raw : null;
    if (!raw) {
      const codeDir = _safeJoinIn(path.join(ADDONS_DIR, a.id), a.activeHash);
      const rootDir = codeDir ? _safeJoinIn(codeDir, a.contentDir) : null;
      if (!rootDir) {
        _addonContent.delete(a.id);
        _addonServers.delete(a.id);
        _addonContentErrors.set(a.id, {
          hash: a.activeHash,
          code: 'ADDON_CONTENT_INVALID',
          message: 'Declarative content path is invalid',
          diagnostics: [],
        });
        continue;
      }
      try {
        raw = AddonContent.loadContentTree(rootDir);
      } catch (e) {
        console.warn(`[addons] content load failed for ${a.id}:`, e && e.message);
        _addonContent.delete(a.id);
        _addonServers.delete(a.id);
        _addonContentErrors.set(a.id, {
          hash: a.activeHash,
          code: e?.code || 'ADDON_CONTENT_INVALID',
          message: e?.message || 'Declarative content could not be loaded',
          diagnostics: Array.isArray(e?.diagnostics)
            ? e.diagnostics.map(diagnostic => ({ ...diagnostic }))
            : [],
        });
        continue;
      }
    }
    const groups = cg ? {
      field: cg.field, label: cg.label || '',
      values: AddonContent.groupValues(raw, cg.field, cg.additionalField),
      disabled,
    } : null;
    const served = cg
      ? AddonContent.filterContentTree(raw, cg.field, disabled, cg.additionalField)
      : raw;
    _addonContent.set(a.id, { hash: a.activeHash, offKey, groups, _raw: raw, ...served });
    _addonContentErrors.delete(a.id);
    console.log(`[addons] content: ${a.id} — ${served.count} records / ${served.kinds.length} kinds (host-served`
      + (cg && disabled.length ? `; ${disabled.length} ${cg.field}-group(s) off, ${raw.count - served.count} records hidden` : '') + ')');
  }
  // Disabled/removed/no-longer-content addons stop serving immediately.
  for (const id of [..._addonContent.keys()]) if (!seen.has(id)) _addonContent.delete(id);
  for (const id of [..._addonContentErrors.keys()]) if (!seen.has(id)) _addonContentErrors.delete(id);
}

// A data helper bound to the addon's isolated dir; a collection name maps to
// data/addon-data/<id>/<name>.json. Uses the SAME grammar as the client wire
// type (AddonBroker.COLLECTION_NAME_RE, no hyphens) so server-side and
// client-side addon collections can't drift into two namespaces; the tight
// regex is also the path-safety gate.
function _addonDataPath(dataDir, name) {
  if (typeof name !== 'string' || !AddonBroker.COLLECTION_NAME_RE.test(name)) return null;
  return _safeJoinIn(dataDir, name + '.json');
}

// Build the scoped facade handed to a server addon's init(host). Everything is
// namespaced / permission-gated: routes only mount under the addon's prefix,
// data reads/writes are confined to its own dir, core reads honour granted
// `data:read:*`, and `lib()` only yields vetted host npm deps.
function _makeServerHost(entry) {
  const id      = entry.id;
  const grants  = Array.isArray(entry.grantedPermissions) ? entry.grantedPermissions : [];
  const dataDir = path.join(ADDON_DATA_DIR, id);
  const router  = express.Router();
  const importDisposers = [];
  const packageRevision = AddonBroker.contentRevision(entry, crypto);
  const host = {
    id,
    apiVersion: entry.apiVersion,
    hostVersion: AddonBroker.HOST_VERSION,
    capabilities: Object.freeze({
      has: capability => AddonBroker.HOST_CAPABILITIES.has(capability),
      supported: Object.freeze([...AddonBroker.HOST_CAPABILITIES]),
    }),
    router,                                                   // raw Express Router, if the addon wants it
    get:    (p, ...h) => router.get(p, ...h),
    post:   (p, ...h) => router.post(p, ...h),
    put:    (p, ...h) => router.put(p, ...h),
    delete: (p, ...h) => router.delete(p, ...h),
    data: {
      dir: dataDir,
      read: async (name) => {
        const p = _addonDataPath(dataDir, name);
        if (!p) throw new Error(`unsafe data name "${name}"`);
        return _publicationBarrier.read(async () => {
          try { return JSON.parse(await fsp.readFile(p, 'utf8')); }
          catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        });
      },
      // NB: write() already runs inside withWriteLock. The mutex is NOT
      // reentrant — do NOT call host.data.write from inside host.withLock(...)
      // or it deadlocks the whole write chain. To do several writes in one
      // critical section, use host.withLock + host.data.dir + your own
      // _writeJsonFile, not nested host.data.write calls.
      write: (name, obj) => withWriteLock(async () => {
        const p = _addonDataPath(dataDir, name);
        if (!p) throw new Error(`unsafe data name "${name}"`);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await _writeJsonFile(p, JSON.stringify(obj, null, 2));
      }),
    },
    // Read a CORE collection — gated by the granted data:read:<name> permission
    // AND restricted to real, non-secret collections. Without the second check,
    // `data:read:auth` would resolve to data/auth.json (password hashes) and
    // `data:read:addons` to the registry; an addon also can't read another
    // addon's `addon:*` collection this way (those go through host.data).
    readCollection: async (name) => {
      if (!grants.includes('data:read:' + name)) {
        throw new Error(`addon "${id}" lacks permission data:read:${name}`);
      }
      if (typeof name !== 'string' || !ALLOWED_TYPES.has(name) || name.startsWith('addon:')) {
        throw new Error(`addon "${id}" cannot read "${name}"`);
      }
      return _publicationBarrier.read(async () => {
        try { return JSON.parse(await fsp.readFile(getFile(name), 'utf8')); }
        catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      });
    },
    registerImportProvider: descriptor => {
      const registration = _importJobs.registerProvider({
        id,
        apiVersion: entry.apiVersion,
        capabilities: entry.capabilities,
        collections: AddonBroker.normalizeCollections(
          entry.collections,
          entry.apiVersion,
          entry.capabilities,
        ),
        grantedPermissions: grants,
        packageRevision,
      }, descriptor);
      importDisposers.push(registration.dispose);
      return registration.dispose;
    },
    lib: (name) => {
      if (!AddonBroker.HOST_SERVER_LIBS.has(name)) {
        throw new Error(`addon "${id}" requested non-vetted server lib "${name}"`);
      }
      return require(name);
    },
    // Serialize a critical section on the global write lock — NOT reentrant
    // (don't nest host.data.write inside; it locks too). A slow holder is
    // logged, but retains ownership until its callback settles.
    withLock: (fn) => withWriteLock(async () => {
      const timer = setTimeout(() => {
        console.error(`[addon ${id}] withLock critical section exceeded ${ADDON_LOCK_WARNING_MS} ms. It still owns the core write lock; fix the addon hang/deadlock.`);
      }, ADDON_LOCK_WARNING_MS);
      if (timer.unref) timer.unref();
      try {
        return await fn();
      } finally {
        clearTimeout(timer);
      }
    }),
    broadcastDataChanged: () => _broadcastDataChanged(),
    log: (...args) => console.log(`[addon ${id}]`, ...args),
  };
  const dispose = () => {
    while (importDisposers.length) {
      try { importDisposers.pop()(); } catch (_) {}
    }
  };
  return { host, router, dispose };
}

// Load one addon's server module (require + init), fully isolated: a throw
// NEVER crashes the server (mirrors the try{require('./tiler')}catch idiom).
// Returns { state, error? }: 'loaded' | 'error' | 'blocked' | null(no server).
async function _loadServerAddon(entry) {
  const id = entry.id;
  if (!entry.server) return { state: null };
  const compatibility = AddonBroker.validateManifest({
    ...entry,
    entry: entry.entry || 'entry.js',
    permissions: entry.grantedPermissions,
  });
  if (!compatibility.ok) return { state: 'blocked', error: compatibility.errors.join('; ') };
  if (!Array.isArray(entry.grantedPermissions) || !entry.grantedPermissions.includes('server:code')) {
    return { state: 'blocked', error: 'chybí oprávnění server:code' };
  }
  const deps  = Array.isArray(entry.serverDeps) ? entry.serverDeps : [];
  const unmet = deps.filter(d => !AddonBroker.HOST_SERVER_LIBS.has(d));
  if (unmet.length) return { state: 'blocked', error: 'nedostupné serverové knihovny: ' + unmet.join(', ') };
  const idDir   = path.join(ADDONS_DIR, id);
  const codeDir = entry.activeHash ? _safeJoinIn(idDir, entry.activeHash) : null;
  if (!codeDir) return { state: 'error', error: 'neplatný activeHash' };
  const serverFile = _safeJoinIn(codeDir, entry.server);
  if (!serverFile) return { state: 'error', error: 'nebezpečná cesta v poli server' };
  let dispose = () => {};
  try {
    const mod  = require(serverFile);
    const init = mod && (mod.init || mod.default);
    if (typeof init !== 'function') return { state: 'error', error: 'serverový modul nemá init(host)' };
    _importJobs.unregisterAddon(id, 'provider-reload');
    const made = _makeServerHost(entry);
    const { host, router } = made;
    dispose = made.dispose;
    await init(host);
    _addonServers.set(id, { id, router, state: 'loaded', hash: entry.activeHash, dispose });
    return { state: 'loaded' };
  } catch (e) {
    dispose();
    console.error(`[addon ${id}] server load failed:`, e);
    return { state: 'error', error: e.message };
  }
}

// Load every enabled server addon once at boot. Read the registry, attempt
// each; record outcomes for the Manager. Called from _bootstrap before listen.
async function _loadServerAddons() {
  let reg;
  try { reg = await _readAddonsRegistry(); } catch { return; }
  for (const a of reg.addons) {
    if (!a || !a.server) continue;
    if (!a.enabled) { _serverLoadState.set(a.id, { state: 'disabled' }); continue; }
    const contentError = _addonContentErrors.get(a.id);
    if (contentError?.hash === a.activeHash) {
      _serverLoadState.set(a.id, { state: 'blocked', error: contentError.message });
      continue;
    }
    const r = await _loadServerAddon(a);
    _serverLoadState.set(a.id, r);
    if (r.state === 'loaded') console.log(`[addons] server loaded: ${a.id} (/api/addon/${a.id}/*)`);
    else if (r.state) console.warn(`[addons] server ${a.id}: ${r.state}${r.error ? ' — ' + r.error : ''}`);
  }
}

// The Manager-facing server state — authoritative on the LIVE router map (not
// just the boot outcome), so a runtime disable→re-enable without a restart
// reads honestly. 'pending-restart' = enabled but not actually serving
// (installed / re-enabled since boot) — restart-to-load v1.
function _serverStateFor(a) {
  if (!a.server) return null;
  if (!a.enabled) return 'disabled';
  const live = _addonServers.get(a.id);
  if (live && live.state === 'loaded') return 'loaded';   // actually serving
  const ls = _serverLoadState.get(a.id);
  if (ls && (ls.state === 'error' || ls.state === 'blocked')) return ls.state;
  return 'pending-restart';                                 // enabled but not live
}

// Prune an addon's on-disk code dirs down to the versions the registry still
// keeps (kept-K `versions[]` + activeHash), plus hashes reachable from retained
// recovery points — old `<hash>/` dirs would otherwise accumulate forever.
// Only content-hash-shaped dirs (16 hex) + a stale
// `.incoming` staging dir are ever removed; anything else is left untouched
// (defence). Rollback targets always live in `versions[]`, so this never
// deletes a reachable rollback. Caller holds the write lock (install) or runs
// pre-listen (boot sweep).
// Restore paths rewrite data/addons.json on disk out-of-band — re-derive
// the in-memory addon state (collection wire types + host-served content)
// from the restored registry, exactly like the mutation endpoints do after
// each registry write. Without this, a restore left stale `addon:<id>:<x>`
// types registered (or missing), 400-ing addon-collection PATCHes and
// serving stale content until a manual restart. Server CODE still defers
// to a restart (the require() cache isn't busted live).
async function _reconcileAddonsFromDisk() {
  _importJobs.invalidateJobs('campaign-restored');
  try {
    const reg = await _readAddonsRegistry();
    _applyAddonCollections(reg);
    _applyAddonContent(reg);
  } catch (e) {
    console.warn('[addons] post-restore reconcile failed:', e.message);
  }
}

async function _pruneAddonVersions(entry, referencedHashes) {
  if (!entry || !entry.id) return;
  const idDir = path.join(ADDONS_DIR, entry.id);
  let subs;
  try { subs = await fsp.readdir(idDir); } catch { return; }
  const keep = new Set();
  if (entry.activeHash) keep.add(entry.activeHash);
  for (const v of (Array.isArray(entry.versions) ? entry.versions : [])) {
    if (v && v.contentHash) keep.add(v.contentHash);
  }
  const snapshotReferences = referencedHashes || await _snapshots.referencedAddonHashes();
  for (const hash of snapshotReferences.get(entry.id) || []) keep.add(hash);
  for (const sub of subs) {
    if (keep.has(sub)) continue;
    if (sub === '.incoming' || /^\.incoming-[0-9a-f]{12}$/.test(sub) || /^[0-9a-f]{16}$/.test(sub)) {
      const p = _safeJoinIn(idDir, sub);
      if (p) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// Boot sweep: prune every installed addon's stale code dirs (cleans up
// accumulation from before pruning existed). Best-effort.
async function _pruneAllAddonCode() {
  // A crash before addon.json is validated can leave the id-agnostic raw
  // extraction stage at the addons root. Only our random staging shape is
  // eligible; real addon ids cannot start with a dot.
  const rootEntries = await fsp.readdir(ADDONS_DIR, { withFileTypes: true }).catch(() => []);
  for (const item of rootEntries) {
    if (item.isDirectory() && /^\.incoming-[0-9a-f]{12}$/.test(item.name)) {
      await fsp.rm(path.join(ADDONS_DIR, item.name), { recursive: true, force: true }).catch(() => {});
    }
  }
  let reg;
  try { reg = await _readAddonsRegistry(); } catch { return; }
  const installed = new Map(reg.addons.map(addon => [addon.id, addon]));
  const referencedHashes = await _snapshots.referencedAddonHashes();
  const ids = new Set(installed.keys());
  for (const item of rootEntries) {
    if (item.isDirectory() && AddonBroker.ID_RE.test(item.name)) ids.add(item.name);
  }
  for (const id of ids) {
    try {
      await _pruneAddonVersions(installed.get(id) || { id }, referencedHashes);
    } catch (_) {}
  }
}

// Staging (NO write lock): fetch → validate → content-hash → stage to
// .incoming → run the server test green-gate. The network I/O and the (up to
// 30 s) test run happen HERE, outside the lock, so installing an addon never
// blocks other clients' saves/snapshots. Returns a staging descriptor for
// _promoteAddon; throws (400-worthy) on any validation miss.
async function _stageAddon(repo, ref, pinnedSha) {
  const token  = _githubToken();
  const useRef = ref || 'HEAD';
  // Pin to the exact reviewed commit when the wizard passes the previewed sha
  // (so what installs == what the DM reviewed); otherwise resolve the ref now.
  // The ORIGINAL ref is what we store, so check-updates can re-resolve it later.
  const sha = (typeof pinnedSha === 'string' && /^[0-9a-f]{40}$/i.test(pinnedSha))
    ? pinnedSha.toLowerCase()
    : await AddonBroker.resolveRefToSha(repo, useRef, { fetch, token });
  const buf = await AddonBroker.fetchZipball(repo, sha, {
    fetch, token, maxBytes: ADDON_MAX_ARCHIVE_BYTES,
  });

  // The manifest id is inside the archive, so extraction starts in a unique
  // host-owned staging dir. The extractor scans every central-directory entry
  // first (count/path/declared sizes/compression ratios), then streams accepted
  // files to disk through actual-byte limiters. Expanded entry buffers never
  // exist in memory. Once the manifest validates, rename the staging tree under
  // its id; promotion later atomically flips it to the content-addressed dir.
  const stageToken = crypto.randomBytes(6).toString('hex');
  const rawIncoming = path.join(ADDONS_DIR, `.incoming-${stageToken}`);
  let incoming = null;
  await fsp.rm(rawIncoming, { recursive: true, force: true }).catch(() => {});
  try {
    const extracted = await AddonArchive.extractAddonZip(buf, rawIncoming, {
      maxArchiveBytes: ADDON_MAX_ARCHIVE_BYTES,
      maxEntries: ADDON_MAX_FILES,
      maxEntryBytes: ADDON_MAX_ENTRY_BYTES,
      maxTotalBytes: ADDON_MAX_BYTES,
      maxCompressionRatio: ADDON_MAX_COMPRESSION_RATIO,
    });
    if (!extracted.files.length) throw new Error('archiv je prázdný nebo neobsahuje platné soubory');
    if (!extracted.files.includes('addon.json')) throw new Error('addon.json chybí v kořeni repozitáře');

    let manifest;
    try { manifest = JSON.parse(await fsp.readFile(path.join(rawIncoming, 'addon.json'), 'utf8')); }
    catch { throw new Error('addon.json není platný JSON'); }
    const v = AddonBroker.validateManifest(manifest);
    if (!v.ok) throw new Error('neplatný addon.json: ' + v.errors.join('; '));

    await AddonLocalization.validateLocalizationPackage(rawIncoming, manifest);
    if (manifest.contentDir) {
      const contentRoot = _safeJoinIn(rawIncoming, manifest.contentDir);
      if (!contentRoot) throw new Error('neplatná cesta contentDir');
      AddonContent.loadContentTree(contentRoot);
    }

    const id = manifest.id;
    const hash = await AddonArchive.contentHashDirectory(rawIncoming, extracted.files, crypto);
    const idDir = path.join(ADDONS_DIR, id);
    incoming = path.join(idDir, `.incoming-${stageToken}`);
    const finalDir = path.join(idDir, hash);
    await fsp.mkdir(idDir, { recursive: true });
    await fsp.rename(rawIncoming, incoming);

    // Run the addon's declared server self-tests before promotion.
    // against the STAGED tree before promoting. Red → discard staging, never
    // activate (the existing stage→rename pipeline makes "revert" free).
    //
    // Running these tests EXECUTES addon code on the host, so we only do it when
    // the addon will actually run server code — i.e. is granted `server:code`. At
    // install the grant set == the manifest's requested permissions (all-or-
    // nothing), so reading the manifest here IS reading the grant; if per-
    // permission deny ever lands, gate this on the GRANTED set instead. The
    // spawned process gets a SCRUBBED env so the addon's tests can't read
    // GITHUB_TOKEN / passwords. Self-contained (no node_modules in staging), capped.
    const serverTestDecl = manifest.tests && manifest.tests.server;
    const grantsServerCode = Array.isArray(manifest.permissions) && manifest.permissions.includes('server:code');
    if (serverTestDecl && grantsServerCode) {
      const testPaths = (Array.isArray(serverTestDecl) ? serverTestDecl : [serverTestDecl])
        .map(p => _safeJoinIn(incoming, p)).filter(Boolean);
      const { spawn } = require('child_process');
      const result = await AddonTesting.runNodeTests(incoming, testPaths, { spawn, timeoutMs: 30000 });
      if (!result.ok) {
        const why = result.timedOut ? 'překročen časový limit' : `selhaly (exit ${result.code})`;
        throw new Error(`serverové testy doplňku ${why}`);
      }
    }
    return { repo, useRef, sha, manifest, id, hash, incoming, finalDir };
  } catch (e) {
    // Discard the half-staged tree so a failed/aborted install never leaks
    // `.incoming`. Best-effort; the original error is what the caller sees.
    await fsp.rm(rawIncoming, { recursive: true, force: true }).catch(() => {});
    if (incoming) await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// Promotion (caller HOLDS the write lock): atomic-rename the staged tree
// into the content-addressed dir, then the registry read-modify-write + live
// collection wiring + version prune. Only this fast, disk-local phase is
// serialized. Returns the updated registry entry.
async function _promoteAddon(staged) {
  const { repo, useRef, sha, manifest, id, hash, incoming, finalDir } = staged;

  await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rename(incoming, finalDir);

  // Per-addon isolated data dir.
  await fsp.mkdir(path.join(ADDON_DATA_DIR, id), { recursive: true }).catch(() => {});

  // Update the registry (content-addressed: activeHash selects the live
  // version, versions[] keeps the last K for rollback).
  const reg = await _readAddonsRegistry();
  const _serverDeps   = Array.isArray(manifest.serverDeps) ? manifest.serverDeps.filter(d => typeof d === 'string') : [];
  const _collections  = AddonBroker.normalizeCollections(
    manifest.collections,
    manifest.apiVersion,
    manifest.capabilities,
  );
  const _dependencies = (manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)) ? manifest.dependencies : {};
  const _optionalDependencies = (manifest.optionalDependencies && typeof manifest.optionalDependencies === 'object' && !Array.isArray(manifest.optionalDependencies)) ? manifest.optionalDependencies : {};
  // The version record snapshots the structural manifest fields too, so a
  // rollback to this contentHash can restore the right entry/server/collections,
  // not just flip the code dir.
  const _optionalMetadata = AddonBroker.installedOptionalMetadata(manifest);
  const versionRec = {
    contentHash: hash, version: manifest.version, sha, installedAt: Date.now(),
    apiVersion: manifest.apiVersion,
    entry: manifest.entry,
    serverDeps: _serverDeps, collections: _collections,
    dependencies: _dependencies, optionalDependencies: _optionalDependencies,
    ..._optionalMetadata,
  };
  let entry = reg.addons.find(a => a.id === id);
  if (!entry) {
    entry = {
      id, repo, ref: useRef, sha,
      name: manifest.name, version: manifest.version,
      apiVersion: manifest.apiVersion,
      entry: manifest.entry,
      disabledContentGroups: [],
      serverDeps: _serverDeps,
      activeHash: hash, versions: [versionRec],
      enabled: true, grantedPermissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      dependencies: _dependencies,
      optionalDependencies: _optionalDependencies,
      collections: _collections,
      schemaVersion: 0, installedAt: Date.now(),
      ..._optionalMetadata,
    };
    reg.addons.push(entry);
  } else {
    Object.assign(entry, {
      repo, ref: useRef, sha,
      name: manifest.name, version: manifest.version,
      apiVersion: manifest.apiVersion,
      entry: manifest.entry,
      // The DM's disabledContentGroups toggle state survives updates; the
      // DECLARATION follows the manifest (an update may add/drop/rename the
      // grouping field — stale off-list ids then simply match nothing).
      serverDeps: _serverDeps,
      dependencies: _dependencies,
      optionalDependencies: _optionalDependencies,
      collections: _collections,
      activeHash: hash,
    });
    AddonBroker.applyInstalledOptionalMetadata(entry, _optionalMetadata);
    if (!Array.isArray(entry.versions)) entry.versions = [];
    if (!entry.versions.some(x => x.contentHash === hash)) entry.versions.push(versionRec);
    if (entry.versions.length > ADDON_VERSIONS_KEEP) entry.versions = entry.versions.slice(-ADDON_VERSIONS_KEEP);
  }
  // Record the source so the update path knows where to re-pull (explicit
  // DM install is itself the trust gesture — no separate allowlist step).
  if (!reg.sources.allow.includes(repo)) reg.sources.allow.push(repo);
  await _writeAddonsRegistry(reg);
  // Make the addon's declared collections writable through /api/data now,
  // without waiting for a restart (the SSE reconcile live-loads the client).
  _applyAddonCollections(reg);
  // (Re)build host-served content trees; and if the promoted version ships no
  // server module, drop any stale live router at once so the content
  // dispatcher (or the JSON 404) takes over instead of a dead router.
  _applyAddonContent(reg);
  if (!entry.server) _addonServers.delete(id);
  // Drop code dirs no longer in versions[] (keep-last-K). Best-effort — a
  // failed prune never fails the install.
  await _pruneAddonVersions(entry).catch(() => {});
  return entry;
}

// Public list — readable by any caller (boot happens pre-login).
app.get('/api/addons', async (req, res) => {
  try {
    const reg = await _readAddonsRegistry();
    res.json({
      apiVersion: AddonBroker.HOST_API_VERSION,
      hostVersion: AddonBroker.HOST_VERSION,
      capabilities: [...AddonBroker.HOST_CAPABILITIES],
      instance: INSTANCE,
      addons: _publicAddonList(reg, req.role === 'dm' ? 'dm' : 'player'),
      // Fragment-override conflict resolutions (target → winner addonId | null).
      // The client host consults these so a DM-picked winner actually applies.
      resolutions: (reg.resolutions && typeof reg.resolutions === 'object') ? reg.resolutions : {},
      // Whether a server-side GitHub token is configured (wizard-stored /
      // CODEX_GITHUB_TOKEN / GITHUB_TOKEN) and where it came from — the
      // Manager + wizard show it so a DM knows up front whether PRIVATE
      // addon repos will install, instead of learning from a failed fetch.
      // Real-DM only (the route itself is public for boot): booleans about
      // server config, but still nobody else's business. Never the token.
      ...(req.realRole === 'dm' ? {
        githubTokenConfigured: !!_githubToken(),
        githubTokenSource: _githubTokenSource(),
      } : {}),
    });
  } catch (e) {
    console.error('GET /api/addons:', e);
    res.status(500).json({ error: 'Read error' });
  }
});

// DM-only (realRole) fragment-override conflict resolution. Body
// `{ target, winner }`: winner = an addonId → that addon's op wins; `null` →
// force the built-in; absent/empty → clear the resolution (back to auto, where
// ≥2 exclusive claims fall back to the built-in until resolved). The client
// reconciles via the addons-changed broadcast.
app.post('/api/addons/resolve', requireRealDM('Jen DM může řešit konflikty doplňků.'), async (req, res) => {
  const { target, winner } = req.body || {};
  if (typeof target !== 'string' || !target || target.length > 200) {
    return res.status(400).json({ error: 'Neplatný cíl konfliktu.' });
  }
  if (_isForbiddenKey(target)) {
    return res.status(400).json({ error: `Forbidden target: ${target}` });
  }
  // winner: a non-empty string (addonId), or null (force built-in). Anything
  // else (undefined / '') means "clear".
  const clear = !(typeof winner === 'string' && winner) && winner !== null;
  if (typeof winner === 'string' && winner && !AddonBroker.ID_RE.test(winner)) {
    return res.status(400).json({ error: 'Neplatné id doplňku.' });
  }
  try {
    const result = await withWriteLock(async () => {
      const reg = await _readAddonsRegistry();
      // A winner addonId must actually be installed — otherwise the conflict
      // would "resolve" to a claim that doesn't exist (a silent no-op that
      // still reads as resolved). Give the DM real feedback instead.
      if (!clear && winner !== null && !reg.addons.some(a => a.id === winner)) {
        return { ok: false, error: 'Vybraný doplněk není nainstalovaný.' };
      }
      if (clear) delete reg.resolutions[target];
      else       reg.resolutions[target] = winner;   // addonId | null
      await _writeAddonsRegistry(reg);
      return { ok: true, resolutions: reg.resolutions };
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, resolutions: result.resolutions });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error('POST /api/addons/resolve:', e);
    res.status(500).json({ error: 'Write error' });
  }
});

// DM-only (realRole) on-demand update check. For each addon installed
// from a real GitHub repo, re-resolve its stored ref → the latest commit SHA and
// diff against the installed `sha`. PURE READ — resolves only, never downloads /
// installs (applying an update opens the wizard). Per-addon failures are
// isolated so one unreachable repo doesn't fail the whole check.
app.post('/api/addons/check-updates', requireRealDM('Jen DM může kontrolovat aktualizace.'), async (req, res) => {
  try {
    const reg   = await _readAddonsRegistry();
    const token = _githubToken();
    const updates = [];
    for (const a of reg.addons) {
      if (!a || !a.repo || a.repo === 'local' || !AddonBroker.REPO_RE.test(a.repo)) {
        updates.push({ id: a && a.id, status: 'local' });   // dev-installed / no real source
        continue;
      }
      try {
        const latest = await AddonBroker.resolveRefToSha(a.repo, a.ref || 'HEAD', { fetch, token });
        updates.push({
          id: a.id, status: 'ok', repo: a.repo, ref: a.ref || 'HEAD',
          currentSha: a.sha || null, latestSha: latest,
          hasUpdate: !!a.sha && latest !== a.sha,
        });
      } catch (e) {
        updates.push({ id: a.id, status: 'error', error: e.message });
      }
    }
    res.json({ checkedAt: Date.now(), updates });
  } catch (e) {
    console.error('POST /api/addons/check-updates:', e);
    res.status(500).json({ error: 'Check failed' });
  }
});

// DM-only (realRole): update EVERY addon from a real GitHub repo to its latest
// commit in one shot — the per-addon update flow, looped. For each non-local addon
// we re-resolve its stored ref → latest SHA and, if it changed, stage+promote via
// the SAME pipeline a single install uses (green-gate, content-hash, kept versions
// for rollback). Local (dev-installed) addons have no remote and are skipped.
// `serverChanged` flags whether any updated addon ships server code, so the client
// can prompt a restart. Per-addon failures are isolated into `errors`.
app.post('/api/addons/update-all', requireRealDM('Jen DM může aktualizovat doplňky.'), async (req, res) => {
  try {
    const reg   = await _readAddonsRegistry();
    const token = _githubToken();
    const updated = [], skipped = [], errors = [];
    let serverChanged = false;
    for (const a of reg.addons) {
      if (!a || !a.id) continue;
      if (!a.repo || a.repo === 'local' || !AddonBroker.REPO_RE.test(a.repo)) {
        skipped.push({ id: a && a.id, reason: 'local' });   // dev-installed / no real source
        continue;
      }
      try {
        const latest = await AddonBroker.resolveRefToSha(a.repo, a.ref || 'HEAD', { fetch, token });
        if (a.sha && latest === a.sha) { skipped.push({ id: a.id, reason: 'up-to-date' }); continue; }
        const staged = await _stageAddon(a.repo, a.ref || 'HEAD', latest);
        const entry  = await withWriteLock(() => _promoteAddon(staged));
        if (entry && entry.server) serverChanged = true;
        updated.push({ id: a.id, from: a.sha || null, to: latest });
      } catch (e) {
        if (_sendWriteLockTimeout(res, e)) return;
        errors.push({ id: a.id, error: e.message });
      }
    }
    if (updated.length) _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, updated, skipped, errors, serverChanged });
  } catch (e) {
    console.error('POST /api/addons/update-all:', e);
    res.status(500).json({ error: 'Update-all failed' });
  }
});

// DM-only (realRole) content-addressed rollback. Flip `activeHash` to
// a kept prior version — instant + offline (no re-fetch), since every version's
// code dir survives under data/addons/<id>/<hash>/. Restores that version's
// structural manifest fields too (entry/server/serverDeps/collections/deps) so
// the registry stays coherent, not just the code dir. Body `{ hash? }` targets a
// specific kept version; omitted → the version immediately before the active one.
app.post('/api/addons/:id/rollback', requireRealDM('Jen DM může vracet verze doplňků.'), async (req, res) => {
  const id = String(req.params.id || '');
  if (!AddonBroker.ID_RE.test(id)) return res.status(400).json({ error: 'Neplatné id doplňku.' });
  const targetHash = (req.body && typeof req.body.hash === 'string') ? req.body.hash : null;
  try {
    const result = await withWriteLock(async () => {
      const reg   = await _readAddonsRegistry();
      const entry = reg.addons.find(a => a.id === id);
      if (!entry) return { status: 404 };
      const versions = Array.isArray(entry.versions) ? entry.versions : [];
      if (versions.length < 2) return { status: 400, error: 'Žádná předchozí verze k obnovení.' };
      let target;
      if (targetHash) {
        target = versions.find(v => v.contentHash === targetHash);
      } else {
        const idx = versions.findIndex(v => v.contentHash === entry.activeHash);
        target = idx > 0 ? versions[idx - 1] : versions[versions.length - 2];   // the one before active
      }
      if (!target) return { status: 400, error: 'Cílová verze nenalezena.' };
      // Verify the code dir still exists (pruning keeps the
      // kept-K dirs, but a manual delete could have removed it).
      const codeDir = _safeJoinIn(path.join(ADDONS_DIR, id), target.contentHash);
      const codeDirExists = codeDir ? await fsp.access(codeDir).then(() => true, () => false) : false;
      if (!codeDirExists) return { status: 400, error: 'Kód cílové verze chybí (znovu nainstaluj).' };

      // Restore the structural fields from the kept version record. These were
      // validated at THAT version's install; the runtime path-safety net is
      // _loadServerAddon's _safeJoinIn on entry.server/entry.entry at (re)load.
      entry.activeHash = target.contentHash;
      entry.version    = target.version || entry.version;
      entry.sha        = target.sha || entry.sha;
      if (target.entry)                  entry.entry       = target.entry;
      if (target.apiVersion)             entry.apiVersion  = target.apiVersion;
      if (target.hostVersion !== undefined) entry.hostVersion = target.hostVersion;
      else delete entry.hostVersion;
      if (target.capabilities !== undefined) entry.capabilities = target.capabilities;
      else delete entry.capabilities;
      if (target.server !== undefined) entry.server = target.server;
      else delete entry.server;
      if (target.contentDir !== undefined) entry.contentDir = target.contentDir;
      else delete entry.contentDir;
      if (target.contentGroups !== undefined) entry.contentGroups = target.contentGroups;
      else delete entry.contentGroups;
      if (target.locales !== undefined) entry.locales = target.locales;
      else delete entry.locales;
      if (Array.isArray(target.serverDeps))  entry.serverDeps  = target.serverDeps;
      if (Array.isArray(target.collections)) {
        entry.collections = AddonBroker.normalizeCollections(
          target.collections,
          target.apiVersion || entry.apiVersion,
          target.capabilities || entry.capabilities,
        );
      }
      if (target.dependencies)           entry.dependencies = target.dependencies;
      if (target.optionalDependencies)   entry.optionalDependencies = target.optionalDependencies;
      await _writeAddonsRegistry(reg);
      _applyAddonCollections(reg);
      _applyAddonContent(reg);           // host-served content flips with the hash, hot
      // Server code changed under it → drop the live router; restart reloads
      // the rolled-back server module (restart-to-load v1). A rolled-back
      // version WITHOUT server code drops the router too (serve nothing stale).
      _addonServers.delete(id);
      return { status: 200, version: entry.version, activeHash: entry.activeHash };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.error || 'Doplněk nenalezen.' });
    _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, version: result.version, activeHash: result.activeHash });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error('POST /api/addons/:id/rollback:', e);
    res.status(500).json({ error: 'Rollback failed' });
  }
});

// DM-only (realRole) source-allowlist management — the trusted repos an
// addon may be installed from. `action:'remove'` drops one.
app.post('/api/addons/sources', requireRealDM('Jen DM může spravovat zdroje doplňků.'), async (req, res) => {
  const { repo, action } = req.body || {};
  if (typeof repo !== 'string' || !(AddonBroker.REPO_RE.test(repo) || /^[A-Za-z0-9_.-]{1,39}\/\*$/.test(repo))) {
    return res.status(400).json({ error: 'Neplatný repozitář (očekávám owner/name nebo owner/*).' });
  }
  try {
    const allow = await withWriteLock(async () => {
      const reg = await _readAddonsRegistry();
      const set = new Set(reg.sources.allow);
      if (action === 'remove') set.delete(repo); else set.add(repo);
      reg.sources.allow = [...set];
      await _writeAddonsRegistry(reg);
      return reg.sources.allow;
    });
    _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, allow });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error('POST /api/addons/sources:', e);
    res.status(500).json({ error: 'Write error' });
  }
});

// DM-only (realRole) install from a pasted GitHub URL or owner/name — the
// wizard's single input. Explicit DM install IS the trust gesture; the repo
// is auto-recorded as a known source by _installAddon (no allowlist to curate).
app.post('/api/addons/install', requireRealDM('Jen DM může instalovat doplňky.'), async (req, res) => {
  const parsed = AddonBroker.parseRepoInput(req.body && req.body.repo);
  if (!parsed) {
    return res.status(400).json({ error: 'Neplatná adresa (očekávám https://github.com/owner/name nebo owner/name).' });
  }
  const repo = parsed.repo;
  const ref  = String((req.body && req.body.ref) || parsed.ref || 'HEAD');
  // The wizard passes the reviewed `sha` to pin the exact previewed commit
  // while `ref` (the branch/tag) is what we store for future update checks.
  const pinnedSha = (req.body && typeof req.body.sha === 'string') ? req.body.sha : undefined;
  try {
    // Stage outside the lock (network + tests must not block other writers),
    // then promote under it (fast, disk-local registry mutation).
    const staged = await _stageAddon(repo, ref, pinnedSha);
    const entry  = await withWriteLock(() => _promoteAddon(staged));
    _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, addon: { id: entry.id, version: entry.version, activeHash: entry.activeHash } });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error('POST /api/addons/install:', e.message);
    res.status(400).json({ error: 'Instalace selhala: ' + e.message });
  }
});

// DM-only (realRole) preview: fetch + validate just addon.json so the
// wizard can show the manifest + requested permissions for review BEFORE
// anything is installed. Returns the manifest even when incompatible (with
// `ok:false` + `errors`) so the DM sees why it can't be installed. The
// resolved `sha` is fed back into install so the exact reviewed commit lands.
app.post('/api/addons/preview', requireRealDM('Jen DM může instalovat doplňky.'), async (req, res) => {
  const parsed = AddonBroker.parseRepoInput(req.body && req.body.repo);
  if (!parsed) {
    return res.status(400).json({ error: 'Neplatná adresa (očekávám https://github.com/owner/name nebo owner/name).' });
  }
  try {
    const token = _githubToken();
    const ref = String((req.body && req.body.ref) || parsed.ref || 'HEAD');
    const { sha, manifest } = await AddonBroker.fetchManifest(parsed.repo, ref, { fetch, token });
    const v = AddonBroker.validateManifest(manifest);
    res.json({
      repo: parsed.repo,
      ref,                 // the original branch/tag — install stores it for update checks
      sha,
      ok: v.ok,
      errors: v.errors,
      manifest: {
        id:          manifest.id,
        name:        manifest.name,
        version:     manifest.version,
        apiVersion:  manifest.apiVersion,
        hostVersion: manifest.hostVersion || '',
        capabilities: manifest.capabilities || undefined,
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        collections: AddonBroker.normalizeCollections(
          manifest.collections,
          manifest.apiVersion,
          manifest.capabilities,
        ),
        dependencies: (manifest.dependencies && typeof manifest.dependencies === 'object') ? manifest.dependencies : {},
        optionalDependencies: (manifest.optionalDependencies && typeof manifest.optionalDependencies === 'object') ? manifest.optionalDependencies : {},
        summary:     manifest.summary || '',
        server:      !!manifest.server,
      },
    });
  } catch (e) {
    console.error('POST /api/addons/preview:', e.message);
    res.status(400).json({ error: 'Náhled selhal: ' + e.message });
  }
});

// DM-only (realRole) enable / disable an installed addon (live-reconciled
// by clients via the addons-changed SSE event).
app.post('/api/addons/:id/enable',  requireRealDM('Jen DM může spravovat doplňky.'), (req, res) => _setAddonEnabled(req, res, true));
app.post('/api/addons/:id/disable', requireRealDM('Jen DM může spravovat doplňky.'), (req, res) => _setAddonEnabled(req, res, false));
async function _setAddonEnabled(req, res, enabled) {
  const id = String(req.params.id || '');
  if (!AddonBroker.ID_RE.test(id)) return res.status(400).json({ error: 'Neplatné id doplňku.' });
  try {
    const found = await withWriteLock(async () => {
      const reg = await _readAddonsRegistry();
      const entry = reg.addons.find(a => a.id === id);
      if (!entry) return false;
      entry.enabled = enabled;
      await _writeAddonsRegistry(reg);
      _applyAddonCollections(reg);   // enabling/disabling adds/removes its wire types
      _applyAddonContent(reg);       // host-served content follows enabled state, hot
      // A disabled addon must serve nothing — drop its live router immediately
      // (re-enabling a server addon needs a restart to reload; restart-to-load v1).
      if (!enabled) _addonServers.delete(id);
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Doplněk nenalezen.' });
    _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, id, enabled });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error('POST /api/addons/:id/enable:', e);
    res.status(500).json({ error: 'Write error' });
  }
}

// DM-only (realRole) content-group toggles: replace the addon's disabled
// group list wholesale ({ disabled: string[] }). Content is hot — the
// filtered tree rebuilds from the in-memory raw cache immediately and
// data-changed pushes every client to refetch, so unticking "Monster
// Manual" empties the bestiary mid-session with no restart. Only valid on
// an addon whose manifest declares `contentGroups`; unknown group ids are
// stored as-is (they match nothing — harmless, and forward-compatible with
// a book the next update adds).
app.post('/api/addons/:id/content-groups', requireRealDM('Jen DM může spravovat doplňky.'), async (req, res) => {
  const id = String(req.params.id || '');
  if (!AddonBroker.ID_RE.test(id)) return res.status(400).json({ error: 'Neplatné id doplňku.' });
  const disabled = AddonBroker.normalizeDisabledContentGroups(req.body && req.body.disabled);
  if (req.body && req.body.disabled !== undefined && !Array.isArray(req.body.disabled)) {
    return res.status(400).json({ error: 'disabled musí být pole řetězců.' });
  }
  try {
    const outcome = await withWriteLock(async () => {
      const reg = await _readAddonsRegistry();
      const entry = reg.addons.find(a => a.id === id);
      if (!entry) return 'missing';
      if (!entry.contentGroups || !entry.contentGroups.field) return 'no-groups';
      entry.disabledContentGroups = disabled;
      await _writeAddonsRegistry(reg);
      _applyAddonContent(reg);       // re-filter from the cached raw tree, hot
      _reconcileImportProviders(reg.addons);
      return 'ok';
    });
    if (outcome === 'missing')   return res.status(404).json({ error: 'Doplněk nenalezen.' });
    if (outcome === 'no-groups') return res.status(400).json({ error: 'Doplněk nedeklaruje contentGroups.' });
    // Content changed for every viewer → both signals: addons-changed
    // refreshes the Manager, data-changed makes content consumers refetch.
    _broadcast('addons-changed', { at: Date.now() });
    await _broadcastDataChanged();
    res.json({ ok: true, id, disabled });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error('POST /api/addons/:id/content-groups:', e);
    res.status(500).json({ error: 'Write error' });
  }
});

// DM-only (realRole): set/clear the stored GitHub token from the install
// wizard. Body { token: "<value>" } sets; { token: "" } (or no token key)
// clears. Shape-validated only (printable ASCII, no spaces — covers ghp_*,
// github_pat_* and future formats), written to data/secrets.json, and NEVER
// echoed back, logged, backed up or snapshotted. A stored token wins over
// the env vars (see _githubToken). Broadcasts addons-changed so every open
// Manager refreshes its 🔑 line live.
const GITHUB_TOKEN_RE = /^[\x21-\x7E]{8,255}$/;
app.post('/api/addons/github-token', requireRealDM('Jen DM může spravovat GitHub token.'), async (req, res) => {
  const raw = (req.body && typeof req.body.token === 'string') ? req.body.token.trim() : '';
  if (raw && !GITHUB_TOKEN_RE.test(raw)) {
    return res.status(400).json({ error: 'Token má neplatný tvar.' });
  }
  try {
    await withWriteLock(async () => {
      const secrets = { ..._loadSecrets() };
      if (raw) secrets.githubToken = raw; else delete secrets.githubToken;
      await _writeSecrets(secrets);
    });
    _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, configured: !!_githubToken(), source: _githubTokenSource() });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    // e.message only — an error object could conceivably carry request body.
    console.error('POST /api/addons/github-token:', e && e.message);
    res.status(500).json({ error: 'Write error' });
  }
});

// DM-only (realRole) remove an installed addon: drop it from the registry +
// delete its code dir. Per-addon DATA (data/addon-data/<id>/) is KEPT unless
// ?purge=1, so a re-install restores the addon's content.
app.delete('/api/addons/:id', requireRealDM('Jen DM může spravovat doplňky.'), async (req, res) => {
  const id = String(req.params.id || '');
  if (!AddonBroker.ID_RE.test(id)) return res.status(400).json({ error: 'Neplatné id doplňku.' });
  const purge = req.query.purge === '1' || req.query.purge === 'true';
  try {
    const found = await withWriteLock(async () => {
      const reg = await _readAddonsRegistry();
      const idx = reg.addons.findIndex(a => a.id === id);
      if (idx === -1) return false;
      reg.addons.splice(idx, 1);
      for (const k of Object.keys(reg.resolutions || {})) {
        if (reg.resolutions[k] === id) reg.resolutions[k] = null;
      }
      await _writeAddonsRegistry(reg);
      // Retained recovery points may restore this registry entry. Keep only
      // packages they can still select; ordinary orphan packages are removed.
      await _pruneAddonVersions(
        { id },
        await _snapshots.referencedAddonHashes(),
      ).catch(() => {});
      if (purge) {
        const dataDir = _safeJoinIn(ADDON_DATA_DIR, id);
        if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
      }
      _applyAddonCollections(reg);   // removed addon's wire types go away
      _applyAddonContent(reg);       // …and its host-served content
      _addonServers.delete(id);      // stop serving its endpoints at once
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Doplněk nenalezen.' });
    _broadcast('addons-changed', { at: Date.now() });
    res.json({ ok: true, id, purged: purge });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error('DELETE /api/addons/:id:', e);
    res.status(500).json({ error: 'Delete error' });
  }
});

registerLiveSyncRoute(app);

function _runMediaUpload(req, res, label, task) {
  const cleanup = () => req.file?.path
    ? fsp.unlink(req.file.path).catch(() => {})
    : Promise.resolve();
  return _runWriteRequest(res, async () => {
    try {
      await task();
    } catch (error) {
      console.error(`[media] ${label}:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
    } finally {
      await cleanup();
    }
  }, cleanup);
}

/**
 * POST /api/portrait/:charId — Upload a character portrait image.
 *
 * Multer config caps at 20 MB and rejects non-image MIME types.
 * The parsed file remains in campaign-scoped staging until the media
 * journal atomically replaces any previous portrait extension.
 *
 * Auth: required.
 */
app.post('/api/portrait/:charId', requireAnyRole, uploadChar.single('portrait'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  return _runMediaUpload(req, res, 'portrait upload', async () => {
    const charId = (req.params.charId || '')
      .replace(/[^a-z0-9_-]/gi, '_')
      .substring(0, 60);
    if (!charId) return res.status(400).json({ error: 'Invalid character id' });
    const extension = imageExtension(req.file, '.jpg');
    await _mediaFiles.publishReplacement({
      stagedPath: req.file.path,
      relativeDir: `portraits/${charId}`,
      baseName: 'portrait',
      extension,
    });
    res.json({ url: `/portraits/${charId}/portrait${extension}` });
  });
});

// ── Tile pyramid ──────────────────────────────────────────────────
// Maps are rendered in Leaflet via an on-disk pyramid of 256px tiles
// (zoom level z, column x, row y). `tiler.js` owns the actual pyramid
// build; we only wire the upload hook and the static route here.
let _tiler = null;
try { _tiler = require('./tiler'); }
catch (e) { console.warn('[tiles] sharp not installed — tile generation disabled:', e.message); }

/**
 * POST /api/localmap/:locId — Upload a local sub-map image for a
 * location. Journal-replaces any prior extension and schedules an
 * immutable tile-generation rebuild. The returned image URL remains the
 * fallback while tiles build. Auth: required.
 */
app.post('/api/localmap/:locId', requireAnyRole, uploadLocalMap.single('localmap'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  return _runMediaUpload(req, res, 'local map upload', async () => {
    const locId = (req.params.locId || '')
      .replace(/[^a-z0-9_-]/gi, '_')
      .substring(0, 60);
    if (!locId) return res.status(400).json({ error: 'Invalid location id' });
    const extension = imageExtension(req.file, '.jpg');
    await _mediaFiles.publishReplacement({
      stagedPath: req.file.path,
      relativeDir: `maps/local/${locId}`,
      baseName: 'map',
      extension,
    });
    const url = `/maps/local/${locId}/map${extension}`;
    if (_tiler) {
      _tiler.buildFor(`local-${locId}`, path.join(LOCAL_MAPS_DIR, locId, `map${extension}`))
        .catch(error => {
          console.warn(`[tiles] build failed for local-${locId}:`, error.message);
        });
    }
    res.json({ url });
  });
});

// Serve tiles as static files. The tiler writes to
// data/maps/tiles/<mapId>/<z>/<x>/<y>.jpg; we expose them at the same
// path under /maps/tiles. Includes a tiles.json manifest per mapId.
app.use('/maps/tiles', express.static(TILES_DIR, { fallthrough: true, maxAge: '7d' }));

// ── Marker icon endpoints ────────────────────────────────────────
// Multipart upload (1..16 files, 2 MB each, svg/png/jpeg/webp). Files
// are buffered IN MEMORY by multer (memoryStorage), so nothing touches
// disk during parse; the route validates the pinType id against the live
// settings.pinTypes list and only THEN writes the buffers — all inside
// withWriteLock, so a concurrent settings PATCH that deletes the pin type
// can't race a file onto disk after the existence check.
async function _pinTypeExists(pinTypeId) {
  try {
    const raw = await fsp.readFile(getFile('settings'), 'utf8');
    const settings = JSON.parse(raw);
    const list = (settings && settings.pinTypes) || [];
    return Array.isArray(list) && list.some(p => p && p.id === pinTypeId);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * POST /api/icons/:pinTypeId — Upload up to 16 marker-icon variants
 * for a pin type (SVG/PNG/JPEG/WEBP, 2 MB each). Validates the
 * `pinTypeId` against the live `settings.pinTypes` list BEFORE writing
 * anything to disk; an unknown id is rejected with no disk side-effect
 * (files are still in memory). Auth: required.
 */
app.post('/api/icons/:pinTypeId', requireDM, uploadIcons.array('icons', 16), (req, res) => {
  _runWriteRequest(res, async () => {
    try {
      const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
      if (!pinTypeId) return res.status(400).json({ error: 'Invalid pinTypeId' });
      // Unknown pin type: nothing was written (memoryStorage), so there's
      // no orphan to clean up — just reject.
      if (!await _pinTypeExists(pinTypeId)) {
        return res.status(400).json({ error: 'Unknown pinTypeId' });
      }
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });

      const dir = path.join(ICONS_DIR, pinTypeId);
      // Resolve filename collisions deterministically (slug, slug-2, …)
      // against both the existing dir AND names already taken earlier in
      // THIS batch, so two identically-named uploads in one request don't
      // clobber each other.
      const taken = new Set();
      try { for (const f of await fsp.readdir(dir)) taken.add(f); } catch (_) {}
      const out = [];
      const files = [];
      for (const f of req.files) {
        const ext  = _iconExt(f.originalname);
        const slug = _slugifyIconName(f.originalname);
        let name = slug + ext;
        let n = 2;
        while (taken.has(name)) name = `${slug}-${n++}${ext}`;
        taken.add(name);
        files.push({ name, content: f.buffer });
        out.push({ id: name, url: `/icons/${pinTypeId}/${name}`, name: f.originalname });
      }
      await _mediaFiles.publishBuffers({
        relativeDir: `icons/${pinTypeId}`,
        files,
      });
      res.json({ files: out });
    } catch (e) {
      console.error('POST /api/icons:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
    }
  });
});

app.delete('/api/icons/:pinTypeId/:filename', requireDM, (req, res) => {
  _runWriteRequest(res, async () => {
    try {
      const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
      if (!pinTypeId) return res.status(400).json({ error: 'Invalid pinTypeId' });
      const filename = String(req.params.filename || '');
      if (!/^[a-z0-9_-]{1,80}\.(?:svg|png|jpe?g|webp)$/i.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
      const dir    = path.join(ICONS_DIR, pinTypeId);
      const target = _safeJoinIn(dir, filename);
      if (!target) return res.status(400).json({ error: 'Invalid filename' });
      try {
        const stat = await fsp.lstat(target);
        if (stat.isSymbolicLink()) return res.status(400).json({ error: 'Symlinks not allowed' });
        if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      } catch (e) {
        if (e.code === 'ENOENT') return res.json({ ok: true });
        throw e;
      }
      await _mediaFiles.removeFiles([`icons/${pinTypeId}/${filename}`]);
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/icons/:pinTypeId/:filename:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Delete failed' });
    }
  });
});

app.delete('/api/icons/:pinTypeId', requireDM, (req, res) => {
  _runWriteRequest(res, async () => {
    try {
      const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
      if (!pinTypeId) return res.status(400).json({ error: 'Invalid pinTypeId' });
      const target = _safeJoinIn(ICONS_DIR, pinTypeId);
      if (!target) return res.status(400).json({ error: 'Invalid pinTypeId' });
      try {
        const stat = await fsp.lstat(target);
        if (stat.isSymbolicLink()) return res.status(400).json({ error: 'Symlinks not allowed' });
        if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
        const entries = await fsp.readdir(target, { withFileTypes: true });
        if (entries.some(entry => !entry.isFile())) {
          return res.status(400).json({ error: 'Unexpected icon entry' });
        }
        await _mediaFiles.removeFiles(
          entries.map(entry => `icons/${pinTypeId}/${entry.name}`),
        );
        await fsp.rmdir(target).catch(() => {});
      } catch (e) {
        if (e.code === 'ENOENT') return res.json({ ok: true });
        throw e;
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/icons/:pinTypeId:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Delete failed' });
    }
  });
});

app.delete('/api/portrait/:identifier', requireAnyRole, async (req, res) => {
  const identifier = (req.params.identifier || '').replace(/[^a-z0-9_\-\.]/gi, '_');
  const target     = _safeJoinIn(PORTRAITS_DIR, identifier);
  if (!target) return res.status(400).json({ error: 'Invalid identifier' });
  return _runWriteRequest(res, async () => {
    try {
      let stat;
      try { stat = await fsp.lstat(target); }
      catch (error) {
        if (error.code === 'ENOENT') return res.json({ ok: true });
        throw error;
      }
      if (stat.isSymbolicLink()) return res.status(400).json({ error: 'Symlinks not allowed' });
      if (stat.isDirectory()) {
        const entries = await fsp.readdir(target, { withFileTypes: true });
        if (entries.some(entry => !entry.isFile())) {
          return res.status(400).json({ error: 'Unexpected portrait entry' });
        }
        await _mediaFiles.removeFiles(
          entries.map(entry => `portraits/${identifier}/${entry.name}`),
        );
        await fsp.rmdir(target).catch(() => {});
      } else if (stat.isFile()) {
        await _mediaFiles.removeFiles([`portraits/${identifier}`]);
      } else {
        return res.status(400).json({ error: 'Not a file' });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/portrait:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Delete error' });
    }
  });
});

registerSnapshotRoutes(app, {
  snapshots: _snapshots,
  requireAnyRole,
  requireDM,
  runWriteRequest: _runWriteRequest,
  minManualIntervalMs: Number(
    process.env.CODEX_SNAPSHOT_MIN_INTERVAL_MS ?? 3000,
  ),
});

// ── World-map upload ─────────────────────────────────────────
// The media journal publishes `data/maps/swordcoast/sword_coast.<ext>`
// as the canonical source and removes prior extensions in the same
// operation. Tile generation runs afterward against that durable source.
const uploadWorldMap = multer({
  storage:    mediaUploadStorage,
  limits:     { fileSize: 40 * 1024 * 1024 },
  fileFilter: _imageFilter,
});

/**
 * POST /api/worldmap — Replace the world map backdrop image. Removes
 * any previous file with a different extension, schedules an async
 * tile-pyramid rebuild, returns the new URL. Capped at 40 MB.
 * Auth: required.
 */
app.post('/api/worldmap', requireDM, uploadWorldMap.single('worldmap'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  return _runMediaUpload(req, res, 'world map upload', async () => {
    const extension = imageExtension(req.file, '.jpg');
    await _mediaFiles.publishReplacement({
      stagedPath: req.file.path,
      relativeDir: 'maps/swordcoast',
      baseName: 'sword_coast',
      extension,
    });
    const source = path.join(SWORDCOAST_DIR, `sword_coast${extension}`);
    if (_tiler) {
      _tiler.buildFor('world', source).catch(error => {
        console.warn('[tiles] build failed for world:', error.message);
      });
    }
    res.json({ url: `/maps/swordcoast/sword_coast${extension}` });
  });
});

// ── Site logo upload ─────────────────────────────────────────
// The media journal publishes `data/branding/logo.<ext>` and removes any
// previous extension in the same operation. The client stores the returned
// URL in `settings.branding.logoUrl`; clearing that (or DELETE below) falls
// back to the bundled `web/branding/logo-default.svg`.
const uploadLogo = multer({
  storage:    mediaUploadStorage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: _imageFilter,
});

/**
 * POST /api/logo — Replace the site logo. Removes any previous logo
 * file with a different extension so the newest upload always wins,
 * returns the new URL. Capped at 5 MB. Auth: DM only (shared chrome).
 */
app.post('/api/logo', requireDM, uploadLogo.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  return _runMediaUpload(req, res, 'logo upload', async () => {
    const extension = imageExtension(req.file, '.png');
    await _mediaFiles.publishReplacement({
      stagedPath: req.file.path,
      relativeDir: 'branding',
      baseName: 'logo',
      extension,
    });
    res.json({ url: `/branding/logo${extension}` });
  });
});

/**
 * DELETE /api/logo — Remove the custom logo so the bundled default
 * takes over again. Idempotent. Auth: DM only.
 */
app.delete('/api/logo', requireDM, async (_req, res) => {
  return _runWriteRequest(res, async () => {
    try {
      const list = await fsp.readdir(BRANDING_DIR).catch(() => []);
      await _mediaFiles.removeFiles(
        list.filter(file => /^logo\./i.test(file))
          .map(file => `branding/${file}`),
      );
      res.json({ ok: true });
    } catch (error) {
      console.error('DELETE /api/logo:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Delete error' });
    }
  });
});

/**
 * GET /api/backup — Stream the entire `data/` directory as a ZIP
 * download. Compatible input format for `/api/restore`. Auth: DM
 * only — the raw on-disk JSON includes DM-only entities
 * (`visibility:'dm'`) that the role filter normally hides. A player
 * download would bypass that filter. Players can still see the
 * snapshot list and create manual server-side snapshots (no contents
 * leave the server), and the DM can hand them a filtered export
 * separately if needed.
 */
app.get('/api/backup', requireDM, async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `backup-${timestamp}.zip`;
  await fsp.mkdir(BACKUP_STAGING_ROOT, { recursive: true });
  const stageDir = await fsp.mkdtemp(path.join(BACKUP_STAGING_ROOT, 'backup-'));
  const stagedDataDir = path.join(stageDir, 'data');
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fsp.rm(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      .catch(err => console.error('Backup staging cleanup error:', err));
  };

  try {
    await _runWriteRequest(res, async () => {
      if (process.env.NODE_ENV === 'test' && process.env.CODEX_BACKUP_TEST_FAIL_PHASE === 'copy') {
        throw new Error('Injected backup copy failure');
      }
      const testDelay = process.env.NODE_ENV === 'test'
        ? Number(process.env.CODEX_BACKUP_TEST_COPY_DELAY_MS) || 0
        : 0;
      if (testDelay > 0) {
        await new Promise(resolve => { setTimeout(resolve, testDelay); });
      }
      await fsp.cp(DATA_DIR, stagedDataDir, {
        recursive: true,
        filter: src => {
          const rel = path.relative(DATA_DIR, src).replace(/\\/g, '/');
          return rel !== 'secrets.json' && rel !== '.runtime' && !rel.startsWith('.runtime/');
        },
      });
    });
    if (res.headersSent) {
      await cleanup();
      return;
    }
  } catch (err) {
    console.error('Backup staging error:', err);
    await cleanup();
    return res.status(500).json({ error: 'Backup failed' });
  }

  try {
    if (process.env.NODE_ENV === 'test' && process.env.CODEX_BACKUP_TEST_FAIL_PHASE === 'archive') {
      throw new Error('Injected backup archive failure');
    }
    // archiver v8 (ESM) dropped the callable factory in favour of class exports
    // (`new ZipArchive(opts)`); older v5/v6 export a factory.
    const archive = (typeof archiver === 'function')
      ? archiver('zip', { zlib: { level: 9 } })
      : new archiver.ZipArchive({ zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.once('finish', cleanup);
    res.once('close', cleanup);
    archive.once('error', err => {
      console.error('Backup archive error:', err);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'Backup failed' });
      else res.destroy(err);
    });
    archive.pipe(res);
    archive.directory(stagedDataDir, 'data');
    archive.finalize();
  } catch (err) {
    console.error('Backup archive setup error:', err);
    await cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed' });
  }
});

// ── Full data/ restore from upload ────────────────────────────
// Accepts either:
//   - a .zip produced by /api/backup (entries under `data/...`)
//   - a single .json document in the shape Store.exportJSON() emits
// Always takes a `pre-restore` snapshot first so the operation is
// undoable from the Záloha tab. Path-traversal-safe: every entry
// is resolved against DATA_DIR and rejected if it would escape.
//
// Fully disk-staged, never memory-buffered: multer writes the upload to
// the OS temp dir, and extraction streams entry-by-entry via yauzl (the
// central directory is walked lazily for the zip-bomb scan; each file then
// pipes decompressed straight to disk). The container's memory limit can't
// absorb a 200 MB archive any other way — the previous AdmZip path buffered
// the whole archive PLUS each entry's decompressed bytes and could OOM the
// 512 MB container on a perfectly legitimate backup. 200 MB upload cap —
// backups include portraits, world/local map images (world alone may be
// 40 MB) and addon code (docs promise 200 MB).
const { pipeline } = require('node:stream/promises');
const RESTORE_MAX_ENTRIES     = 50000;               // tile pyramids can be many files
const RESTORE_MAX_ENTRY_BYTES = 200 * 1024 * 1024;   // 200 MB per file
const RESTORE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;  // 1 GB uncompressed total
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename:    (_req, _file, cb) => cb(null, `restore-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

function _restoreRelativePath(rel) {
  const resolved = _safeJoinIn(DATA_DIR, rel);
  if (!resolved) return null;
  // `auth.json` is deployment config, not campaign data — same posture as
  // snapshots (NON_DATA_JSON_FILES): restoring an old backup must never
  // silently roll the password back to one the operator may no longer
  // remember (the cookie secret rotates with it → instant lockout with no
  // in-app recovery). The file still ships inside backup ZIPs; disaster
  // recovery onto a fresh install goes through setup first, then restore.
  const base = rel.replace(/\\/g, '/');
  if (NON_DATA_JSON_FILES.has(base)) return null;
  // Defence-in-depth: snapshots now live in a sibling `data-snapshots/`
  // dir, so a restore ZIP cannot reach them through DATA_DIR — but if a
  // future refactor ever moves them back inside DATA_DIR, this guard
  // prevents the silent-overwrite class of attack.
  const snapRoot = path.resolve(SNAPSHOTS_DIR);
  if (resolved === snapRoot || resolved.startsWith(snapRoot + path.sep)) return null;
  // Refuse to write addon CODE (data/addons/**) from a restore. Backups include
  // it for inspection, but restoring it would let a crafted ZIP plant a
  // server/index.cjs that boot require()s — RCE that bypasses the install
  // (preview/SHA-pin/content-hash) trust path entirely. Addon code is recovered
  // by re-installing from the registry's recorded repo+SHA; addon DATA
  // (data/addon-data/**) restores fine.
  const codeRoot = path.resolve(ADDONS_DIR);
  if (resolved === codeRoot || resolved.startsWith(codeRoot + path.sep)) return null;
  const runtimeRoot = path.resolve(path.join(DATA_DIR, '.runtime'));
  if (resolved === runtimeRoot || resolved.startsWith(runtimeRoot + path.sep)) return null;
  return path.relative(DATA_DIR, resolved).replace(/\\/g, '/');
}

// A restore-validation failure carrying a user-facing (Czech) message; the
// handler turns it into a 400. Anything without `userMessage` is treated as
// a broken/invalid archive.
function _restoreErr(userMessage) {
  const e = new Error(userMessage);
  e.userMessage = userMessage;
  return e;
}

function _restoreCandidateErr(error) {
  if (!(error instanceof RestoreCandidateError)) return error;
  const file = error.relativePath ? ` „${error.relativePath}"` : '';
  return _restoreErr(`Záloha obsahuje neplatná data${file}`);
}

// Pass 1 — zip-bomb scan BEFORE anything is written: too many entries, a
// single absurdly large file, or an absurd total uncompressed size (all
// from central-directory metadata; realistic backups stay far under).
async function _scanZipForRestore(zipPath) {
  let total = 0;
  await walkZipEntries(zipPath, {
    onEntry(entry) {
      if (/\/$/.test(entry.fileName)) return;
      const size = entry.uncompressedSize || 0;
      if (size > RESTORE_MAX_ENTRY_BYTES) {
        throw _restoreErr('ZIP obsahuje příliš velký soubor (možný zip bomb)');
      }
      total += size;
      if (total > RESTORE_MAX_TOTAL_BYTES) {
        throw _restoreErr('ZIP je po rozbalení příliš velký (možný zip bomb)');
      }
    },
    onOpen(zipfile) {
      if (zipfile.entryCount > RESTORE_MAX_ENTRIES) {
        throw _restoreErr(`ZIP má příliš mnoho položek (> ${RESTORE_MAX_ENTRIES})`);
      }
    },
  });
}

// Pass 2 — extract every allowed entry into an isolated candidate tree.
// Policy-rejected entries are reported as skipped; any actual extraction
// failure rejects the entire candidate before live data is touched.
async function _extractZipForRestore(zipPath, candidateDir) {
  const restored = [];
  const skipped  = [];
  const seen = new Set();
  await walkZipEntries(zipPath, {
    async onEntry(entry, zipfile) {
      if (/\/$/.test(entry.fileName)) return;
      let name = entry.fileName.replace(/\\/g, '/');
      if (name.startsWith('data/')) name = name.slice(5);
      if (!name) return;

      const relativePath = _restoreRelativePath(name);
      if (!relativePath) {
        skipped.push(name);
        return;
      }
      if (seen.has(relativePath)) {
        throw _restoreErr(`ZIP obsahuje duplicitní cestu „${relativePath}"`);
      }
      seen.add(relativePath);
      const target = _safeJoinIn(candidateDir, relativePath);
      if (!target) throw _restoreErr('ZIP obsahuje neplatnou cestu');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const source = await openEntryStream(zipfile, entry);
      const limiter = createByteLimiter({
        maxBytes: RESTORE_MAX_ENTRY_BYTES,
        errorFactory: () => new Error('entry stream exceeded the size cap'),
      });
      await pipeline(source, limiter.stream, fs.createWriteStream(target, { flags: 'wx' }));
      restored.push(relativePath);
    },
  });
  return { restored, skipped };
}

async function _stageJsonRestore(uploadPath, candidateDir) {
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(uploadPath, 'utf8'));
  } catch {
    throw _restoreErr('Neplatný JSON soubor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw _restoreErr('Neplatný formát zálohy (očekávám objekt)');
  }

  const restored = [];
  for (const type of ALL_TYPES) {
    if (parsed[type] === undefined) continue;
    const value = parsed[type];
    const validShape = KEYED_OBJ_TYPES.has(type)
      ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : Array.isArray(value);
    if (!validShape) {
      throw _restoreErr(`Neplatný tvar kolekce „${type}" v záloze`);
    }
    const relativePath = path.relative(DATA_DIR, getFile(type)).replace(/\\/g, '/');
    await fsp.writeFile(
      path.join(candidateDir, relativePath),
      JSON.stringify(value, null, 2),
      'utf8',
    );
    restored.push(relativePath);
  }
  if (!restored.length) {
    throw _restoreErr('JSON neobsahuje žádnou známou kolekci');
  }
  return restored;
}

async function _publishSnapshotRestore(files) {
  const candidateDir = await fsp.mkdtemp(path.join(RESTORE_STAGING_ROOT, 'snapshot-'));
  try {
    const paths = Object.keys(files).sort();
    for (const relativePath of paths) {
      if (!isSnapshotFileKey(relativePath)) {
        throw new Error(`Invalid snapshot path: ${relativePath}`);
      }
      const target = path.join(candidateDir, ...relativePath.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, JSON.stringify(files[relativePath], null, 2), 'utf8');
    }
    const currentPaths = (await _trackedDataFiles()).map(entry => entry.key);
    const restored = new Set(paths);
    const removePaths = currentPaths.filter(relativePath => !restored.has(relativePath));
    if (!paths.length && !removePaths.length) return { ok: true };
    return await _campaignRestores.commit({ candidateDir, paths, removePaths });
  } finally {
    await fsp.rm(candidateDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * POST /api/restore — Replace the live `data/` directory from an
 * uploaded backup. Accepts both formats:
 *   - a `.zip` produced by `/api/backup` (entries under `data/...`),
 *   - a single `.json` document in the shape `Store.exportJSON()` emits.
 * Takes a `pre-restore` snapshot first so the operation is undoable
 * from the Záloha tab. Every entry path is resolved through
 * `_restoreRelativePath` so a malicious archive cannot escape `DATA_DIR`
 * (traversal, absolute paths, symlinks all rejected). Auth: required.
 */
app.post('/api/restore', requireDM, restoreUpload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Žádný soubor nepřijat' });

  const filename = String(req.file.originalname || '');
  const tmpPath  = req.file.path;
  let candidateDir = null;
  let disconnected = false;
  req.once('aborted', () => { disconnected = true; });
  res.once('close', () => {
    if (!res.writableEnded) disconnected = true;
  });
  const cleanup = async () => {
    await Promise.all([
      fsp.unlink(tmpPath).catch(() => {}),
      candidateDir
        ? fsp.rm(candidateDir, { recursive: true, force: true }).catch(() => {})
        : Promise.resolve(),
    ]);
  };

  try {
    let head;
    try {
      const handle = await fsp.open(tmpPath, 'r');
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return res.status(500).json({ error: 'Nelze přečíst nahraný soubor' });
    }

    const isZipMagic = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4B
                                        && head[2] === 0x03 && head[3] === 0x04;
    const isZip = /\.zip$/i.test(filename) || isZipMagic;
    const looksJson = !isZip && (
      /\.json$/i.test(filename) || /^\s*[\{\[]/.test(head.toString('utf8'))
    );
    if (!isZip && !looksJson) {
      return res.status(400).json({ error: 'Nepodporovaný formát — očekávám .zip nebo .json' });
    }

    await fsp.mkdir(RESTORE_STAGING_ROOT, { recursive: true });
    candidateDir = await fsp.mkdtemp(path.join(RESTORE_STAGING_ROOT, 'candidate-'));

    let format;
    let restored;
    let skipped = [];
    if (isZip) {
      try {
        await _scanZipForRestore(tmpPath);
        ({ restored, skipped } = await _extractZipForRestore(tmpPath, candidateDir));
      } catch (error) {
        if (error.userMessage) throw error;
        throw _restoreErr('Neplatný ZIP soubor');
      }
      format = 'zip';
    } else {
      restored = await _stageJsonRestore(tmpPath, candidateDir);
      format = 'json';
    }
    if (!restored.length) {
      throw _restoreErr('Záloha neobsahuje žádná obnovitelná data');
    }
    try {
      await validateRestoreCandidate({
        candidateDir,
        paths: restored,
        isAuthoritativePath: isSnapshotFileKey,
        coreShapes: CORE_RESTORE_SHAPES,
      });
    } catch (error) {
      throw _restoreCandidateErr(error);
    }
    if (disconnected) return;

    await _runWriteRequest(res, async () => {
      if (disconnected) return;
      await _createSnapshot('pre-restore');
      let prepared;
      try {
        prepared = await prepareRestoreCandidate({
          candidateDir,
          paths: restored,
          liveFiles: await _trackedDataFiles(),
          isAuthoritativePath: isSnapshotFileKey,
          coreShapes: CORE_RESTORE_SHAPES,
          migrations: CAMPAIGN_MIGRATIONS,
        });
      } catch (error) {
        throw _restoreCandidateErr(error);
      }
      await _campaignRestores.commit({ candidateDir, paths: prepared.paths });
      if (!res.headersSent) {
        const result = { ok: true, format, restored: restored.length };
        if (format === 'zip') result.skipped = skipped.length;
        res.json(result);
      }
    });
  } catch (error) {
    console.error('POST /api/restore:', error);
    if (!res.headersSent && !disconnected) {
      res.status(error.userMessage ? 400 : 500).json({
        error: error.userMessage || 'Restore failed',
      });
    }
  } finally {
    await cleanup();
  }
});

// Server-addon route dispatcher. A single stable mount, registered
// BEFORE the SPA fallback, that delegates `/api/addon/<id>/*` to the addon's
// live Express Router (populated at boot). Singular `/api/addon/` can't collide
// with the plural `/api/addons` management routes above. `req.role`/`realRole`
// are already stamped by attachRole, so addon routes can gate themselves; an
// unmatched sub-path returns JSON 404 (never the SPA index). A disabled/absent
// addon 404s here too — a disabled addon serves nothing.
app.use('/api/addon/:addonId', (req, res, _next) => {
  const entry = _addonServers.get(req.params.addonId);
  if (!entry || entry.state !== 'loaded' || !entry.router) {
    // No live router — host-served declarative content (manifest `contentDir`)
    // answers the four stable GET endpoints for data addons. An addon with a
    // live server router takes precedence entirely (it may serve /content
    // itself); everything else 404s as before.
    const c = _addonContent.get(req.params.addonId);
    if (c && req.method === 'GET') {
      const p = req.path;                       // mount-relative: '/content', …
      if (p === '/content') return res.json(c.content);
      let m = /^\/content\/([^/]+)$/.exec(p);
      if (m) return res.json(c.content[decodeURIComponent(m[1])] || []);
      m = /^\/item\/([^/]+)\/([^/]+)$/.exec(p);
      if (m) {
        const byId = c.index[decodeURIComponent(m[1])];
        const rec  = byId && byId[decodeURIComponent(m[2])];
        if (!rec) return res.status(404).json({ error: 'not found' });
        return res.json(rec);
      }
      if (p === '/kinds') return res.json({ kinds: c.kinds });
    }
    return res.status(404).json({ error: 'Addon endpoint not available' });
  }
  // A SYNCHRONOUS throw inside the addon's router (Express routes async
  // rejections itself, but not sync throws) must never crash the server — the
  // "a server addon throw is isolated" invariant has to hold at request time too.
  try {
    entry.router(req, res, (err) => {
      if (err) {
        if (_sendWriteLockTimeout(res, err)) return;
        console.error(`[addon ${req.params.addonId}] route error`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Addon route error' });
        return;
      }
      if (!res.headersSent) res.status(404).json({ error: 'Addon route not found' });
    });
  } catch (e) {
    if (_sendWriteLockTimeout(res, e)) return;
    console.error(`[addon ${req.params.addonId}] route threw`, e);
    if (!res.headersSent) res.status(500).json({ error: 'Addon route error' });
  }
});

// Unmatched API paths return JSON 404, not the SPA index. Registered AFTER
// every real /api route + the /api/addon dispatcher above (so it shadows
// none of them) and BEFORE the SPA fallback (so a wrong/renamed /api/* path
// gives an honest JSON 404 instead of 200 + index.html, which would mislead
// a fetch caller into parsing HTML as JSON). Covers every method.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// SPA fallback: serve index.html for any unmatched GET so client-side
// hash routing works on a hard refresh / deep link. Express 5 (path-to-regexp
// 8) rejects a bare '*' — the catch-all must be a named wildcard ('/*splat').
app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

// ── Terminal error handler ───────────────────────────────────────
// Last middleware in the chain (4-arg signature = Express error handler).
// Anything passed to next(err) — most importantly multer upload errors
// (LIMIT_FILE_SIZE / LIMIT_FILE_COUNT on the portrait/localmap/icons/
// worldmap/logo/restore uploads, surfaced BEFORE our route bodies run),
// an oversized express.json body (`entity.too.large`), and a malformed
// JSON body (`entity.parse.failed`) — lands here and returns clean JSON
// instead of Express's default HTML 500. Multer disk-storage uploads
// that may have partially written a file before erroring are cleaned up
// best-effort.
app.use((err, req, res, _next) => {
  if (_sendWriteLockTimeout(res, err)) return;
  if (err instanceof multer.MulterError) {
    // multer may have already written one or more files to disk before the
    // limit tripped (e.g. LIMIT_FILE_COUNT on a multi-file upload). Best-
    // effort unlink so a rejected upload doesn't leave orphans.
    const files = req.files || (req.file ? [req.file] : []);
    for (const f of files) {
      if (f && f.path) fsp.unlink(f.path).catch(() => {});
    }
    if (req.path.startsWith('/api/content-import/')) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'IMPORT_INPUT_LIMIT' : 'IMPORT_INPUT_INVALID';
      return res.status(status).json({ error: `Upload error: ${err.code}`, code });
    }
    return res.status(400).json({ error: `Upload error: ${err.code}` });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  console.error('[unhandled]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

// ── Bootstrap: ensure tiles exist for any map already on disk ─────
async function _backgroundTileSweep() {
  if (!_tiler) return;
  const jobs = [];
  // World map(s): data/maps/swordcoast/*.jpg
  try {
    const swDir = path.join(MAPS_DIR, 'swordcoast');
    const list  = await fsp.readdir(swDir).catch(() => []);
    // Only one world image exists at a time (upload replaces others).
    // Its pyramid must live under the client-visible id `world`.
    const img = list.find(f => /\.(jpe?g|png|webp)$/i.test(f));
    if (img) jobs.push({ mapId: 'world', src: path.join(swDir, img) });
  } catch (_) {}
  // Local maps: data/maps/local/<locId>/map.*
  try {
    const locIds = await fsp.readdir(LOCAL_MAPS_DIR).catch(() => []);
    for (const locId of locIds) {
      const locDir = path.join(LOCAL_MAPS_DIR, locId);
      let stat;
      try { stat = await fsp.stat(locDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const files = (await fsp.readdir(locDir)).filter(f => /^map\.(jpe?g|png|webp)$/i.test(f));
      if (files.length) jobs.push({ mapId: `local-${locId}`, src: path.join(locDir, files[0]) });
    }
  } catch (_) {}
  // Run sequentially to avoid hammering CPU on startup
  for (const j of jobs) {
    try { await _tiler.buildFor(j.mapId, j.src); }
    catch (e) { console.warn(`[tiles] ${j.mapId}: ${e.message}`); }
  }
}

async function _prepareOwnedTemp(root, label) {
  const resolved = path.resolve(root);
  const parsed = path.parse(resolved);
  const dataRoot = path.resolve(DATA_DIR);
  const relativeToData = path.relative(dataRoot, resolved);
  const insideData = relativeToData === ''
    || (!relativeToData.startsWith('..') && !path.isAbsolute(relativeToData));
  if (resolved === parsed.root || insideData) {
    throw new Error(`Unsafe ${label} temporary directory`);
  }
  await fsp.rm(resolved, { recursive: true, force: true });
  await fsp.mkdir(resolved, { recursive: true });
}

// Bootstrap: await data migrations BEFORE accepting any connections.
// Tile sweep stays fire-and-forget (it can take seconds on a large
// map and the fallback overlay covers any in-flight requests anyway).
async function _bootstrap() {
  await _prepareOwnedTemp(IMPORT_TEMP_ROOT, 'import');
  await _prepareOwnedTemp(RESTORE_STAGING_ROOT, 'restore');
  await _prepareOwnedTemp(MEDIA_STAGING_ROOT, 'media');
  await _prepareOwnedTemp(MUTATION_STAGING_ROOT, 'campaign mutation');
  const recovery = await _collectionTransactions.recover();
  if (recovery.committed.length || recovery.rolledBack.length
      || recovery.cleaned.length || recovery.invalid.length) {
    console.log('[transactions] startup recovery:', recovery);
  }
  const restoreRecovery = await _campaignRestores.recover();
  if (restoreRecovery.committed.length || restoreRecovery.rolledBack.length
      || restoreRecovery.cleaned.length) {
    console.log('[restore] startup recovery:', restoreRecovery);
  }
  const mediaRecovery = await _mediaPublications.recover();
  if (mediaRecovery.committed.length || mediaRecovery.rolledBack.length
      || mediaRecovery.cleaned.length) {
    console.log('[media] startup recovery:', mediaRecovery);
  }
  const mutationRecovery = await _campaignMutationPublications.recover();
  if (mutationRecovery.committed.length || mutationRecovery.rolledBack.length
      || mutationRecovery.cleaned.length) {
    console.log('[campaign mutation] startup recovery:', mutationRecovery);
  }
  if (_tiler) await _tiler.cleanupStaging();
  _auth.reportConfiguration();
  try {
    await runStartupMigrations();
  } catch (e) {
    console.warn('[migration] startup migration sweep failed:', e.message);
  }
  try {
    const repaired = await _repairLegacyAddonRegistry();
    if (repaired) console.log(`[addons] repaired ${repaired} legacy contentDir metadata field(s)`);
  } catch (e) {
    console.warn('[addons] legacy metadata repair failed:', e.message);
  }
  // Register enabled addons' declared collections into the type system so
  // their data rides the generic GET/PATCH /api/data path from the first
  // request (install/enable/disable re-apply this live afterwards), and
  // build the host-served content trees (manifest `contentDir`).
  try {
    const _bootReg = await _readAddonsRegistry();
    _applyAddonCollections(_bootReg);
    _applyAddonContent(_bootReg);
  } catch (e) {
    console.warn('[addons] collection type seed failed:', e.message);
  }
  // Load enabled server-side addons before listening so their
  // /api/addon/<id>/* routes are ready. Each load is isolated — a throwing
  // addon is recorded as `error`, never crashing boot.
  try {
    await _loadServerAddons();
  } catch (e) {
    console.warn('[addons] server load sweep failed:', e.message);
  }
  // Reclaim old addon version code dirs left from before pruning existed.
  try { await _pruneAllAddonCode(); } catch (e) { console.warn('[addons] code prune failed:', e.message); }
  const importSweep = setInterval(() => _importJobs.sweep(), 30_000);
  if (importSweep.unref) importSweep.unref();
  app.listen(PORT, () => {
    console.log(`TTRPG Codex running on http://localhost:${PORT}`);
    if (INSTANCE !== 'default' || FEATURES.length) {
      console.log(`  instance: ${INSTANCE}` +
        (FEATURES.length ? ` · features: ${FEATURES.join(', ')}` : ''));
    }
    _backgroundTileSweep().catch(e => console.warn('[tiles] sweep failed:', e.message));
  });
}
_bootstrap().catch(e => {
  console.error('[bootstrap] fatal:', e);
  process.exit(1);
});
