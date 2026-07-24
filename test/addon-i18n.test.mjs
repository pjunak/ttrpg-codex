import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDON_I18N_LIMITS,
  clearAddonCatalogCache,
  createScopedI18n,
  loadAddonCatalogs,
  parseCatalogText,
  validateCatalog,
  validateCatalogPackage,
  validateLocaleDeclarations,
} from '../web/js/addon-i18n.js';
import {
  createMockHost,
  validateAddonCatalogs,
} from '../web/js/addon-test-harness.mjs';

const require = createRequire(import.meta.url);
const { validateLocalizationPackage } = require('../server/addon-localization.cjs');

const meta = (overrides = {}) => ({
  id: 'localized-addon',
  version: '1.0.0',
  apiVersion: 2,
  hostVersion: '>=1.0.0',
  capabilities: { required: ['i18n.catalogs'] },
  activeHash: '0123456789abcdef',
  locales: { en: 'locales/en.json' },
  ...overrides,
});

test('declarative locale map requires API v2, capability, safe JSON paths, and English', () => {
  assert.equal(validateLocaleDeclarations(meta().locales, meta()).ok, true);
  assert.match(validateLocaleDeclarations({ cs: 'locales/cs.json' }, meta()).errors.join('; '), /English/);
  assert.match(validateLocaleDeclarations({ en: '../en.json' }, meta()).errors.join('; '), /relative \.json path/);
  assert.match(validateLocaleDeclarations({ en: 'locales/en.js' }, meta()).errors.join('; '), /relative \.json path/);
  assert.match(validateLocaleDeclarations({ en: 'locales/en.json' }, { ...meta(), apiVersion: 1 }).errors.join('; '), /apiVersion 2/);
  assert.match(validateLocaleDeclarations({ en: 'locales/en.json' }, { ...meta(), capabilities: { required: [] } }).errors.join('; '), /i18n\.catalogs/);
  assert.match(validateLocaleDeclarations({ en: 'a.json', EN: 'b.json' }, meta()).errors.join('; '), /duplicate locale/);
  assert.match(validateLocaleDeclarations({ 'not_a_locale': 'a.json', en: 'b.json' }, meta()).errors.join('; '), /invalid locale/);
});

test('catalog validation accepts English-only and partial translations with matching placeholders', () => {
  const declarations = { en: 'locales/en.json', cs: 'locales/cs.json' };
  const catalogs = {
    en: {
      title: 'Title',
      greeting: 'Hello, {name}',
      count: { one: '{n} item', other: '{n} items' },
    },
    cs: {
      greeting: 'Ahoj, {name}',
      count: { one: '{n} položka', few: '{n} položky', other: '{n} položek' },
    },
  };
  const result = validateCatalogPackage(declarations, catalogs, { ...meta(), locales: declarations });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(validateAddonCatalogs({ ...meta(), locales: declarations }, catalogs).ok, true);
});

test('catalog validation rejects invalid JSON shape, keys, values, limits, and prototype names', () => {
  assert.throws(() => parseCatalogText('{', { locale: 'en' }), /valid JSON/);
  assert.equal(validateCatalog([], { locale: 'en' }).ok, false);
  assert.match(validateCatalog({ '__proto__.x': 'bad' }, { locale: 'en' }).errors.join('; '), /invalid key/);
  assert.match(validateCatalog({ 'constructor.x': 'bad' }, { locale: 'en' }).errors.join('; '), /invalid key/);
  assert.match(validateCatalog({ 'bad key': 'bad' }, { locale: 'en' }).errors.join('; '), /invalid key/);
  assert.match(validateCatalog({ 'bad..key': 'bad' }, { locale: 'en' }).errors.join('; '), /invalid key/);
  assert.match(validateCatalog({ good: 3 }, { locale: 'en' }).errors.join('; '), /string or plural object/);
  assert.match(validateCatalog({ good: { one: 'one' } }, { locale: 'en' }).errors.join('; '), /include "other"/);
  assert.match(validateCatalog({ good: { other: 'ok', bogus: 'bad' } }, { locale: 'en' }).errors.join('; '), /invalid plural category/);
  const tooMany = Object.fromEntries(Array.from(
    { length: ADDON_I18N_LIMITS.keysPerCatalog + 1 },
    (_, index) => [`key.${index}`, 'value'],
  ));
  assert.match(validateCatalog(tooMany, { locale: 'en' }).errors.join('; '), /exceeds .* keys/);
  assert.match(
    validateCatalog({ key: 'x'.repeat(ADDON_I18N_LIMITS.valueLength + 1) }, { locale: 'en' }).errors.join('; '),
    /exceeds .* characters/,
  );
  assert.throws(
    () => parseCatalogText(
      JSON.stringify({ key: 'x'.repeat(ADDON_I18N_LIMITS.bytesPerCatalog) }),
      { locale: 'en' },
    ),
    /bytes/,
  );
});

test('placeholder and source-key guards reject malformed or incompatible translations', () => {
  assert.match(validateCatalog({ key: 'Hello {name' }, { locale: 'en' }).errors.join('; '), /unmatched/);
  const sourceCatalog = {
    greeting: 'Hello {name}',
    count: { one: '{n} item', other: '{n} items' },
  };
  assert.match(
    validateCatalog({ greeting: 'Ahoj {person}' }, { locale: 'cs', sourceCatalog }).errors.join('; '),
    /placeholders do not match/,
  );
  assert.match(
    validateCatalog({ foreign: 'Cizí' }, { locale: 'cs', sourceCatalog }).errors.join('; '),
    /missing from English/,
  );
  assert.match(
    validateCatalog({ count: 'položky' }, { locale: 'cs', sourceCatalog }).errors.join('; '),
    /same string\/plural shape/,
  );
});

