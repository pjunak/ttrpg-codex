import test from 'node:test';
import assert from 'node:assert/strict';

import { EditLogin } from '../web/js/edit-login.js';
import { Role } from '../web/js/role.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('login controller authenticates and refreshes the shared role cache', async () => {
  let role = null;
  const listeners = new Map();
  globalThis.document = {
    body: {
      classList: { toggle() {} },
    },
  };
  globalThis.window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatchEvent() {},
  };
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  globalThis.fetch = async url => {
    if (url !== '/api/auth') throw new Error(`Unexpected request: ${url}`);
    return jsonResponse({ role, realRole: role });
  };
  await Role.refresh();

  const messages = [];
  const login = EditLogin.create({
    toast(message, ok = true) {
      messages.push({ message, ok });
    },
    documentRef: globalThis.document,
    windowRef: globalThis.window,
    promptPassword: async () => 'secret',
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/login');
      assert.deepEqual(JSON.parse(options.body), { password: 'secret' });
      role = 'dm';
      return jsonResponse({ ok: true, role });
    },
  });

  assert.equal(await login.promptLogin(), true);
  assert.equal(Role.isDM(), true);
  assert.deepEqual(messages, [{ message: 'editmode.dmAccess', ok: true }]);
  assert.equal(listeners.has('auth:prompt-login'), true);
});
