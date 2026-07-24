import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(root, rel), 'utf8');

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:html|js|mjs|cjs|css|md)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('UI residue: obsolete dashboard title selectors have no core or example consumers', () => {
  const files = [
    ...sourceFiles(join(root, 'web')),
    ...sourceFiles(join(root, 'examples')),
  ];
  const hits = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (/dashboard-(?:title|subtitle)/.test(source)) hits.push(file);
  }
  assert.deepEqual(hits, []);
});

test('remote and reconnect banners use the tokenized app-banner component without a second live region', () => {
  const app = read('web/js/app.js');
  const css = read('web/css/widgets.css');
  const remote = app.match(/function _showRemoteBanner\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const server = app.match(/function _showServerBanner\(msg\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const component = css.match(/\.app-banner\s*\{[^}]*\}/)?.[0] || '';

  assert.match(remote, /banner\.className = 'app-banner'/);
  assert.match(remote, /class="inline-create-btn"/);
  assert.match(remote, /esc\(I18n\.t\('app\.remoteChanged'\)\)/);
  assert.doesNotMatch(remote, /style=|style\.cssText|aria-live|role="status"/);
  assert.match(server, /banner\.className = "app-banner app-banner-error"/);
  assert.doesNotMatch(server, /style=|style\.cssText/);

  for (const token of [
    '--z-toast',
    '--space-2',
    '--space-3',
    '--space-4',
    '--bg-raised',
    '--text-cream',
    '--font-ui',
    '--text-sm',
    '--shadow-md',
  ]) {
    assert.ok(component.includes(`var(${token})`), `${token} used`);
  }
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}|rgba?\(|\b\d+(?:\.\d+)?(?:px|rem)\b/i);
  assert.doesNotMatch(component, /z-index:\s*\d/);
});
