// Unit tests for the published addon test harness (Phase 8). Pure — no DOM.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMockHost, disposeMockHost, dryRunRegister, smokeRegistrations } from '../web/js/addon-test-harness.mjs';

test('createMockHost: records every register* call', () => {
  const { host, rec } = createMockHost({ id: 'x', collections: [{ name: 'rules', keyed: true }] });
  host.registerRoute('foo', () => '');
  host.registerSidebarPage({ route: '/foo' });
  host.registerArticleSection('characters', () => null);
  host.registerAction('go', () => {});
  host.registerCollection('rules', { keyed: true });
  host.registerWikiKind('rule', () => null);
  host.registerEditorFields('characters', { fields: () => '' });
  host.registerFragmentOp('characters:body', { op: 'wrap', render: h => h });
  assert.equal(rec.routes.length, 1);
  assert.equal(rec.sidebar.length, 1);
  assert.equal(rec.articleSections.length, 1);
  assert.equal(rec.actions[0].name, 'go');
  assert.equal(rec.collections[0].name, 'rules');
  assert.equal(rec.wikiKinds[0].scope, 'rule');
  assert.equal(rec.editorFields[0].kind, 'characters');
  assert.equal(rec.fragmentOps[0].target, 'characters:body');
});

test('mock host.h + action are pure + namespaced', () => {
  const { host } = createMockHost({ id: 'demo' });
  assert.equal(host.action('roll'), 'demo:roll');
  assert.equal(host.h.esc('<a>'), '&lt;a&gt;');
  assert.match(host.h.dataAction('M.x', 1), /data-action="M\.x"/);
  assert.equal(host.h.slugify('Příliš Žluťoučký'), 'prilis-zlutoucky');
});

test('store fixtures + role flags are honoured', () => {
  const { host } = createMockHost({ id: 'x' }, { isDM: true, fixtures: { characters: [{ id: 'a' }] } });
  assert.equal(host.role.isDM(), true);
  assert.equal(host.role.isAnonymous(), false);
  assert.equal(host.store.getCharacters().length, 1);
});

test('mock store.collection: save / read-back / remove actually mutate the backing store', () => {
  const { host } = createMockHost({
    id: 'rules-addon',
    permissions: ['data:own'],
    collections: [{ name: 'rules', keyed: false }],
  }, { fixtures: { 'collection:rules': [{ id: 'seed', name: 'Seed' }] } });
  host.registerCollection('rules');
  const rules = host.store.collection('rules');
  assert.equal(rules.list().length, 1, 'seeded from fixtures');

  const saved = rules.save({ name: 'Grappling' });
  assert.ok(saved.id, 'save generates a missing id');
  assert.equal(rules.list().length, 2, 'save is visible on read-back (not a no-op mock)');
  assert.equal(rules.get(saved.id).name, 'Grappling');
  // upsert by id, not a duplicate
  rules.save({ id: saved.id, name: 'Grappling v2' });
  assert.equal(rules.list().length, 2);
  assert.equal(rules.get(saved.id).name, 'Grappling v2');

  rules.remove('seed');
  assert.equal(rules.list().length, 1);
  assert.equal(rules.get('seed'), null);
});

