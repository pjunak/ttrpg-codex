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
const { isForbiddenKey, safeJoinIn, pickKeptSnapshots } = require('./server-utils.cjs');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust the first reverse-proxy hop so req.ip / cookie `secure` work
// correctly when deployed behind nginx/Caddy/Traefik (the standard
// docker-compose layout uses an external `proxy` network).
app.set('trust proxy', 1);

// Re-bind the imported helpers under the `_`-prefix names that the
// rest of this file was written against. Keeps the diff at the call
// sites minimal while still letting tests import the canonical names
// from server-utils.cjs.
const _isForbiddenKey = isForbiddenKey;

const DATA_DIR       = path.join(__dirname, 'data');
const PORTRAITS_DIR  = path.join(__dirname, 'data', 'portraits');
const MAPS_DIR       = path.join(__dirname, 'data', 'maps');
const LOCAL_MAPS_DIR = path.join(MAPS_DIR, 'local');
const TILES_DIR      = path.join(MAPS_DIR, 'tiles');
const SWORDCOAST_DIR = path.join(MAPS_DIR, 'swordcoast');
const ICONS_DIR      = path.join(__dirname, 'data', 'icons');
// Snapshots live OUTSIDE data/ so:
//   - the data hash and the backup zip don't have to keep stepping
//     around them (they used to be at data/snapshots/).
//   - the restore zip can never inadvertently plant or overwrite a
//     legitimate snapshot via _safeJoinDataDir.
//   - "data/" stays a clean reflection of the campaign content.
// One-time migration below moves any pre-existing data/snapshots/* up.
const SNAPSHOTS_DIR  = path.join(__dirname, 'data-snapshots');
const LEGACY_SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const WEB_DIR        = path.join(__dirname, 'web');

fs.mkdirSync(DATA_DIR,       { recursive: true });
fs.mkdirSync(PORTRAITS_DIR,  { recursive: true });
fs.mkdirSync(LOCAL_MAPS_DIR, { recursive: true });
fs.mkdirSync(TILES_DIR,      { recursive: true });
fs.mkdirSync(SWORDCOAST_DIR, { recursive: true });
fs.mkdirSync(ICONS_DIR,      { recursive: true });
fs.mkdirSync(SNAPSHOTS_DIR,  { recursive: true });

// One-shot relocation: if a pre-A3 deployment left snapshots inside
// data/, move them to the new sibling dir. Idempotent — re-running is
// a no-op once data/snapshots is gone.
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

