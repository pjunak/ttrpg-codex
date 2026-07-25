'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/server-process.cjs');

const fsp = fs.promises;
const DM = 'dm-pass';

async function loginDM(server) {
  const response = await server.fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DM }),
  });
  assert.equal(response.status, 200);
}

function imageForm(field, bytes, filename, type) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), filename);
  return form;
}

test('media routes atomically replace, batch-publish, and remove files', async () => {
  const server = await startServer({
    dmPassword: DM,
    seedData: {
      'settings.json': {
        pinTypes: [{ id: 'town', label: 'Town' }],
      },
    },
  });
  try {
    await loginDM(server);

    let response = await server.fetch('/api/portrait/hero', {
      method: 'POST',
      body: imageForm('portrait', 'portrait-one', 'hero.png', 'image/png'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: '/portraits/hero/portrait.png' });

    response = await server.fetch('/api/portrait/hero', {
      method: 'POST',
      body: imageForm('portrait', 'portrait-two', 'hero.jpeg', 'image/jpeg'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: '/portraits/hero/portrait.jpg' });
    const portraitDir = path.join(server.dataDir, 'portraits', 'hero');
    assert.equal(await fsp.readFile(path.join(portraitDir, 'portrait.jpg'), 'utf8'), 'portrait-two');
    await assert.rejects(fsp.stat(path.join(portraitDir, 'portrait.png')), { code: 'ENOENT' });

    response = await server.fetch('/api/localmap/village', {
      method: 'POST',
      body: imageForm('localmap', 'local-map', 'village.webp', 'image/webp'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: '/maps/local/village/map.webp',
    });

    response = await server.fetch('/api/logo', {
      method: 'POST',
      body: imageForm('logo', 'custom-logo', 'logo.svg', 'image/svg+xml'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: '/branding/logo.svg' });

    const icons = new FormData();
    icons.append('icons', new Blob(['one'], { type: 'image/svg+xml' }), 'Castle.svg');
    icons.append('icons', new Blob(['two'], { type: 'image/svg+xml' }), 'Castle.svg');
    response = await server.fetch('/api/icons/town', {
      method: 'POST',
      body: icons,
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).files.map(file => file.id), [
      'castle.svg',
      'castle-2.svg',
    ]);
    const iconDir = path.join(server.dataDir, 'icons', 'town');
    assert.equal(await fsp.readFile(path.join(iconDir, 'castle.svg'), 'utf8'), 'one');
    assert.equal(await fsp.readFile(path.join(iconDir, 'castle-2.svg'), 'utf8'), 'two');

    assert.equal((await server.fetch('/api/icons/town/castle.svg', {
      method: 'DELETE',
    })).status, 200);
    await assert.rejects(fsp.stat(path.join(iconDir, 'castle.svg')), { code: 'ENOENT' });
    assert.equal((await server.fetch('/api/icons/town', { method: 'DELETE' })).status, 200);
    await assert.rejects(fsp.stat(path.join(iconDir, 'castle-2.svg')), { code: 'ENOENT' });

    assert.equal((await server.fetch('/api/portrait/hero', { method: 'DELETE' })).status, 200);
    await assert.rejects(fsp.stat(path.join(portraitDir, 'portrait.jpg')), { code: 'ENOENT' });
    assert.equal((await server.fetch('/api/logo', { method: 'DELETE' })).status, 200);
    await assert.rejects(
      fsp.stat(path.join(server.dataDir, 'branding', 'logo.svg')),
      { code: 'ENOENT' },
    );
  } finally {
    await server.kill();
  }
});
