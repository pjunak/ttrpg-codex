import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const migrationPath = 'internal/storage/sqlite/migrations';

test('Windows and Unix Git checkout modes preserve identical migration bytes', t => {
  const temporaryRoot = resolve(tmpdir());
  const root = mkdtempSync(join(temporaryRoot, 'codex-migration-checkout-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), temporaryRoot);
    rmSync(root, { recursive: true, force: true });
  });
  const repository = join(root, 'source');
  mkdirSync(join(repository, migrationPath), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, windowsHide: true });
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repository, '.gitattributes'), readFileSync(join(source, '.gitattributes')));
  writeFileSync(join(repository, 'ordinary.txt'), 'checkout control\n');
  const filenames = readdirSync(join(source, migrationPath)).filter(name => name.endsWith('.sql'));
  assert.ok(filenames.length > 0);
  for (const name of filenames) {
    const bytes = readFileSync(join(source, migrationPath, name));
    assert.equal(bytes.includes(13), false, name + ' must contain canonical LF bytes before building');
    writeFileSync(join(repository, migrationPath, name), bytes);
  }
  git('add', '.');
  for (const autocrlf of ['true', 'false']) {
    const checkout = join(root, autocrlf);
    mkdirSync(checkout);
    git('-c', 'core.autocrlf=' + autocrlf, '-c', 'core.eol=lf', 'checkout-index', '--all', '--force',
      '--prefix=' + checkout.replaceAll('\\', '/') + '/');
    assert.equal(readFileSync(join(checkout, 'ordinary.txt'), 'utf8'),
      autocrlf === 'true' ? 'checkout control\r\n' : 'checkout control\n');
    for (const name of filenames) assert.deepEqual(readFileSync(join(checkout, migrationPath, name)),
      readFileSync(join(source, migrationPath, name)), autocrlf + ': ' + name);
  }
});
