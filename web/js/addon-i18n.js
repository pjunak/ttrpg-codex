export const ADDON_I18N_CAPABILITY = 'i18n.catalogs';
export const ADDON_I18N_LIMITS = Object.freeze({
  locales: 20,
  bytesPerCatalog: 256 * 1024,
  keysPerCatalog: 2000,
  keyLength: 160,
  valueLength: 10000,
});

const LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const KEY_RE = /^[a-z0-9][a-zA-Z0-9_.-]*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const catalogCache = new Map();

const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeLocaleId(value) {
  if (typeof value !== 'string' || !LOCALE_RE.test(value)) return null;
  return value.toLowerCase();
}

export function validateLocaleDeclarations(raw, { apiVersion, capabilities } = {}) {
  const errors = [];
  const locales = {};
  if (raw === undefined) return { ok: true, errors, locales };
  if (apiVersion !== undefined && apiVersion !== 2) {
    errors.push('locales requires apiVersion 2');
  }
  const required = Array.isArray(capabilities?.required) ? capabilities.required : [];
  if (capabilities !== undefined && !required.includes(ADDON_I18N_CAPABILITY)) {
    errors.push(`locales requires capability "${ADDON_I18N_CAPABILITY}"`);
  }
  if (!isObject(raw)) {
    errors.push('locales must be an object mapping locale ids to catalog paths');
    return { ok: false, errors, locales };
  }
  const entries = Object.entries(raw);
  if (entries.length > ADDON_I18N_LIMITS.locales) {
    errors.push(`locales may declare at most ${ADDON_I18N_LIMITS.locales} catalogs`);
  }
  for (const [declaredId, path] of entries) {
    const locale = normalizeLocaleId(declaredId);
    if (!locale) {
      errors.push(`invalid locale id "${declaredId}"`);
      continue;
    }
    if (owns(locales, locale)) {
      errors.push(`duplicate locale declaration "${locale}"`);
      continue;
    }
    if (typeof path !== 'string' || !isSafeCatalogPath(path)) {
      errors.push(`locales.${declaredId} must be a relative .json path inside the addon`);
      continue;
    }
    locales[locale] = path;
  }
  if (!owns(locales, 'en')) errors.push('locales must declare the required English source catalog "en"');
  return { ok: errors.length === 0, errors, locales };
}

export function isSafeCatalogPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || !/\.json$/i.test(path)) return false;
  if (path.includes('?') || path.includes('#')) return false;
  const segments = path.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

export function extractPlaceholders(value) {
  const names = new Set();
  const source = String(value);
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '}') return { ok: false, names, error: 'unmatched "}"' };
    if (char !== '{') continue;
    const end = source.indexOf('}', index + 1);
    if (end < 0) return { ok: false, names, error: 'unmatched "{"' };
    const name = source.slice(index + 1, end);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.includes('{')) {
      return { ok: false, names, error: `malformed placeholder "{${name}}"` };
    }
    names.add(name);
    index = end;
  }
  return { ok: true, names };
}

function placeholderSignature(value) {
  const result = extractPlaceholders(value);
  return result.ok ? [...result.names].sort().join('\0') : null;
}

