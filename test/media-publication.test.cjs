'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fsp = fs.promises;
const { CampaignRestoreManager } = require('../server/campaign-restore.cjs');
const {
  MediaPublicationService,
  acceptsImage,
  imageExtension,
} = require('../server/media-publication.cjs');
const { PublicationBarrier } = require('../server/publication-barrier.cjs');

async function createFixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-media-'));
  const dataDir = path.join(root, 'data');
  const stagingRoot = path.join(root, 'staging');
  const runtimeDir = path.join(dataDir, '.runtime', 'media');
  await fsp.mkdir(runtimeDir, { recursive: true });
  const manager = new CampaignRestoreManager({
    dataDir,
    runtimeDir,
    publicationBarrier: new PublicationBarrier(),
    fault: options.fault,
  });
  return {
    root,
    dataDir,
    stagingRoot,
    runtimeDir,
    service: new MediaPublicationService({ dataDir, stagingRoot, manager }),
  };
}

test('media image validation normalizes supported extensions and MIME fallbacks', () => {
  assert.equal(acceptsImage({ mimetype: 'image/png' }), true);
  assert.equal(acceptsImage({ mimetype: 'text/html' }), false);
  assert.equal(imageExtension({
    originalname: 'portrait.JPEG',
    mimetype: 'image/jpeg',
  }, '.png'), '.jpg');
  assert.equal(imageExtension({
    originalname: 'portrait',
    mimetype: 'image/webp',
  }, '.png'), '.webp');
});

test('media replacement and multi-file publication leave one complete durable state', async t => {
  const fixture = await createFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  const targetDir = path.join(fixture.dataDir, 'maps', 'swordcoast');
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(path.join(targetDir, 'sword_coast.png'), 'old');
  const staged = path.join(fixture.stagingRoot, '.upload-new');
  await fsp.mkdir(fixture.stagingRoot, { recursive: true });
  await fsp.writeFile(staged, 'new');

  assert.equal(await fixture.service.publishReplacement({
    stagedPath: staged,
    relativeDir: 'maps/swordcoast',
    baseName: 'sword_coast',
    extension: '.jpg',
  }), 'maps/swordcoast/sword_coast.jpg');
  assert.equal(await fsp.readFile(path.join(targetDir, 'sword_coast.jpg'), 'utf8'), 'new');
  await assert.rejects(fsp.stat(path.join(targetDir, 'sword_coast.png')), { code: 'ENOENT' });
  await assert.rejects(fsp.stat(staged), { code: 'ENOENT' });

  await fixture.service.publishBuffers({
    relativeDir: 'icons/town',
    files: [
      { name: 'one.svg', content: Buffer.from('one') },
      { name: 'two.svg', content: Buffer.from('two') },
    ],
  });
  assert.equal(await fsp.readFile(path.join(fixture.dataDir, 'icons', 'town', 'one.svg'), 'utf8'), 'one');
  assert.equal(await fsp.readFile(path.join(fixture.dataDir, 'icons', 'town', 'two.svg'), 'utf8'), 'two');
  await fixture.service.removeFiles([
    'icons/town/one.svg',
    'icons/town/two.svg',
  ]);
  await assert.rejects(
    fsp.stat(path.join(fixture.dataDir, 'icons', 'town', 'one.svg')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fsp.stat(path.join(fixture.dataDir, 'icons', 'town', 'two.svg')),
    { code: 'ENOENT' },
  );
  assert.deepEqual(await fsp.readdir(fixture.runtimeDir), []);
});

test('failed media replacement restores the previous file and cleans staging', async t => {
  const fixture = await createFixture({
    fault: async phase => {
      if (phase === 'publish:0:after') throw new Error('injected media failure');
    },
  });
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  const targetDir = path.join(fixture.dataDir, 'branding');
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(path.join(targetDir, 'logo.png'), 'old');
  const staged = path.join(fixture.stagingRoot, '.upload-new');
  await fsp.mkdir(fixture.stagingRoot, { recursive: true });
  await fsp.writeFile(staged, 'new');

  await assert.rejects(fixture.service.publishReplacement({
    stagedPath: staged,
    relativeDir: 'branding',
    baseName: 'logo',
    extension: '.jpg',
  }), /injected media failure/);
  assert.equal(await fsp.readFile(path.join(targetDir, 'logo.png'), 'utf8'), 'old');
  await assert.rejects(fsp.stat(path.join(targetDir, 'logo.jpg')), { code: 'ENOENT' });
  await assert.rejects(fsp.stat(staged), { code: 'ENOENT' });
});
