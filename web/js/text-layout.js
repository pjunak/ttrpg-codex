import {
  clearCache as clearPretextCache,
  layoutWithLines,
  prepareWithSegments,
} from './vendor/pretext/layout.js';

const MAX_PREPARED_TEXTS = 512;
const preparedTexts = new Map();

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function preparedText(text, font, options) {
  const key = JSON.stringify([
    text,
    font,
    options.whiteSpace,
    options.wordBreak,
    options.letterSpacing,
  ]);
  const cached = preparedTexts.get(key);
  if (cached) {
    preparedTexts.delete(key);
    preparedTexts.set(key, cached);
    return cached;
  }
  const prepared = prepareWithSegments(text, font, options);
  preparedTexts.set(key, prepared);
  if (preparedTexts.size > MAX_PREPARED_TEXTS) {
    preparedTexts.delete(preparedTexts.keys().next().value);
  }
  return prepared;
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
  const result = layoutWithLines(
    preparedText(value, normalizedFont, options),
    width,
    normalizedLineHeight,
  );
  const lines = result.lines.map(line => Object.freeze({
    text: line.text,
    width: line.width,
  }));
  return Object.freeze({
    lineCount: result.lineCount,
    height: result.height,
    maxLineWidth: lines.reduce((largest, line) => Math.max(largest, line.width), 0),
    lines: Object.freeze(lines),
  });
}

export function clearTextLayoutCache() {
  preparedTexts.clear();
  clearPretextCache();
}

if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', clearTextLayoutCache);
}
