// CloudMap measures in zoom-1 graph coordinates. These descriptors must mirror
// the corresponding CSS, including fallbacks and spacing, so edge gaps and
// pre-layout card heights agree with the text the browser eventually paints.
import { cloudMapTypographyScale } from './cloudmap-detail.js';

export const CLOUDMAP_FACT_FONT = '11px Lora, Georgia, serif';
export const CLOUDMAP_EDGE_LABEL_FONT = '12px Inter, "Helvetica Neue", sans-serif';
export const CLOUDMAP_EDGE_LABEL_LETTER_SPACING = 0.24;

const WIDTH_STEP = 0.5;
const TEXT_ROLES = Object.freeze({
  strip: Object.freeze({ size: 9, family: 'Inter, "Helvetica Neue", sans-serif', lineHeight: 1.25, letterSpacing: 0.54 }),
  name: Object.freeze({ size: 13, family: 'Cinzel, Georgia, serif', lineHeight: 1.25, letterSpacing: 0 }),
  'hub-name': Object.freeze({ size: 15, family: 'Cinzel, Georgia, serif', lineHeight: 1.25, letterSpacing: 0 }),
  fact: Object.freeze({ size: 11, family: 'Lora, Georgia, serif', lineHeight: 1.4, letterSpacing: 0 }),
  dim: Object.freeze({ size: 10.5, family: 'Lora, Georgia, serif', lineHeight: 1.4, letterSpacing: 0 }),
  hint: Object.freeze({ size: 10.5, family: 'Lora, Georgia, serif', lineHeight: 1.4, letterSpacing: 0, style: 'italic' }),
  priority: Object.freeze({ size: 10, family: 'Lora, Georgia, serif', lineHeight: 1.4, letterSpacing: 0 }),
});

function widthBucket(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return WIDTH_STEP;
  return Math.max(WIDTH_STEP, Math.round(numeric / WIDTH_STEP) * WIDTH_STEP);
}

export function cloudMapTextMetrics(role, zoom, baseWidth, maxLines = 2) {
  const descriptor = TEXT_ROLES[role];
  if (!descriptor) throw new TypeError(`Unknown CloudMap text role: ${role}`);
  const numericZoom = Number(zoom);
  const geometryZoom = Number.isFinite(numericZoom) && numericZoom > 0 ? numericZoom : 1;
  const typeScale = cloudMapTypographyScale(geometryZoom);
  const fontSize = descriptor.size * typeScale;
  const stylePrefix = descriptor.style ? `${descriptor.style} ` : '';
  return Object.freeze({
    role,
    fontSize,
    font: `${stylePrefix}${fontSize}px ${descriptor.family}`,
    lineHeight: fontSize * descriptor.lineHeight,
    letterSpacing: descriptor.letterSpacing * typeScale,
    maxLines: Math.max(1, Math.trunc(Number(maxLines) || 1)),
    maxWidth: widthBucket(Number(baseWidth) * geometryZoom),
    typeScale,
  });
}

function optionsFor(metrics) {
  return {
    font: metrics.font,
    maxWidth: metrics.maxWidth,
    lineHeight: metrics.lineHeight,
    letterSpacing: metrics.letterSpacing,
  };
}

function measuredLines(text, metrics, layoutText) {
  try {
    const result = layoutText(text, optionsFor(metrics));
    return (result?.lines || []).map(line => String(line?.text ?? '')).filter(Boolean);
  } catch {
    return null;
  }
}

function ellipsizedLine(text, metrics, layoutText) {
  const suffix = '…';
  const characters = Array.from(String(text || '').trimEnd());
  const fits = candidate => {
    const lines = measuredLines(candidate, metrics, layoutText);
    return lines?.length === 1 && lines[0] === candidate;
  };
  if (fits(`${characters.join('')}${suffix}`)) return `${characters.join('')}${suffix}`;
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(`${characters.slice(0, middle).join('').trimEnd()}${suffix}`)) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join('').trimEnd()}${suffix}`;
}

export function layoutCloudMapText(text, {
  role,
  zoom = 1,
  baseWidth,
  maxLines = 2,
} = {}, layoutText) {
  const value = String(text ?? '');
  const metrics = cloudMapTextMetrics(role, zoom, baseWidth, maxLines);
  const key = JSON.stringify([
    value,
    role,
    metrics.maxWidth,
    metrics.fontSize,
    metrics.letterSpacing,
    metrics.maxLines,
  ]);
  if (!value) return { key, lines: [], measured: true, metrics };
  if (typeof layoutText !== 'function') return { key, lines: [value], measured: false, metrics };
  const allLines = measuredLines(value, metrics, layoutText);
  if (!allLines) return { key, lines: [value], measured: false, metrics };
  const lines = allLines.slice(0, metrics.maxLines);
  if (allLines.length > metrics.maxLines) {
    lines[lines.length - 1] = ellipsizedLine(lines[lines.length - 1], metrics, layoutText);
  }
  return { key, lines, measured: true, metrics };
}
