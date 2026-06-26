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

// On-disk registry schema version (data/addons.json).
const REGISTRY_SCHEMA = 1;

// Addon id: lowercase, no underscores (so it can never collide with a
// built-in `addon_*` collection name and is safe as an object key — the
// `_`-free shape also rejects `__proto__`/`constructor`/`prototype`).
// Doubles as the on-disk directory name and the URL path segment.
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

// owner/repo as accepted from the client. Conservative: GitHub allows a
// bounded character set in owner + repo names.
const REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

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
  if (m.server !== undefined && (typeof m.server !== 'string' || !_safeRel(m.server))) {
    errors.push('server, if set, must be a relative path inside the addon');
  }
  if (m.permissions !== undefined && !Array.isArray(m.permissions)) {
    errors.push('permissions must be an array');
  }
  if (m.dependencies !== undefined &&
      (typeof m.dependencies !== 'object' || Array.isArray(m.dependencies) || m.dependencies === null)) {
    errors.push('dependencies must be an object');
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

/** Is this repo allowed to be installed from? Empty allowlist = nothing
 *  allowed (install refused until the DM adds a trusted source). */
function isAllowed(registry, repo) {
  const allow = (registry && registry.sources && registry.sources.allow) || [];
  return allow.some(rule => matchRepoRule(rule, repo));
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
function extractZip(buffer, AdmZip) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);

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
  for (const e of entries) {
    let rel = e.entryName.replace(/\\/g, '/');
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    if (!rel) continue;                       // the wrapper dir entry itself
    if (!_safeRel(rel)) continue;             // traversal / absolute / null — skip
    out.push({ relpath: rel, buffer: e.getData() });
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
  const r = await fetch(url, { headers });
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
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (!r.ok) throw new Error(`GitHub zipball fetch failed (${r.status}) for ${repo}@${sha}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

module.exports = {
  HOST_API_VERSION,
  REGISTRY_SCHEMA,
  ID_RE,
  REPO_RE,
  defaultRegistry,
  normalizeRegistry,
  validateManifest,
  matchRepoRule,
  isAllowed,
  contentHash,
  extractZip,
  resolveRefToSha,
  fetchZipball,
  _safeRel,
};
