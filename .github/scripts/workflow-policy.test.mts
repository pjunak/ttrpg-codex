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


function evaluate(expression: string | undefined, context: object): unknown {
  assert.ok(expression, 'Required workflow policy is missing');
  return runInNewContext(expression, { ...context, format: (template: string, value: unknown) => template.replace('{0}', String(value)) });
}

const prepare = build.split('  resolve-targets:')[1]?.split('  dispatch:')[0] ?? '';
const deployPolicy = prepare.match(/if: \$\{\{ (.+) \}\}/)?.[1];
const targetPolicy = prepare.match(/DEPLOY_TARGET: \$\{\{ (.+) \}\}/)?.[1];
for (const [event, ref, target, expected] of [
  ['push', 'refs/heads/main', undefined, true],
  ['push', 'refs/heads/feature', undefined, false],
  ['pull_request', 'refs/pull/1/merge', undefined, false],
  ['workflow_dispatch', 'refs/heads/main', 'none', false],
  ['workflow_dispatch', 'refs/heads/main', 'configured', true],
  ['workflow_dispatch', 'refs/heads/main', 'asurai', true],
  ['workflow_dispatch', 'refs/heads/main', 'tiamat', true],
  ['workflow_dispatch', 'refs/heads/feature', 'configured', false],
] as const) {
  test(`deployment policy: ${event}, ${ref}, ${target}`, () => {
    const context = { github: { event_name: event, ref }, inputs: { deploy_target: target } };
    assert.equal(Boolean(evaluate(deployPolicy, context)), expected);
    if (expected) assert.equal(evaluate(targetPolicy, context), event === 'push' ? 'configured' : target);
  });
}

test('publication cannot silently succeed without release readiness, or publish an older push', () => {
  const refusal = build.match(/name: Refuse an incomplete release\s+if: \$\{\{ (.+) \}\}/)?.[1];
  const publication = build.match(/name: Publish the verified warm build\s+id: publish_image\s+if: \$\{\{ (.+) \}\}/)?.[1];
  const context = { github: { event_name: 'push', ref: 'refs/heads/main' }, inputs: {},
    steps: { release_readiness: { outputs: { ready: 'false' } }, current: { outputs: { current: 'true' } } } };
  assert.equal(evaluate(refusal, context), true);
  assert.equal(evaluate(publication, context), false);
  context.steps.release_readiness.outputs.ready = 'true';
  assert.equal(evaluate(publication, context), true);
  context.steps.current.outputs.current = 'false';
  assert.equal(evaluate(publication, context), false);
  assert.match(build, /needs: \[test, compatibility, resolve-targets\]/);
});

test('automatic and manual releases share a non-cancelling queue; PRs cannot block it', () => {
  const manual = readFileSync(new URL('../workflows/deploy-release.yml', import.meta.url), 'utf8');
  const group = build.match(/group: \$\{\{ (.+) \}\}/)?.[1];
  const releaseGroup = evaluate(group, { github: { event_name: 'push', run_id: 1 } });
  assert.equal(releaseGroup, 'codex-production-release');
  assert.equal(evaluate(group, { github: { event_name: 'workflow_dispatch', run_id: 2 } }), releaseGroup);
  assert.notEqual(evaluate(group, { github: { event_name: 'pull_request', run_id: 3 } }), releaseGroup);
  assert.match(manual, /group: codex-production-release/);
  for (const workflow of [build, manual]) assert.match(workflow, /cancel-in-progress: false\s+queue: max/);
  assert.match(build, /if: \$\{\{ needs.build.outputs.image_ref != '' && needs.resolve-targets.outputs.services != '' \}\}/);
});

test('companion checkouts use verified immutable refs before any package build', () => {
  const workflow = readFileSync(new URL('../workflows/addon-compatibility.yml', import.meta.url), 'utf8');
  const resolver = workflow.indexOf('node scripts/companion-revisions.mts github');
  const check = workflow.indexOf('node scripts/companion-revisions.mts check');
  assert.ok(resolver > 0 && resolver < check);
  for (const [repository, output] of [
    ['addon-dm-tools', 'dm_tools'], ['addon-dnd-engine', 'dnd_engine'],
    ['addon-dnd-character-sheets', 'dnd_sheets'], ['addon-dnd-2024-compendium', 'dnd_2024_compendium'],
  ]) {
    const checkout = workflow.indexOf('repository: pjunak/' + repository);
    const options = workflow.slice(checkout).split('\n      - ')[0]!;
    assert.ok(checkout > resolver && checkout < check, repository + ' must resolve before checkout and verify before build');
    assert.ok(options.includes('ref: ${{ steps.companions.outputs.' + output + ' }}'), repository + ' must use its exact validated SHA');
  }
  assert.ok(check < workflow.indexOf('name: Test and package'));
  assert.ok(workflow.indexOf('actions/setup-node') < resolver);
  assert.match(workflow, /node scripts\/companion-suite\.mts test "\$SUITE_MODE"/);
});
