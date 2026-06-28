// Unit tests for the published addon test harness (Phase 8). Pure — no DOM.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMockHost, dryRunRegister, smokeRegistrations } from '../web/js/addon-test-harness.mjs';

test('createMockHost: records every register* call', () => {
  const { host, rec } = createMockHost({ id: 'x' });
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
  const { host } = createMockHost({ id: 'rules-addon' }, { fixtures: { 'collection:rules': [{ id: 'seed', name: 'Seed' }] } });
  const rules = host.store.collection('rules');
  assert.equal(rules.list().length, 1, 'seeded from fixtures');

  const saved = rules.save({ name: 'Grappling' });
  assert.ok(saved.id, 'save generates a missing id');
  assert.equal(rules.list().length, 2, 'save is visible on read-back (not a no-op mock)');
  assert.equal(rules.get(saved.id).name, 'Grappling');
  assert.equal(host.store.getCollection('rules').length, 2, 'getCollection sees it too');

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
  const register = () => { throw new Error('bad register'); };
  const r = dryRunRegister(register, { id: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /bad register/);
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
