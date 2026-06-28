'use strict';
// ═══════════════════════════════════════════════════════════════
//  ADDONS (server broker) — pure / injectable helpers.
//
//  The SERVER is the addon broker: it fetches an addon repo from
//  GitHub, validates it, content-hashes it, and lays the code down
//  under data/addons/<id>/<contentHash>/ so the client can import it
//  same-origin (CSP-clean). This module holds the side-effect-free
//  pieces so they're unit-testable from `node --test` (mirrors the
//  split in server-utils.cjs / server/visibility.cjs): manifest
//  validation, allowlist matching, content hashing, and zipball
//  extraction. GitHub I/O is here too but takes an injected `fetch`
//  so tests never touch the network.
//
//  Nothing here touches the filesystem or holds module state —
//  server.js owns DATA_DIR paths, withWriteLock, _atomicWrite, and
//  the Express endpoints, and calls into these helpers.
// ═══════════════════════════════════════════════════════════════

// Host addon-API contract version. An addon's manifest `apiVersion`
// must equal this or it won't load (with a clear "incompatible"
// message rather than a silent break). Bump on a breaking change to
// the host facade / fragment-id contract.
const HOST_API_VERSION = 1;

// Vetted npm libraries a SERVER addon may pull via `serverHost.lib(name)`
// (Phase 7). Arbitrary native modules aren't runtime-installable (no rebuild,
// no writable node_modules), so a server addon either vendors pure-JS deps in
// its repo or consumes one of these already-bundled host deps. Node built-ins
// (crypto/path/fs/…) are reachable via the addon's own require — they're not
// listed here. Anything in a manifest's `serverDeps[]` MUST be in this set or
// the addon loads `blocked`.
const HOST_SERVER_LIBS = new Set(['express', 'adm-zip', 'archiver', 'multer']);

// On-disk registry schema version (data/addons.json).
const REGISTRY_SCHEMA = 1;

// Hard timeout on every GitHub call. A hung connection must not stall an
// install indefinitely (and, since promote holds the write lock, must not
// risk wedging it) — and check-updates iterates serially, so one slow repo
// can't freeze the whole batch.
const GH_FETCH_TIMEOUT_MS = 20000;

// Addon id: lowercase, no underscores (so it can never collide with a
// built-in `addon_*` collection name and is safe as an object key — the
// `_`-free shape also rejects `__proto__`/`constructor`/`prototype`).
// Doubles as the on-disk directory name and the URL path segment.
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

// owner/repo as accepted from the client. Conservative: GitHub allows a
// bounded character set in owner + repo names.
const REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

// Addon-owned collection name (manifest `collections[].name`). Lowercase,
// underscores allowed (so the on-disk filename is friendly), no colons /
// slashes / dots — those are reserved for the `addon:<id>:<name>` wire type
// and the file path. The leading char can't be `_`, which also keeps it
// clear of `__proto__`-style keys when a collection is keyed-object.
const COLLECTION_NAME_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;

// The wire `type` + on-disk identity for an addon-owned collection. Colon-
// namespaced under the addon id so it can never collide with a built-in
// collection (none contain a colon) or with another addon's collection.
function addonCollectionType(id, name) { return `addon:${id}:${name}`; }

// Parse an `addon:<id>:<name>` wire type back into its parts, or null if it
// isn't one (a built-in collection name, or a malformed/unsafe string). The
// tight id+name regexes here are the path-safety gate: neither part can carry
// `..`, a slash, or a null byte, so the derived file path stays inside the
// addon's data dir.
function parseAddonType(type) {
  const m = /^addon:([a-z0-9][a-z0-9-]{1,38}):([a-z0-9][a-z0-9_]{0,39})$/.exec(type || '');
  return m ? { id: m[1], name: m[2] } : null;
}

// Coerce a manifest `collections` value into a clean, de-duped list of
// `{ name, keyed }`. Never throws — invalid entries are dropped (the strict
// `validateManifest` below is what surfaces them as errors to the DM).
function normalizeCollections(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name : '';
    if (!COLLECTION_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, keyed: !!c.keyed });
  }
  return out;
}

