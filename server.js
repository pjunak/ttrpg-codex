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

// Pure helpers extracted for testability. server-utils.cjs has no
// module-level side effects so it can be required from `node --test`.
const {
  isForbiddenKey, safeJoinIn, pickKeptSnapshots,
  hashPassword, verifyPassword, safeEqStrings,
} = require('./server-utils.cjs');

// Role-aware filtering of the dataset (`server/visibility.cjs`) and
// the startup migration that backfills `visibility:'public'` on every
// pre-existing record (`server/migrations.cjs`). Both are pure-ish
// (visibility is pure; migrations only touch DATA_DIR through the
// caller-supplied writer) so they're importable from node --test.
const {
  filterForRole,
  VISIBILITY_BEARING,
  KEYED_OBJ_VISIBILITY,
} = require('./server/visibility.cjs');
const { runVisibilityMigration: _runVisibilityMigration } = require('./server/migrations.cjs');

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
//     around them (they used to be at data/snapshots/).
//   - the restore zip can never inadvertently plant or overwrite a
//     legitimate snapshot via _safeJoinDataDir.
//   - "data/" stays a clean reflection of the campaign content.
// One-time migration below moves any pre-existing data/snapshots/* up.
const SNAPSHOTS_DIR  = process.env.CODEX_SNAPSHOTS_DIR
                       || path.join(__dirname, 'data-snapshots');
const LEGACY_SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const WEB_DIR        = path.join(__dirname, 'web');

fs.mkdirSync(DATA_DIR,       { recursive: true });
fs.mkdirSync(PORTRAITS_DIR,  { recursive: true });
fs.mkdirSync(LOCAL_MAPS_DIR, { recursive: true });
fs.mkdirSync(TILES_DIR,      { recursive: true });
fs.mkdirSync(SWORDCOAST_DIR, { recursive: true });
fs.mkdirSync(ICONS_DIR,      { recursive: true });
fs.mkdirSync(SNAPSHOTS_DIR,  { recursive: true });

// Idempotent relocation: any leftover snapshots inside data/ get
// moved to the new sibling directory.
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

// Sensible default security headers — X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, etc. CSP is OFF because
// the UI uses inline onclick handlers and inline style="…" attributes
// that strict CSP would block. crossOriginEmbedderPolicy is OFF so
// CDN scripts/fonts without explicit CORP headers still load.
app.use(helmet({
  contentSecurityPolicy:     false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
// Stamp req.role / req.realRole on every request based on the
// edit_session cookie. Must run AFTER cookieParser so the cookie is
// already parsed when the middleware reads it.
app.use((req, res, next) => attachRole(req, res, next));

// ── Auth ──────────────────────────────────────────────────────────
// Two shared passwords: DM (full edit access) and PLAYER (read-only
// view, no DM-only content). Cookie value:
//   "<realRole>.<role>.<token>"
// where token = SHA256(realRole + ':' + role + ':' + secret). The
// realRole claim is part of the signed token so a DM impersonating a
// player can flip back without re-entering the password, and a player
// can't forge a realRole=dm cookie.
//
// Passwords come from two sources, in priority order:
//   1. `data/auth.json` — stored as `{ salt, hash, updatedAt }`. Set
//      by the DM via Settings → Účet, persists across restarts, and
//      survives env-var changes. Hash is SHA-256(salt + ':' + pwd).
//   2. Env vars DM_PASSWORD / PLAYER_PASSWORD (EDIT_PASSWORD is a
//      legacy alias for DM_PASSWORD). Only consulted when the
//      corresponding role is missing from auth.json.
//
// The cookie token is derived from whichever secret was used (stored
// hash or env-var raw). When the DM changes a password, the new hash
// → new token → existing cookies for that role become invalid, which
// is the desired logout-everyone-else behaviour.
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

// Lazy cache of the parsed auth.json. Reloaded on every write through
// `_writeStoredCredentials`; cleared via `_clearAuthCache` so the
// next `_loadStoredCredentials()` re-reads from disk.
let _authCache = null;
function _clearAuthCache() { _authCache = null; }
function _loadStoredCredentials() {
  if (_authCache) return _authCache;
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _authCache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[auth] failed to read auth.json:', e.message);
    _authCache = {};
  }
  return _authCache;
}
function _storedCredentialFor(role) {
  const c = _loadStoredCredentials()[role];
  if (!c || typeof c.salt !== 'string' || typeof c.hash !== 'string') return null;
  return c;
}
async function _writeStoredCredentials(next) {
  const json = JSON.stringify(next, null, 2);
  await _atomicWrite(AUTH_FILE, json);
  // Restrictive perms: best-effort, harmless on Windows where chmod
  // is a near-noop. Better than nothing on the Linux deploy target.
  try { await fsp.chmod(AUTH_FILE, 0o600); } catch (_) {}
  _clearAuthCache();
}

function _dmEnvPassword()     { return process.env.DM_PASSWORD     || process.env.EDIT_PASSWORD || '123'; }
function _playerEnvPassword() { return process.env.PLAYER_PASSWORD || ''; }

// Secret used as the cookie-token input. Prefer stored hash (changes
// when DM rotates the password → invalidates outstanding cookies);
// fall back to env-var raw. Empty string = "no password configured"
// → `_tokenFor` returns '' so the role can't be logged into.
function _secretFor(role) {
  const stored = _storedCredentialFor(role);
  if (stored) return stored.hash;
  return role === 'dm' ? _dmEnvPassword() : _playerEnvPassword();
}

function _tokenFor(realRole, role) {
  const secret = _secretFor(realRole);
  // Empty player password = player auth disabled; never matches.
  if (!secret) return '';
  return crypto.createHash('sha256')
    .update(realRole + ':' + role + ':' + secret)
    .digest('hex');
}
// Validate a raw login password against the configured credential for
// this role. Stored credential wins; falls back to env var.
function _verifyPassword(role, raw) {
  const stored = _storedCredentialFor(role);
  if (stored) return verifyPassword(stored, raw);
  const envPwd = role === 'dm' ? _dmEnvPassword() : _playerEnvPassword();
  if (!envPwd) return false;   // player auth disabled when env empty
  return safeEqStrings(raw, envPwd);
}
// Back-compat alias for the rest of the file — `_safeEq` was the only
// helper this section exported.
const _safeEq = safeEqStrings;
// Cookie shape: "<realRole>.<role>.<hex token>". Anything malformed
// returns null so callers default to anonymous.
function _parseSessionCookie(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [realRole, role, token] = parts;
  if (realRole !== 'dm' && realRole !== 'player') return null;
  if (role     !== 'dm' && role     !== 'player') return null;
  // Player can never impersonate DM.
  if (realRole === 'player' && role === 'dm')     return null;
  if (!/^[0-9a-f]{64}$/.test(token))              return null;
  return { realRole, role, token };
}
function _cookieValue(realRole, role) {
  return `${realRole}.${role}.${_tokenFor(realRole, role)}`;
}
// Session cookies live for 30 days; a single place to change the policy.
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Issue (or re-issue) the edit_session cookie for the given roles. All
// auth endpoints (login, view-as, view-as-dm, password rotation) route
// through here so the cookie options stay identical in one spot.
function _setSessionCookie(res, realRole, role) {
  res.cookie('edit_session', _cookieValue(realRole, role), {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    path:     '/',
    maxAge:   SESSION_COOKIE_MAX_AGE_MS,
  });
}
// Resolve a request to a role (`dm` | `player` | null). Validates the
// cookie's token against the expected hash for its claimed roles;
// tampered cookies fall through to anonymous.
function _resolveRole(req) {
  const parsed = _parseSessionCookie(req.cookies?.edit_session);
  if (!parsed) return { role: null, realRole: null };
  const expected = _tokenFor(parsed.realRole, parsed.role);
  if (!expected) return { role: null, realRole: null };
  if (!_safeEq(parsed.token, expected)) return { role: null, realRole: null };
  return { role: parsed.role, realRole: parsed.realRole };
}
// attachRole runs on every request and stamps req.role / req.realRole.
// Reads don't reject for null role — they just filter to the public
// subset (so unauthenticated visitors get a player-equivalent view).
function attachRole(req, _res, next) {
  const { role, realRole } = _resolveRole(req);
  req.role     = role;
  req.realRole = realRole;
  next();
}
// requireRole('dm') replaces the old requireAuth — write endpoints
// gate on it. Role gates are based on EFFECTIVE role (req.role), not
// realRole: a DM impersonating a player gets player-level write rights
// (i.e. none), which is the point of the impersonation feature.
function requireRole(role) {
  return (req, res, next) => {
    if (req.role === role) return next();
    res.status(401).json({ error: 'Neznámé nebo chybějící heslo.' });
  };
}
// Back-compat: the rest of this file was written against `requireAuth`.
// Keep the name as an alias for `requireRole('dm')` so we don't churn
// every endpoint.
const requireAuth = requireRole('dm');

// Content-write gate: any authenticated role (DM or player) may use
// the endpoint. PATCH /api/data has its own role-aware logic; this
// gate is for simpler endpoints (portrait upload, sub-map upload)
// that don't need per-payload sanitization.
function requireAnyRole(req, res, next) {
  if (req.role === 'dm' || req.role === 'player') return next();
  return res.status(401).json({ error: 'Neznámé nebo chybějící heslo.' });
}

app.use('/portraits', express.static(PORTRAITS_DIR));
app.use('/maps',      express.static(MAPS_DIR));
app.use('/icons',     express.static(ICONS_DIR, { maxAge: '7d', fallthrough: true }));
// Custom-uploaded logo. fallthrough: true so a request for the bundled
// default (`/branding/logo-default.svg`) — which lives in WEB_DIR, not
// here — passes through to the WEB_DIR static handler below.
app.use('/branding',  express.static(BRANDING_DIR, { maxAge: '7d', fallthrough: true }));
app.use(express.static(WEB_DIR));

function _imageFilter(_req, file, cb) {
  cb(null, file.mimetype.startsWith('image/'));
}

const charStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const charId = (req.params.charId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
    const dir    = path.join(PORTRAITS_DIR, charId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, 'portrait' + ext);
  },
});

