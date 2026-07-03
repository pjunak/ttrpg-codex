'use strict';

// Integration: host-served declarative addon content (manifest `contentDir`).
// A data addon (rulebook) ships a per-record JSON tree and NO server code; the
// HOST answers /api/addon/<id>/{content,content/:kind,item/:kind/:id,kinds}.
// Covers: the four endpoints (anonymous — content is public statics), kind
// grouping + id index, disabled addons serving nothing, and precedence (a live
// server router beats host-served content entirely).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { startServer } = require('./helpers/server-process.cjs');

const registry = (addons) => ({ schema: 1, addons, resolutions: {}, sources: { allow: [] } });

function bookEntry(over) {
  return Object.assign({
    id: 'book', name: 'Book', version: '0.1.0', apiVersion: 1, enabled: true,
    entry: 'entry.js', server: null, contentDir: 'data', activeHash: 'h1',
    grantedPermissions: [], serverDeps: [],
  }, over || {});
}

const TREE = {
  'addons/book/h1/data/spells/fireball.json': JSON.stringify({ id: 'fireball', kind: 'spell', name: 'Fireball', level: 3 }),
  'addons/book/h1/data/spells/bless.json':    JSON.stringify({ id: 'bless', kind: 'spell', name: 'Bless', level: 1 }),
  // no kind field → grouped under the dir name
  'addons/book/h1/data/monsters/aboleth.json': JSON.stringify({ id: 'aboleth', name: 'Aboleth' }),
  // corrupt file — skipped, never fatal
  'addons/book/h1/data/rules/broken.json': '{ not valid json',
};

test('content addon: host serves the four endpoints, anonymously, with kind grouping', async () => {
  const srv = await startServer({
    seedData:  { 'addons.json': registry([bookEntry()]) },
    seedFiles: TREE,
  });
  try {
    // Whole library (anonymous fetch — content is as public as the static mount).
    const all = await (await srv.fetch('/api/addon/book/content')).json();
    assert.deepEqual(all.spell.map(s => s.id), ['bless', 'fireball'], 'spells present, sorted by id');
    assert.equal(all.monsters[0].id, 'aboleth', 'kind-less record under its dir name');
    assert.ok(!all.rules, 'corrupt-only kind absent');

    // One kind + unknown kind.
    const spells = await (await srv.fetch('/api/addon/book/content/spell')).json();
    assert.equal(spells.length, 2);
    assert.deepEqual(await (await srv.fetch('/api/addon/book/content/nope')).json(), [], 'unknown kind → []');

    // One item + 404.
    const fb = await srv.fetch('/api/addon/book/item/spell/fireball');
    assert.equal(fb.status, 200);
    assert.equal((await fb.json()).level, 3);
    assert.equal((await srv.fetch('/api/addon/book/item/spell/nope')).status, 404);

    // Kinds diagnostic.
    const kinds = (await (await srv.fetch('/api/addon/book/kinds')).json()).kinds;
    assert.ok(kinds.includes('spell') && kinds.includes('monsters'));

    // Unmatched sub-path still a JSON 404.
    const miss = await srv.fetch('/api/addon/book/other');
    assert.equal(miss.status, 404);
    assert.ok((miss.headers.get('content-type') || '').includes('application/json'));

    // Public list surfaces the declarative content (and no server code).
    const a = (await (await srv.fetch('/api/addons')).json()).addons.find(x => x.id === 'book');
    assert.equal(a.contentDir, 'data');
    assert.equal(a.server, false);
    assert.equal(a.serverState, null);
  } finally { await srv.kill(); }
});

test('content addon: disabled serves nothing', async () => {
  const srv = await startServer({
    seedData:  { 'addons.json': registry([bookEntry({ enabled: false })]) },
    seedFiles: TREE,
  });
  try {
    assert.equal((await srv.fetch('/api/addon/book/content')).status, 404);
  } finally { await srv.kill(); }
});

test('precedence: a live server router beats host-served content entirely', async () => {
  const SERVER = `'use strict';
module.exports.init = (host) => {
  host.get('/content', (_req, res) => res.json({ mine: true }));
};`;
  const srv = await startServer({
    seedData: { 'addons.json': registry([bookEntry({
      server: 'server/index.cjs', grantedPermissions: ['server:code'],
    })]) },
    seedFiles: { ...TREE, 'addons/book/h1/server/index.cjs': SERVER },
  });
  try {
    const body = await (await srv.fetch('/api/addon/book/content')).json();
    assert.deepEqual(body, { mine: true }, 'the addon router answered, not the host content');
    // …and paths the router does NOT define 404 via the router (no content fallback).
    assert.equal((await srv.fetch('/api/addon/book/kinds')).status, 404);
  } finally { await srv.kill(); }
});
