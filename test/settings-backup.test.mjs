import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { createElement: () => ({}) };
globalThis.CustomEvent = globalThis.CustomEvent || class {
  constructor(type) { this.type = type; }
};

const { SettingsBackup } = await import(
  '../web/js/settings-backup.js?settings-backup-tests'
);

function i18nStub() {
  return {
    t: (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`,
    plural: (key, count, vars) => (
      `${key}:${count}${vars ? JSON.stringify(vars) : ''}`
    ),
    formatDate: value => `date:${value}`,
  };
}

function createController({
  isDM = true,
  requests = [],
  snapshots = [],
  confirmResult = true,
  inputValue = '1',
} = {}) {
  const calls = [];
  const flashes = [];
  let renders = 0;
  let storeLoads = 0;
  let snapshotList = snapshots;
  const api = {
    async requestJson(url, options = {}) {
      calls.push({ kind: 'json', url, options });
      if (url === '/api/snapshots' && !options.method) {
        return { snapshots: snapshotList };
      }
      const queued = requests.shift();
      if (queued instanceof Error) throw queued;
      return queued || { ok: true };
    },
    async uploadJson(url, form, options = {}) {
      calls.push({ kind: 'upload', url, form, options });
      const queued = requests.shift();
      if (queued instanceof Error) throw queued;
      return queued || { ok: true, format: 'zip', restored: 1 };
    },
  };
  class FakeFormData {
    constructor() { this.entries = []; }
    append(...args) { this.entries.push(args); }
  }
  const controller = SettingsBackup.create({
    store: { async load() { storeLoads += 1; return true; } },
    role: { isDM: () => isDM },
    api,
    i18n: i18nStub(),
    render: () => { renders += 1; },
    flash: (...args) => flashes.push(args),
    confirmAction: () => confirmResult,
    documentRef: {
      getElementById: () => ({ value: inputValue }),
    },
    FormDataClass: FakeFormData,
  });
  return {
    controller,
    calls,
    flashes,
    get renders() { return renders; },
    get storeLoads() { return storeLoads; },
    setSnapshots(value) { snapshotList = value; },
  };
}

test('backup controller renders role-appropriate controls and escaped metadata', async () => {
  const player = createController({
    isDM: false,
    snapshots: [{
      id: `snapshot-'<unsafe>.json`,
      createdAt: '2026-07-25T12:00:00Z',
      reason: 'manual',
      size: 2048,
    }],
  });
  await player.controller.open();
  const playerHtml = player.controller.html();
  assert.match(playerHtml, /Settings\.createSnapshot/);
  assert.doesNotMatch(playerHtml, /href="\/api\/backup"/);
  assert.doesNotMatch(playerHtml, /Settings\.restoreSnapshot/);
  assert.doesNotMatch(playerHtml, /<unsafe>/);

  const dm = createController();
  const dmHtml = dm.controller.html();
  assert.match(dmHtml, /href="\/api\/backup"/);
  assert.match(dmHtml, /Settings\.uploadRestore/);
  assert.match(dmHtml, /Settings\.revertLastN/);
});

test('backup controller owns snapshot create, restore, delete, and revert workflows', async () => {
  const fixture = createController({
    snapshots: [{
      id: 'snapshot-one.json',
      createdAt: '2026-07-25T12:00:00Z',
      reason: 'manual',
    }],
    inputValue: '99',
  });
  await fixture.controller.open();
  assert.equal(fixture.renders, 2);

  await fixture.controller.createSnapshot();
  await fixture.controller.restoreSnapshot('snapshot-one.json');
  await fixture.controller.deleteSnapshot('snapshot-one.json');
  await fixture.controller.revertLastN();

  assert.deepEqual(
    fixture.calls
      .filter(call => call.options.method)
      .map(call => [call.url, call.options.method]),
    [
      ['/api/snapshots', 'POST'],
      ['/api/snapshots/snapshot-one.json/restore', 'POST'],
      ['/api/snapshots/snapshot-one.json', 'DELETE'],
      ['/api/snapshots/revert-last/50', 'POST'],
    ],
  );
  assert.equal(fixture.storeLoads, 2);
  assert.ok(fixture.flashes.length >= 4);
});

test('backup controller uploads one selected file and always clears the input', async () => {
  const fixture = createController({
    requests: [{ format: 'json', restored: 3 }],
  });
  const input = {
    files: [{ name: `campaign'<backup>.json` }],
    value: 'selected',
  };

  await fixture.controller.uploadRestore(input);
  assert.equal(input.value, '');
  assert.equal(fixture.calls[0].url, '/api/restore');
  assert.deepEqual(fixture.calls[0].form.entries, [
    ['backup', input.files[0]],
  ]);
  assert.equal(fixture.storeLoads, 1);
});

test('backup controller leaves server state untouched when confirmation is declined', async () => {
  const fixture = createController({
    snapshots: [{
      id: 'snapshot-one.json',
      createdAt: '2026-07-25T12:00:00Z',
      reason: 'manual',
    }],
    confirmResult: false,
  });
  await fixture.controller.open();
  fixture.calls.length = 0;

  assert.equal(
    fixture.controller.restoreSnapshot('snapshot-one.json'),
    undefined,
  );
  assert.equal(fixture.controller.revertLastN(), undefined);
  assert.deepEqual(fixture.calls, []);
});