const uploadChar = multer({ storage: charStorage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: _imageFilter });

const localMapStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const locId = (req.params.locId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
    const dir   = path.join(LOCAL_MAPS_DIR, locId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, 'map' + ext);
  },
});
const uploadLocalMap = multer({ storage: localMapStorage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: _imageFilter });

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
const iconStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
    const dir = path.join(ICONS_DIR, pinTypeId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = (path.extname(file.originalname).toLowerCase().match(/^\.(svg|png|jpe?g|webp)$/) || ['.png'])[0];
    const slug = _slugifyIconName(file.originalname);
    const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
    const dir = path.join(ICONS_DIR, pinTypeId);
    // Resolve collisions deterministically: slug, slug-2, slug-3, …
    let name = slug + ext;
    let n = 2;
    try {
      const existing = new Set(fs.readdirSync(dir));
      while (existing.has(name)) { name = `${slug}-${n++}${ext}`; }
    } catch (_) {}
    cb(null, name);
  },
});
const uploadIcons = multer({
  storage:    iconStorage,
  limits:     { fileSize: 2 * 1024 * 1024, files: 16 },
  fileFilter: _iconMimeOk,
});

// ── Write serialisation ─────────────────────────────────────────
// Single-host single-process app, so a Promise-chain mutex is enough
// to prevent two concurrent PATCHes from interleaving read-modify-
// write cycles on the same JSON file. Wrap any handler that mutates
// disk state in `withWriteLock(async () => { … })`.
let _writeChain = Promise.resolve();
function withWriteLock(fn) {
  const next = _writeChain.then(fn, fn);  // run regardless of prior outcome
  _writeChain = next.catch(() => {});      // never break the chain
  return next;
}

// ── Atomic write helper ──────────────────────────────────────────
// Writing JSON directly can corrupt the file if the server is killed
// mid-write. We write to a sibling `.tmp` and `rename()` into place —
// POSIX rename is atomic on the same filesystem. On Windows the rename
// can briefly fail with EBUSY/EPERM if any reader has the destination
// open; retry a few times with a tiny backoff before giving up.
async function _atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  await fsp.writeFile(tmp, content, 'utf8');
  const delays = [10, 50, 200];
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await fsp.rename(tmp, filePath);
      // Invalidate the cached top-level data hash whenever a JSON file in
      // DATA_DIR (but NOT a snapshot file) is written. Subdirectories like
      // SNAPSHOTS_DIR don't contribute to the hash so they don't need to
      // bust it.
      _maybeBustDataHash(filePath);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') break;
      if (attempt === delays.length) break;
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
  // Best-effort tmp cleanup so we don't leave half-written sidecars.
  try { await fsp.unlink(tmp); } catch (_) {}
  throw lastErr;
}

// ── Path-safety helper ──────────────────────────────────────────
// Imported from server-utils.cjs (this re-bind keeps the legacy
// `_`-prefix name used throughout the rest of this file).
const _safeJoinIn = safeJoinIn;

// ── Snapshot system ──────────────────────────────────────────────
// Every PATCH / POST that writes data creates a point-in-time
// snapshot of the entire JSON dataset under `data/snapshots/`.
// One file per snapshot, shape:
//   { id, createdAt, dataHash, reason, files: { "<name>.json": <parsed> } }
// Writes coalesce within a 60 s window so burst-edits (e.g.
// saveLocation's peer cascade) produce one snapshot per logical
// action. Retention: keep the most recent 50 snapshots, plus one
// per UTC-day for the last 14 days — whichever is more.
const SNAPSHOT_COALESCE_MS = 60 * 1000;
const SNAPSHOT_RECENT_KEEP = 50;
const SNAPSHOT_DAILY_DAYS  = 14;

async function _snapshotFiles() {
  try {
    const list = await fsp.readdir(SNAPSHOTS_DIR);
    return list.filter(f => /^snapshot-.*\.json$/.test(f)).sort();
  } catch { return []; }
}

async function _readSnapshot(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const file = path.join(SNAPSHOTS_DIR, safe);
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return null; }
}

async function _snapshotMeta(filename) {
  const file = path.join(SNAPSHOTS_DIR, filename);
  try {
    const [stat, raw] = await Promise.all([fsp.stat(file), fsp.readFile(file, 'utf8')]);
    const snap = JSON.parse(raw);
    return {
      id:        filename,
      createdAt: snap.createdAt,
      dataHash:  snap.dataHash,
      reason:    snap.reason || 'save',
      size:      stat.size,
    };
  } catch { return null; }
}

async function _lastSnapshotTime() {
  const files = await _snapshotFiles();
  if (!files.length) return 0;
  const last = files[files.length - 1];
  const meta = await _snapshotMeta(last);
  if (meta && meta.createdAt) {
    const t = Date.parse(meta.createdAt);
    if (!Number.isNaN(t)) return t;
  }
  // Defensive fallback for a corrupt/unreadable snapshot file: trust the
  // file's mtime instead of the field that failed to parse. Without this
  // a NaN propagated into `Date.now() - last < SNAPSHOT_COALESCE_MS` and
  // the comparison was always false — accidentally correct (a fresh
  // snapshot would be taken) but only via NaN's quirks.
  try {
    const stat = await fsp.stat(path.join(SNAPSHOTS_DIR, last));
    return stat.mtimeMs || 0;
  } catch { return 0; }
}

// `auth.json` is deployment config, not campaign data. We intentionally
// exclude it from snapshots (so restoring an old snapshot doesn't
// silently roll back a password change) and from the data hash (so a
// password rotation doesn't trigger a no-op SSE refetch). It still
// ships inside the full backup zip for disaster-recovery purposes.
const NON_DATA_JSON_FILES = new Set(['auth.json']);

async function _createSnapshot(reason = 'save') {
  const now       = Date.now();
  const createdAt = new Date(now).toISOString();
  const files     = {};
  try {
    const list = await fsp.readdir(DATA_DIR);
    for (const f of list) {
      if (!f.endsWith('.json')) continue;
      if (NON_DATA_JSON_FILES.has(f)) continue;
      try {
        files[f] = JSON.parse(await fsp.readFile(path.join(DATA_DIR, f), 'utf8'));
      } catch (_) { /* skip corrupt file */ }
    }
  } catch (_) { /* data dir missing is OK */ }
  const snap = {
    id:        `snapshot-${createdAt.replace(/[:.]/g, '-')}.json`,
    createdAt,
    dataHash:  await _dataHash(),
    reason,
    files,
  };
  const target = path.join(SNAPSHOTS_DIR, snap.id);
  await _atomicWrite(target, JSON.stringify(snap));
  await _pruneSnapshots();
  return snap.id;
}

// Keep last N plus the latest per UTC-day for D days. Anything
// outside both windows is deleted. The pure retention logic lives in
// `pickKeptSnapshots` (server-utils.cjs) so it can be unit-tested
// without touching disk.
async function _pruneSnapshots() {
  const files = await _snapshotFiles();
  if (files.length <= SNAPSHOT_RECENT_KEEP) return;

  const metas = (await Promise.all(files.map(_snapshotMeta))).filter(Boolean);
  const keep  = pickKeptSnapshots(metas, {
    recentKeep: SNAPSHOT_RECENT_KEEP,
    dailyDays:  SNAPSHOT_DAILY_DAYS,
  });

  await Promise.all(metas.map(m =>
    keep.has(m.id) ? null : fsp.unlink(path.join(SNAPSHOTS_DIR, m.id)).catch(() => {})
  ));
}

