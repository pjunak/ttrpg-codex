'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { startServer } = require('./helpers/server-process.cjs');

const DM = 'dm-pass';

async function loginDM(srv) {
  const res = await srv.fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DM }),
  });
  assert.equal(res.status, 200);
}

test('world map upload: server path remains functional and a later error preserves the current image', async () => {
  const srv = await startServer({ dmPassword: DM, playerPassword: 'player-pass' });
  try {
    await loginDM(srv);
    const bytes = Buffer.from('server-hosted-world-map');
    const form = new FormData();
    form.append('worldmap', new Blob([bytes], { type: 'image/png' }), 'campaign.png');

    const uploaded = await srv.fetch('/api/worldmap', { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    assert.deepEqual(await uploaded.json(), {
      url: '/maps/swordcoast/sword_coast.png',
    });

    const imagePath = path.join(srv.dataDir, 'maps', 'swordcoast', 'sword_coast.png');
    assert.deepEqual(await fsp.readFile(imagePath), bytes);

    const failed = await srv.fetch('/api/worldmap', {
      method: 'POST',
      body: new FormData(),
    });
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { error: 'No image received' });
    assert.deepEqual(await fsp.readFile(imagePath), bytes);
  } finally {
    await srv.kill();
  }
});

test('world map upload: the server keeps the documented 40 MB cap', async () => {
  const server = await fsp.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  const uploadBlock = server.match(/const uploadWorldMap = multer\(\{[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(uploadBlock, /fileSize:\s*40 \* 1024 \* 1024/);
});
