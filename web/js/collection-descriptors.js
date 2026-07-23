export const CollectionDescriptors = (() => {
  const all = Object.freeze([
    { collection: 'characters',       kind: 'postava',            routePrefix: 'postava',            aliases: [] },
    { collection: 'locations',        kind: 'misto',              routePrefix: 'misto',              aliases: [] },
    { collection: 'events',           kind: 'udalost',            routePrefix: 'udalost',            aliases: [] },
    { collection: 'mysteries',        kind: 'zahada',             routePrefix: 'zahada',             aliases: [] },
    { collection: 'factions',         kind: 'frakce',             routePrefix: 'frakce',             aliases: ['frakce-id'] },
    { collection: 'pantheon',         kind: 'buh',                routePrefix: 'buh',                aliases: [] },
    { collection: 'artifacts',        kind: 'artefakt',           routePrefix: 'artefakt',           aliases: [] },
    { collection: 'historicalEvents', kind: 'historicka-udalost', routePrefix: 'historicka-udalost', aliases: [] },
  ].map(descriptor => Object.freeze({
    ...descriptor,
    aliases: Object.freeze([...descriptor.aliases]),
  })));

  const byCollection = new Map();
  const byKind = new Map();
  const routePrefixes = new Set();

  function _addUnique(map, key, descriptor, identity) {
    if (!key || map.has(key)) {
      throw new Error(`Duplicate or empty built-in collection ${identity}: ${key}`);
    }
    map.set(key, descriptor);
  }

  for (const descriptor of all) {
    _addUnique(byCollection, descriptor.collection, descriptor, 'key');
    _addUnique(byKind, descriptor.kind, descriptor, 'kind');
    for (const alias of descriptor.aliases) {
      _addUnique(byKind, alias, descriptor, 'alias');
    }
    if (!descriptor.routePrefix || routePrefixes.has(descriptor.routePrefix)) {
      throw new Error(`Duplicate or empty built-in collection route: ${descriptor.routePrefix}`);
    }
    routePrefixes.add(descriptor.routePrefix);
  }

  function forCollection(collection) {
    return byCollection.get(collection) || null;
  }

  function forKind(kind) {
    return byKind.get(kind) || null;
  }

  function _route(descriptor, id) {
    if (!descriptor) return null;
    const base = `/${descriptor.routePrefix}`;
    return id === undefined ? base : `${base}/${String(id)}`;
  }

  function routeForCollection(collection, id) {
    return _route(forCollection(collection), id);
  }

  function routeForKind(kind, id) {
    return _route(forKind(kind), id);
  }

  return Object.freeze({
    all,
    forCollection,
    forKind,
    routeForCollection,
    routeForKind,
  });
})();
