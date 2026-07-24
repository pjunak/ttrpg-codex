import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const fixtureUrl = pathToFileURL(path.resolve('test/fixtures/addon-lifecycle-fixture.mjs')).href;
let runtimeSequence = 0;

function metadata(id, revision, extra = {}) {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 2,
    hostVersion: '>=1.0.0',
    capabilities: { required: ['lifecycle.dispose', 'content.revision'] },
    enabled: true,
    entryUrl: fixtureUrl,
    activeHash: 'fixture-hash',
    contentRevision: revision,
    permissions: ['ui:route'],
    dependencies: {},
    optionalDependencies: {},
    ...extra,
  };
}

async function freshRuntime(initial, config = {}) {
  globalThis.__addonLifecycleState = {
    config,
    events: [],
    instances: {},
    consumerApis: {},
  };
  const responses = [initial];
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/addons');
    const next = responses.shift();
    const addons = typeof next === 'function' ? await next() : next;
    return { ok: true, json: async () => ({ addons, resolutions: {} }) };
  };
  const { Addons } = await import(`../web/js/addons.js?lifecycle-test=${++runtimeSequence}`);
  Addons.init({ toast: () => {}, rerender: () => {} });
  await Addons.boot();
  return {
    Addons,
    state: globalThis.__addonLifecycleState,
    queue: (...items) => responses.push(...items),
  };
}

test('lifecycle: disable/removal is idempotent and cleanup precedes registration reversal', async () => {
  const rt = await freshRuntime([metadata('alpha', 'r1')]);
  assert.equal(rt.Addons.hasRoute('alpha'), true);
  rt.queue([metadata('alpha', 'r1', { enabled: false })]);
  await rt.Addons.reconcile();
  assert.equal(rt.Addons.hasRoute('alpha'), false);
  assert.deepEqual(rt.state.events.filter(e => e.includes('Dispose:alpha')), [
    'returnedDispose:alpha:r1',
    'onDispose:alpha:r1',
  ]);

  rt.queue([metadata('alpha', 'r1', { enabled: false })]);
  await rt.Addons.reconcile();
  assert.equal(rt.state.events.filter(e => e.includes('Dispose:alpha')).length, 2, 'repeated removal does not dispose twice');

  rt.queue([metadata('alpha', 'r1')], []);
  await rt.Addons.reconcile();
  assert.equal(rt.Addons.hasRoute('alpha'), true, 're-enable registers a fresh instance');
  await rt.Addons.reconcile();
  assert.equal(rt.Addons.hasRoute('alpha'), false, 'uninstall/removal unloads the fresh instance');
  assert.equal(rt.state.events.filter(e => e.includes('Dispose:alpha')).length, 4);
});

test('lifecycle: content revision reloads once, busts the entry-module cache, and same revision is a no-op', async () => {
  const rt = await freshRuntime([metadata('alpha', 'r1')]);
  const first = rt.state.instances.alpha;
  assert.equal(first.moduleRevision, 'r1');

  rt.queue([metadata('alpha', 'r1')]);
  assert.equal(await rt.Addons.reconcile(), false);
  assert.equal(rt.state.instances.alpha, first, 'same revision preserves the loaded instance');

  rt.queue([metadata('alpha', 'r2')]);
  assert.equal(await rt.Addons.reconcile(), true);
  assert.equal(first.active, false);
  assert.equal(rt.state.instances.alpha.revision, 'r2');
  assert.equal(rt.state.instances.alpha.moduleRevision, 'r2');
  assert.equal(rt.Addons.list()[0].state, 'ok');
});

