import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const events = [];
globalThis.window = {
  dispatchEvent: event => events.push(event),
  addEventListener() {},
};
globalThis.document = { documentElement: { lang: 'en' } };
globalThis.CustomEvent = globalThis.CustomEvent || class {
  constructor(type) { this.type = type; }
};

const { StoreAdminClient } = await import(
  '../web/js/store-admin-client.js?store-admin-client-tests'
);

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('Store admin client normalizes add-on administration responses', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/check-updates')) {
      return response(200, { updates: 'invalid' });
    }
    if (url.endsWith('/update-all')) {
      return response(200, {
        updated: ['one'],
        skipped: null,
        errors: ['broken'],
        serverChanged: 1,
      });
    }
    return response(200, { version: '1.2.3', resolutions: { slot: 'one' } });
  };

  assert.deepEqual(await StoreAdminClient.resolveAddonConflict('slot', 'one'), {
    ok: true,
    resolutions: { slot: 'one' },
  });
  assert.deepEqual(await StoreAdminClient.checkAddonUpdates(), {
    ok: true,
    updates: [],
  });
  assert.deepEqual(await StoreAdminClient.rollbackAddon('addon id', 'hash'), {
    ok: true,
    version: '1.2.3',
  });
  assert.deepEqual(await StoreAdminClient.updateAllAddons(), {
    ok: true,
    updated: ['one'],
    skipped: [],
    errors: ['broken'],
    serverChanged: true,
  });
  assert.match(calls[2].url, /addon%20id\/rollback$/);
});

test('Store admin client maps authorization failures and restart availability', async () => {
  events.length = 0;
  globalThis.fetch = async () => response(403, { error: 'denied' });
  assert.equal((await StoreAdminClient.restartServer()).ok, false);
  assert.equal(events.some(event => event.type === 'store:auth-failed'), true);

  globalThis.fetch = async () => response(200, { canRestart: true });
  assert.equal(await StoreAdminClient.getCanRestart(), true);

  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await StoreAdminClient.getCanRestart(), false);
});
