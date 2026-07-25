import test from 'node:test';
import assert from 'node:assert/strict';

import { Role } from '../web/js/role.js';
import { SettingsAccount } from '../web/js/settings-account.js';

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('account controller owns status loading and restart availability', async () => {
  const requests = [];
  globalThis.document = {
    body: {
      classList: { toggle() {} },
    },
    getElementById() {
      return null;
    },
  };
  globalThis.window = {
    dispatchEvent() {},
  };
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (url === '/api/auth') {
      return jsonResponse({ role: 'dm', realRole: 'dm' });
    }
    if (url === '/api/passwords') {
      return jsonResponse({
        dm: { stored: false, envFallback: true, isDefault: false },
        player: { stored: false, envFallback: false, disabled: true },
      });
    }
    if (url === '/api/version') {
      return jsonResponse({ canRestart: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await Role.refresh();
  let renders = 0;
  const account = SettingsAccount.create({
    render() {
      renders++;
    },
    flash() {},
    requireDM() {
      return true;
    },
  });

  await account.open();
  assert.equal(renders, 1);
  assert.match(account.html(), /Settings\.changePassword/);

  account.ensureServerInfo();
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
  assert.equal(account.canRestart(), true);
  assert.equal(renders, 2);
  assert.match(account.html(), /Settings\.restartServer/);
  assert.deepEqual(requests, [
    '/api/auth',
    '/api/passwords',
    '/api/version',
  ]);
});
