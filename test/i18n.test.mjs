// Tests for the i18n engine (web/js/i18n.js). The module is import-safe
// (no DOM / navigator / fetch at load), and `register()` injects catalogs
// so these run headless with no server. Catalog files are imported
// directly to drive the parity check.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { I18n } from '../web/js/i18n.js';
import en from '../web/i18n/en.json' with { type: 'json' };
import cs from '../web/i18n/cs.json' with { type: 'json' };

// Inject catalogs (no fetch). English carries one exclusive key so the
// active→English fallback path is observable.
I18n.register('en', { ...en, 'test.enOnly': 'EnglishOnly' });
I18n.register('cs', cs);

test('detectLocale: primary-subtag match against browser languages', () => {
  assert.equal(I18n.detectLocale(['cs-CZ', 'en'], null), 'cs');
  assert.equal(I18n.detectLocale(['en-US'], null),       'en');
});

test('detectLocale: falls back to English when nothing matches', () => {
  assert.equal(I18n.detectLocale(['fr-FR', 'de'], null), 'en');
  assert.equal(I18n.detectLocale([], null),              'en');
  assert.equal(I18n.detectLocale(undefined, null) !== '', true); // never empty
});

test('detectLocale: an explicit stored choice overrides the browser', () => {
  assert.equal(I18n.detectLocale(['en'], 'cs'), 'cs');
  // An unavailable stored value is ignored, detection continues.
  assert.equal(I18n.detectLocale(['en'], 'de'), 'en');
});

test('t(): returns the active-locale string', async () => {
  await I18n.setLocale('cs');
  assert.equal(I18n.getLocale(), 'cs');
  assert.equal(I18n.t('nav.characters'), 'Postavy');
  assert.equal(I18n.t('nav.map'),        'Mapa');
});

test('t(): falls back to English, then to the key itself', async () => {
  await I18n.setLocale('cs');
  // Present only in English → English value.
  assert.equal(I18n.t('test.enOnly'), 'EnglishOnly');
  // Present in neither → the key verbatim (never blank, never throws).
  assert.equal(I18n.t('totally.missing.key'), 'totally.missing.key');
});

test('t(): interpolates {placeholders}; leaves unknown ones intact', async () => {
  await I18n.setLocale('cs');
  assert.equal(I18n.t('cloudmap.underCommand', { name: 'Frulam' }), 'Pod velením: Frulam');
  assert.equal(I18n.t('cloudmap.underCommand'),                     'Pod velením: {name}');
});

test('plural(): Czech one/few/other via Intl.PluralRules', async () => {
  await I18n.setLocale('cs');
  // Pin the CLDR contract the catalog relies on.
  const cz = new Intl.PluralRules('cs');
  assert.equal(cz.select(1), 'one');
  assert.equal(cz.select(3), 'few');
  assert.equal(cz.select(8), 'other');

  assert.equal(I18n.plural('pets.count', 1), '1 mazlíček');
  assert.equal(I18n.plural('pets.count', 3), '3 mazlíčci');
  assert.equal(I18n.plural('pets.count', 8), '8 mazlíčků');
  assert.equal(I18n.plural('pets.count', 0), '0 mazlíčků');
});

test('plural(): English one/other', async () => {
  await I18n.setLocale('en');
  assert.equal(I18n.plural('pets.count', 1), '1 pet');
  assert.equal(I18n.plural('pets.count', 2), '2 pets');
  assert.equal(I18n.plural('pets.count', 0), '0 pets');
});

test('catalog parity: cs covers every en key, with Czech plural buckets', () => {
  for (const k of Object.keys(en)) {
    assert.ok(k in cs, `cs.json is missing key "${k}"`);
    if (en[k] && typeof en[k] === 'object') {
      assert.equal(typeof cs[k], 'object', `cs["${k}"] must be a plural object`);
      // Czech integers need one/few/other; many covers decimals.
      for (const bucket of ['one', 'few', 'other']) {
        assert.ok(bucket in cs[k], `cs["${k}"] needs the "${bucket}" form`);
      }
    }
  }
});

test('relativeTime(): locale-aware, with empty-input guards', async () => {
  await I18n.setLocale('en');
  const en1h = I18n.relativeTime(Date.now() - 3600_000);
  assert.ok(en1h.length > 0 && /\d/.test(en1h), `expected a numeric relative time, got "${en1h}"`);
  assert.equal(I18n.relativeTime(Date.now() - 1000), I18n.t('time.now')); // < 45s

  await I18n.setLocale('cs');
  const cs1h = I18n.relativeTime(Date.now() - 3600_000);
  assert.ok(cs1h.length > 0, 'cs relative time should be non-empty');

  assert.equal(I18n.relativeTime(0),    '');
  assert.equal(I18n.relativeTime(NaN),  '');
  assert.equal(I18n.relativeTime(null), '');
});

test('availableLocales(): returns the registry with endonyms', () => {
  const locs = I18n.availableLocales();
  assert.deepEqual(locs.map(l => l.id), ['en', 'cs']);
  assert.equal(locs.find(l => l.id === 'cs').endonym, 'Čeština');
});
