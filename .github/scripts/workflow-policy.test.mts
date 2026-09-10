import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const build = readFileSync(new URL('../workflows/build-and-dispatch.yml', import.meta.url), 'utf8');
const expression = build.match(/require_private: \$\{\{ (.+) \}\}/)?.[1];

for (const [event, publish, target, required] of [
  ['push', false, undefined, true],
  ['pull_request', false, undefined, false],
  ['workflow_dispatch', false, 'none', false],
  ['workflow_dispatch', true, 'none', true],
  ['workflow_dispatch', false, 'asurai', true],
  ['workflow_dispatch', false, 'tiamat', true],
  ['workflow_dispatch', false, 'configured', true],
] as const) {
  test(`private suite policy: ${event}, publish=${publish}, target=${target}`, () => {
    assert.ok(expression, 'The release caller must explicitly set its private-suite policy');
    assert.equal(Boolean(runInNewContext(expression, {
      github: { event_name: event }, inputs: { publish, deploy_target: target },
    })), required);
  });
}
