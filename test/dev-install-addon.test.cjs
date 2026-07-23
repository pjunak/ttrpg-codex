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
    capabilities: { required: ['lifecycle.dispose', 'content.revision'] },
    entry: 'entry.js',
    contentDir: 'data',
    contentGroups: { field: 'book', label: 'Books' },
    permissions: [],
  };

  const install = () => {
    const result = spawnSync(process.execPath, [SCRIPT, addonDir, dataDir], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };

  try {
    await fsp.writeFile(path.join(addonDir, 'addon.json'), JSON.stringify(manifest, null, 2));
    await fsp.writeFile(path.join(addonDir, 'entry.js'), 'export default function register() {}\n');
    await fsp.mkdir(path.join(addonDir, 'data'));
    install();

    let registry = JSON.parse(await fsp.readFile(path.join(dataDir, 'addons.json'), 'utf8'));
    let entry = registry.addons[0];
    assert.deepEqual(entry.capabilities, manifest.capabilities);
    assert.deepEqual(entry.contentGroups, manifest.contentGroups);
    assert.deepEqual(entry.disabledContentGroups, []);
    assert.deepEqual(entry.versions[0].capabilities, manifest.capabilities);
    assert.deepEqual(entry.versions[0].contentGroups, manifest.contentGroups);

    entry.disabledContentGroups = ['mm'];
    await fsp.writeFile(path.join(dataDir, 'addons.json'), JSON.stringify(registry, null, 2));
    manifest.version = '1.0.1';
    manifest.hostVersion = '^1.0.0';
    await fsp.writeFile(path.join(addonDir, 'addon.json'), JSON.stringify(manifest, null, 2));
    install();

    registry = JSON.parse(await fsp.readFile(path.join(dataDir, 'addons.json'), 'utf8'));
    entry = registry.addons[0];
    assert.equal(entry.hostVersion, '^1.0.0');
    assert.deepEqual(entry.disabledContentGroups, ['mm'], 'developer reinstall preserves the DM content policy');
    const activeVersion = entry.versions.find(version => version.contentHash === entry.activeHash);
    assert.deepEqual(activeVersion.capabilities, manifest.capabilities);
    assert.deepEqual(activeVersion.contentGroups, manifest.contentGroups);
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
