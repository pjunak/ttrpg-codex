'use strict';

// Integration: SSE + the role-aware refetch loop.
//
// Two clients (one DM, one player) connect to /api/events. The DM
// PATCHes a DM-only entity. The player's SSE event fires, and the
// player's subsequent /api/data call must NOT contain that entity.
// This is the load-bearing assertion that the data layer's
// "broadcast hash, refetch through filter" model actually works
// end-to-end.

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const http       = require('http');
const { startServer } = require('./helpers/server-process.cjs');

const DM     = 'dm-pw';
const PLAYER = 'player-pw';

// Open an EventSource-equivalent on the server with optional cookie.
// Resolves with `{ events: [], close: fn, waitForEvent: name => Promise }`.
// Each line of SSE data is parsed and stashed.
function openSSE(baseUrl, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + '/api/events');
    const req = http.request({
      method:   'GET',
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      headers:  cookie ? { cookie } : {},
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`SSE HTTP ${res.statusCode}`));
      }
      const events = [];
      const waiters = []; // { name, resolve }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          let eventName = 'message', dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!eventName || (eventName === 'message' && !dataStr)) continue;
          let data;
          try { data = dataStr ? JSON.parse(dataStr) : null; } catch (_) { data = dataStr; }
          const ev = { event: eventName, data };
          events.push(ev);
          // Resolve any matching waiters in arrival order.
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].name === eventName) {
              waiters[i].resolve(ev);
              waiters.splice(i, 1);
            }
          }
        }
      });
      const handle = {
        events,
        close: () => { try { req.destroy(); } catch (_) {} try { res.destroy(); } catch (_) {} },
        waitForEvent: (name, timeoutMs = 3000) => new Promise((res2, rej2) => {
          // Already in events?
          const hit = events.find(e => e.event === name && (e !== handle._lastDelivered));
          if (hit) { handle._lastDelivered = hit; return res2(hit); }
          const w = { name, resolve: (e) => { handle._lastDelivered = e; res2(e); } };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) { waiters.splice(i, 1); rej2(new Error(`SSE ${name} timeout`)); }
          }, timeoutMs);
        }),
      };
      resolve(handle);
    });
    req.on('error', reject);
    req.end();
  });
}

async function loginAs(baseUrl, password) {
  // Need a separate fetch (no cookie jar coupling) so we can extract
  // the cookie and use it on subsequent requests independently.
  const res = await fetch(baseUrl + '/api/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie     = setCookies.length ? setCookies[0].split(';')[0] : '';
  return cookie;
}

test('SSE: hello event delivers current dataset hash on connect', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const sse = await openSSE(srv.baseUrl);
    try {
      const ev = await sse.waitForEvent('hello');
      assert.equal(ev.event, 'hello');
      assert.equal(typeof ev.data.hash, 'string');
      assert.match(ev.data.hash, /^[0-9a-f]{16}$/);
    } finally { sse.close(); }
  } finally { await srv.kill(); }
});

test('SSE: data-changed fires after a PATCH, refetch under each role respects the filter', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const dmCookie     = await loginAs(srv.baseUrl, DM);
    const playerCookie = await loginAs(srv.baseUrl, PLAYER);

    // Player listens for the upcoming change.
    const playerSse = await openSSE(srv.baseUrl, playerCookie);
    const dmSse     = await openSSE(srv.baseUrl, dmCookie);
    try {
      // Drain hello events first so waitForEvent('data-changed') doesn't
      // accidentally pick up a buffered 'hello'.
      await playerSse.waitForEvent('hello');
      await dmSse.waitForEvent('hello');

      // DM creates a DM-only entity.
      const patch = await fetch(srv.baseUrl + '/api/data', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: dmCookie },
        body:    JSON.stringify({
          type: 'characters', action: 'save',
          payload: {
            id: 'spy', name: 'Hidden Spy', faction: 'cult',
            description: 'Plot detail.',
            visibility: 'dm', secrets: {},
          },
        }),
      });
      assert.equal(patch.status, 200);

      // Both clients should receive a data-changed event.
      const playerEvent = await playerSse.waitForEvent('data-changed');
      const dmEvent     = await dmSse.waitForEvent('data-changed');
      assert.equal(playerEvent.event, 'data-changed');
      assert.equal(dmEvent.event,     'data-changed');
      // Change tokens are projections of what each role may read.
      assert.notEqual(playerEvent.data.hash, dmEvent.data.hash);

      // Player refetches → DM-only spy is absent.
      const playerData = await (await fetch(srv.baseUrl + '/api/data', { headers: { cookie: playerCookie } })).json();
      assert.equal(playerData.characters.find(c => c.id === 'spy'), undefined);

      // DM refetches → spy present.
      const dmData = await (await fetch(srv.baseUrl + '/api/data', { headers: { cookie: dmCookie } })).json();
      const spy = dmData.characters.find(c => c.id === 'spy');
      assert.ok(spy, 'DM should see the new entity');
      assert.equal(spy.visibility, 'dm');
    } finally {
      playerSse.close();
      dmSse.close();
    }
  } finally { await srv.kill(); }
});

