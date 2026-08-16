import test from 'node:test';
import assert from 'node:assert/strict';

test('player preview bootstrap scopes API fetches and SSE URL to the current tab token', async () => {
  const values = new Map();
  const calls = [];
  globalThis.window = {
    location: {
      href: 'https://codex.test/?playerPreview=preview-token#/mista',
      origin: 'https://codex.test',
    },
    close() {},
  };
  globalThis.sessionStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  globalThis.history = {
    state: null,
    replaceState(_state, _title, href) {
      globalThis.window.location.href = href;
    },
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200 });
  };

  const { PlayerPreview } = await import(`../web/js/player-preview.js?test=${Date.now()}`);
  assert.equal(PlayerPreview.isActive(), true);
  assert.equal(values.get('playerPreview'), 'preview-token');
  assert.doesNotMatch(globalThis.window.location.href, /playerPreview=/);

  await fetch('/api/data', { headers: { Accept: 'application/json' } });
  assert.equal(new Headers(calls[0].init.headers).get('X-Codex-Player-Preview'), 'preview-token');
  assert.equal(new Headers(calls[0].init.headers).get('Accept'), 'application/json');

  await fetch('https://elsewhere.test/api/data');
  assert.equal(new Headers(calls[1].init?.headers).has('X-Codex-Player-Preview'), false);
  assert.equal(PlayerPreview.apiUrl('/api/events'), '/api/events?playerPreviewToken=preview-token');
  assert.match(PlayerPreview.buildUrl('next-token'), /playerPreview=next-token/);
});
