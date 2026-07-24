'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dev-install-addon.cjs');

test('dev install preserves API-v2 capability and content lifecycle metadata', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-dev-install-'));
  const addonDir = path.join(root, 'addon');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(addonDir, { recursive: true });

  const manifest = {
    id: 'content-fixture',
    name: 'Content Fixture',
    version: '1.0.0',
    apiVersion: 2,
    hostVersion: '>=1.0.0',
    capabilities: { required: ['collections.dm', 'lifecycle.dispose', 'content.revision', 'i18n.catalogs'] },
    entry: 'entry.js',
    locales: { en: 'locales/en.json' },
    collections: [{ name: 'scenarios', access: 'dm' }],
    contentDir: 'data',
    contentGroups: { field: 'book', label: 'Books' },
    permissions: [],
  };

  const runInstall = () => spawnSync(process.execPath, [SCRIPT, addonDir, dataDir], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
  const install = () => {
    const result = runInstall();
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };

  try {
    await fsp.writeFile(path.join(addonDir, 'addon.json'), JSON.stringify(manifest, null, 2));
    await fsp.writeFile(path.join(addonDir, 'entry.js'), 'export default function register() {}\n');
    await fsp.mkdir(path.join(addonDir, 'data'));
    await fsp.mkdir(path.join(addonDir, 'locales'));
    await fsp.writeFile(path.join(addonDir, 'locales', 'en.json'), '{"page.title":"Fixture"}\n');
    install();

    let registry = JSON.parse(await fsp.readFile(path.join(dataDir, 'addons.json'), 'utf8'));
    let entry = registry.addons[0];
    assert.deepEqual(entry.capabilities, manifest.capabilities);
    assert.deepEqual(entry.collections, [{ name: 'scenarios', keyed: false, access: 'dm' }]);
    assert.deepEqual(entry.contentGroups, manifest.contentGroups);
    assert.deepEqual(entry.locales, manifest.locales);
    assert.deepEqual(entry.disabledContentGroups, []);
    assert.deepEqual(entry.versions[0].capabilities, manifest.capabilities);
    assert.deepEqual(entry.versions[0].collections, entry.collections);
    assert.deepEqual(entry.versions[0].contentGroups, manifest.contentGroups);
    assert.deepEqual(entry.versions[0].locales, manifest.locales);

    entry.disabledContentGroups = ['mm'];
    await fsp.writeFile(path.join(dataDir, 'addons.json'), JSON.stringify(registry, null, 2));
    const scenariosPath = path.join(dataDir, 'addon-data', manifest.id, 'scenarios.json');
    await fsp.mkdir(path.dirname(scenariosPath), { recursive: true });
    await fsp.writeFile(scenariosPath, JSON.stringify([{ id: 'preserved-secret' }]));
    manifest.version = '1.0.1';
    manifest.hostVersion = '^1.0.0';
    await fsp.writeFile(path.join(addonDir, 'addon.json'), JSON.stringify(manifest, null, 2));
    install();

    registry = JSON.parse(await fsp.readFile(path.join(dataDir, 'addons.json'), 'utf8'));
    entry = registry.addons[0];
    assert.equal(entry.hostVersion, '^1.0.0');
    assert.deepEqual(entry.disabledContentGroups, ['mm'], 'developer reinstall preserves the DM content policy');
    assert.deepEqual(entry.collections, [{ name: 'scenarios', keyed: false, access: 'dm' }]);
    assert.deepEqual(
      JSON.parse(await fsp.readFile(scenariosPath, 'utf8')),
      [{ id: 'preserved-secret' }],
      'developer update preserves DM-only collection data',
    );
    const activeVersion = entry.versions.find(version => version.contentHash === entry.activeHash);
    assert.deepEqual(activeVersion.capabilities, manifest.capabilities);
    assert.deepEqual(activeVersion.contentGroups, manifest.contentGroups);
    assert.deepEqual(activeVersion.locales, manifest.locales);

    manifest.version = '1.0.2';
    await fsp.writeFile(path.join(addonDir, 'addon.json'), JSON.stringify(manifest, null, 2));
    await fsp.writeFile(path.join(addonDir, 'locales', 'en.json'), '{"page.title":3}\n');
    const rejected = runInstall();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /invalid localization package.*string or plural object/s);
    registry = JSON.parse(await fsp.readFile(path.join(dataDir, 'addons.json'), 'utf8'));
    assert.equal(registry.addons[0].version, '1.0.1', 'invalid catalogs never replace the active version');
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