// Take a snapshot unless the last one is within the coalesce window.
// Called AFTER a successful write — snapshot N represents the data
// state after change N, so restoring N puts you back to that moment.
async function _maybeSnapshot(reason = 'save') {
  const last = await _lastSnapshotTime();
  if (last && Date.now() - last < SNAPSHOT_COALESCE_MS) return null;
  try { return await _createSnapshot(reason); }
  catch (e) { console.warn('[snapshot] create failed:', e.message); return null; }
}

// Restore a snapshot: overwrite every JSON file in data/ with the
// snapshot's contents, and delete any JSON file present today that
// the snapshot didn't have. Before restoring, take a "pre-restore"
// snapshot so the operation itself is undoable.
async function _restoreSnapshot(id) {
  const snap = await _readSnapshot(id);
  if (!snap || !snap.files) return { ok: false, error: 'Snapshot nenalezen' };
  await _createSnapshot('pre-restore');
  // Write every file in the snapshot.
  for (const [name, content] of Object.entries(snap.files)) {
    if (!/^[a-z0-9_]+\.json$/i.test(name)) continue;
    await _atomicWrite(path.join(DATA_DIR, name), JSON.stringify(content, null, 2));
  }
  // Remove any JSON file not in the snapshot (e.g. a collection
  // added after the snapshot that didn't exist then). Skip
  // NON_DATA_JSON_FILES — those aren't tracked by snapshots, so
  // missing-from-snapshot is the expected state, not a removal signal.
  try {
    const list = await fsp.readdir(DATA_DIR);
    for (const f of list) {
      if (!f.endsWith('.json')) continue;
      if (NON_DATA_JSON_FILES.has(f)) continue;
      if (!Object.prototype.hasOwnProperty.call(snap.files, f)) {
        try { await fsp.unlink(path.join(DATA_DIR, f)); } catch (_) {}
      }
    }
  } catch (_) {}
  // Unlinks above bypassed _atomicWrite, and a fresh write set may
  // differ from the cached digest — bust unconditionally.
  _invalidateDataHash();
  return { ok: true };
}

// ── Data hash (with cache) ───────────────────────────────────────
// Content-hashed — previous mtime+size version gave false positives
// on filesystems with low-res mtime (e.g. Docker on Windows) and false
// negatives on touch(1). We hash the concatenated JSON file contents,
// which is cheap enough for our ~100 KB dataset.
//
// Cached so SSE broadcasts (one per write) don't re-read every JSON
// file on disk to compute the same hex digest. `_atomicWrite` clears
// the cache when it rewrites a top-level data file, and
// `_restoreSnapshot` clears it when it deletes one.
let _cachedDataHash = null;
const _DATA_DIR_RESOLVED      = path.resolve(DATA_DIR);
const _SNAPSHOTS_DIR_RESOLVED = path.resolve(SNAPSHOTS_DIR);
function _invalidateDataHash() { _cachedDataHash = null; }
function _maybeBustDataHash(filePath) {
  try {
    if (!filePath.endsWith('.json')) return;
    const dir = path.dirname(path.resolve(filePath));
    // Only the top level of DATA_DIR contributes to the hash; snapshots
    // and any other nested dir do not.
    if (dir !== _DATA_DIR_RESOLVED) return;
    if (dir.startsWith(_SNAPSHOTS_DIR_RESOLVED)) return;
    // Files explicitly excluded from the data hash (e.g. auth.json)
    // shouldn't invalidate the cache either — otherwise a password
    // change would trigger a no-op SSE refetch.
    if (NON_DATA_JSON_FILES.has(path.basename(filePath))) return;
    _cachedDataHash = null;
  } catch (_) { _cachedDataHash = null; }
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
async function _dataHash() {
  if (_cachedDataHash !== null) return _cachedDataHash;
  try {
    const h = crypto.createHash('sha1');
    const list = (await fsp.readdir(DATA_DIR))
      .filter(f => f.endsWith('.json') && !NON_DATA_JSON_FILES.has(f))
      .sort();
    for (const f of list) {
      h.update(f);
      h.update('\0');
      h.update(await fsp.readFile(path.join(DATA_DIR, f)));
      h.update('\0');
    }
    _cachedDataHash = h.digest('hex').slice(0, 16);
    return _cachedDataHash;
  } catch {
    return 'none';
  }
}

function getFile(type) {
  const safeType = (type || '').replace(/[^a-z0-9_]/gi, '');
  return path.join(DATA_DIR, safeType + '.json');
}

// ── Visibility migration wrapper ─────────────────────────────────
// Runs the pure migration from server/migrations.cjs with this
// server's _atomicWrite injected, takes a one-shot pre-migration
// snapshot if anything was touched (so the deploy is undoable), and
// broadcasts data-changed so any client already on the page sees the
// new shape. Idempotent on subsequent boots.
async function runVisibilityMigration() {
  const result = await _runVisibilityMigration(DATA_DIR, { atomicWrite: _atomicWrite });
  if (result.changed > 0) {
    // Snapshot AFTER the writes so it captures the migrated state.
    // The pre-migration state is implicitly captured by any earlier
    // 'save' snapshot — the dataset hasn't changed in essence, just
    // gained a default field on each record.
    try { await _createSnapshot('migration'); }
    catch (e) { console.warn('[migration] snapshot failed:', e.message); }
    await _broadcastDataChanged();
    console.log(`[migration] visibility: stamped ${result.changed} record(s) across ${Object.keys(result.byCollection).length} collection(s)`);
  }
  return result;
}

// ── SSE broadcast ────────────────────────────────────────────────
// Every successful write fans a `data-changed` event out to every
// connected client. Clients refetch + re-render in well under a
// second; no polling involved.
const _sseClients = new Set();
function _broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(data); } catch (_) { /* client gone — cleanup on close */ }
  }
}
async function _broadcastDataChanged() {
  _broadcast('data-changed', { hash: await _dataHash(), at: Date.now() });
}

