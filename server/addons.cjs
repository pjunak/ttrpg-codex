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
//  server.js owns DATA_DIR paths, the write lock, durable persistence, and
//  the Express endpoints, and calls into these helpers.
// ═══════════════════════════════════════════════════════════════

// Host addon-API contract version. An addon's manifest `apiVersion`
// must equal this or it won't load (with a clear "incompatible"
// message rather than a silent break). Bump on a breaking change to
// the host facade / fragment-id contract.
const Compatibility = require('./addon-compat.cjs');
const HOST_API_VERSION = 2;

// Vetted npm libraries a SERVER addon may pull via `serverHost.lib(name)`
// Arbitrary native modules aren't runtime-installable (no rebuild,
// no writable node_modules), so a server addon either vendors pure-JS deps in
// its repo or consumes one of these already-bundled host deps. Node built-ins
// (crypto/path/fs/…) are reachable via the addon's own require — they're not
// listed here. Anything in a manifest's `serverDeps[]` MUST be in this set or
// the addon loads `blocked`.
const HOST_SERVER_LIBS = new Set(['express', 'archiver', 'multer']);

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

// Manifest `contentGroups.field` — the record property a content addon
// (`contentDir`) buckets its records by (e.g. "book" for sourcebooks), so the
// DM can toggle whole groups off. Plain identifier grammar: the field is used
// as a bare property lookup on every record, never as a path.
const CONTENT_GROUP_FIELD_RE = /^[a-zA-Z0-9_]{1,40}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const MAX_LOCALES = 20;

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

// Coerce a manifest or persisted-registry `collections` value into a clean,
// de-duped list of `{ name, keyed, access }`. Invalid security semantics drop
// the declaration instead of widening it to public. The strict
// `validateManifest` below surfaces install-time errors to the DM.
function normalizeCollections(raw, apiVersion = 1, capabilities) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  const required = capabilities && Array.isArray(capabilities.required)
    ? capabilities.required
    : [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const name = typeof c.name === 'string' ? c.name : '';
    if (!COLLECTION_NAME_RE.test(name) || seen.has(name)) continue;
    // Persisted normalized v1 declarations may carry `access:"public"` even
    // though source v1 manifests may not declare access at all.
    const allowed = ['name', 'keyed', 'access'];
    if (Object.keys(c).some(key => !allowed.includes(key))) continue;
    if (c.keyed !== undefined && typeof c.keyed !== 'boolean') continue;
    if (apiVersion !== 2 && c.access !== undefined && c.access !== 'public') continue;
    if (c.access !== undefined && c.access !== 'public' && c.access !== 'dm') continue;
    const access = c.access === 'dm' ? 'dm' : 'public';
    if (access === 'dm' && !required.includes('collections.dm')) continue;
    seen.add(name);
    out.push({ name, keyed: !!c.keyed, access });
  }
  return out;
}

// Coerce a manifest `contentGroups` value into
// `{ field, additionalField?, label }` or null.
// Never throws — a malformed declaration simply doesn't group (the strict
// `validateManifest` below is what surfaces it as an error to the DM). Used
// both at promote time (manifest → registry) and by normalizeRegistry (a
// registry can arrive from a restore ZIP, so shapes are re-checked on read).
function normalizeContentGroups(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const field = typeof raw.field === 'string' ? raw.field : '';
  if (!CONTENT_GROUP_FIELD_RE.test(field)) return null;
  const additionalField = typeof raw.additionalField === 'string'
    ? raw.additionalField
    : '';
  if (additionalField &&
      (!CONTENT_GROUP_FIELD_RE.test(additionalField) || additionalField === field)) {
    return null;
  }
  const label = typeof raw.label === 'string' ? raw.label.slice(0, 60) : '';
  return additionalField ? { field, additionalField, label } : { field, label };
}