test('lifecycle: enabling an optional provider reloads an existing standalone consumer', async () => {
  const consumer = metadata('consumer', 'c1', {
    optionalDependencies: { provider: '*' },
  });
  const provider = metadata('provider', 'p1');
  const rt = await freshRuntime([consumer], {
    provider: { provide: true },
    consumer: { consume: 'provider', allowMissing: true },
  });
  assert.ok(rt.state.events.includes('consumer-missing:consumer'));

  rt.queue([consumer, provider]);
  await rt.Addons.reconcile();

  assert.equal(rt.state.consumerApis.consumer?.revision, 'p1');
  assert.equal(rt.state.events.filter(e => e === 'register:consumer:c1:c1').length, 2);
  const providerRegister = rt.state.events.lastIndexOf('register:provider:p1:p1');
  const consumerRegister = rt.state.events.lastIndexOf('register:consumer:c1:c1');
  assert.ok(providerRegister >= 0 && providerRegister < consumerRegister, 'provider reload precedes consumer reload');
});

test('lifecycle: partial registration and disposer failures are isolated', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const rt = await freshRuntime([
      metadata('broken', 'r1'),
      metadata('healthy', 'r1'),
      metadata('other', 'r1'),
    ], {
      broken: { failAfterRegister: true },
      healthy: {},
      other: {},
    });
    assert.equal(rt.Addons.hasRoute('broken'), false, 'partial route rolled back');
    assert.equal(rt.Addons.hasRoute('healthy'), true, 'unrelated addon loaded');
    assert.ok(rt.state.events.includes('onDispose:broken:r1'), 'registered cleanup ran after register failure');

    rt.state.config.healthy.rejectDispose = true;
    rt.queue([]);
    await rt.Addons.reconcile();
    assert.equal(rt.Addons.hasRoute('healthy'), false, 'a rejecting disposer cannot block unload');
    assert.equal(rt.Addons.hasRoute('other'), false, 'another addon still reconciles after the failure');
    assert.ok(rt.state.events.includes('onDispose:other:r1'));
  } finally {
    console.error = originalError;
  }
});

test('live collection facade requires data:own before registration', async () => {
  const withoutPermission = metadata('guarded', 'r1', {
    collections: [{ name: 'notes', keyed: false, access: 'public' }],
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const rt = await freshRuntime([withoutPermission], {
      guarded: { collection: 'notes' },
    });
    assert.equal(rt.Addons.hasRoute('guarded'), false, 'failed registration rolls back earlier UI');
    assert.equal(rt.Addons.list()[0].state, 'error');

    const withPermission = {
      ...withoutPermission,
      permissions: ['ui:route', 'data:own'],
    };
    rt.queue([withPermission]);
    await rt.Addons.reconcile();
    assert.equal(rt.Addons.hasRoute('guarded'), true);
    assert.equal(rt.Addons.list()[0].state, 'ok');
  } finally {
    console.error = originalError;
  }
});

test('lifecycle: consumers dispose before providers and rapid reconciles settle on the newest revision', async () => {
  const provider = metadata('provider', 'p1');
  const consumer = metadata('consumer', 'c1', { dependencies: { provider: '*' } });
  const rt = await freshRuntime([consumer, provider], {
    provider: { provide: true },
    consumer: { consume: 'provider' },
  });

  let resolveSecond;
  rt.queue(
    () => new Promise(resolve => { resolveSecond = resolve; }),
    [metadata('provider', 'p3')],
  );
  const firstReconcile = rt.Addons.reconcile();
  const queuedReconcile = rt.Addons.reconcile();
  resolveSecond([metadata('provider', 'p2')]);
  await Promise.all([firstReconcile, queuedReconcile]);

  assert.equal(rt.state.instances.provider.revision, 'p3');
  assert.equal(rt.state.events.filter(e => e === 'register:provider:p2:p2').length, 1);
  assert.ok(rt.state.events.includes('consumer-sees:consumer:p1'), 'consumer cleanup can still use the provider');
  const consumerDispose = rt.state.events.indexOf('onDispose:consumer:c1');
  const providerDispose = rt.state.events.indexOf('onDispose:provider:p1');
  assert.ok(consumerDispose >= 0 && consumerDispose < providerDispose, 'consumer unload precedes provider unload');
});