// ── Allowed collections ──────────────────────────────────────────
// Defense in depth: reject unknown collection names at the API
// boundary. Clients should never produce these, but a buggy build or
// a hand-crafted PATCH could. Enum validation (relationship type,
// character status, artifact state, pin type, etc.) lives in the
// client-side `settings` collection — the server trusts sent ids.
const ALLOWED_TYPES = new Set([
  'characters', 'relationships', 'locations', 'events',
  'mysteries', 'factions', 'deletedDefaults',
  'species', 'pantheon', 'artifacts', 'settings',
  'historicalEvents', 'campaign',
]);
const ALL_TYPES = [
  'characters', 'relationships', 'locations', 'events',
  'mysteries', 'factions', 'deletedDefaults',
  'species', 'pantheon', 'artifacts', 'settings',
  'historicalEvents', 'campaign',
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
 * anonymous callers, DM-only entities are dropped, `secrets` fields
 * are stripped, and `[secret]…[/secret]` regions are removed from
 * known markdown body fields. Players literally cannot see DM
 * content via DevTools.
 *
 * Auth: none required (anonymous callers get the same view as a
 * player). Editing requires the `edit_session` cookie + DM role.
 */
app.get('/api/data', async (req, res) => {
  try {
    const campaign = {};
    let foundAny   = false;
    await Promise.all(ALL_TYPES.map(async t => {
      const p = getFile(t);
      try {
        const raw = await fsp.readFile(p, 'utf8');
        campaign[t] = JSON.parse(raw);
        foundAny    = true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }));
    if (!foundAny) return res.json(null);
    // Role-aware filter. `filterForRole` is identity for DM and for
    // non-visibility-bearing collections, so this is cheap on the
    // hot path. Anonymous callers (req.role === null) are treated
    // as players — they see the public subset.
    const role = req.role === 'dm' ? 'dm' : 'player';
    const filtered = {};
    for (const [collection, container] of Object.entries(campaign)) {
      filtered[collection] = filterForRole(collection, container, role);
    }
    res.type('application/json').send(JSON.stringify(filtered));
  } catch (e) {
    console.error('GET /api/data:', e);
    res.status(500).json({ error: 'Read error' });
  }
});

// ── Login rate limit ─────────────────────────────────────────────
// In-memory sliding window. Blocks an IP after 10 failed attempts in
// 15 minutes. Resets on successful login. Good enough for a small
// campaign wiki; a proper reverse proxy would do this upstream.
const _loginAttempts = new Map();   // ip → { count, firstMs }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX       = 10;
function _loginKey(req) {
  // `app.set('trust proxy', 1)` (above) makes req.ip honour X-Forwarded-For
  // from the immediate reverse proxy, so we don't need the deprecated
  // req.connection.remoteAddress fallback.
  return (req.ip || req.socket?.remoteAddress || 'unknown').toString();
}
function _isBlocked(ip) {
  const rec = _loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstMs > LOGIN_WINDOW_MS) { _loginAttempts.delete(ip); return false; }
  return rec.count >= LOGIN_MAX;
}
function _noteFailure(ip) {
  const now = Date.now();
  const rec = _loginAttempts.get(ip);
  if (!rec || now - rec.firstMs > LOGIN_WINDOW_MS) {
    _loginAttempts.set(ip, { count: 1, firstMs: now });
  } else {
    rec.count++;
  }
}

/**
 * POST /api/login — Validate the supplied password and issue an
 * `edit_session` cookie on success. Tries the DM password first, then
 * the player password; the role baked into the cookie reflects which
 * matched. Rate-limited per source IP (15-minute window).
 *
 * Body: `{ password: string }`.
 * Response: `{ ok: true, role: 'dm' | 'player' }`.
 */
app.post('/api/login', (req, res) => {
  const ip = _loginKey(req);
  if (_isBlocked(ip)) {
    return res.status(429).json({ error: 'Příliš mnoho neúspěšných pokusů. Zkus to za 15 minut.' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string') {
    _noteFailure(ip);
    return res.status(401).json({ error: 'Špatné heslo' });
  }
  let role = null;
  if (_verifyPassword('dm', password)) {
    role = 'dm';
  } else if (_verifyPassword('player', password)) {
    role = 'player';
  }
  if (!role) {
    _noteFailure(ip);
    return res.status(401).json({ error: 'Špatné heslo' });
  }
  _loginAttempts.delete(ip);
  _setSessionCookie(res, role, role);
  res.json({ ok: true, role });
});

/**
 * POST /api/logout — Clear the edit_session cookie. Idempotent; safe
 * for anonymous callers too. Lets a DM hand the laptop to a player
 * without leaving a DM session attached.
 */
app.post('/api/logout', (_req, res) => {
  res.clearCookie('edit_session', { path: '/' });
  res.json({ ok: true });
});

/**
 * GET /api/auth — Probe the caller's current role and impersonation
 * state. Returns `{ role: null, realRole: null }` for anonymous users
 * (no 401) so the client can decide whether to show the login prompt
 * without a network-level failure for first-time visitors.
 */
app.get('/api/auth', (req, res) => {
  res.json({ role: req.role, realRole: req.realRole });
});

/**
 * POST /api/view-as — DM-only. Re-issue the session cookie with the
 * effective `role` flipped to 'player' while `realRole` stays 'dm'.
 * Used by the "View as player" toggle so the DM can verify what leaks
 * without re-entering the password.
 *
 * Authorization is based on req.realRole (the validated signed claim),
 * not req.role — so a DM already impersonating a player can still
 * call this (and idempotently stay in player mode).
 */
app.post('/api/view-as', (req, res) => {
  if (req.realRole !== 'dm') return res.status(403).json({ error: 'Pouze pro DM' });
  _setSessionCookie(res, 'dm', 'player');
  res.json({ ok: true, role: 'player', realRole: 'dm' });
});

/**
 * POST /api/view-as-dm — DM-only. Flip the effective role back to
 * 'dm' from an active impersonation. Same auth rule as /api/view-as.
 */
app.post('/api/view-as-dm', (req, res) => {
  if (req.realRole !== 'dm') return res.status(403).json({ error: 'Pouze pro DM' });
  _setSessionCookie(res, 'dm', 'dm');
  res.json({ ok: true, role: 'dm', realRole: 'dm' });
});

/**
 * GET /api/passwords — DM-only. Report which roles have a stored
 * password (vs falling back to env / default). Used by the Settings →
 * Účet tab to label each row "nastaveno" vs "z proměnné prostředí".
 *
 * Never reveals the hash or salt — only presence flags.
 */
app.get('/api/passwords', (req, res) => {
  if (req.realRole !== 'dm') return res.status(403).json({ error: 'Pouze pro DM' });
  const dm     = _storedCredentialFor('dm');
  const player = _storedCredentialFor('player');
  res.json({
    dm: {
      stored:    !!dm,
      updatedAt: dm ? (dm.updatedAt || null) : null,
      envFallback: !dm && !!(process.env.DM_PASSWORD || process.env.EDIT_PASSWORD),
      isDefault: !dm && !(process.env.DM_PASSWORD || process.env.EDIT_PASSWORD),
    },
    player: {
      stored:    !!player,
      updatedAt: player ? (player.updatedAt || null) : null,
      envFallback: !player && !!process.env.PLAYER_PASSWORD,
      disabled:  !player && !process.env.PLAYER_PASSWORD,
    },
  });
});

/**
 * POST /api/passwords — DM-only. Set or change the DM or player
 * password. Stores `{ salt, hash, updatedAt }` to `data/auth.json`,
 * which supersedes any env-var value on subsequent restarts.
 *
 * Body: `{ role: 'dm' | 'player', newPassword: string, currentPassword?: string }`
 *
 * Rules:
 *   - Caller must currently hold a DM session (realRole === 'dm').
 *   - `currentPassword` MUST verify against the active DM password
 *     before any change is accepted. This blocks a stolen session
 *     cookie from rotating credentials silently.
 *   - `newPassword` ≥ 4 chars. Empty string for `role: 'player'`
 *     is a special case: clears the stored player credential AND
 *     means env fallback applies (or player auth is disabled if env
 *     is also empty). Empty DM password is rejected outright.
 *   - On success: writes auth.json, then re-issues the caller's
 *     cookie if they changed their own (DM) password — otherwise
 *     their session would be invalidated by the secret rotation.
 */
app.post('/api/passwords', async (req, res) => {
  if (req.realRole !== 'dm') return res.status(403).json({ error: 'Pouze pro DM' });
  const { role, newPassword, currentPassword } = req.body || {};
  if (role !== 'dm' && role !== 'player') {
    return res.status(400).json({ error: 'Neznámá role' });
  }
  if (typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Heslo musí být řetězec' });
  }
  // Always require the DM's current password — even when rotating the
  // player password, since a stolen session shouldn't be able to lock
  // players out.
  if (!_verifyPassword('dm', currentPassword || '')) {
    return res.status(401).json({ error: 'Aktuální DM heslo nesouhlasí' });
  }
  // Validation: DM password must be non-trivial; empty player
  // password is the documented "clear stored credential, fall back to
  // env (or disable player auth)" lever.
  if (role === 'dm' && newPassword.length < 4) {
    return res.status(400).json({ error: 'DM heslo musí mít alespoň 4 znaky' });
  }
  if (role === 'player' && newPassword.length > 0 && newPassword.length < 4) {
    return res.status(400).json({ error: 'Hráčské heslo musí mít alespoň 4 znaky (nebo prázdné pro vymazání)' });
  }
  if (newPassword.length > 200) {
    return res.status(400).json({ error: 'Heslo je příliš dlouhé' });
  }

  await withWriteLock(async () => {
    const current = { ..._loadStoredCredentials() };
    if (role === 'player' && newPassword === '') {
      delete current.player;
    } else {
      current[role] = hashPassword(newPassword);
    }
    await _writeStoredCredentials(current);
  });

  // After a DM password change the secret rotates, which invalidates
  // every outstanding DM cookie — including ours. Re-issue so the
  // caller stays logged in without a manual re-login.
  if (role === 'dm') {
    _setSessionCookie(res, 'dm', req.role === 'player' ? 'player' : 'dm');
  }
  res.json({ ok: true, role });
});

// Collections stored as keyed objects on disk (factions, settings,
// campaign, deletedDefaults). Everything else is a plain entity-list
// array. `deletedDefaults` was historically a string array but was
// converted to a keyed-object so individual tombstones can round-trip
// through the per-entity PATCH path (no whole-collection wipe needed).
const KEYED_OBJ_TYPES = new Set(['factions', 'settings', 'campaign', 'deletedDefaults']);

// Types DMs alone can write to. Players are collaborative editors of
// in-world content; they don't get to rename the campaign or reshape
// the enum vocabulary (which affects everyone instantly).
const DM_ONLY_WRITE_TYPES = new Set(['settings', 'campaign']);

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
//   - `secrets` is unconditionally stripped from the payload. The
//     legacy per-field secret toggles were retired in the twin pivot;
//     even if a stale client sends the field, it never persists.
//
// DM content (the lore that used to live under [secret] markers or
// secret flags) now lives in a sibling DM-only twin entity linked via
// `linkedTwinId`. There's no marker collision to defend against —
// the public entity has only public content by construction.
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
  return out;
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

// ─ Twin creation ────────────────────────────────────────────────
// Build a new entity that mirrors `source` but lives in the opposite
// visibility space. Pure: returns the new entity object; the caller
// is responsible for setting up the bidirectional linkedTwinId and
// persisting both records inside one withWriteLock.
//
// Field copy is verbatim across every property on the source except:
//   - `id`           → generated fresh (slug + suffix; uniqueness
//                      check is the caller's responsibility)
//   - `visibility`   → flipped to the opposite space
//   - `linkedTwinId` → set explicitly by the caller to point back
//   - `updatedAt`    → stamped fresh
//   - `secrets`      → legacy field; never copied (removed in pivot)
// Relationships are a separate collection and are NOT auto-mirrored;
// the DM clones them manually in a later iteration.
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
function _createTwin(source) {
  const twin = { ...source };
  delete twin.id;
  delete twin.linkedTwinId;
  delete twin.updatedAt;
  delete twin.secrets;
  twin.id = _generateId(source.name || 'twin');
  twin.visibility = source.visibility === 'dm' ? 'public' : 'dm';
  twin.updatedAt = Date.now();
  return twin;
}

/**
 * POST /api/twin — Create or unlink a twin entity. DM-only via
 * `req.realRole === 'dm'` (impersonating players cannot manage
 * twins; the write tier is gated on the underlying signed claim,
 * not the effective role).
 *
 * Body shape:
 *   { action: 'create', type: <collection>, sourceId: <id> }
 *   { action: 'unlink', type: <collection>, sourceId: <id> }
 *
 * Atomicity: both sides of the link are written inside one
 * `withWriteLock` pass, so a concurrent PATCH can't see the
 * intermediate state where one side has linkedTwinId but the other
 * doesn't. Broadcasts `data-changed` once at the end.
 */
app.post('/api/twin', (req, res) => {
  if (req.realRole !== 'dm') return res.status(403).json({ error: 'Pouze pro DM' });
  withWriteLock(async () => {
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

      const p = getFile(type);
      const emptyContainer = KEYED_OBJ_TYPES.has(type) ? {} : [];
      const container = await _readJsonOr(p, emptyContainer);

      const isKeyed = KEYED_OBJ_TYPES.has(type);
      const lookup  = id => isKeyed ? (container[id] || null)
                                     : (container.find(x => x && x.id === id) || null);

      const source = lookup(sourceId);
      if (!source) return res.status(404).json({ error: 'Source entity not found' });

      if (action === 'create') {
        if (source.linkedTwinId) {
          return res.status(409).json({ error: 'Entita už má spárovaný twin.' });
        }
        const twin = _createTwin(source);
        // Uniqueness guard for the generated id (vanishingly rare
        // collision; the caller retries on 500).
        if (lookup(twin.id)) {
          return res.status(500).json({ error: 'Twin id collision — try again.' });
        }
        twin.linkedTwinId = source.id;
        source.linkedTwinId = twin.id;
        source.updatedAt = Date.now();

        if (isKeyed) {
          container[twin.id] = twin;
          // source already in container (mutated above)
        } else {
          // source already in container (mutated above)
          container.push(twin);
        }
        await _atomicWrite(p, JSON.stringify(container, null, 2));
        await _maybeSnapshot('save');
        await _broadcastDataChanged();
        return res.json({ ok: true, twinId: twin.id, twin });
      }

      if (action === 'link') {
        // Link two EXISTING entities as twins. Used when a player
        // unknowingly created a duplicate of a DM-only entity (the
        // typical case the picker resolves) — the DM marries the two
        // records instead of deleting + recreating.
        if (typeof targetId !== 'string' || !targetId) {
          return res.status(400).json({ error: 'Missing targetId' });
        }
        if (targetId === sourceId) {
          return res.status(400).json({ error: 'Source and target must differ.' });
        }
        const target = lookup(targetId);
        if (!target) return res.status(404).json({ error: 'Target entity not found' });
        if (source.linkedTwinId || target.linkedTwinId) {
          return res.status(409).json({ error: 'Jedna nebo obě entity už mají twin — odpárujte ho nejprve.' });
        }
        const srcVis = source.visibility === 'dm' ? 'dm' : 'public';
        const tgtVis = target.visibility === 'dm' ? 'dm' : 'public';
        if (srcVis === tgtVis) {
          return res.status(400).json({
            error: 'Twin musí být v opačném prostoru (jeden DM, druhý hráčský).',
          });
        }
        source.linkedTwinId = target.id;
        target.linkedTwinId = source.id;
        source.updatedAt = Date.now();
        target.updatedAt = Date.now();
        await _atomicWrite(p, JSON.stringify(container, null, 2));
        await _maybeSnapshot('save');
        await _broadcastDataChanged();
        return res.json({ ok: true });
      }

      // action === 'unlink'
      if (!source.linkedTwinId) {
        return res.status(409).json({ error: 'Entita nemá spárovaný twin.' });
      }
      const twin = lookup(source.linkedTwinId);
      delete source.linkedTwinId;
      source.updatedAt = Date.now();
      if (twin) {
        delete twin.linkedTwinId;
        twin.updatedAt = Date.now();
      }
      await _atomicWrite(p, JSON.stringify(container, null, 2));
      await _maybeSnapshot('save');
      await _broadcastDataChanged();
      return res.json({ ok: true });
    } catch (e) {
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
  withWriteLock(async () => {
    try {
      const { type, action, payload } = req.body || {};

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
      let existing = null;
      if (Array.isArray(container)) {
        if (type === 'relationships') {
          existing = container.find(r =>
            r.source === payload.source &&
            r.target === payload.target &&
            r.type   === payload.type) || null;
        } else {
          existing = container.find(x => x.id === payload.id) || null;
        }
      } else if (KEYED_OBJ_TYPES.has(type)) {
        existing = container[payload.id] || null;
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
      // on save. Both the source URL fragment AND the destination char
      // id come from the (authenticated) client, so each is run through
      // `_safeJoinIn` before any filesystem operation. The helper
      // refuses traversal (`..`), absolute paths, null bytes, and (via
      // realpath on each existing prefix) symlink escapes — without
      // it, an authed editor could send a portrait URL like
      // `/portraits/../../etc/passwd` or a crafted `payload.id` of
      // `../foo` and have us rename arbitrary files into a controlled
      // location. Auth is the first line of defence; this is the
      // second.
      if (type === 'characters' && action === 'save' && payload?.id && payload?.portrait) {
        const charId         = payload.id;
        const cleanUrl       = payload.portrait.split('?')[0];
        const expectedPrefix = `/portraits/${charId}/portrait.`;
        if (!cleanUrl.startsWith(expectedPrefix)) {
          const relPath = cleanUrl.replace(/^\/portraits\//, '');
          const srcFile = _safeJoinIn(PORTRAITS_DIR, relPath);
          const destDir = _safeJoinIn(PORTRAITS_DIR, charId);
          let migrated = false;
          if (srcFile && destDir) {
            try {
              const srcStat = await fsp.lstat(srcFile);
              if (srcStat.isFile()) {
                const ext      = path.extname(srcFile).toLowerCase() || '.jpg';
                const destFile = path.join(destDir, `portrait${ext}`);
                await fsp.mkdir(destDir, { recursive: true });
                try {
                  const existing = await fsp.readdir(destDir);
                  await Promise.all(existing.filter(f => /^portrait\./i.test(f))
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
                payload.portrait = `/portraits/${charId}/portrait${ext}`;
                migrated = true;
              }
            } catch (e) {
              if (e.code !== 'ENOENT') {
                console.warn(`[portrait] Migration failed for ${charId}:`, e.message);
              }
            }
          }
          if (!migrated) payload.portrait = cleanUrl;
        } else {
          payload.portrait = cleanUrl;
        }
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
            if (type === 'characters') {
              const relP = getFile('relationships');
              const rels = await _readJsonOr(relP, null);
              if (Array.isArray(rels)) {
                const filtered = rels.filter(r => r.source !== payload.id && r.target !== payload.id);
                await _atomicWrite(relP, JSON.stringify(filtered, null, 2));
              }
              const evtP = getFile('events');
              const evts = await _readJsonOr(evtP, null);
              if (Array.isArray(evts) && evts.some(e => (e.characters || []).includes(payload.id))) {
                const next = evts.map(e => ({ ...e, characters: (e.characters || []).filter(cid => cid !== payload.id) }));
                await _atomicWrite(evtP, JSON.stringify(next, null, 2));
              }
              const mysP = getFile('mysteries');
              const mys = await _readJsonOr(mysP, null);
              if (Array.isArray(mys) && mys.some(m => (m.characters || []).includes(payload.id))) {
                const next = mys.map(m => ({ ...m, characters: (m.characters || []).filter(cid => cid !== payload.id) }));
                await _atomicWrite(mysP, JSON.stringify(next, null, 2));
              }
            }
          }
        } else {
          if (_isForbiddenKey(payload.id)) {
            return res.status(400).json({ error: `Forbidden id: ${payload.id}` });
          }
          delete container[payload.id];
        }
      }

      await _atomicWrite(p, JSON.stringify(container, null, 2));
      await _maybeSnapshot('save');
      await _broadcastDataChanged();
      res.json({ ok: true });
    } catch (e) {
      console.error('PATCH /api/data:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Patch error' });
    }
  });
});

/**
 * GET /api/version — Returns the current dataset hash. Useful for
 * health-check probes (the Dockerfile HEALTHCHECK pings this), and
 * historically for clients to poll for changes before SSE existed.
 */
app.get('/api/version', async (_req, res) => {
  res.json({ hash: await _dataHash(), instance: INSTANCE, features: FEATURES });
});

/**
 * GET /api/events — Server-Sent Events stream.
 *
 * Emits a `hello` event on connect carrying the current data hash so
 * the client can dedupe its very first refetch. Emits `data-changed`
 * after every successful write. Pings every 25 s to keep proxies from
 * dropping the idle connection.
 *
 * Auth: none — read-only event stream.
 */
app.get('/api/events', async (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const hash = await _dataHash();
  // Guard the handshake write: a client that disconnects between
  // flushHeaders and here makes res.write throw. Bail rather than let
  // the rejection escape the handler (the ping below is guarded too).
  try {
    res.write(`event: hello\ndata: ${JSON.stringify({ hash, at: Date.now() })}\n\n`);
  } catch (_) { return; }
  _sseClients.add(res);

  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(ping);
    _sseClients.delete(res);
  });
});

/**
 * POST /api/portrait/:charId — Upload a character portrait image.
 *
 * Multer config caps at 20 MB and rejects non-image MIME types.
 * After write, removes any previous portrait files in the same
 * subfolder so only the new file remains (the URL the client stores
 * doesn't carry an extension hint).
 *
 * Auth: required.
 */
app.post('/api/portrait/:charId', requireAnyRole, uploadChar.single('portrait'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  const charId  = (req.params.charId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
  const charDir = path.join(PORTRAITS_DIR, charId);
  const newFile = req.file.filename;
  try {
    const list = await fsp.readdir(charDir);
    await Promise.all(list.filter(f => f !== newFile && /^portrait\./i.test(f))
      .map(f => fsp.unlink(path.join(charDir, f)).catch(() => {})));
  } catch (_) {}
  res.json({ url: `/portraits/${charId}/${req.file.filename}` });
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
 * location. Removes any prior file with a different extension and
 * schedules an async tile-pyramid rebuild. The returned URL is always
 * usable; tiles just accelerate subsequent loads. Auth: required.
 */
app.post('/api/localmap/:locId', requireAnyRole, uploadLocalMap.single('localmap'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  const locId  = (req.params.locId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
  const locDir = path.join(LOCAL_MAPS_DIR, locId);
  const newFile = req.file.filename;
  try {
    const list = await fsp.readdir(locDir);
    await Promise.all(list.filter(f => f !== newFile && /^map\./i.test(f))
      .map(f => fsp.unlink(path.join(locDir, f)).catch(() => {})));
  } catch (_) {}
  const url = `/maps/local/${locId}/${req.file.filename}`;
  // Kick off tile generation in the background; the URL above is
  // always usable (fallback), tiles just accelerate subsequent loads.
  if (_tiler) _tiler.buildFor(`local/${locId}`, path.join(locDir, newFile)).catch(e => {
    console.warn(`[tiles] build failed for local/${locId}:`, e.message);
  });
  res.json({ url });
});

// Serve tiles as static files. The tiler writes to
// data/maps/tiles/<mapId>/<z>/<x>/<y>.jpg; we expose them at the same
// path under /maps/tiles. Includes a tiles.json manifest per mapId.
app.use('/maps/tiles', express.static(TILES_DIR, { fallthrough: true, maxAge: '7d' }));

// ── Marker icon endpoints ────────────────────────────────────────
// Multipart upload (1..16 files, 2 MB each, svg/png/jpeg/webp). The
// pinType id is validated against the live settings.pinTypes list
// before any file lands on disk so a typo can't seed an orphan
// folder. Upload runs inside withWriteLock so a concurrent settings
// PATCH doesn't see partial state.
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
 * `pinTypeId` against the live `settings.pinTypes` list before
 * accepting the files; rejects + cleans up uploads for unknown ids.
 * Auth: required.
 */
app.post('/api/icons/:pinTypeId', requireAuth, uploadIcons.array('icons', 16), (req, res) => {
  withWriteLock(async () => {
    try {
      const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
      if (!pinTypeId) return res.status(400).json({ error: 'Invalid pinTypeId' });
      if (!await _pinTypeExists(pinTypeId)) {
        // Clean up files multer already wrote — we don't want orphans
        // for a non-existent pin type.
        for (const f of req.files || []) {
          try { await fsp.unlink(f.path); } catch (_) {}
        }
        return res.status(400).json({ error: 'Unknown pinTypeId' });
      }
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });
      const out = req.files.map(f => ({
        id:   f.filename,
        url:  `/icons/${pinTypeId}/${f.filename}`,
        name: f.originalname,
      }));
      res.json({ files: out });
    } catch (e) {
      console.error('POST /api/icons:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
    }
  });
});

app.delete('/api/icons/:pinTypeId/:filename', requireAuth, (req, res) => {
  withWriteLock(async () => {
    try {
      const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
      if (!pinTypeId) return res.status(400).json({ error: 'Invalid pinTypeId' });
      const dir    = path.join(ICONS_DIR, pinTypeId);
      const target = _safeJoinIn(dir, req.params.filename || '');
      if (!target) return res.status(400).json({ error: 'Invalid filename' });
      try {
        const stat = await fsp.lstat(target);
        if (stat.isSymbolicLink()) return res.status(400).json({ error: 'Symlinks not allowed' });
        if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
        await fsp.unlink(target);
      } catch (e) {
        if (e.code === 'ENOENT') return res.json({ ok: true });
        throw e;
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/icons/:pinTypeId/:filename:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Delete failed' });
    }
  });
});

app.delete('/api/icons/:pinTypeId', requireAuth, (req, res) => {
  withWriteLock(async () => {
    try {
      const pinTypeId = (req.params.pinTypeId || '').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 60);
      if (!pinTypeId) return res.status(400).json({ error: 'Invalid pinTypeId' });
      const target = _safeJoinIn(ICONS_DIR, pinTypeId);
      if (!target) return res.status(400).json({ error: 'Invalid pinTypeId' });
      try {
        const stat = await fsp.lstat(target);
        if (stat.isSymbolicLink()) return res.status(400).json({ error: 'Symlinks not allowed' });
        if (stat.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
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
  try {
    let stat;
    try { stat = await fsp.lstat(target); }
    catch (e) {
      if (e.code === 'ENOENT') return res.json({ ok: true });
      throw e;
    }
    // Refuse symlinks — never follow them out of PORTRAITS_DIR.
    if (stat.isSymbolicLink()) return res.status(400).json({ error: 'Symlinks not allowed' });
    if (stat.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
    else await fsp.unlink(target);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/portrait:', e);
    res.status(500).json({ error: 'Delete error' });
  }
});

// ── Snapshot API ─────────────────────────────────────────────
// Backed by the snapshot helpers near the top of this file. The
// `/nastaveni` Záloha tab calls these to surface the snapshot list,
// take a manual snapshot, restore one, or undo the last N edits.

/**
 * GET /api/snapshots — List every snapshot, newest first. Each entry
 * carries `{id, createdAt, dataHash, reason, size}`. Auth: any role —
 * players need read access so they can see their own change history
 * and pick a download point. Destructive endpoints below stay DM-only.
 */
app.get('/api/snapshots', requireAnyRole, async (_req, res) => {
  try {
    const files = await _snapshotFiles();
    const metas = (await Promise.all(files.map(_snapshotMeta))).filter(Boolean);
    // Newest first for UI convenience.
    metas.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    res.json({ snapshots: metas });
  } catch (e) {
    console.error('GET /api/snapshots:', e);
    res.status(500).json({ error: 'List failed' });
  }
});

/**
 * POST /api/snapshots — Take a manual snapshot now. Bypasses the
 * 60 s coalesce window that suppresses bursts during normal save
 * activity. Auth: any role — players can pin a "known-good" point
 * before they make a risky edit, same as DMs.
 */
app.post('/api/snapshots', requireAnyRole, (_req, res) => {
  withWriteLock(async () => {
    try {
      const id = await _createSnapshot('manual');
      res.json({ ok: true, id });
    } catch (e) {
      console.error('POST /api/snapshots:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Snapshot failed' });
    }
  });
});

/**
 * POST /api/snapshots/:id/restore — Roll the entire `data/` directory
 * back to a snapshot. The handler takes a `pre-restore` snapshot first
 * so the restore itself is undoable, then broadcasts `data-changed` so
 * every connected client refetches. Auth: required.
 */
app.post('/api/snapshots/:id/restore', requireAuth, (req, res) => {
  withWriteLock(async () => {
    try {
      const r = await _restoreSnapshot(req.params.id);
      if (!r.ok) return res.status(404).json(r);
      await _broadcastDataChanged();
      res.json({ ok: true });
    } catch (e) {
      console.error('POST /api/snapshots/:id/restore:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Restore failed' });
    }
  });
});

/**
 * POST /api/snapshots/revert-last/:n — Undo the last N edits by
 * restoring the snapshot N positions before the newest. n=1 restores
 * the state right before the most recent change. Capped at 50.
 * Auth: required.
 */
app.post('/api/snapshots/revert-last/:n', requireAuth, (req, res) => {
  withWriteLock(async () => {
    const n = Math.max(1, Math.min(50, Number(req.params.n) || 1));
    try {
      const files = await _snapshotFiles();
      if (files.length <= n) return res.status(400).json({ error: 'Nedostatek bodů zálohy pro zpětný krok' });
      // files is ascending by timestamp; the last entry is the newest.
      // To undo the last N changes, restore the snapshot N+1 from the end.
      const id = files[files.length - 1 - n];
      const r = await _restoreSnapshot(id);
      if (!r.ok) return res.status(404).json(r);
      await _broadcastDataChanged();
      res.json({ ok: true, id });
    } catch (e) {
      console.error('POST /api/snapshots/revert-last:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Revert failed' });
    }
  });
});

app.delete('/api/snapshots/:id', requireAuth, async (req, res) => {
  const safe = String(req.params.id || '').replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safe) return res.status(400).json({ error: 'Invalid id' });
  const file = path.join(SNAPSHOTS_DIR, safe);
  try {
    await fsp.unlink(file);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Snapshot nenalezen' });
    console.error('DELETE /api/snapshots:', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ── World-map upload ─────────────────────────────────────────
// Writes the image to `data/maps/swordcoast/sword_coast.<ext>`
// (the canonical default path the client reads). Removes any
// existing world-map file with a different extension so the
// newest upload always wins. Triggers async tile-pyramid build.
const worldMapStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(SWORDCOAST_DIR, { recursive: true });
    cb(null, SWORDCOAST_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, 'sword_coast' + ext);
  },
});
const uploadWorldMap = multer({
  storage:    worldMapStorage,
  limits:     { fileSize: 40 * 1024 * 1024 },
  fileFilter: _imageFilter,
});

/**
 * POST /api/worldmap — Replace the world map backdrop image. Removes
 * any previous file with a different extension, schedules an async
 * tile-pyramid rebuild, returns the new URL. Capped at 40 MB.
 * Auth: required.
 */
app.post('/api/worldmap', requireAuth, uploadWorldMap.single('worldmap'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  const newFile = req.file.filename;
  try {
    const list = await fsp.readdir(SWORDCOAST_DIR);
    await Promise.all(list.filter(f => f !== newFile && /^sword_coast\./i.test(f))
      .map(f => fsp.unlink(path.join(SWORDCOAST_DIR, f)).catch(() => {})));
  } catch (_) {}
  const url = `/maps/swordcoast/${newFile}`;
  // Schedule tile rebuild so the Leaflet path picks up the new image.
  if (_tiler) {
    const base = path.basename(newFile, path.extname(newFile));
    _tiler.buildFor(`swordcoast/${base}`, path.join(SWORDCOAST_DIR, newFile)).catch(e => {
      console.warn(`[tiles] build failed for swordcoast/${base}:`, e.message);
    });
  }
  res.json({ url });
});

// ── Site logo upload ─────────────────────────────────────────
// Writes the uploaded image to `data/branding/logo.<ext>` (replacing
// any previous logo of a different extension). The client stores the
// returned URL in `settings.branding.logoUrl`; clearing that (or
// DELETE below) falls back to the bundled `web/branding/logo-default.svg`.
const brandingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(BRANDING_DIR, { recursive: true });
    cb(null, BRANDING_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, 'logo' + ext);
  },
});
const uploadLogo = multer({
  storage:    brandingStorage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: _imageFilter,
});

/**
 * POST /api/logo — Replace the site logo. Removes any previous logo
 * file with a different extension so the newest upload always wins,
 * returns the new URL. Capped at 5 MB. Auth: DM only (shared chrome).
 */
app.post('/api/logo', requireAuth, uploadLogo.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  const newFile = req.file.filename;
  try {
    const list = await fsp.readdir(BRANDING_DIR);
    await Promise.all(list.filter(f => f !== newFile && /^logo\./i.test(f))
      .map(f => fsp.unlink(path.join(BRANDING_DIR, f)).catch(() => {})));
  } catch (_) {}
  res.json({ url: `/branding/${newFile}` });
});

/**
 * DELETE /api/logo — Remove the custom logo so the bundled default
 * takes over again. Idempotent. Auth: DM only.
 */
app.delete('/api/logo', requireAuth, async (_req, res) => {
  try {
    const list = await fsp.readdir(BRANDING_DIR).catch(() => []);
    await Promise.all(list.filter(f => /^logo\./i.test(f))
      .map(f => fsp.unlink(path.join(BRANDING_DIR, f)).catch(() => {})));
  } catch (_) {}
  res.json({ ok: true });
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
app.get('/api/backup', requireAuth, (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `backup-${timestamp}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    console.error('Backup archive error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed' });
  });
  archive.pipe(res);
  archive.directory(DATA_DIR, 'data');
  archive.finalize();
});

// ── Full data/ restore from upload ────────────────────────────
// Accepts either:
//   - a .zip produced by /api/backup (entries under `data/...`)
//   - a single .json document in the shape Store.exportJSON() emits
// Always takes a `pre-restore` snapshot first so the operation is
// undoable from the Záloha tab. Path-traversal-safe: every entry
// is resolved against DATA_DIR and rejected if it would escape.
//
// Uses disk-staged storage rather than memory: the container's 256 MB
// memory limit can't absorb a 200 MB upload buffer, so multer writes
// to the OS temp dir first and we read from there. 50 MB cap is well
// above any realistic backup (campaign data + portraits + maps).
const AdmZip = require('adm-zip');
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename:    (_req, _file, cb) => cb(null, `restore-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function _safeJoinDataDir(rel) {
  const resolved = _safeJoinIn(DATA_DIR, rel);
  if (!resolved) return null;
  // Defence-in-depth: snapshots now live in a sibling `data-snapshots/`
  // dir, so a restore ZIP cannot reach them through DATA_DIR — but if a
  // future refactor ever moves them back inside DATA_DIR, this guard
  // prevents the silent-overwrite class of attack.
  const snapRoot = path.resolve(SNAPSHOTS_DIR);
  if (resolved === snapRoot || resolved.startsWith(snapRoot + path.sep)) return null;
  return resolved;
}

/**
 * POST /api/restore — Replace the live `data/` directory from an
 * uploaded backup. Accepts both formats:
 *   - a `.zip` produced by `/api/backup` (entries under `data/...`),
 *   - a single `.json` document in the shape `Store.exportJSON()` emits.
 * Takes a `pre-restore` snapshot first so the operation is undoable
 * from the Záloha tab. Every entry path is resolved through
 * `_safeJoinDataDir` so a malicious archive cannot escape `DATA_DIR`
 * (traversal, absolute paths, symlinks all rejected). Auth: required.
 */
app.post('/api/restore', requireAuth, restoreUpload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Žádný soubor nepřijat' });

  const filename = String(req.file.originalname || '');
  const tmpPath  = req.file.path;

  withWriteLock(async () => {
    const cleanup = () => fsp.unlink(tmpPath).catch(() => {});
    try {
      // Sniff the first 64 bytes from disk to detect format. ZIP starts
      // with magic `PK\x03\x04`; JSON with `{` or `[` after optional ws.
      let head;
      try {
        const fh = await fsp.open(tmpPath, 'r');
        try {
          const { buffer: buf, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0);
          head = buf.slice(0, bytesRead);
        } finally { await fh.close(); }
      } catch (e) {
        await cleanup();
        return res.status(500).json({ error: 'Nelze přečíst nahraný soubor' });
      }

      const isZipMagic = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4B
                                          && head[2] === 0x03 && head[3] === 0x04;
      const isZip      = /\.zip$/i.test(filename) || isZipMagic;
      const looksJson  = !isZip && (/\.json$/i.test(filename)
                          || /^\s*[\{\[]/.test(head.toString('utf8')));

      // Pre-restore snapshot — bypass the coalesce window so we always
      // capture the current state regardless of recent activity.
      try { await _createSnapshot('pre-restore'); }
      catch (e) { console.warn('[restore] pre-restore snapshot failed:', e.message); }

      if (isZip) {
        let zip;
        try { zip = new AdmZip(tmpPath); }
        catch (e) {
          await cleanup();
          return res.status(400).json({ error: 'Neplatný ZIP soubor' });
        }

        const entries  = zip.getEntries();

        // Guard against zip bombs / pathological archives BEFORE extracting:
        // too many entries, a single absurdly large file, or an absurd total
        // uncompressed size. Realistic backups (JSON + already-compressed
        // images + tile pyramids) stay far under these. `entry.header.size`
        // is the uncompressed size, read from the central directory without
        // decompressing anything.
        const MAX_ENTRIES     = 50000;               // tile pyramids can be many files
        const MAX_ENTRY_BYTES = 200 * 1024 * 1024;   // 200 MB per file
        const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;  // 1 GB uncompressed total
        if (entries.length > MAX_ENTRIES) {
          await cleanup();
          return res.status(400).json({ error: `ZIP má příliš mnoho položek (> ${MAX_ENTRIES})` });
        }
        let _totalUncompressed = 0;
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const sz = entry.header?.size || 0;
          if (sz > MAX_ENTRY_BYTES) {
            await cleanup();
            return res.status(400).json({ error: 'ZIP obsahuje příliš velký soubor (možný zip bomb)' });
          }
          _totalUncompressed += sz;
          if (_totalUncompressed > MAX_TOTAL_BYTES) {
            await cleanup();
            return res.status(400).json({ error: 'ZIP je po rozbalení příliš velký (možný zip bomb)' });
          }
        }

        const restored = [];
        const skipped  = [];
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          // Normalize separators and strip the leading `data/` wrapper that
          // /api/backup adds. Other zip producers may put files at the root.
          let name = entry.entryName.replace(/\\/g, '/');
          if (name.startsWith('data/')) name = name.slice(5);
          if (!name) continue;

          const target = _safeJoinDataDir(name);
          if (!target) { skipped.push(name); continue; }
          try {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.writeFile(target, entry.getData());
            restored.push(name);
          } catch (e) {
            console.warn('[restore] failed entry', name, e.message);
            skipped.push(name);
          }
        }

        // Rebuild tile pyramids in the background so map images uploaded
        // along with the backup get fresh tiles.
        try { _backgroundTileSweep(); } catch (_) {}

        await _broadcastDataChanged();
        await cleanup();
        return res.json({ ok: true, format: 'zip', restored: restored.length, skipped: skipped.length });
      }

      if (looksJson) {
        let parsed;
        try {
          const raw = await fsp.readFile(tmpPath, 'utf8');
          parsed = JSON.parse(raw);
        } catch (e) {
          await cleanup();
          return res.status(400).json({ error: 'Neplatný JSON soubor' });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          await cleanup();
          return res.status(400).json({ error: 'Neplatný formát zálohy (očekávám objekt)' });
        }
        const restored = [];
        for (const t of ALL_TYPES) {
          if (parsed[t] === undefined) continue;
          // Validate each collection's shape before writing: keyed-object
          // collections must be plain objects, everything else an array.
          // Writing a wrong shape (e.g. characters as a string) would break
          // every subsequent read of that file.
          const val       = parsed[t];
          const wantArray = !KEYED_OBJ_TYPES.has(t);
          const okShape   = wantArray
            ? Array.isArray(val)
            : (val !== null && typeof val === 'object' && !Array.isArray(val));
          if (!okShape) {
            await cleanup();
            return res.status(400).json({ error: `Neplatný tvar kolekce „${t}" v záloze` });
          }
          await _atomicWrite(getFile(t), JSON.stringify(val, null, 2));
          restored.push(`${t}.json`);
        }
        if (!restored.length) {
          await cleanup();
          return res.status(400).json({ error: 'JSON neobsahuje žádnou známou kolekci' });
        }
        await _broadcastDataChanged();
        await cleanup();
        return res.json({ ok: true, format: 'json', restored: restored.length });
      }

      await cleanup();
      return res.status(400).json({ error: 'Nepodporovaný formát — očekávám .zip nebo .json' });
    } catch (e) {
      await cleanup();
      console.error('POST /api/restore:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Restore failed' });
    }
  });
});

// SPA fallback: serve index.html for any unmatched GET so client-side
// hash routing works on a hard refresh / deep link. Express 5 (path-to-regexp
// 8) rejects a bare '*' — the catch-all must be a named wildcard ('/*splat').
app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

// ── Bootstrap: ensure tiles exist for any map already on disk ─────
async function _backgroundTileSweep() {
  if (!_tiler) return;
  const jobs = [];
  // World map(s): data/maps/swordcoast/*.jpg
  try {
    const swDir = path.join(MAPS_DIR, 'swordcoast');
    const list  = await fsp.readdir(swDir).catch(() => []);
    for (const f of list) {
      if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
      const base = path.basename(f, path.extname(f));
      jobs.push({ mapId: `swordcoast/${base}`, src: path.join(swDir, f) });
    }
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
      if (files.length) jobs.push({ mapId: `local/${locId}`, src: path.join(locDir, files[0]) });
    }
  } catch (_) {}
  // Run sequentially to avoid hammering CPU on startup
  for (const j of jobs) {
    try { await _tiler.buildFor(j.mapId, j.src); }
    catch (e) { console.warn(`[tiles] ${j.mapId}: ${e.message}`); }
  }
}

// Bootstrap: await the visibility migration BEFORE accepting any
// connections, so no client can ever see un-stamped data. Tile sweep
// stays fire-and-forget (it can take seconds on a large map and the
// fallback overlay covers any in-flight requests anyway).
async function _bootstrap() {
  // Loud warnings about password configuration. The codebase is open-
  // source so anyone can compute SHA256(...) — a deployment that left
  // DM_PASSWORD unset (or set to the default "123") would be world-
  // editable. A stored credential in data/auth.json (set via Settings
  // → Účet) satisfies the same requirement and silences the warning.
  // EDIT_PASSWORD is the legacy alias; honour it but nag.
  const storedDm     = !!_storedCredentialFor('dm');
  const storedPlayer = !!_storedCredentialFor('player');
  const dmPwdRaw  = process.env.DM_PASSWORD || process.env.EDIT_PASSWORD;
  const playerPwd = process.env.PLAYER_PASSWORD;
  const legacy    = !!process.env.EDIT_PASSWORD && !process.env.DM_PASSWORD;
  if (!storedDm && (!dmPwdRaw || dmPwdRaw === '123')) {
    console.warn('');
    console.warn('  ⚠  DM password is ' + (dmPwdRaw ? 'the default ("123")' : 'UNSET') + '.');
    console.warn('     Anyone with the source can compute the cookie value and gain DM access.');
    console.warn('     Set DM_PASSWORD in the environment, OR sign in once and change it from Settings → Účet.');
    console.warn('');
  } else if (!storedDm && legacy) {
    console.warn('');
    console.warn('  ℹ  Using EDIT_PASSWORD as DM_PASSWORD (back-compat alias).');
    console.warn('     Set DM_PASSWORD explicitly to silence this notice.');
    console.warn('');
  } else if (storedDm) {
    console.log('  ✓  DM password loaded from data/auth.json (overrides env var).');
  }
  if (!storedPlayer && !playerPwd) {
    console.warn('  ℹ  Player password is unset — player login is disabled.');
    console.warn('     Unauthenticated visitors see only public content (same view as a player).');
    console.warn('     Set PLAYER_PASSWORD, or sign in as DM and configure it from Settings → Účet.');
    console.warn('');
  }
  try {
    await runVisibilityMigration();
  } catch (e) {
    console.warn('[migration] visibility migration failed:', e.message);
  }
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
