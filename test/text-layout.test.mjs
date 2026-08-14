import assert from 'node:assert/strict';
import test from 'node:test';

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
});
