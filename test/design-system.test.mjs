// Guards the shared design-system components that addons build on (the
// promotion contract: repeatable UI renders + styles HOST-side, addons only
// consume). If a class or the icon facade disappears or loses a load-bearing
// property, every consuming addon regresses silently — these asserts are the
// tripwire. The addon repos' own tests assert only that their markup USES
// the classes; the guarantees behind the classes live here.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createMockHost } from '../web/js/addon-test-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('widgets.css: .codex-link-row is a comfortable whole-element target', () => {
  const css = read('web/css/widgets.css');
  const row = css.match(/\.codex-link-row\s*\{[^}]*\}/);
  assert.ok(row, '.codex-link-row exists');
  assert.match(row[0], /min-height:\s*2\.75rem/, '~44px target (WCAG 2.5.5)');
  assert.match(css, /\.codex-link-row:hover/, 'hover feedback');
  assert.match(css, /\.codex-link-row:focus-visible/, 'keyboard focus ring');
  assert.match(css, /\.codex-link-tile:hover/, 'tile hover feedback');
  assert.match(css, /\.codex-link-tile:focus-visible/, 'tile focus ring');
});

test('widgets.css: .codex-skel shimmer exists (reduced-motion handled globally)', () => {
  const css = read('web/css/widgets.css');
  assert.match(css, /\.codex-skel\s*\{/, 'skeleton block');
  assert.match(css, /@keyframes codex-shimmer/, 'shimmer sweep');
  const main = read('web/css/main.css');
  assert.match(main, /prefers-reduced-motion/, 'global reduced-motion block still present');
  assert.match(main, /animation-iteration-count:\s*1\s*!important/,
    'global block caps infinite animations (what turns the shimmer off)');
});

test('h.icon: the harness mirror emits host-shaped stat glyphs', () => {
  const { host } = createMockHost({ id: 'ds-test' });
  for (const name of ['heart', 'shield', 'bolt', 'chevrons', 'medal', 'plus-circle', 'eye']) {
    assert.match(host.h.icon(name), /^<svg class="codex-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">/, name);
  }
  assert.equal(host.h.icon('no-such-glyph'), '', 'unknown name → empty, callers pass through freely');
  assert.match(host.h.icon('shield', { label: 'Armor Class', size: 14 }),
    /width="14" height="14" role="img" aria-label="Armor Class"/, 'label + size opts');
});

test('widgets.css: chip + badge variants exist for the addon list/fact patterns', () => {
  const css = read('web/css/widgets.css');
  const chip = css.match(/\.codex-chip\s*\{[^}]*\}/);
  assert.ok(chip, '.codex-chip exists');
  assert.match(chip[0], /min-height:\s*2\.15rem/, 'comfortable chip height');
  assert.match(css, /\.codex-chip-danger/, 'danger variant');
  assert.match(css, /\.codex-badge\s*\{/, 'badge pill');
  assert.match(css, /\.codex-badge-accent/, 'accent badge variant');
});

test('the live facade and the harness mirror stay in sync (text tripwire)', () => {
  // addons.js + utils.js are browser modules (import Store/I18n) — not
  // importable headless — so pin the wiring at the source-text level.
  assert.match(read('web/js/addons.js'), /icon:\s*iconGlyph/, 'h.icon wired in the facade');
  const utils = read('web/js/utils.js');
  assert.match(utils, /export function iconGlyph/, 'utils.iconGlyph exported');
  for (const name of ['heart', 'shield', 'bolt', 'chevrons', "'plus-circle'", 'eye']) {
    assert.ok(utils.includes(name), `glyph ${name} in the live set`);
  }
  // Same glyph names in the harness mirror.
  const harness = read('web/js/addon-test-harness.mjs');
  for (const name of ['heart:', 'shield:', 'bolt:', 'chevrons:', "'plus-circle':", 'eye:']) {
    assert.ok(harness.includes(name), `glyph ${name} mirrored in the harness`);
  }
});