test('SSE: anonymous client also receives data-changed and refetches filtered payload', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: PLAYER });
  try {
    const dmCookie = await loginAs(srv.baseUrl, DM);

    // Anonymous SSE — no cookie at all.
    const anon = await openSSE(srv.baseUrl);
    try {
      await anon.waitForEvent('hello');

      const patch = await fetch(srv.baseUrl + '/api/data', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: dmCookie },
        body:    JSON.stringify({
          type: 'characters', action: 'save',
          payload: {
            id: 'pub_n', name: 'Public NPC', faction: 'neutral',
            visibility: 'public', secrets: {},
          },
        }),
      });
      assert.equal(patch.status, 200);

      const ev = await anon.waitForEvent('data-changed');
      assert.equal(ev.event, 'data-changed');

      const data = await (await fetch(srv.baseUrl + '/api/data')).json();
      assert.ok(data.characters.find(c => c.id === 'pub_n'), 'anonymous should see public entities');
    } finally { anon.close(); }
  } finally { await srv.kill(); }
});

test('SSE: a DM-only addon mutation notifies only DM and preserves the player hash', async () => {
  const addons = {
    schema: 1,
    addons: [{
      id: 'dm-fixture',
      name: 'DM Fixture',
      version: '1.0.0',
      apiVersion: 2,
      hostVersion: '>=1.0.0',
      capabilities: { required: ['collections.dm'] },
      enabled: true,
      entry: 'entry.js',
      activeHash: 'fixture',
      collections: [{ name: 'scenarios', keyed: false, access: 'dm' }],
    }],
    resolutions: {},
    sources: { allow: [] },
  };
  const srv = await startServer({
    dmPassword: DM,
    playerPassword: PLAYER,
    seedData: { 'addons.json': addons },
  });
  try {
    const dmCookie = await loginAs(srv.baseUrl, DM);
    const playerCookie = await loginAs(srv.baseUrl, PLAYER);
    const playerSse = await openSSE(srv.baseUrl, playerCookie);
    const dmSse = await openSSE(srv.baseUrl, dmCookie);
    try {
      const playerHello = await playerSse.waitForEvent('hello');
      await dmSse.waitForEvent('hello');
      const patch = await fetch(srv.baseUrl + '/api/data', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: dmCookie },
        body: JSON.stringify({
          type: 'addon:dm-fixture:scenarios',
          action: 'save',
          payload: { id: 'hidden', name: 'Hidden scenario' },
        }),
      });
      assert.equal(patch.status, 200);
      const dmEvent = await dmSse.waitForEvent('data-changed');
      assert.equal(dmEvent.event, 'data-changed');
      await assert.rejects(playerSse.waitForEvent('data-changed', 250), /timeout/);

      const version = await fetch(srv.baseUrl + '/api/version', {
        headers: { cookie: playerCookie },
      }).then(response => response.json());
      assert.equal(version.hash, playerHello.data.hash);
    } finally {
      playerSse.close();
      dmSse.close();
    }
  } finally { await srv.kill(); }
});

