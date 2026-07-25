import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.CustomEvent = globalThis.CustomEvent || class {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { StoreTransport } = await import(
  '../web/js/store-transport.js?store-transport-tests'
);

function response({ ok = true, status = 200, data = {} } = {}) {
  return { ok, status, json: async () => data };
}

function eventRecorder() {
  const events = [];
  return {
    events,
    target: { dispatchEvent: event => events.push(event) },
  };
}

test('Store transport validates loads and tracks availability explicitly', async () => {
  let next = response({ data: { characters: [] } });
  const transport = StoreTransport.create({
    fetchImpl: async () => next,
    eventTarget: eventRecorder().target,
  });

  assert.equal(transport.isAvailable(), false);
  assert.deepEqual(await transport.loadDataset(), {
    ok: true,
    data: { characters: [] },
  });
  transport.setAvailable(true);
  assert.equal(transport.isAvailable(), true);

  next = response({ ok: false, status: 503 });
  assert.deepEqual(await transport.loadDataset(), { ok: false });

  next = response({ data: [] });
  await assert.rejects(
    transport.loadDataset(),
    /returned a non-object payload/,
  );
});

test('Store transport serializes writes and snapshots queued payloads', async () => {
  const pending = [];
  const recorder = eventRecorder();
  const transport = StoreTransport.create({
    fetchImpl: (_url, options) => new Promise(resolve => {
      pending.push({ options, resolve });
    }),
    eventTarget: recorder.target,
  });
  transport.setAvailable(true);

  const first = { id: 'one', value: 1 };
  assert.equal(transport.sync('characters', 'save', first), true);
  first.value = 99;
  assert.equal(
    transport.sync('characters', 'delete', { id: 'two' }),
    true,
  );

  await Promise.resolve();
  assert.equal(pending.length, 1);
  assert.equal(JSON.parse(pending[0].options.body).payload.value, 1);
  pending[0].resolve(response());
  await new Promise(resolve => { setTimeout(resolve, 0); });
  assert.equal(pending.length, 2);
  pending[1].resolve(response());
  await transport.settled();

  assert.deepEqual(
    recorder.events
      .filter(event => event.type === 'store:inflight')
      .map(event => event.detail.count),
    [1, 2, 1, 0],
  );
});

test('Store transport retries transient failures and reports terminal failures', async () => {
  const delays = [];
  const recorder = eventRecorder();
  const results = [
    response({ ok: false, status: 503 }),
    response({ ok: false, status: 500 }),
    response(),
    response({ ok: false, status: 422 }),
  ];
  const transport = StoreTransport.create({
    fetchImpl: async () => results.shift(),
    eventTarget: recorder.target,
    delay: async ms => { delays.push(ms); },
    logger: { warn() {} },
  });
  transport.setAvailable(true);

  transport.sync('events', 'save', { id: 'event-1' });
  transport.sync('events', 'save', { id: 'event-2' });
  transport.sync('events', 'save', { id: 'event-3' });
  await transport.settled();

  assert.deepEqual(delays, [200, 800]);
  assert.equal(
    recorder.events.some(event => (
      event.type === 'store:save-failed'
      && event.detail.status === 422
    )),
    true,
  );
  assert.equal(
    recorder.events.some(event => event.type === 'store:write-recovery-needed'),
    true,
  );
  assert.equal(transport.needsRecovery(), true);
});

test('Store transport serializes enum mutations with ordinary writes', async () => {
  const calls = [];
  const transport = StoreTransport.create({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response();
    },
    eventTarget: eventRecorder().target,
  });
  transport.setAvailable(true);

  const command = {
    category: 'attitudes',
    id: 'old value',
    replaceWith: 'new',
    tombstone: true,
  };
  assert.equal(transport.deleteEnumItem(command), true);
  command.replaceWith = 'changed-after-queue';
  transport.sync('settings', 'save', { id: 'appearance', data: {} });
  await transport.settled();

  assert.equal(calls[0].url, '/api/campaign/enums/attitudes/old%20value');
  assert.equal(calls[0].options.method, 'DELETE');
  const enumBody = JSON.parse(calls[0].options.body);
  assert.deepEqual({
    replaceWith: enumBody.replaceWith,
    force: enumBody.force,
    tombstone: enumBody.tombstone,
  }, {
    replaceWith: 'new',
    force: false,
    tombstone: true,
  });
  assert.match(enumBody.baseRevision, /^[0-9a-f]{16}$/);
  assert.equal(calls[1].url, '/api/data');
});

test('Store transport blocks dependent writes after conflict until a confirmed reload', async () => {
  const calls = [];
  const recorder = eventRecorder();
  let conflict = true;
  const transport = StoreTransport.create({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return conflict
        ? response({
          ok: false,
          status: 409,
          data: { code: 'WRITE_CONFLICT' },
        })
        : response({ data: { revision: '0123456789abcdef' } });
    },
    eventTarget: recorder.target,
    logger: { warn() {} },
  });
  transport.setAvailable(true);
  transport.acceptDataset({
    characters: [
      { id: 'one', name: 'Original' },
      { id: 'two', name: 'Other' },
    ],
  });

  transport.sync('characters', 'save', { id: 'one', name: 'Local' });
  transport.sync('characters', 'save', { id: 'two', name: 'Queued' });
  await transport.settled();

  assert.equal(calls.length, 1);
  assert.equal(transport.needsRecovery(), true);
  assert.equal(
    recorder.events.some(event => (
      event.type === 'store:write-recovery-needed'
      && event.detail.code === 'WRITE_CONFLICT'
    )),
    true,
  );

  conflict = false;
  transport.acceptDataset({
    characters: [
      { id: 'one', name: 'Remote' },
      { id: 'two', name: 'Other' },
    ],
  });
  assert.equal(transport.needsRecovery(), false);
  assert.equal(
    transport.sync('characters', 'save', { id: 'two', name: 'Retried' }),
    true,
  );
  await transport.settled();
  assert.equal(calls.length, 2);
  assert.match(
    JSON.parse(calls[1].options.body).baseRevision,
    /^[0-9a-f]{16}$/,
  );
});

test('Store transport reports authentication failures without sending later queued writes', async () => {
  const recorder = eventRecorder();
  let calls = 0;
  const transport = StoreTransport.create({
    fetchImpl: async () => {
      calls += 1;
      return response({ ok: false, status: 401 });
    },
    eventTarget: recorder.target,
  });
  transport.setAvailable(true);
  transport.acceptDataset({ events: [] });
  transport.sync('events', 'save', { id: 'one' });
  transport.sync('events', 'save', { id: 'two' });
  await transport.settled();
  assert.equal(calls, 1);
  assert.equal(
    recorder.events.some(event => event.type === 'store:auth-failed'),
    true,
  );
});

test('Store transport refuses writes while unavailable', async () => {
  let calls = 0;
  const transport = StoreTransport.create({
    fetchImpl: async () => {
      calls += 1;
      return response();
    },
    eventTarget: eventRecorder().target,
  });
  assert.equal(transport.sync('events', 'save', {}), false);
  assert.equal(transport.deleteEnumItem({ category: 'genders', id: 'x' }), false);
  await transport.settled();
  assert.equal(calls, 0);
});
