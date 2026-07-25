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
    response({ ok: false, status: 401 }),
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
  await transport.settled();
  assert.equal(calls, 0);
});
