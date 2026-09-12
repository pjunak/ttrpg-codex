import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { builtAddonArchive, inspectAddonBuilds } from './inspect-addon-builds.mts';

function fixture(t: test.TestContext, id = 'example-addon') {
  const temporaryRoot = resolve(tmpdir());
  const root = mkdtempSync(join(temporaryRoot, 'codex-addon-build-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), temporaryRoot);
    rmSync(root, { recursive: true, force: true });
  });
  const repository = join(root, 'repository with spaces');
  mkdirSync(join(repository, 'dist'), { recursive: true });
  const manifest = (version: string) => writeFileSync(join(repository, 'addon.json'), JSON.stringify({ id, version }));
  const archive = (version: string) => {
    const path = join(repository, 'dist', `${id}-${version}.zip`);
    writeFileSync(path, 'synthetic archive for path selection');
    return path;
  };
  return { repository, manifest, archive };
}

test('inspection follows the current manifest across version changes, ignoring older ZIPs', t => {
  const sample = fixture(t);
  sample.manifest('3.0.0');
  const oldArchive = sample.archive('3.0.0');
  assert.equal(builtAddonArchive(sample.repository), oldArchive);
  sample.manifest('4.0.0-rc.1+build.2');
  const currentArchive = sample.archive('4.0.0-rc.1+build.2');
  const inspected: string[] = [];
  inspectAddonBuilds([sample.repository], archive => { inspected.push(archive); });
  assert.deepEqual(inspected, [currentArchive]);
});

test('an older package cannot stand in for a missing current build', t => {
  const sample = fixture(t);
  sample.manifest('4.0.0');
  sample.archive('3.0.0');
  assert.throws(() => inspectAddonBuilds([sample.repository], () => assert.fail('inspected stale package')),
    /Build the current add-on package before inspection/);
});

test('all requested add-ons are inspected and an inspector rejection fails the gate', t => {
  const first = fixture(t, 'first-addon'), second = fixture(t, 'second-addon');
  first.manifest('3.0.0'); second.manifest('3.1.0');
  const expected = [first.archive('3.0.0'), second.archive('3.1.0')];
  const inspected: string[] = [];
  assert.throws(() => inspectAddonBuilds([first.repository, second.repository], archive => {
    inspected.push(archive);
    if (archive === expected[1]) throw new Error('invalid package');
  }), /invalid package/);
  assert.deepEqual(inspected, expected);
});

test('missing repository arguments or malformed manifest identities fail visibly', t => {
  assert.throws(() => inspectAddonBuilds([]), /Usage:/);
  const sample = fixture(t);
  for (const manifest of [null, [], {}, { id: '../outside', version: '4.0.0' },
    { id: 'example-addon', version: '../outside' }]) {
    writeFileSync(join(sample.repository, 'addon.json'), JSON.stringify(manifest));
    assert.throws(() => builtAddonArchive(sample.repository), /Invalid add-on/);
  }
});
