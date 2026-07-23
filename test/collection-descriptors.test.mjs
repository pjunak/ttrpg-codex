import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { CollectionDescriptors } from '../web/js/collection-descriptors.js';

const EXPECTED = [
  { collection: 'characters',       kind: 'postava',            routePrefix: 'postava',            aliases: [] },
  { collection: 'locations',        kind: 'misto',              routePrefix: 'misto',              aliases: [] },
  { collection: 'events',           kind: 'udalost',            routePrefix: 'udalost',            aliases: [] },
  { collection: 'mysteries',        kind: 'zahada',             routePrefix: 'zahada',             aliases: [] },
  { collection: 'factions',         kind: 'frakce',             routePrefix: 'frakce',             aliases: ['frakce-id'] },
  { collection: 'pantheon',         kind: 'buh',                routePrefix: 'buh',                aliases: [] },
  { collection: 'artifacts',        kind: 'artefakt',           routePrefix: 'artefakt',           aliases: [] },
  { collection: 'historicalEvents', kind: 'historicka-udalost', routePrefix: 'historicka-udalost', aliases: [] },
];

test('descriptors cover every built-in routable collection', () => {
  assert.deepEqual(
    CollectionDescriptors.all.map(({ collection, kind, routePrefix, aliases }) => ({
      collection,
      kind,
      routePrefix,
      aliases: [...aliases],
    })),
    EXPECTED,
  );
});

test('collection keys, kinds, aliases, and route identities are unique', () => {
  const collections = CollectionDescriptors.all.map(d => d.collection);
  const kinds = CollectionDescriptors.all.flatMap(d => [d.kind, ...d.aliases]);
  const aliases = CollectionDescriptors.all.flatMap(d => d.aliases);
  const routes = CollectionDescriptors.all.map(d => d.routePrefix);

  assert.equal(new Set(collections).size, collections.length);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.equal(new Set(aliases).size, aliases.length);
  assert.equal(new Set(routes).size, routes.length);
});

test('lookup by collection returns the canonical descriptor', () => {
  for (const expected of EXPECTED) {
    assert.equal(CollectionDescriptors.forCollection(expected.collection)?.kind, expected.kind);
  }
});

test('lookup by kind and supported aliases returns the same descriptor', () => {
  for (const expected of EXPECTED) {
    const descriptor = CollectionDescriptors.forKind(expected.kind);
    assert.equal(descriptor, CollectionDescriptors.forCollection(expected.collection));
    for (const alias of expected.aliases) {
      assert.equal(CollectionDescriptors.forKind(alias), descriptor);
    }
  }
  assert.equal(
    CollectionDescriptors.forKind('frakce-id'),
    CollectionDescriptors.forCollection('factions'),
  );
});

test('route construction preserves every public article route', () => {
  for (const expected of EXPECTED) {
    assert.equal(
      CollectionDescriptors.routeForCollection(expected.collection),
      `/${expected.routePrefix}`,
    );
    assert.equal(
      CollectionDescriptors.routeForCollection(expected.collection, 'entity_1'),
      `/${expected.routePrefix}/entity_1`,
    );
    assert.equal(
      CollectionDescriptors.routeForKind(expected.kind, 'entity_1'),
      `/${expected.routePrefix}/entity_1`,
    );
    for (const alias of expected.aliases) {
      assert.equal(
        CollectionDescriptors.routeForKind(alias, 'entity_1'),
        `/${expected.routePrefix}/entity_1`,
      );
    }
  }
});

test('unknown collections and kinds do not acquire fallback routes', () => {
  assert.equal(CollectionDescriptors.forCollection('pets'), null);
  assert.equal(CollectionDescriptors.forCollection('addon:notes'), null);
  assert.equal(CollectionDescriptors.forKind('pravidla'), null);
  assert.equal(CollectionDescriptors.routeForCollection('missing', 'x'), null);
  assert.equal(CollectionDescriptors.routeForKind('missing', 'x'), null);
});

test('the registry, descriptors, and alias arrays are immutable', () => {
  const descriptor = CollectionDescriptors.forCollection('characters');
  assert.ok(Object.isFrozen(CollectionDescriptors));
  assert.ok(Object.isFrozen(CollectionDescriptors.all));
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.aliases));
  assert.throws(() => { descriptor.routePrefix = 'changed'; }, TypeError);
  assert.throws(() => { descriptor.aliases.push('changed'); }, TypeError);
  assert.equal(CollectionDescriptors.routeForCollection('characters', 'x'), '/postava/x');
});

test('edit-form twin links use the canonical route and reject unknown collections', async () => {
  globalThis.window = globalThis.window || {
    addEventListener: () => {},
    dispatchEvent: () => {},
    location: { hash: '' },
  };
  globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  globalThis.document = globalThis.document || {
    addEventListener: () => {},
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({}),
    body: { appendChild: () => {} },
  };

  const { EditTemplates } = await import('../web/js/edit_templates.js');
  const html = EditTemplates.twinHeaderRow(
    'character_1',
    { id: 'character_1', linkedTwinId: 'character_2', visibility: 'public' },
    'characters',
  );

  assert.match(html, /href="#\/postava\/character_2"/);
  assert.equal(
    EditTemplates.twinHeaderRow(
      'pet_1',
      { id: 'pet_1', linkedTwinId: 'pet_2', visibility: 'public' },
      'pets',
    ),
    '',
  );
});

test('route consumers use the canonical registry and retain addon fallthrough', async () => {
  const consumers = [
    'app.js',
    'wiki.js',
    'edit_templates.js',
    'editmode.js',
    'search.js',
    'store.js',
    'settings.js',
  ];
  const sources = Object.fromEntries(await Promise.all(consumers.map(async file => [
    file,
    await readFile(new URL(`../web/js/${file}`, import.meta.url), 'utf8'),
  ])));

  for (const [file, source] of Object.entries(sources)) {
    assert.match(source, /from '\.\/collection-descriptors\.js'/, `${file} imports the registry`);
    assert.match(source, /CollectionDescriptors\./, `${file} consumes the registry`);
  }

  const appSource = sources['app.js'];
  assert.match(
    appSource,
    /CollectionDescriptors\.forCollection\([\s\S]*Addons\.resolveWikiLink\(/,
    'built-in lookup still falls through to addon wiki-kind resolution',
  );
});