// ── Auth ──────────────────────────────────────────────────────────
// Cookie value is SHA256(password); compared with timingSafeEqual to
// avoid leaking length/prefix info via timing side channel.
function _expectedToken() {
  const pwd = process.env.EDIT_PASSWORD || '123';
  return crypto.createHash('sha256').update(pwd).digest('hex');
}
function _safeEq(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
const requireAuth = (req, res, next) => {
  if (_safeEq(req.cookies.edit_session, _expectedToken())) return next();
  res.status(401).json({ error: 'Neznámé nebo chybějící heslo.' });
};

app.use('/portraits', express.static(PORTRAITS_DIR));
app.use('/maps',      express.static(MAPS_DIR));
app.use('/icons',     express.static(ICONS_DIR, { maxAge: '7d', fallthrough: true }));
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
// Custom marker artwork lives under data/icons/<pinTypeId>/<file>.
// Per-pinType strategy + per-file state assignments are stored on
// settings.pinTypes[i].iconConfig (in-band on the existing settings
// PATCH path). Filenames are slugified before write so an upload of
// "Castle Burning.png" lands at "castle_burning.png" and round-trips
// cleanly through URLs without encoding hazards.
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

async function _createSnapshot(reason = 'save') {
  const now       = Date.now();
  const createdAt = new Date(now).toISOString();
  const files     = {};
  try {
    const list = await fsp.readdir(DATA_DIR);
    for (const f of list) {
      if (!f.endsWith('.json')) continue;
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
  // added after the snapshot that didn't exist then).
  try {
    const list = await fsp.readdir(DATA_DIR);
    for (const f of list) {
      if (!f.endsWith('.json')) continue;
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
    _cachedDataHash = null;
  } catch (_) { _cachedDataHash = null; }
}

async function _dataHash() {
  if (_cachedDataHash !== null) return _cachedDataHash;
  try {
    const h = crypto.createHash('sha1');
    const list = (await fsp.readdir(DATA_DIR)).filter(f => f.endsWith('.json')).sort();
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

// ── SSE broadcast (Phase 5.1) ────────────────────────────────────
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

app.get('/api/data', async (_req, res) => {
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
    res.type('application/json').send(JSON.stringify(campaign));
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

app.post('/api/login', (req, res) => {
  const ip = _loginKey(req);
  if (_isBlocked(ip)) {
    return res.status(429).json({ error: 'Příliš mnoho neúspěšných pokusů. Zkus to za 15 minut.' });
  }
  const { password } = req.body || {};
  const expected     = process.env.EDIT_PASSWORD || '123';
  if (typeof password !== 'string' || !_safeEq(password, expected)) {
    _noteFailure(ip);
    return res.status(401).json({ error: 'Špatné heslo' });
  }
  _loginAttempts.delete(ip);
  res.cookie('edit_session', _expectedToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    path:     '/',
    maxAge:   30 * 24 * 60 * 60 * 1000,   // 30 days
  });
  res.json({ ok: true });
});

app.get('/api/auth', requireAuth, (_req, res) => {
  res.json({ ok: true });
});

// Collections stored as keyed objects on disk (factions, settings,
// campaign, deletedDefaults). Everything else is a plain entity-list
// array. `deletedDefaults` was historically a string array but was
// converted to a keyed-object so individual tombstones can round-trip
// through the per-entity PATCH path (no whole-collection wipe needed).
const KEYED_OBJ_TYPES = new Set(['factions', 'settings', 'campaign', 'deletedDefaults']);

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

app.patch('/api/data', requireAuth, (req, res) => {
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

      const p = getFile(type);
      // Keyed-object collections: factions (id → record), settings
      // (category → array), and campaign (single 'main' record).
      // Everything else is an entity list.
      const emptyContainer = KEYED_OBJ_TYPES.has(type) ? {} : [];
      let container = await _readJsonOr(p, emptyContainer);

      // Auto-migrate portrait to canonical subfolder on character save
      if (type === 'characters' && action === 'save' && payload?.id && payload?.portrait) {
        const charId         = payload.id;
        const cleanUrl       = payload.portrait.split('?')[0];
        const expectedPrefix = `/portraits/${charId}/portrait.`;
        if (!cleanUrl.startsWith(expectedPrefix)) {
          const relPath = cleanUrl.replace(/^\/portraits\//, '');
          // Refuse traversal/absolute paths and verify the resolved
          // location is still inside PORTRAITS_DIR. Without this, an
          // authed editor could move arbitrary files into the portraits
          // dir by sending a portrait URL like "/portraits/../../etc/passwd".
          const srcFile = _safeJoinIn(PORTRAITS_DIR, relPath);
          // Also guard the destination charId — character ids today are
          // ASCII slugs, but `payload.id` is caller-supplied so a crafted
          // `..` would otherwise let the rename target escape.
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

app.get('/api/version', async (_req, res) => {
  res.json({ hash: await _dataHash() });
});

// ── SSE event stream (Phase 5.1) ──────────────────────────────────
app.get('/api/events', async (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const hash = await _dataHash();
  res.write(`event: hello\ndata: ${JSON.stringify({ hash, at: Date.now() })}\n\n`);
  _sseClients.add(res);

  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(ping);
    _sseClients.delete(res);
  });
});

app.post('/api/portrait/:charId', requireAuth, uploadChar.single('portrait'), async (req, res) => {
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

app.post('/api/localmap/:locId', requireAuth, uploadLocalMap.single('localmap'), async (req, res) => {
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

app.delete('/api/portrait/:identifier', requireAuth, async (req, res) => {
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
// The snapshot system lives in the helpers at the top of this file.
// Endpoints here expose list / create / restore / delete to the
// client so the /nastaveni Záloha tab can manage them.
app.get('/api/snapshots', requireAuth, async (_req, res) => {
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

app.post('/api/snapshots', requireAuth, (_req, res) => {
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

// Revert the last N changes by restoring the snapshot N-1 positions
// back in the newest-first list (so n=1 = second-newest snapshot,
// which represents state before the most recent change).
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

// ── Full data/ backup as zip ──────────────────────────────────
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
    filename:    (_req, _file, cb) => cb(null, `tiamat-restore-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
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
          await _atomicWrite(getFile(t), JSON.stringify(parsed[t], null, 2));
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

app.get('*', (_req, res) => {
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

app.listen(PORT, () => {
  console.log(`Tiamat running on http://localhost:${PORT}`);
  // Loud warning if running with the default/insecure password. The
  // codebase is open-source so anyone can compute SHA256("123") — a
  // deployment that left EDIT_PASSWORD unset would be world-editable.
  const pwd = process.env.EDIT_PASSWORD;
  if (!pwd || pwd === '123') {
    console.warn('');
    console.warn('  ⚠  EDIT_PASSWORD is ' + (pwd ? 'the default ("123")' : 'UNSET') + '.');
    console.warn('     Anyone with the source can compute the cookie value and gain edit access.');
    console.warn('     Set EDIT_PASSWORD in the environment (e.g. in docker-compose.yml or .env) before exposing this server.');
    console.warn('');
  }
  // Fire-and-forget — sweep can take seconds for large maps; don't
  // block the listen callback.
  _backgroundTileSweep().catch(e => console.warn('[tiles] sweep failed:', e.message));
});