function validateString(value, label, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`);
    return;
  }
  if (value.length > ADDON_I18N_LIMITS.valueLength) {
    errors.push(`${label} exceeds ${ADDON_I18N_LIMITS.valueLength} characters`);
  }
  const placeholders = extractPlaceholders(value);
  if (!placeholders.ok) errors.push(`${label} has ${placeholders.error}`);
}

function validateEntry(value, label, errors) {
  if (typeof value === 'string') {
    validateString(value, label, errors);
    return;
  }
  if (!isObject(value)) {
    errors.push(`${label} must be a string or plural object`);
    return;
  }
  const categories = Object.keys(value);
  if (!categories.length || !categories.includes('other')) {
    errors.push(`${label} plural object must include "other"`);
  }
  for (const category of categories) {
    if (!PLURAL_CATEGORIES.has(category)) {
      errors.push(`${label} has invalid plural category "${category}"`);
      continue;
    }
    validateString(value[category], `${label}.${category}`, errors);
  }
}

function sourceTemplate(sourceEntry, category) {
  if (typeof sourceEntry === 'string') return sourceEntry;
  if (!isObject(sourceEntry)) return undefined;
  return sourceEntry[category] ?? sourceEntry.other;
}

function validateTranslationShape(key, entry, sourceEntry, errors) {
  const sourceIsPlural = isObject(sourceEntry);
  const entryIsPlural = isObject(entry);
  if (sourceIsPlural !== entryIsPlural) {
    errors.push(`catalog key "${key}" must use the same string/plural shape as English`);
    return;
  }
  const values = entryIsPlural ? Object.entries(entry) : [['value', entry]];
  for (const [category, value] of values) {
    if (typeof value !== 'string') continue;
    const expected = sourceTemplate(sourceEntry, category);
    if (typeof expected !== 'string') continue;
    const actualSignature = placeholderSignature(value);
    const expectedSignature = placeholderSignature(expected);
    if (actualSignature !== null && expectedSignature !== null && actualSignature !== expectedSignature) {
      errors.push(`catalog key "${key}"${entryIsPlural ? `.${category}` : ''} placeholders do not match English`);
    }
  }
}

export function validateCatalog(catalog, { locale = 'en', sourceCatalog } = {}) {
  const normalizedLocale = normalizeLocaleId(locale);
  const errors = [];
  if (!normalizedLocale) errors.push(`invalid locale id "${locale}"`);
  if (!isObject(catalog)) {
    return { ok: false, errors: [...errors, `catalog "${locale}" must be a flat JSON object`] };
  }
  const keys = Object.keys(catalog);
  if (keys.length > ADDON_I18N_LIMITS.keysPerCatalog) {
    errors.push(`catalog "${locale}" exceeds ${ADDON_I18N_LIMITS.keysPerCatalog} keys`);
  }
  for (const key of keys) {
    const segments = key.split('.');
    if (!KEY_RE.test(key)
        || key.length > ADDON_I18N_LIMITS.keyLength
        || segments.some(segment => !segment || FORBIDDEN_SEGMENTS.has(segment))) {
      errors.push(`catalog "${locale}" has invalid key "${key}"`);
      continue;
    }
    const entry = catalog[key];
    validateEntry(entry, `catalog "${locale}" key "${key}"`, errors);
    if (sourceCatalog && normalizedLocale !== 'en') {
      if (!owns(sourceCatalog, key)) errors.push(`catalog "${locale}" key "${key}" is missing from English`);
      else validateTranslationShape(key, entry, sourceCatalog[key], errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function parseCatalogText(text, { locale = 'en', sourceCatalog } = {}) {
  if (typeof text !== 'string') throw new Error(`catalog "${locale}" is not text`);
  const bytes = encoder ? encoder.encode(text).byteLength : text.length;
  if (bytes > ADDON_I18N_LIMITS.bytesPerCatalog) {
    throw new Error(`catalog "${locale}" exceeds ${ADDON_I18N_LIMITS.bytesPerCatalog} bytes`);
  }
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (error) {
    throw new Error(`catalog "${locale}" is not valid JSON: ${error.message}`);
  }
  const validation = validateCatalog(catalog, { locale, sourceCatalog });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return catalog;
}

export function validateCatalogPackage(declarations, catalogs, manifestMeta = {}) {
  const declarationResult = validateLocaleDeclarations(declarations, manifestMeta);
  const errors = declarationResult.errors.slice();
  const normalizedCatalogs = {};
  if (!declarationResult.ok) return { ok: false, errors, locales: declarationResult.locales, catalogs: normalizedCatalogs };
  const supplied = isObject(catalogs) ? catalogs : {};
  const english = supplied.en;
  const englishResult = validateCatalog(english, { locale: 'en' });
  if (!englishResult.ok) errors.push(...englishResult.errors);
  else normalizedCatalogs.en = english;
  for (const locale of Object.keys(declarationResult.locales)) {
    if (locale === 'en') continue;
    if (!owns(supplied, locale)) {
      errors.push(`catalog "${locale}" was declared but not supplied`);
      continue;
    }
    const result = validateCatalog(supplied[locale], { locale, sourceCatalog: englishResult.ok ? english : undefined });
    if (!result.ok) errors.push(...result.errors);
    else normalizedCatalogs[locale] = supplied[locale];
  }
  return {
    ok: errors.length === 0,
    errors,
    locales: declarationResult.locales,
    catalogs: normalizedCatalogs,
  };
}

function localeChain(value) {
  const locale = normalizeLocaleId(value) || 'en';
  const base = locale.split('-')[0];
  return [...new Set([locale, base, 'en'])];
}

function interpolate(value, params) {
  if (params == null) return String(value);
  return String(value).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) =>
    owns(params, key) ? String(params[key]) : match);
}

export function createScopedI18n({
  addonId,
  catalogs,
  getLocale = () => 'en',
  formatNumber,
  formatDate,
  relativeTime,
  onMissing = () => {},
} = {}) {
  const source = isObject(catalogs?.en) ? catalogs.en : {};
  const warned = new Set();
  const activeLocale = () => normalizeLocaleId(getLocale()) || 'en';
  const missing = key => {
    if (!warned.has(key)) {
      warned.add(key);
      onMissing({ addonId, key });
    }
    return String(key);
  };
  const lookup = key => {
    for (const locale of localeChain(activeLocale())) {
      const catalog = catalogs?.[locale];
      if (isObject(catalog) && owns(catalog, key)) return catalog[key];
    }
    return owns(source, key) ? source[key] : undefined;
  };
  const t = (key, params) => {
    let entry = lookup(String(key));
    if (entry === undefined) return missing(key);
    if (isObject(entry)) entry = entry.other;
    return typeof entry === 'string' ? interpolate(entry, params) : missing(key);
  };
  const plural = (key, n, params) => {
    const locale = activeLocale();
    let category = 'other';
    try { category = new Intl.PluralRules(locale).select(Math.abs(Number(n) || 0)); } catch (_) {}
    let template;
    for (const candidate of localeChain(locale)) {
      const entry = catalogs?.[candidate]?.[key];
      if (isObject(entry)) template = entry[category] ?? entry.other;
      else if (typeof entry === 'string') template = entry;
      if (typeof template === 'string') break;
    }
    if (typeof template !== 'string') return missing(key);
    return interpolate(template, { n, ...(params || {}) });
  };
  return Object.freeze({
    get locale() { return activeLocale(); },
    t,
    plural,
    formatNumber: (value, opts) => typeof formatNumber === 'function'
      ? formatNumber(value, opts)
      : new Intl.NumberFormat(activeLocale(), opts).format(value),
    formatDate: (value, opts) => typeof formatDate === 'function'
      ? formatDate(value, opts)
      : new Intl.DateTimeFormat(activeLocale(), opts).format(new Date(value)),
    relativeTime: (value, now) => typeof relativeTime === 'function'
      ? relativeTime(value, now)
      : String(value),
  });
}

function packageUrl(meta, path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `/addons/${encodeURIComponent(meta.id)}/${encodeURIComponent(meta.activeHash)}/${encodedPath}`;
}

async function fetchCatalog(meta, locale, path, fetchImpl, signal, sourceCatalog) {
  const revision = meta.activeHash || meta.contentRevision || '';
  const cacheKey = `${meta.id}\0${revision}\0${locale}\0${path}`;
  let pending = catalogCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const response = await fetchImpl(packageUrl(meta, path), {
        credentials: 'same-origin',
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseCatalogText(await response.text(), { locale, sourceCatalog });
    })();
    catalogCache.set(cacheKey, pending);
    pending.catch(() => {
      if (catalogCache.get(cacheKey) === pending) catalogCache.delete(cacheKey);
    });
  }
  return { cacheKey, catalog: await pending };
}

export async function loadAddonCatalogs(meta, {
  fetchImpl = (...args) => fetch(...args),
  isCurrent = () => true,
} = {}) {
  const declarationResult = validateLocaleDeclarations(meta.locales, meta);
  if (!declarationResult.ok) throw new Error(declarationResult.errors.join('; '));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const cacheKeys = new Set();
  const warnings = [];
  const dispose = () => {
    if (controller) controller.abort();
    for (const key of cacheKeys) catalogCache.delete(key);
    cacheKeys.clear();
  };
  try {
    const englishResult = await fetchCatalog(
      meta,
      'en',
      declarationResult.locales.en,
      fetchImpl,
      controller?.signal,
    );
    cacheKeys.add(englishResult.cacheKey);
    if (!isCurrent()) throw new Error('stale addon catalog response');
    const catalogs = { en: englishResult.catalog };
    for (const [locale, path] of Object.entries(declarationResult.locales)) {
      if (locale === 'en') continue;
      try {
        const result = await fetchCatalog(meta, locale, path, fetchImpl, controller?.signal, catalogs.en);
        cacheKeys.add(result.cacheKey);
        if (!isCurrent()) throw new Error('stale addon catalog response');
        catalogs[locale] = result.catalog;
      } catch (error) {
        if (!isCurrent() || error?.name === 'AbortError') throw error;
        warnings.push(`locale "${locale}" failed: ${error.message}`);
      }
    }
    if (!isCurrent()) throw new Error('stale addon catalog response');
    return { catalogs, warnings, dispose };
  } catch (error) {
    dispose();
    throw new Error(`localization package failed: ${error.message}`);
  }
}

export function clearAddonCatalogCache() {
  catalogCache.clear();
}
