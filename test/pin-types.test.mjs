import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PinTypes } from '../web/js/pin-types.js';
import { SETTINGS_DEFAULTS } from '../web/js/data.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => readFileSync(join(root, relativePath), 'utf8');

test('pin type defaults have one immutable source and mutable settings seeds', () => {
  assert.deepEqual(SETTINGS_DEFAULTS.pinTypes, PinTypes.defaults);
  assert.notEqual(SETTINGS_DEFAULTS.pinTypes, PinTypes.defaults);
  assert.ok(Object.isFrozen(PinTypes.defaults));
  assert.equal(new Set(PinTypes.defaults.map(item => item.id)).size, PinTypes.defaults.length);

  const seed = PinTypes.seed();
  seed[0].label = 'Campaign override';
  assert.notEqual(seed[0].label, PinTypes.defaults[0].label);
});

test('live custom pin types remain selectable and resolve their own presentation', () => {
  const live = [
    { id: 'custom-landmark', label: 'Custom landmark', icon: '🜁', size: 42 },
    { id: 'city', label: 'Renamed city', icon: '🏙', size: 36 },
  ];

  assert.deepEqual(PinTypes.choices(live).map(item => item.id), ['custom-landmark', 'city']);
  assert.equal(PinTypes.resolve(live, 'custom-landmark'), live[0]);
  assert.equal(PinTypes.resolve(live, 'city').label, 'Renamed city');
  assert.equal(PinTypes.choices(live, 'retired-type').at(-1).id, 'retired-type');
});

test('map and location editor build choices from the live settings enum', () => {
  const map = read('web/js/map.js');
  const templates = read('web/js/edit_templates.js');

  assert.match(map, /PinTypes\.choices\(_livePinTypes\(\), currentType\)/);
  assert.match(templates, /PinTypes\.choices\(livePinTypes, selectedPinType\)/);
  assert.doesNotMatch(map, /Object\.entries\(PIN_TYPES\)/);
  assert.doesNotMatch(templates, /Object\.entries\(PIN_TYPES\)/);
});
