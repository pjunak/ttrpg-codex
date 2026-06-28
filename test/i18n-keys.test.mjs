// Guards the i18n migration: every catalog key referenced by a LITERAL
// I18n.t('…') / I18n.plural('…') call in the browser sources — and every
// data-i18n / data-i18n-title attribute in index.html — must exist in
// en.json (the source catalog). Dynamic keys (I18n.t(variable),
// I18n.t('prefix'+x)) are intentionally NOT checked; the lookahead below
// skips concatenations so they don't false-positive.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import en from '../web/i18n/en.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const enKeys = new Set(Object.keys(en));

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...jsFiles(join(dir, e.name)));
    else if (e.name.endsWith('.js')) out.push(join(dir, e.name));
  }
  return out;
}

// Quote-delimited first arg of I18n.t/plural, only when it's a COMPLETE
// argument (followed by ',' or ')') — so `I18n.t('x.y' + n)` is skipped.
const KEY_RE = /I18n\.(?:t|plural)\(\s*(['"])([^'"]+)\1(?=\s*[,)])/g;
const DATA_RE = /data-i18n(?:-title)?="([^"]+)"/g;

test('every literal I18n.t/plural key in web/js exists in en.json', () => {
  const missing = [];
  for (const file of jsFiles(join(__dirname, '../web/js'))) {
    const src = readFileSync(file, 'utf8');
    let m;
    while ((m = KEY_RE.exec(src))) {
      if (!enKeys.has(m[2])) missing.push(`${file.split(/[\\/]/).pop()}: ${m[2]}`);
    }
  }
  assert.equal(missing.length, 0, `Missing catalog keys:\n  ${missing.join('\n  ')}`);
});

test('every data-i18n key in index.html exists in en.json', () => {
  const html = readFileSync(join(__dirname, '../web/index.html'), 'utf8');
  const missing = [];
  let m;
  while ((m = DATA_RE.exec(html))) {
    if (!enKeys.has(m[1])) missing.push(m[1]);
  }
  assert.equal(missing.length, 0, `Missing data-i18n keys: ${missing.join(', ')}`);
});
