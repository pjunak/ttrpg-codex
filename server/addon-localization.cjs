'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function validateLocalizationPackage(rootDir, manifest, { fileSystem = fsp } = {}) {
  if (manifest.locales === undefined) return { locales: null, catalogs: null };
  const contract = await import('../web/js/addon-i18n.js');
  const declaration = contract.validateLocaleDeclarations(manifest.locales, manifest);
  if (!declaration.ok) throw new Error(declaration.errors.join('; '));

  const root = path.resolve(rootDir);
  const readCatalog = async (locale, rel, sourceCatalog) => {
    const absolute = path.resolve(root, ...rel.split('/'));
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`catalog "${locale}" path escapes the addon package`);
    }
    let stat;
    try {
      stat = typeof fileSystem.lstat === 'function'
        ? await fileSystem.lstat(absolute)
        : await fileSystem.stat(absolute);
    } catch (_) {
      throw new Error(`catalog "${locale}" is missing at ${rel}`);
    }
    if ((typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) || !stat.isFile()) {
      throw new Error(`catalog "${locale}" is not a regular file at ${rel}`);
    }
    if (stat.size > contract.ADDON_I18N_LIMITS.bytesPerCatalog) {
      throw new Error(`catalog "${locale}" exceeds ${contract.ADDON_I18N_LIMITS.bytesPerCatalog} bytes`);
    }
    const text = await fileSystem.readFile(absolute, 'utf8');
    return contract.parseCatalogText(text, { locale, sourceCatalog });
  };

  const catalogs = {};
  catalogs.en = await readCatalog('en', declaration.locales.en);
  for (const [locale, rel] of Object.entries(declaration.locales)) {
    if (locale !== 'en') catalogs[locale] = await readCatalog(locale, rel, catalogs.en);
  }
  return { locales: declaration.locales, catalogs };
}

module.exports = { validateLocalizationPackage };
