import {
  clearCache as clearPretextCache,
  layoutWithLines,
  prepareWithSegments,
  setLocale as setPretextLocale,
} from './vendor/pretext/layout.js';

const MAX_PREPARED_TEXTS = 512;
const MAX_LAYOUT_RESULTS = 1024;
const preparedTexts = new Map();
const layoutResults = new Map();
const invalidationListeners = new Set();
let activeLocale = '';
let revision = 0;

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function preparedTextKey(text, font, options) {
  return JSON.stringify([
    text,
    font,
    options.whiteSpace,
    options.wordBreak,
    options.letterSpacing,
  ]);
}

function lruValue(cache, key) {
  const cached = cache.get(key);
  if (cached === undefined) return undefined;
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function remember(cache, key, value, limit) {
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

function preparedText(key, text, font, options) {
  const cached = lruValue(preparedTexts, key);
  if (cached !== undefined) return cached;
  const prepared = prepareWithSegments(text, font, options);
  return remember(preparedTexts, key, prepared, MAX_PREPARED_TEXTS);
}

function notifyInvalidation(reason) {
  const event = Object.freeze({ reason, revision: ++revision, locale: activeLocale });
  for (const listener of [...invalidationListeners]) {
    try { listener(event); }
    catch (error) { console.error('[text-layout] invalidation listener failed', error); }
  }
  return event;
}

/**
 * Measure and line-break plain text without forcing DOM layout.
 * Callers own rendering and must use the returned line strings verbatim when
 * measured geometry must exactly match visible wrapping.
 */
export function layoutText(text, {
  font = '16px serif',
  maxWidth,
  lineHeight,
  letterSpacing = 0,
  whiteSpace = 'normal',
  wordBreak = 'normal',
} = {}) {
  const value = String(text ?? '');
  const normalizedFont = String(font || '').trim();
  const width = finitePositive(maxWidth, NaN);
  if (!normalizedFont) throw new TypeError('layoutText requires a non-empty font');
  if (!Number.isFinite(width)) throw new TypeError('layoutText requires a positive maxWidth');
  const normalizedLineHeight = finitePositive(lineHeight, 1);
  const normalizedLetterSpacing = Number.isFinite(Number(letterSpacing))
    ? Number(letterSpacing)
    : 0;
  const options = {
    whiteSpace: whiteSpace === 'pre-wrap' ? 'pre-wrap' : 'normal',
    wordBreak: wordBreak === 'keep-all' ? 'keep-all' : 'normal',
    letterSpacing: normalizedLetterSpacing,
  };
  const preparedKey = preparedTextKey(value, normalizedFont, options);
  const resultKey = JSON.stringify([preparedKey, width, normalizedLineHeight]);
  const cached = lruValue(layoutResults, resultKey);
  if (cached !== undefined) return cached;
  const result = layoutWithLines(
    preparedText(preparedKey, value, normalizedFont, options),
    width,
    normalizedLineHeight,
  );
  const lines = result.lines.map(line => Object.freeze({
    text: line.text,
    width: line.width,
  }));
  return remember(layoutResults, resultKey, Object.freeze({
    lineCount: result.lineCount,
    height: result.height,
    maxLineWidth: lines.reduce((largest, line) => Math.max(largest, line.width), 0),
    lines: Object.freeze(lines),
  }), MAX_LAYOUT_RESULTS);
}

export function clearTextLayoutCache(reason = 'manual') {
  preparedTexts.clear();
  layoutResults.clear();
  clearPretextCache();
  return notifyInvalidation(String(reason || 'manual'));
}

export function setTextLayoutLocale(locale) {
  const next = typeof locale === 'string' ? locale.trim() : '';
  if (next === activeLocale) return false;
  activeLocale = next;
  preparedTexts.clear();
  layoutResults.clear();
  setPretextLocale(next || undefined);
  notifyInvalidation('locale');
  return true;
}

export function onTextLayoutInvalidated(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('onTextLayoutInvalidated requires a function');
  }
  invalidationListeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    invalidationListeners.delete(listener);
  };
}

if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => clearTextLayoutCache('fonts'));
}