test('dryRunRegister: ok for a clean register, captures registrations', () => {
  const register = (host) => { host.registerRoute('foo', () => 'ok'); };
  const r = dryRunRegister(register, { id: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.rec.routes.length, 1);
});

test('dryRunRegister: catches a throwing register (no crash)', () => {
  let disposed = 0;
  const register = (host) => {
    host.onDispose(() => { disposed++; });
    host.registerRoute('partial', () => '');
    throw new Error('bad register');
  };
  const r = dryRunRegister(register, { id: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /bad register/);
  assert.equal(disposed, 1);
  assert.equal(r.rec.routes.length, 0, 'partial registrations roll back');
});

test('dryRunRegister: rejects a non-function register', () => {
  assert.equal(dryRunRegister(null, { id: 'x' }).ok, false);
});

test('smokeRegistrations: ok when renderers tolerate sample input', () => {
  const { rec } = dryRunRegister((host) => {
    host.registerRoute('foo', () => '<p>ok</p>');
    host.registerArticleSection('characters', (c) => ({ title: 'T', html: c.name }));
    host.registerFragmentOp('characters:body', { op: 'wrap', render: (html) => `[${html}]` });
    host.registerWikiKind('rule', (label) => ({ kind: 'pravidla', id: label.toLowerCase() }));
  }, { id: 'x' });
  const smoke = smokeRegistrations(rec);
  assert.equal(smoke.ok, true, JSON.stringify(smoke.failures));
});

test('smokeRegistrations: flags a renderer that throws on benign input', () => {
  const { rec } = dryRunRegister((host) => {
    host.registerArticleSection('characters', (c) => ({ html: c.missing.deep })); // throws
    host.registerRoute('safe', () => 'fine');
  }, { id: 'x' });
  const smoke = smokeRegistrations(rec);
  assert.equal(smoke.ok, false);
  assert.equal(smoke.failures.length, 1);
  assert.equal(smoke.failures[0].kind, 'articleSection');
});

test('smokeRegistrations: does NOT invoke actions (side effects)', () => {
  let called = false;
  const { rec } = dryRunRegister((host) => {
    host.registerAction('boom', () => { called = true; throw new Error('should not run'); });
  }, { id: 'x' });
  const smoke = smokeRegistrations(rec);
  assert.equal(called, false);
  assert.equal(smoke.ok, true);
});

test('mock host.use matches live declared/missing/loaded dependency behavior', () => {
  const undeclared = createMockHost({ id: 'consumer' }, { deps: { provider: { ok: true } } }).host;
  assert.throws(() => undeclared.use('provider'), /nedeklaroval závislost/);

  const hardMissing = createMockHost({ id: 'consumer', dependencies: { provider: '*' } }).host;
  assert.throws(() => hardMissing.use('provider'), /není načtená/);

  const optionalMissing = createMockHost({ id: 'consumer', optionalDependencies: { provider: '*' } }).host;
  assert.throws(() => optionalMissing.use('provider'), /není načtená/);

  const api = { apiVersion: 1 };
  const loaded = createMockHost(
    { id: 'consumer', optionalDependencies: { provider: '*' } },
    { deps: { provider: api } },
  ).host;
  assert.equal(loaded.use('provider'), api);
});

test('mock collection declaration validation matches the live contract', () => {
  const { host } = createMockHost({
    id: 'collections-addon',
    permissions: ['data:own'],
    collections: [{ name: 'notes', keyed: false }],
  });
  assert.throws(() => host.registerCollection('missing'), /not declared/);
  assert.throws(() => host.store.collection('notes'), /not registered/);
  host.registerCollection('notes');
  assert.throws(() => host.registerCollection('notes'), /already registered/);
  assert.doesNotThrow(() => host.store.collection('notes'));
});

test('collection facade rejects missing data:own permission before registration or CRUD', () => {
  const { host } = createMockHost({
    id: 'ungranted-collections',
    permissions: [],
    collections: [{ name: 'notes', keyed: false }],
  });
  assert.throws(() => host.registerCollection('notes'), /data:own/);
  assert.throws(() => host.store.collection('notes'), /not registered/);
});

test('mock DM collections enforce capability, declaration, role, and keyed/list CRUD', () => {
  const meta = {
    id: 'dm-collections',
    version: '1.0.0',
    apiVersion: 2,
    hostVersion: '>=1.0.0',
    capabilities: { required: ['collections.dm'] },
    permissions: ['data:own'],
    collections: [
      { name: 'list', keyed: false, access: 'dm' },
      { name: 'keyed', keyed: true, access: 'dm' },
    ],
  };
  assert.throws(
    () => createMockHost(meta, { isDM: true, capabilities: ['lifecycle.dispose', 'content.revision'] }),
    /collections\.dm.*unavailable/,
  );

  const dm = createMockHost(meta, { isDM: true }).host;
  dm.registerCollection('list');
  dm.registerCollection('keyed');
  const list = dm.store.collection('list');
  const keyed = dm.store.collection('keyed');
  const listItem = list.save({ name: 'List item' });
  const keyedItem = keyed.save({ id: 'main', value: 7 });
  assert.equal(list.get(listItem.id).name, 'List item');
  assert.equal(keyed.get(keyedItem.id).value, 7);
  list.remove(listItem.id);
  keyed.remove(keyedItem.id);
  assert.deepEqual(list.list(), []);
  assert.deepEqual(keyed.list(), []);

  const player = createMockHost(meta, {
    isDM: false,
    fixtures: { 'collection:list': [{ id: 'secret', name: 'Hidden' }] },
  }).host;
  player.registerCollection('list');
  const hidden = player.store.collection('list');
  assert.deepEqual(hidden.list(), []);
  assert.equal(hidden.get('secret'), null);
  assert.throws(() => hidden.save({ id: 'x' }), /not available for this role/);
  assert.throws(() => hidden.remove('secret'), /not available for this role/);
});

test('mock lifecycle models capabilities, content revision, LIFO disposal, and isolation', async () => {
  const calls = [];
  const { host, rec } = createMockHost({
    id: 'lifecycle-addon',
    version: '1.0.0',
    apiVersion: 2,
    hostVersion: '>=1.0.0',
    capabilities: { required: ['lifecycle.dispose', 'content.revision'] },
    contentRevision: 'revision-7',
  });
  assert.equal(host.capabilities.has('lifecycle.dispose'), true);
  assert.equal(host.capabilities.has('content.revision'), true);
  assert.equal(host.capabilities.has('collections.dm'), true);
  assert.equal(host.contentRevision, 'revision-7');
  host.onDispose(() => { calls.push('first'); });
  host.onDispose(async () => { calls.push('second'); throw new Error('expected'); });
  const result = await disposeMockHost(rec);
  assert.deepEqual(calls, ['second', 'first']);
  assert.equal(result.errors.length, 1);
  assert.equal((await disposeMockHost(rec)).started, false, 'repeated disposal is idempotent');
});

test('mock lifecycle bounds hung async cleanup without skipping other disposers', async () => {
  const calls = [];
  const { host, rec } = createMockHost({ id: 'hung-addon' });
  host.onDispose(() => { calls.push('first'); });
  host.onDispose(() => new Promise(() => {}));
  host.onDispose(() => { calls.push('last'); });
  const result = await disposeMockHost(rec, { timeoutMs: 10 });
  assert.equal(result.timedOut, true);
  assert.deepEqual(calls, ['last', 'first'], 'all cleanup functions are invoked despite one hung promise');
});