/** The empty registry shape written on first install. */
function defaultRegistry() {
  return { schema: REGISTRY_SCHEMA, addons: [], resolutions: {}, sources: { allow: [] } };
}

/** Coerce an arbitrary parsed value into a well-formed registry so
 *  downstream code never has to null-check. Never throws. */
function normalizeRegistry(parsed) {
  const reg = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  reg.schema      = Number.isInteger(reg.schema) ? reg.schema : REGISTRY_SCHEMA;
  reg.addons      = Array.isArray(reg.addons) ? reg.addons : [];
  reg.resolutions = (reg.resolutions && typeof reg.resolutions === 'object' && !Array.isArray(reg.resolutions)) ? reg.resolutions : {};
  reg.sources     = (reg.sources && typeof reg.sources === 'object' && !Array.isArray(reg.sources)) ? reg.sources : {};
  reg.sources.allow = Array.isArray(reg.sources.allow) ? reg.sources.allow.filter(s => typeof s === 'string') : [];
  return reg;
}

/**
 * Tier-A contract check on an addon manifest. Returns { ok, errors }.
 * This is the always-run, no-author-tests-needed gate — a malformed or
 * incompatible manifest never reaches the disk-promote step.
 */
function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['addon.json is not an object'] };
  }
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    errors.push('id must match ^[a-z0-9][a-z0-9-]{1,38}$');
  }
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('name is required');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
    errors.push('version must be semver (x.y.z)');
  }
  if (!Number.isInteger(m.apiVersion)) {
    errors.push('apiVersion must be an integer');
  } else if (m.apiVersion !== HOST_API_VERSION) {
    errors.push(`apiVersion ${m.apiVersion} is incompatible with host apiVersion ${HOST_API_VERSION}`);
  }
  if (typeof m.entry !== 'string' || !m.entry.trim()) {
    errors.push('entry (client ESM path) is required');
  } else if (!_safeRel(m.entry) || !/\.m?js$/.test(m.entry)) {
    errors.push('entry must be a relative .js/.mjs path inside the addon');
  }
  if (m.server !== undefined && (typeof m.server !== 'string' || !_safeRel(m.server) || !/\.c?js$/.test(m.server))) {
    errors.push('server, if set, must be a relative .cjs/.js path inside the addon');
  }
  if (m.serverDeps !== undefined &&
      (!Array.isArray(m.serverDeps) || m.serverDeps.some(d => typeof d !== 'string'))) {
    errors.push('serverDeps must be an array of strings');
  }
  if (m.tests !== undefined) {
    if (typeof m.tests !== 'object' || Array.isArray(m.tests) || m.tests === null) {
      errors.push('tests must be an object { client?, server? }');
    } else {
      for (const k of ['client', 'server']) {
        const v = m.tests[k];
        if (v === undefined) continue;
        const arr = Array.isArray(v) ? v : [v];
        if (!arr.length || arr.some(x => typeof x !== 'string' || !_safeRel(x))) {
          errors.push(`tests.${k} must be a relative path (or array of) inside the addon`);
        }
      }
    }
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions must be an array');
    } else if (m.permissions.some(p => typeof p !== 'string' || !/^[a-z][a-z0-9:_.-]{0,79}$/.test(p))) {
      // Each permission is a capability TOKEN — reject non-strings + anything
      // that isn't token-shaped (so a manifest can't inject forged/garbage
      // labels into the DM's review checklist or break `grants.includes(...)`).
      errors.push('each permission must be a lowercase token (^[a-z][a-z0-9:_.-]*$)');
    }
  }
  if (m.dependencies !== undefined &&
      (typeof m.dependencies !== 'object' || Array.isArray(m.dependencies) || m.dependencies === null)) {
    errors.push('dependencies must be an object');
  }
  if (m.collections !== undefined) {
    if (!Array.isArray(m.collections)) {
      errors.push('collections must be an array');
    } else {
      const seen = new Set();
      for (const c of m.collections) {
        if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !COLLECTION_NAME_RE.test(c.name)) {
          errors.push('each collection needs a name matching ^[a-z0-9][a-z0-9_]{0,39}$');
        } else if (seen.has(c.name)) {
          errors.push(`duplicate collection name "${c.name}"`);
        } else {
          seen.add(c.name);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** A relative path with no traversal, no absolute root, no null byte,
 *  no drive letter. Used for manifest `entry`/`server` and as a cheap
 *  pre-filter on zip entry names (the real disk write still goes
 *  through server.js's _safeJoinIn). */
function _safeRel(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  if (rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;                 // drive letter
  const norm = rel.replace(/\\/g, '/');
  if (norm.split('/').some(seg => seg === '..')) return false;
  return true;
}

/** Does `repo` (owner/name) satisfy one allowlist rule? Supports an
 *  exact `owner/name` and an `owner/*` wildcard for a whole account. */
function matchRepoRule(rule, repo) {
  if (typeof rule !== 'string' || typeof repo !== 'string') return false;
  if (rule === repo) return true;
  if (rule.endsWith('/*')) {
    const owner = rule.slice(0, -2);
    return repo.startsWith(owner + '/') && repo.indexOf('/', owner.length + 1) === -1;
  }
  return false;
}

/** Does `repo` appear in `sources.allow`? NOTE: install does NOT currently
 *  gate on this — an explicit DM paste-and-confirm IS the trust gesture, and
 *  install auto-records the repo here as an audit trail of where addons came
 *  from. This helper + `matchRepoRule` exist for an optional future "only from
 *  recorded sources" gate; they are not wired into `/api/addons/install` today.
 *  (Unit-tested so the matching grammar stays correct if/when that gate lands.) */
function isAllowed(registry, repo) {
  const allow = (registry && registry.sources && registry.sources.allow) || [];
  return allow.some(rule => matchRepoRule(rule, repo));
}

/**
 * Parse a user-pasted repo reference into `{ repo: 'owner/name', ref? }`.
 * Accepts a plain `owner/name`, a GitHub web URL
 * (`https://github.com/owner/name`, optionally `.git`, a trailing slash,
 * or a `/tree/<ref>` suffix), or an SSH URL (`git@github.com:owner/name.git`).
 * Returns null if it doesn't look like a GitHub repo. This is what lets the
 * install wizard take a pasted URL and "handle it from there".
 */
function parseRepoInput(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  let repo = s;
  let ref;
  let m = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/([^/?#\s]+))?\/?(?:[?#].*)?$/i);
  if (m) {
    if (m[3]) { try { ref = decodeURIComponent(m[3]); } catch { ref = m[3]; } }
    repo = `${m[1]}/${m[2]}`;
  } else {
    m = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (m) repo = `${m[1]}/${m[2]}`;
  }
  if (!REPO_RE.test(repo)) return null;
  return ref ? { repo, ref } : { repo };
}

/**
 * Deterministic content hash over a file map ([{relpath, buffer}]).
 * Order-independent (sorted by relpath) so the same tree always hashes
 * the same. Drives the content-addressed install dir + cache-busting.
 *
 * @param {Array<{relpath:string,buffer:Buffer}>} fileMap
 * @param {object} crypto - Node's crypto module (injected).
 * @returns {string} 16-char hex prefix.
 */
function contentHash(fileMap, crypto) {
  const h = crypto.createHash('sha256');
  const sorted = [...fileMap].sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  for (const f of sorted) {
    h.update(f.relpath);
    h.update('\0');
    h.update(f.buffer);
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Extract a zip buffer into a file map, stripping the single top-level
 * wrapper directory that GitHub zipballs always add
 * (`<owner>-<repo>-<sha>/…`). Entry names that fail the relative-path
 * safety check are dropped (defence in depth — server.js also routes
 * every write through `_safeJoinIn`).
 *
 * @param {Buffer} buffer
 * @param {Function} AdmZip - the adm-zip constructor (injected).
 * @returns {Array<{relpath:string,buffer:Buffer}>}
 */
function extractZip(buffer, AdmZip, limits) {
  const maxFiles = (limits && limits.maxFiles) || 5000;
  const maxBytes = (limits && limits.maxBytes) || 200 * 1024 * 1024;
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);

  // Zip-bomb guard: cap the file count, and reject up front if the central
  // directory's DECLARED uncompressed total already blows the cap — so we
  // never decompress a 25 MB zipball into multiple GB of memory before
  // checking. We also re-check the actual decompressed total below in case a
  // crafted header under-reports.
  if (entries.length > maxFiles) throw new Error(`too many files in archive (> ${maxFiles})`);
  let declared = 0;
  for (const e of entries) declared += (e.header && e.header.size) || 0;
  if (declared > maxBytes) throw new Error('archive too large when uncompressed');

  // Detect a common top-level segment shared by every entry (the GitHub
  // wrapper dir). If entries disagree, strip nothing (a hand-made flat
  // zip with files at the root).
  let prefix = null;
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/');
    const slash = name.indexOf('/');
    const seg = slash === -1 ? '' : name.slice(0, slash + 1);   // "" when a file sits at the root
    if (prefix === null) prefix = seg;
    else if (seg !== prefix) { prefix = ''; break; }
  }

  const out = [];
  let total = 0;
  for (const e of entries) {
    let rel = e.entryName.replace(/\\/g, '/');
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    if (!rel) continue;                       // the wrapper dir entry itself
    if (!_safeRel(rel)) continue;             // traversal / absolute / null — skip
    const data = e.getData();
    total += data.length;
    if (total > maxBytes) throw new Error('archive too large when uncompressed');
    out.push({ relpath: rel, buffer: data });
  }
  return out;
}

/**
 * Resolve a git ref (branch/tag/sha) to a full commit SHA via the
 * GitHub API. Pins the install to an immutable commit.
 *
 * @param {string} repo - "owner/name"
 * @param {string} ref  - branch / tag / sha
 * @param {object} deps - { fetch, token? }
 * @returns {Promise<string>} 40-char commit SHA
 */
async function resolveRefToSha(repo, ref, { fetch, token } = {}) {
  const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`;
  const headers = { Accept: 'application/vnd.github.sha', 'User-Agent': 'ttrpg-codex-addons' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`GitHub ref resolve failed (${r.status}) for ${repo}@${ref}`);
  const sha = (await r.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('GitHub returned an unexpected SHA');
  return sha.toLowerCase();
}

/**
 * Download a repo's zipball at a pinned SHA.
 *
 * @param {string} repo - "owner/name"
 * @param {string} sha  - 40-char commit SHA
 * @param {object} deps - { fetch, token? }
 * @returns {Promise<Buffer>}
 */
async function fetchZipball(repo, sha, { fetch, token } = {}) {
  const url = `https://api.github.com/repos/${repo}/zipball/${sha}`;
  const headers = { 'User-Agent': 'ttrpg-codex-addons' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`GitHub zipball fetch failed (${r.status}) for ${repo}@${sha}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Fetch + parse just `addon.json` (the lightweight preview path — one
 * small file via the GitHub contents API, not the whole zipball). Lets
 * the install wizard show the manifest + requested permissions for DM
 * review before anything is downloaded/installed.
 *
 * @returns {Promise<{sha:string, manifest:object}>}
 */
async function fetchManifest(repo, ref, { fetch, token } = {}) {
  const sha = await resolveRefToSha(repo, ref, { fetch, token });
  const url = `https://api.github.com/repos/${repo}/contents/addon.json?ref=${encodeURIComponent(sha)}`;
  const headers = { Accept: 'application/vnd.github.raw', 'User-Agent': 'ttrpg-codex-addons' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`addon.json se nepodařilo načíst (${r.status})`);
  let manifest;
  try { manifest = JSON.parse(await r.text()); }
  catch { throw new Error('addon.json není platný JSON'); }
  return { sha, manifest };
}

module.exports = {
  HOST_API_VERSION,
  HOST_SERVER_LIBS,
  REGISTRY_SCHEMA,
  ID_RE,
  REPO_RE,
  COLLECTION_NAME_RE,
  defaultRegistry,
  normalizeRegistry,
  validateManifest,
  matchRepoRule,
  isAllowed,
  parseRepoInput,
  addonCollectionType,
  parseAddonType,
  normalizeCollections,
  contentHash,
  extractZip,
  resolveRefToSha,
  fetchZipball,
  fetchManifest,
  _safeRel,
};
