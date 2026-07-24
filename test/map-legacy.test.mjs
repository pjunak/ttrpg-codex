import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(root, rel), 'utf8');

test('world map: browser persistence cannot shadow the server-hosted image', () => {
  const map = read('web/js/map.js');
  const settings = read('web/js/settings.js');

  for (const source of [map, settings]) {
    assert.doesNotMatch(source, /world_map_image_url/);
    assert.doesNotMatch(source, /\bFileReader\b|readAsDataURL/);
  }
  assert.match(map, /const DEFAULT_IMG = '\/maps\/swordcoast\/sword_coast\.jpg'/);
  assert.match(map, /function _getImgUrl\(\) \{\s*return DEFAULT_IMG;\s*\}/);
});

test('world map: settings keeps the authenticated server upload as the only image-change path', () => {
  const settings = read('web/js/settings.js');
  const upload = settings.match(/function uploadWorldMap\(input\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(upload, /fd\.append\('worldmap', file\)/);
  assert.match(upload, /fetch\('\/api\/worldmap', \{ method: 'POST'/);
  assert.match(upload, /\.then\(\(\) => \{\s*_bumpPreviewBust\('world'\)/);
  assert.match(upload, /\.catch\(\(\) => _flash\(I18n\.t\('settings\.uploadFailed'\), false\)\)/);
  assert.equal((upload.match(/_bumpPreviewBust\('world'\)/g) || []).length, 1);
});

test('world map: navigation and rerenders invalidate map work through the generation controller', () => {
  const map = read('web/js/map.js');
  const app = read('web/js/app.js');

  assert.match(map, /createMapGenerationController\(\)/);
  assert.match(map, /function teardown\(\)/);
  assert.match(map, /_mapGeneration\.begin\(container\)/);
  assert.match(map, /_isCurrentGeneration\(token, container\)/);
  assert.doesNotMatch(map, /\bsetTimeout\s*\(/);
  assert.match(map, /_pendingPinId = null/);
  assert.match(map, /_pendingEventPinId = null/);
  assert.match(app, /if \(!isWorldMapRoute\) WorldMap\.teardown\(\)/);
});