// Coerce a registry `disabledContentGroups` value into a clean, de-duped list
// of group ids (the DM's per-addon off-list). Group ids are String(record
// [field]) values — free-form content strings, so only length + type are
// constrained. Never throws; junk entries are dropped.
function normalizeDisabledContentGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    if (typeof v !== 'string' || !v || v.length > 80 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function _safeCatalogPath(rel) {
  if (!_safeRel(rel) || rel.includes('\\') || !/\.json$/i.test(rel)) return false;
  if (rel.includes('?') || rel.includes('#')) return false;
  return rel.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function normalizeLocales(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const locales = {};
  for (const [declaredId, rel] of Object.entries(raw)) {
    const locale = LOCALE_RE.test(declaredId) ? declaredId.toLowerCase() : null;
    if (!locale || Object.prototype.hasOwnProperty.call(locales, locale) || !_safeCatalogPath(rel)) continue;
    locales[locale] = rel;
  }
  return Object.keys(locales).length ? locales : null;
}

const INSTALLED_OPTIONAL_MANIFEST_FIELDS = [
  'hostVersion',
  'capabilities',
  'server',
  'contentDir',
  'contentGroups',
  'locales',
];

function installedOptionalMetadata(manifest) {
  const metadata = {};
  if (manifest.hostVersion !== undefined) metadata.hostVersion = manifest.hostVersion;
  if (manifest.capabilities !== undefined) metadata.capabilities = manifest.capabilities;
  if (manifest.server !== undefined) metadata.server = manifest.server;
  if (manifest.contentDir !== undefined) metadata.contentDir = manifest.contentDir;
  const contentGroups = normalizeContentGroups(manifest.contentGroups);
  if (contentGroups) metadata.contentGroups = contentGroups;
  const locales = normalizeLocales(manifest.locales);
  if (locales) metadata.locales = locales;
  return metadata;
}

function applyInstalledOptionalMetadata(target, metadata) {
  for (const field of INSTALLED_OPTIONAL_MANIFEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(metadata, field)) target[field] = metadata[field];
    else delete target[field];
  }
  return target;
}

function repairLegacyInstalledMetadata(registry) {
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.addons)) return 0;
  let repaired = 0;
  for (const addon of registry.addons) {
    if (!addon || typeof addon !== 'object' || Array.isArray(addon)) continue;
    if (addon.contentDir === null) {
      delete addon.contentDir;
      repaired++;
    }
    if (!Array.isArray(addon.versions)) continue;
    for (const version of addon.versions) {
      if (!version || typeof version !== 'object' || Array.isArray(version)) continue;
      if (version.contentDir === null) {
        delete version.contentDir;
        repaired++;
      }
    }
  }
  return repaired;
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
  repairLegacyInstalledMetadata(reg);
  // Per-addon content-group state: `contentGroups` (the manifest declaration
  // carried into the registry at promote) and `disabledContentGroups` (the
  // DM's off-list). Both re-validated on every read — a registry may arrive
  // from a restore ZIP, and downstream consumers (_applyAddonContent /
  // _publicAddonList in server.js) rely on these shapes without re-checking.
  for (const a of reg.addons) {
    if (!a || typeof a !== 'object') continue;
    a.collections = normalizeCollections(a.collections, a.apiVersion, a.capabilities);
    const locales = normalizeLocales(a.locales);
    if (locales) a.locales = locales; else delete a.locales;
    const cg = normalizeContentGroups(a.contentGroups);
    if (cg) a.contentGroups = cg; else delete a.contentGroups;
    a.disabledContentGroups = normalizeDisabledContentGroups(a.disabledContentGroups);
  }
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
  if (!Compatibility.parseVersion(m.version)) {
    errors.push('version must be semver (x.y.z)');
  }
  if (!Number.isInteger(m.apiVersion)) {
    errors.push('apiVersion must be an integer');
  } else if (!Compatibility.SUPPORTED_API_VERSIONS.has(m.apiVersion)) {
    errors.push(`apiVersion ${m.apiVersion} is unsupported; host supports 1 and 2`);
  }
  if (typeof m.entry !== 'string' || !m.entry.trim()) {
    errors.push('entry (client ESM path) is required');
  } else if (!_safeRel(m.entry) || !/\.m?js$/.test(m.entry)) {
    errors.push('entry must be a relative .js/.mjs path inside the addon');
  }
  if (m.server !== undefined && (typeof m.server !== 'string' || !_safeRel(m.server) || !/\.c?js$/.test(m.server))) {
    errors.push('server, if set, must be a relative .cjs/.js path inside the addon');
  }
  // Declarative content tree (host-served — no server code / server:code
  // grant needed): a relative dir of per-record JSON the host exposes at
  // /api/addon/<id>/{content,content/:kind,item/:kind/:id,kinds}.
  if (m.contentDir !== undefined && (typeof m.contentDir !== 'string' || !m.contentDir.trim() || !_safeRel(m.contentDir))) {
    errors.push('contentDir, if set, must be a relative directory path inside the addon');
  }
  // Optional content-group declaration for contentDir addons: the record
  // field whose value buckets records into DM-toggleable groups (e.g. a
  // rulebook's `book` field → per-sourcebook on/off switches).
  if (m.contentGroups !== undefined) {
    const cg = m.contentGroups;
    if (!cg || typeof cg !== 'object' || Array.isArray(cg)) {
      errors.push('contentGroups must be an object { field, additionalField?, label? }');
    } else {
      if (typeof cg.field !== 'string' || !CONTENT_GROUP_FIELD_RE.test(cg.field)) {
        errors.push('contentGroups.field must match ^[a-zA-Z0-9_]{1,40}$');
      }
      if (cg.additionalField !== undefined &&
          (typeof cg.additionalField !== 'string' ||
           !CONTENT_GROUP_FIELD_RE.test(cg.additionalField) ||
           cg.additionalField === cg.field)) {
        errors.push('contentGroups.additionalField must be a distinct field matching ^[a-zA-Z0-9_]{1,40}$');
      }
      if (cg.label !== undefined && (typeof cg.label !== 'string' || cg.label.length > 60)) {
        errors.push('contentGroups.label must be a string of at most 60 characters');
      }
      for (const key of Object.keys(cg)) {
        if (!['field', 'additionalField', 'label'].includes(key)) {
          errors.push(`contentGroups has unknown field "${key}"`);
        }
      }
    }
  }
  if (m.locales !== undefined) {
    if (m.apiVersion !== 2) errors.push('locales requires apiVersion 2');
    const required = Array.isArray(m.capabilities?.required) ? m.capabilities.required : [];
    if (!required.includes('i18n.catalogs')) errors.push('locales requires capability "i18n.catalogs"');
    if (!m.locales || typeof m.locales !== 'object' || Array.isArray(m.locales)) {
      errors.push('locales must be an object mapping locale ids to catalog paths');
    } else {
      const entries = Object.entries(m.locales);
      if (entries.length > MAX_LOCALES) errors.push(`locales may declare at most ${MAX_LOCALES} catalogs`);
      const seen = new Set();
      for (const [declaredId, rel] of entries) {
        const locale = LOCALE_RE.test(declaredId) ? declaredId.toLowerCase() : null;
        if (!locale) errors.push(`invalid locale id "${declaredId}"`);
        else if (seen.has(locale)) errors.push(`duplicate locale declaration "${locale}"`);
        else seen.add(locale);
        if (typeof rel !== 'string' || !_safeCatalogPath(rel)) {
          errors.push(`locales.${declaredId} must be a relative .json path inside the addon`);
        }
      }
      if (!seen.has('en')) errors.push('locales must declare the required English source catalog "en"');
    }
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
    } else if (m.permissions.some(p => typeof p !== 'string' || !/^[a-z][a-zA-Z0-9:_.-]{0,79}$/.test(p))) {
      // Each permission is a capability TOKEN — reject non-strings + anything
      // that isn't token-shaped (so a manifest can't inject forged/garbage
      // labels into the DM's review checklist or break `grants.includes(...)`).
      // Must START lowercase, but uppercase is allowed afterward: the runtime
      // emits the camelCase per-entity-write token `data:write:<coll>.addonData`.
      errors.push('each permission must be a token starting lowercase (^[a-z][a-zA-Z0-9:_.-]*$)');
    }
  }
  errors.push(...Compatibility.compatibilityErrors(m).filter(e => !e.startsWith('apiVersion ')));
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
          const allowed = m.apiVersion === 2 ? ['name', 'keyed', 'access'] : ['name', 'keyed'];
          for (const key of Object.keys(c)) if (!allowed.includes(key)) errors.push(`collection "${c.name}" has unknown field "${key}"`);
          if (c.keyed !== undefined && typeof c.keyed !== 'boolean') {
            errors.push(`collection "${c.name}" keyed must be a boolean`);
          }
          if (c.access !== undefined) {
            if (m.apiVersion !== 2) errors.push(`collection "${c.name}" access semantics require apiVersion 2`);
            else if (c.access !== 'public' && c.access !== 'dm') errors.push(`collection "${c.name}" access must be "public" or "dm"`);
            else if (c.access === 'dm' && !(m.capabilities && Array.isArray(m.capabilities.required) && m.capabilities.required.includes('collections.dm'))) {
              errors.push(`collection "${c.name}" access "dm" requires capability "collections.dm"`);
            }
          }
        }
      }
    }
  }
  const declaredCapabilities = [
    ...(m.capabilities?.required || []),
    ...(m.capabilities?.optional || []),
  ];
  if (declaredCapabilities.includes('collections.transactions')) {
    if (!Array.isArray(m.collections) || !m.collections.length) {
      errors.push('capability "collections.transactions" requires at least one declared collection');
    }
    if (!Array.isArray(m.permissions) || !m.permissions.includes('data:own')) {
      errors.push('capability "collections.transactions" requires permission "data:own"');
    }
  }
  if (declaredCapabilities.includes('imports.providers')) {
    if (m.apiVersion !== 2) {
      errors.push('capability "imports.providers" requires apiVersion 2');
    }
    if (typeof m.server !== 'string' || !m.server) {
      errors.push('capability "imports.providers" requires a server module');
    }
    for (const permission of ['server:code', 'data:import-provider', 'data:own']) {
      if (!Array.isArray(m.permissions) || !m.permissions.includes(permission)) {
        errors.push(`capability "imports.providers" requires permission "${permission}"`);
      }
    }
    if (!declaredCapabilities.includes('collections.transactions')) {
      errors.push('capability "imports.providers" requires capability "collections.transactions"');
    }
    if (!Array.isArray(m.collections) || !m.collections.length) {
      errors.push('capability "imports.providers" requires at least one declared collection');
    }
  }
  if (declaredCapabilities.includes('graphs.facade')) {
    if (m.apiVersion !== 2) {
      errors.push('capability "graphs.facade" requires apiVersion 2');
    }
    if (!Array.isArray(m.permissions) || !m.permissions.includes('ui:graph')) {
      errors.push('capability "graphs.facade" requires permission "ui:graph"');
    }
    if (!declaredCapabilities.includes('lifecycle.dispose')) {
      errors.push('capability "graphs.facade" requires capability "lifecycle.dispose"');
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

function contentRevision(entry, crypto) {
  const groups = normalizeContentGroups(entry && entry.contentGroups);
  const disabled = groups
    ? normalizeDisabledContentGroups(entry && entry.disabledContentGroups).sort()
    : [];
  const identity = {
    activeHash: typeof entry?.activeHash === 'string' ? entry.activeHash : '',
    version: typeof entry?.version === 'string' ? entry.version : '',
    contentGroups: groups
      ? { field: groups.field, additionalField: groups.additionalField || '', disabled }
      : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

// GitHub answers 404 (not 403) for a private repo hit anonymously, so a DM
// installing from a private repo without a server token sees a misleading
// "not found" for a repo they know exists. When a fetch 404s AND no token is
// configured, extend the error with the operator hint. Never echoes the
// token (or anything else request-derived beyond repo + status).
function _privateRepoHint(status, token) {
  return (status === 404 && !token)
    ? ' — pokud je repozitář privátní, nastav na serveru CODEX_GITHUB_TOKEN'
    : '';
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
  if (!r.ok) throw new Error(`GitHub ref resolve failed (${r.status}) for ${repo}@${ref}${_privateRepoHint(r.status, token)}`);
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
async function fetchZipball(repo, sha, { fetch, token, maxBytes = 30 * 1024 * 1024 } = {}) {
  const url = `https://api.github.com/repos/${repo}/zipball/${sha}`;
  const headers = { 'User-Agent': 'ttrpg-codex-addons' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`GitHub zipball fetch failed (${r.status}) for ${repo}@${sha}${_privateRepoHint(r.status, token)}`);
  const declared = Number(r.headers && r.headers.get && r.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`GitHub zipball exceeds the compressed size limit (${maxBytes} bytes)`);
  }
  // Node fetch exposes a WHATWG ReadableStream. Consume it incrementally and
  // stop as soon as the compressed download crosses the cap, instead of
  // calling response.arrayBuffer() and allowing an arbitrary allocation.
  if (r.body && typeof r.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of r.body) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw new Error(`GitHub zipball exceeds the compressed size limit (${maxBytes} bytes)`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  }
  // Small injected test doubles may expose only arrayBuffer(). Production
  // always takes the bounded streaming branch above.
  const ab = await r.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new Error(`GitHub zipball exceeds the compressed size limit (${maxBytes} bytes)`);
  }
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
  if (!r.ok) throw new Error(`addon.json se nepodařilo načíst (${r.status})${_privateRepoHint(r.status, token)}`);
  let manifest;
  try { manifest = JSON.parse(await r.text()); }
  catch { throw new Error('addon.json není platný JSON'); }
  return { sha, manifest };
}

module.exports = {
  HOST_API_VERSION,
  HOST_VERSION: Compatibility.HOST_VERSION,
  HOST_CAPABILITIES: Compatibility.HOST_CAPABILITIES,
  HOST_SERVER_LIBS,
  REGISTRY_SCHEMA,
  ID_RE,
  REPO_RE,
  COLLECTION_NAME_RE,
  CONTENT_GROUP_FIELD_RE,
  LOCALE_RE,
  defaultRegistry,
  normalizeRegistry,
  normalizeContentGroups,
  normalizeDisabledContentGroups,
  normalizeLocales,
  installedOptionalMetadata,
  applyInstalledOptionalMetadata,
  repairLegacyInstalledMetadata,
  validateManifest,
  matchRepoRule,
  isAllowed,
  parseRepoInput,
  addonCollectionType,
  parseAddonType,
  normalizeCollections,
  contentHash,
  contentRevision,
  resolveRefToSha,
  fetchZipball,
  fetchManifest,
  _safeRel,
};
