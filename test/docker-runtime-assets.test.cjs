'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('Docker image includes import schemas loaded during server startup', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY schemas \.\/schemas$/m);

  for (const filename of ['campaign-bundle-v1.schema.json', 'inventory-v1.schema.json']) {
    const source = fs.readFileSync(path.join(ROOT, 'schemas', 'import', filename), 'utf8');
    assert.doesNotThrow(() => JSON.parse(source), `${filename} must contain valid JSON`);
  }
});
