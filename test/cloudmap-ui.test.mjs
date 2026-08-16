import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../web/js/cloudmap.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../web/css/cloudmap.css', import.meta.url), 'utf8');

test('Mind Palace is a read-only projection with planner-style zoom controls', () => {
  assert.match(source, /autoungrabify:\s+true/);
  assert.match(source, /CloudMap\.zoomOut/);
  assert.match(source, /CloudMap\.zoomReset/);
  assert.match(source, /CloudMap\.zoomIn/);
  assert.match(source, /CloudMap\.fitView/);
  assert.match(source, /cloudmap\.readOnly/);
  assert.match(source, /data-cm-visibility/);
  assert.doesNotMatch(source, /dataAction\('CloudMap\.(?:runAutoLayout|runDagreLayout|undoLayout|resetLayout|savePositions)'\)/);
  assert.doesNotMatch(source, /cloudmap\.addRelationHere/);
  assert.doesNotMatch(source, /pageEditToggle/);
  assert.doesNotMatch(styles, /\.map-toolbar\.is-editing/);
  assert.match(styles, /\.cm-edge-svg > path\s*{\s*vector-effect: non-scaling-stroke/);
});

test('hidden relationship labels produce uninterrupted curves', () => {
  assert.match(source, /const showEdgeLabels = cloudMapDetailLevel\(_zoom\) === 'full'/);
  assert.match(source, /if \(showEdgeLabels && label && visLen > 50\)/);
  assert.doesNotMatch(
    styles,
    /data-cm-detail="overview"[^\n]*\.cm-name/,
    'overview must keep node names visible',
  );
});
