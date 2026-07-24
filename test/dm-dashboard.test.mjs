import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.window = globalThis.window || {
  addEventListener: () => {},
  dispatchEvent: () => {},
};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({}),
  documentElement: { setAttribute: () => {} },
};

const { Store } = await import('../web/js/store.js');
const { Role } = await import('../web/js/role.js');
const { Addons } = await import('../web/js/addons.js');
const { I18n } = await import('../web/js/i18n.js');
const { DmDashboard } = await import('../web/js/dm_dashboard.js');

const en = JSON.parse(await readFile(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
const cs = JSON.parse(await readFile(new URL('../web/i18n/cs.json', import.meta.url), 'utf8'));
I18n.register('en', en);
I18n.register('cs', cs);

const originals = {
  roleIsDM: Role.isDM,
  slotContent: Addons.slotContent,
  list: Addons.list,
  getters: new Map(),
};
const getterNames = [
  'getCharacters',
  'getLocations',
  'getEvents',
  'getMysteries',
  'getPantheon',
  'getArtifacts',
  'getHistoricalEvents',
  'getFactions',
];
for (const name of getterNames) originals.getters.set(name, Store[name]);

function stubCollections(values = {}) {
  for (const name of getterNames) {
    Store[name] = () => values[name] ?? (name === 'getFactions' ? {} : []);
  }
}

after(async () => {
  Role.isDM = originals.roleIsDM;
  Addons.slotContent = originals.slotContent;
  Addons.list = originals.list;
  for (const [name, value] of originals.getters) Store[name] = value;
  await I18n.setLocale('en');
});

test('authorization refusal happens before dashboard slot enumeration', () => {
  let invoked = false;
  Role.isDM = () => false;
  Addons.slotContent = () => {
    invoked = true;
    return [{ addonId: 'dm-tools', html: '<p>secret</p>' }];
  };
  const html = DmDashboard.html();
  assert.equal(invoked, false);
  assert.match(html, /available to the DM only/);
  assert.doesNotMatch(html, /secret/);
});

test('a successful addon contribution owns the workflow dashboard body', () => {
  Role.isDM = () => true;
  Addons.slotContent = (slotId, context) => {
    assert.equal(slotId, 'dm:dashboard');
    assert.equal(context.role.isDM, true);
    return [{ addonId: 'dm-tools', html: '<section id="addon-dashboard">Workflow</section>' }];
  };
  Addons.list = () => {
    throw new Error('fallback diagnostics must not run');
  };
  stubCollections(Object.fromEntries(getterNames.map(name => [name, () => {
    throw new Error('fallback counts must not run');
  }])));
  const html = DmDashboard.html();
  assert.match(html, /id="addon-dashboard"/);
  assert.match(html, /data-addon-id="dm-tools"/);
  assert.doesNotMatch(html, /Addon health and recovery/);
});

test('zero contributors retain a standalone core diagnostic and recovery fallback', () => {
  Role.isDM = () => true;
  Addons.slotContent = () => [];
  Addons.list = () => [];
  stubCollections();
  const html = DmDashboard.html();
  assert.match(html, /Core diagnostics remain available/);
  assert.match(html, /No addons are currently loaded/);
  assert.match(html, /Settings\.selectCategory/);
  assert.match(html, /#\/nastaveni/);
  assert.doesNotMatch(html, /Future tools|Plot tracker|Session notes/);
});

test('fallback escapes addon diagnostics and reports hidden core counts', () => {
  Role.isDM = () => true;
  Addons.slotContent = () => [];
  Addons.list = () => [{
    id: 'broken',
    name: '<img src=x onerror=alert(1)>',
    state: 'error',
    error: '<script>alert(1)</script>',
    slotFailures: [],
  }];
  stubCollections({
    getCharacters: [
      { id: 'hidden', visibility: 'dm' },
      { id: 'public', visibility: 'public' },
    ],
  });
  const html = DmDashboard.html();
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>1<\/strong> \/ 2/);
});

test('core fallback follows the active English or Czech locale', async () => {
  Role.isDM = () => true;
  Addons.slotContent = () => [];
  Addons.list = () => [];
  stubCollections();

  await I18n.setLocale('cs');
  assert.match(DmDashboard.html(), /Základní diagnostika/);
  await I18n.setLocale('en');
  assert.match(DmDashboard.html(), /Core diagnostics/);
});