test('scoped lookup isolates namespaces, interpolates, pluralizes, and keeps HTML-like text plain', () => {
  let locale = 'cs-CZ';
  const missing = [];
  const first = createScopedI18n({
    addonId: 'first',
    catalogs: {
      en: { shared: 'First', hello: 'Hello {name}', html: '<img src=x onerror=alert(1)>', count: { one: '{n} item', other: '{n} items' } },
      cs: { shared: 'První', count: { one: '{n} položka', few: '{n} položky', other: '{n} položek' } },
    },
    getLocale: () => locale,
    onMissing: diagnostic => missing.push(diagnostic),
  });
  const second = createScopedI18n({
    addonId: 'second',
    catalogs: { en: { shared: 'Second', 'nav.characters': 'Local only' } },
    getLocale: () => locale,
  });
  assert.equal(first.t('shared'), 'První');
  assert.equal(second.t('shared'), 'Second');
  assert.equal(second.t('nav.characters'), 'Local only');
  assert.equal(first.t('hello', { name: 'Ada' }), 'Hello Ada');
  assert.equal(first.plural('count', 3), '3 položky');
  assert.equal(first.t('html'), '<img src=x onerror=alert(1)>');
  assert.equal(first.t('missing.key'), 'missing.key');
  assert.deepEqual(missing, [{ addonId: 'first', key: 'missing.key' }]);
  locale = 'en';
  assert.equal(first.t('shared'), 'First', 'runtime locale switches are observed without rebuilding the facade');
});

test('harness and live contract share scoped lookup behavior and formatters', () => {
  const manifest = meta({ locales: { en: 'locales/en.json', cs: 'locales/cs.json' } });
  const catalogs = {
    en: { hello: 'Hello {name}', count: { one: '{n} item', other: '{n} items' } },
    cs: { hello: 'Ahoj {name}', count: { one: '{n} položka', few: '{n} položky', other: '{n} položek' } },
  };
  const { host } = createMockHost(manifest, { locale: 'cs-CZ', catalogs });
  assert.equal(host.i18n.t('hello', { name: 'Eliška' }), 'Ahoj Eliška');
  assert.equal(host.i18n.plural('count', 4), '4 položky');
  assert.equal(host.i18n.locale, 'cs-cz');
  assert.equal(typeof host.i18n.formatNumber(1234), 'string');
  assert.throws(() => createMockHost(manifest, { locale: 'en' }), /English|flat JSON object/);
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test('runtime loader caches by package revision and clears on disposal/update', async () => {
  clearAddonCatalogCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return response(200, '{"title":"Title"}');
  };
  const first = await loadAddonCatalogs(meta(), { fetchImpl });
  const same = await loadAddonCatalogs(meta(), { fetchImpl });
  assert.equal(calls, 1);
  same.dispose();
  await loadAddonCatalogs(meta({ activeHash: 'fedcba9876543210' }), { fetchImpl });
  assert.equal(calls, 2);
  first.dispose();
});

test('runtime loader blocks broken English, isolates optional locale failures, and rejects stale responses', async () => {
  clearAddonCatalogCache();
  await assert.rejects(
    loadAddonCatalogs(meta(), { fetchImpl: async () => response(404, '') }),
    /localization package failed.*HTTP 404/,
  );
  const healthy = await loadAddonCatalogs(meta({ id: 'healthy-addon' }), {
    fetchImpl: async () => response(200, '{"title":"Healthy"}'),
  });
  assert.equal(healthy.catalogs.en.title, 'Healthy', 'a broken addon does not poison another namespace');
  healthy.dispose();

  const partialMeta = meta({ locales: { en: 'locales/en.json', cs: 'locales/cs.json' } });
  const partial = await loadAddonCatalogs(partialMeta, {
    fetchImpl: async url => url.endsWith('/en.json')
      ? response(200, '{"title":"Title"}')
      : response(500, ''),
  });
  assert.equal(partial.catalogs.en.title, 'Title');
  assert.equal(partial.catalogs.cs, undefined);
  assert.match(partial.warnings.join('; '), /locale "cs" failed/);
  partial.dispose();

  let current = true;
  await assert.rejects(
    loadAddonCatalogs(meta({ activeHash: 'stale00000000000' }), {
      fetchImpl: async () => {
        current = false;
        return response(200, '{"title":"Old"}');
      },
      isCurrent: () => current,
    }),
    /stale addon catalog response/,
  );
});

test('installation validator reads only declared package JSON files and enforces source validity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-addon-i18n-'));
  try {
    await mkdir(path.join(root, 'locales'));
    await writeFile(path.join(root, 'locales', 'en.json'), '{"hello":"Hello {name}"}');
    await writeFile(path.join(root, 'locales', 'cs.json'), '{"hello":"Ahoj {name}"}');
    const manifest = meta({ locales: { en: 'locales/en.json', cs: 'locales/cs.json' } });
    const result = await validateLocalizationPackage(root, manifest);
    assert.equal(result.catalogs.cs.hello, 'Ahoj {name}');
    await assert.rejects(
      validateLocalizationPackage(root, manifest, {
        fileSystem: {
          lstat: async () => ({
            isSymbolicLink: () => true,
            isFile: () => true,
          }),
          readFile: async () => '{"hello":"Hello {name}"}',
        },
      }),
      /not a regular file/,
    );
    await writeFile(path.join(root, 'locales', 'en.json'), '{"hello":3}');
    await assert.rejects(validateLocalizationPackage(root, manifest), /string or plural object/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
