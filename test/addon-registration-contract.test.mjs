import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMockHost } from '../web/js/addon-test-harness.mjs';
import { AddonRegistrationContract } from '../web/js/addon-registration-contract.js';

const fn = () => '';

const INVALID_REGISTRATIONS = [
  ['route collision', host => host.registerRoute('postava', fn), () => AddonRegistrationContract.route('postava', fn), /built-in route/],
  ['route renderer', host => host.registerRoute('addon-page', null), () => AddonRegistrationContract.route('addon-page', null), /render must be a function/],
  ['sidebar route', host => host.registerSidebarPage({}), () => AddonRegistrationContract.sidebarPage({}), /spec\.route required/],
  ['page kind', host => host.registerPageRenderer('', fn), () => AddonRegistrationContract.pageRenderer('', fn), /kind required/],
  ['article renderer', host => host.registerArticleSection('characters', null), () => AddonRegistrationContract.articleSection('characters', null), /fn must be a function/],
  ['settings renderer', host => host.registerSettingsTab({ id: 'tab' }), () => AddonRegistrationContract.settingsTab({ id: 'tab' }), /spec\.render required/],
  ['action name', host => host.registerAction('', fn), () => AddonRegistrationContract.action('', fn), /name required/],
  ['editor fields', host => host.registerEditorFields('characters', {}), () => AddonRegistrationContract.editorFields('characters', {}), /spec\.fields required/],
  ['fragment operation', host => host.registerFragmentOp('characters:body', { op: 'drop' }), () => AddonRegistrationContract.fragmentOp('characters:body', { op: 'drop' }), /op must be/],
  ['slot renderer', host => host.registerSlot('dm:dashboard', null), () => AddonRegistrationContract.slot('dm:dashboard', null), /render must be a function/],
  ['data kind id', host => host.registerKind('statuses', {}), () => AddonRegistrationContract.kind('statuses', {}), /def\.id required/],
  ['node kind id', host => host.registerNodeKind({}), () => AddonRegistrationContract.nodeKind({}), /def\.id required/],
  ['graph view id', host => host.registerGraphView({}), () => AddonRegistrationContract.graphView({}), /def\.id required/],
  ['graph contributor', host => host.registerGraphContributor('main', null), () => AddonRegistrationContract.graphContributor('main', null), /fn must be a function/],
  ['wiki collision', host => host.registerWikiKind('postava', fn), () => AddonRegistrationContract.wikiKind('postava', fn), /built-in scope/],
];

test('the authoring harness applies every shared registration validator', () => {
  for (const [label, callHarness, callContract, expected] of INVALID_REGISTRATIONS) {
    const { host } = createMockHost({ id: 'contract-test' });
    assert.throws(callContract, expected, `${label}: shared contract`);
    assert.throws(() => callHarness(host), expected, `${label}: harness`);
  }
});

test('shared registration normalization is reflected in harness records', () => {
  const { host, rec } = createMockHost({ id: 'contract-test' });
  host.registerArticleSection('characters', fn, { order: 4 });
  host.registerFragmentOp('characters:body', { op: 'insert', position: 'before', render: fn, order: 7 });
  host.registerSlot('dm:dashboard', fn, { order: 3 });

  assert.equal(rec.articleSections[0].order, 4);
  assert.deepEqual(rec.fragmentOps[0].spec, {
    op: 'insert',
    render: fn,
    order: 7,
    position: 'before',
  });
  assert.deepEqual(rec.slots[0].opts, { order: 3 });
});

test('the harness mirrors live duplicate rejection for keyed registrations', () => {
  const { host } = createMockHost({ id: 'contract-test' });
  const duplicates = [
    () => host.registerSettingsTab({ id: 'same', render: fn }),
    () => host.registerAction('same', fn),
    () => host.registerKind('statuses', { id: 'same' }),
    () => host.registerNodeKind({ id: 'same' }),
    () => host.registerGraphView({ id: 'same' }),
  ];

  for (const register of duplicates) {
    register();
    assert.throws(register, /duplicate/);
  }
});
