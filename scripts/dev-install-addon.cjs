#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────
//  DEV HELPER — install a LOCAL addon directory, bypassing GitHub.
//
//  Mirrors server.js's _installAddon disk layout (content-addressed
//  under data/addons/<id>/<hash>/ + a data/addons.json registry entry)
//  so the running app loads it on next launch — no GitHub repo, no
//  allowlist, no UI needed. Handy for developing an addon locally and
//  for kicking the tyres on the framework before the Addon Manager UI
//  lands.
//
//  Usage:
//    node scripts/dev-install-addon.cjs <addon-dir> [data-dir]
//    node scripts/dev-install-addon.cjs examples/addons/hello
//
//  data-dir defaults to $CODEX_DATA_DIR or ./data.
// ─────────────────────────────────────────────────────────────────
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const Broker = require('../server/addons.cjs');

const src = process.argv[2];
const dataDir = path.resolve(process.argv[3] || process.env.CODEX_DATA_DIR || path.join(__dirname, '..', 'data'));
if (!src) {
  console.error('usage: node scripts/dev-install-addon.cjs <addon-dir> [data-dir]');
  process.exit(1);
}

function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ relpath: path.relative(base, full).replace(/\\/g, '/'), buffer: fs.readFileSync(full) });
  }
  return out;
}

const srcAbs  = path.resolve(src);
const fileMap = walk(srcAbs, srcAbs);
const mf = fileMap.find(f => f.relpath === 'addon.json');
if (!mf) { console.error(`addon.json not found in ${srcAbs}`); process.exit(1); }

let manifest;
try { manifest = JSON.parse(mf.buffer.toString('utf8')); }
catch (e) { console.error('addon.json is not valid JSON:', e.message); process.exit(1); }

const v = Broker.validateManifest(manifest);
if (!v.ok) { console.error('invalid addon.json:\n  - ' + v.errors.join('\n  - ')); process.exit(1); }

const id   = manifest.id;
const hash = Broker.contentHash(fileMap, crypto);
const finalDir = path.join(dataDir, 'addons', id, hash);

fs.rmSync(finalDir, { recursive: true, force: true });
for (const f of fileMap) {
  const dest = path.join(finalDir, f.relpath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.buffer);
}
fs.mkdirSync(path.join(dataDir, 'addon-data', id), { recursive: true });

const regFile = path.join(dataDir, 'addons.json');
let reg;
try { reg = Broker.normalizeRegistry(JSON.parse(fs.readFileSync(regFile, 'utf8'))); }
catch { reg = Broker.defaultRegistry(); }

const versionRec = { contentHash: hash, version: manifest.version, sha: 'local', installedAt: Date.now() };
let entry = reg.addons.find(a => a.id === id);
if (!entry) {
  entry = {
    id, repo: 'local', ref: 'local', sha: 'local',
    name: manifest.name, version: manifest.version,
    apiVersion: manifest.apiVersion, hostVersion: manifest.hostVersion || '',
    entry: manifest.entry, server: manifest.server || null,
    serverDeps: Array.isArray(manifest.serverDeps) ? manifest.serverDeps.filter(d => typeof d === 'string') : [],
    activeHash: hash, versions: [versionRec],
    enabled: true, grantedPermissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
    dependencies: (manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)) ? manifest.dependencies : {},
    collections: Broker.normalizeCollections(manifest.collections),
    schemaVersion: 0, installedAt: Date.now(),
  };
  reg.addons.push(entry);
} else {
  Object.assign(entry, {
    name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion,
    entry: manifest.entry, server: manifest.server || null, activeHash: hash, enabled: true,
    serverDeps: Array.isArray(manifest.serverDeps) ? manifest.serverDeps.filter(d => typeof d === 'string') : [],
    dependencies: (manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)) ? manifest.dependencies : {},
    collections: Broker.normalizeCollections(manifest.collections),
  });
  if (!Array.isArray(entry.versions)) entry.versions = [];
  if (!entry.versions.some(x => x.contentHash === hash)) entry.versions.push(versionRec);
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));

console.log(`✓ installed "${id}" v${manifest.version}`);
console.log(`  code:      ${finalDir}`);
console.log(`  entry URL: /addons/${id}/${hash}/${manifest.entry}`);
console.log('  Restart / reload the app — the addon loads at boot and its sidebar link appears under "Doplňky".');
