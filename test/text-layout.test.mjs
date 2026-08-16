import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloudMapDetailLevel,
  cloudMapHiddenDetailKey,
  cloudMapTypographyScale,
} from '../web/js/cloudmap-detail.js';
import {
  CLOUDMAP_ZOOM_LEVELS,
  fittedCloudMapZoom,
  normalizeCloudMapZoom,
  stepCloudMapZoom,
} from '../web/js/cloudmap-zoom.js';
import {
  cloudMapTextMetrics,
  layoutCloudMapText,
} from '../web/js/cloudmap-text-style.js';

test('CloudMap separates continuous geometry from readable typography bands', () => {
  assert.deepEqual(
    [0.25, 0.449, 0.45, 0.599, 0.6, 0.999, 1, 2].map(cloudMapDetailLevel),
    ['overview', 'overview', 'compact', 'compact', 'condensed', 'condensed', 'full', 'full'],
  );
  assert.deepEqual(
    [0.35, 0.55, 0.8, 1].map(cloudMapHiddenDetailKey),
    [
      'cloudmap.hiddenDetails.overview',
      'cloudmap.hiddenDetails.compact',
      'cloudmap.hiddenDetails.condensed',
      '',
    ],
  );
  assert.deepEqual(
    [0.25, 0.9, 1, 1.24, 1.25, 1.99, 2].map(cloudMapTypographyScale),
    [1, 1, 1, 1, 1.25, 1.75, 2],
  );
  assert.deepEqual(cloudMapTextMetrics('name', 0.5, 148, 2), {
    role: 'name',
    fontSize: 13,
    font: '13px Cinzel, Georgia, serif',
    lineHeight: 16.25,
    letterSpacing: 0,
    maxLines: 2,
    maxWidth: 74,
    typeScale: 1,
  });
  assert.deepEqual(cloudMapTextMetrics('hub-name', 0.5, 170, 2), {
    role: 'hub-name',
    fontSize: 15,
    font: '15px Cinzel, Georgia, serif',
    lineHeight: 18.75,
    letterSpacing: 0,
    maxLines: 2,
    maxWidth: 85,
    typeScale: 1,
  });
});

test('CloudMap shares the planner zoom detents and fits down to a stable level', () => {
  assert.deepEqual(CLOUDMAP_ZOOM_LEVELS, [
    0.25, 0.35, 0.45, 0.55, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
  ]);
  assert.equal(Object.isFrozen(CLOUDMAP_ZOOM_LEVELS), true);
  assert.equal(normalizeCloudMapZoom(0.77), 0.8);
  assert.equal(stepCloudMapZoom(0.9, 1, 2), 1);
  assert.equal(stepCloudMapZoom(1.1, -1, 2), 1);
  assert.equal(stepCloudMapZoom(1, -1), 0.9);
  assert.equal(fittedCloudMapZoom(0.86, 1), 0.8);
  assert.equal(fittedCloudMapZoom(1.4, 0.8), 0.8);
  assert.equal(fittedCloudMapZoom(0.2, 0.8), 0.25);
  assert.equal(fittedCloudMapZoom(0.2, 0.8, 0.45), 0.45);
});

test('CloudMap card text materializes cached Pretext lines and clamps overflow', () => {
  const calls = [];
  const result = layoutCloudMapText('The road beyond the mountains', {
    role: 'name',
    zoom: 0.5,
    baseWidth: 148,
    maxLines: 2,
  }, (text, options) => {
    calls.push({ text, options });
    if (text.endsWith('…')) {
      return text.length <= 9
        ? { lines: [{ text }] }
        : { lines: [{ text: text.slice(0, 5) }, { text: text.slice(5) }] };
    }
    return { lines: [
      { text: 'The road' },
      { text: 'beyond the' },
      { text: 'mountains' },
    ] };
  });
  assert.equal(result.measured, true);
  assert.equal(result.lines.length, 2);
  assert.match(result.lines[1], /…$/);
  assert.equal(calls[0].options.font, '13px Cinzel, Georgia, serif');
  assert.equal(calls[0].options.maxWidth, 74);
});

test('text layout caches preparation and materializes Unicode-safe lines', async t => {
  const originalCanvas = globalThis.OffscreenCanvas;
  let measurements = 0;
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        font: '',
        measureText(value) {
          measurements += 1;
          return { width: [...String(value)].length * 10 };
        },
      };
    }
  };
  t.after(() => {
    if (originalCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = originalCanvas;
  });

  const { clearTextLayoutCache, layoutText } = await import('../web/js/text-layout.js');
  clearTextLayoutCache();
  const narrow = layoutText('alpha 春天 beta', {
    font: '16px Inter',
    maxWidth: 55,
    lineHeight: 20,
  });
  assert.ok(narrow.lineCount > 1);
  assert.equal(narrow.height, narrow.lineCount * 20);
  assert.equal(narrow.maxLineWidth, Math.max(...narrow.lines.map(line => line.width)));
  assert.equal(narrow.lines.map(line => line.text).join('').replaceAll(' ', ''), 'alpha春天beta');

  const preparedMeasurements = measurements;
  const wide = layoutText('alpha 春天 beta', {
    font: '16px Inter',
    maxWidth: 200,
    lineHeight: 20,
  });
  assert.equal(measurements, preparedMeasurements, 'changing only width reuses prepared measurements');
  assert.equal(wide.lineCount, 1);
  assert.equal(
    layoutText('alpha 春天 beta', { font: '16px Inter', maxWidth: 200, lineHeight: 20 }),
    wide,
    'identical layouts reuse the frozen result object',
  );
});

test('text layout invalidation is reasoned, locale-aware, and unsubscribable', async () => {
  const {
    clearTextLayoutCache,
    onTextLayoutInvalidated,
    setTextLayoutLocale,
  } = await import('../web/js/text-layout.js');
  const events = [];
  const off = onTextLayoutInvalidated(event => events.push(event));

  assert.equal(setTextLayoutLocale('cs'), true);
  assert.equal(setTextLayoutLocale('cs'), false);
  clearTextLayoutCache('fonts');
  off();
  clearTextLayoutCache('after-unsubscribe');
  setTextLayoutLocale('en');

  assert.deepEqual(events.map(event => event.reason), ['locale', 'fonts']);
  assert.equal(events[0].locale, 'cs');
  assert.ok(events[1].revision > events[0].revision);
  assert.throws(() => onTextLayoutInvalidated(null), /requires a function/);
});