test('SSE: mixed transaction emits one role-scoped event per audience without leaking DM state', async () => {
  const addons = {
    schema: 1,
    addons: [{
      id: 'tx-events',
      name: 'Transaction Events',
      version: '1.0.0',
      apiVersion: 2,
      hostVersion: '>=1.0.0',
      capabilities: { required: ['collections.dm', 'collections.transactions'] },
      enabled: true,
      entry: 'entry.js',
      activeHash: 'fixture',
      grantedPermissions: ['data:own'],
      collections: [
        { name: 'notes', keyed: false, access: 'public' },
        { name: 'secrets', keyed: false, access: 'dm' },
      ],
    }],
    resolutions: {},
    sources: { allow: [] },
  };
  const srv = await startServer({
    dmPassword: DM,
    playerPassword: PLAYER,
    seedData: { 'addons.json': addons },
  });
  try {
    const dmCookie = await loginAs(srv.baseUrl, DM);
    const playerCookie = await loginAs(srv.baseUrl, PLAYER);
    const playerSse = await openSSE(srv.baseUrl, playerCookie);
    const dmSse = await openSSE(srv.baseUrl, dmCookie);
    const request = (cookie, body) => fetch(srv.baseUrl + '/api/addons/tx-events/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    try {
      const playerHello = await playerSse.waitForEvent('hello');
      await dmSse.waitForEvent('hello');
      const opened = await request(dmCookie, {
        mode: 'begin',
        collections: ['notes', 'secrets'],
      }).then(response => response.json());
      const committed = await request(dmCookie, {
        mode: 'commit',
        transactionId: opened.transactionId,
        operations: [
          { collection: 'notes', op: 'put', id: 'public', value: { name: 'Public result' } },
          { collection: 'secrets', op: 'put', id: 'hidden', value: { name: 'Hidden result' } },
        ],
      });
      assert.equal(committed.status, 200);

      const playerEvent = await playerSse.waitForEvent('data-changed');
      const dmEvent = await dmSse.waitForEvent('data-changed');
      assert.notEqual(playerEvent.data.hash, playerHello.data.hash);
      assert.notEqual(dmEvent.data.hash, playerEvent.data.hash);
      assert.equal(playerSse.events.filter(event => event.event === 'data-changed').length, 1);
      assert.equal(dmSse.events.filter(event => event.event === 'data-changed').length, 1);

      const playerRaw = await fetch(srv.baseUrl + '/api/data', {
        headers: { cookie: playerCookie },
      }).then(response => response.text());
      assert.equal(playerRaw.includes('Public result'), true);
      assert.equal(playerRaw.includes('secrets'), false);
      assert.equal(playerRaw.includes('Hidden result'), false);
    } finally {
      playerSse.close();
      dmSse.close();
    }
  } finally {
    await srv.kill();
  }
});

test('SSE: DM-only transaction leaves the player hash and event stream unchanged', async () => {
  const addons = {
    schema: 1,
    addons: [{
      id: 'tx-secret-events',
      name: 'Secret Transaction Events',
      version: '1.0.0',
      apiVersion: 2,
      hostVersion: '>=1.0.0',
      capabilities: { required: ['collections.dm', 'collections.transactions'] },
      enabled: true,
      entry: 'entry.js',
      activeHash: 'fixture',
      grantedPermissions: ['data:own'],
      collections: [{ name: 'secrets', keyed: false, access: 'dm' }],
    }],
    resolutions: {},
    sources: { allow: [] },
  };
  const srv = await startServer({
    dmPassword: DM,
    playerPassword: PLAYER,
    seedData: { 'addons.json': addons },
  });
  try {
    const dmCookie = await loginAs(srv.baseUrl, DM);
    const playerCookie = await loginAs(srv.baseUrl, PLAYER);
    const playerSse = await openSSE(srv.baseUrl, playerCookie);
    const dmSse = await openSSE(srv.baseUrl, dmCookie);
    const request = body => fetch(srv.baseUrl + '/api/addons/tx-secret-events/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: dmCookie },
      body: JSON.stringify(body),
    });
    try {
      const playerHello = await playerSse.waitForEvent('hello');
      await dmSse.waitForEvent('hello');
      const opened = await request({
        mode: 'begin',
        collections: ['secrets'],
      }).then(response => response.json());
      const committed = await request({
        mode: 'commit',
        transactionId: opened.transactionId,
        operations: [
          { collection: 'secrets', op: 'put', id: 'hidden', value: { name: 'Hidden result' } },
        ],
      });
      assert.equal(committed.status, 200);
      await dmSse.waitForEvent('data-changed');
      await assert.rejects(playerSse.waitForEvent('data-changed', 250), /timeout/);
      const playerVersion = await fetch(srv.baseUrl + '/api/version', {
        headers: { cookie: playerCookie },
      }).then(response => response.json());
      assert.equal(playerVersion.hash, playerHello.data.hash);
    } finally {
      playerSse.close();
      dmSse.close();
    }
  } finally {
    await srv.kill();
  }
});
