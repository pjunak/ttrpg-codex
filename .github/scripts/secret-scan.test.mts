import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = resolve(root, '.gitleaks.toml');
const binary = process.env['GITLEAKS_BINARY'] || 'gitleaks';
const fixture = 'frontend/test/browser/installed-character-storage-fixture.mts';
const focus = ['inventory', 'dagger', 'move'].join('/');
const selector = `const move = sheet.locator('[data-focus-key="${focus}"]');`;
// This deterministic value exists only in disposable scanner fixtures.
const synthetic = createHash('sha256').update('Codex scanner regression, never a credential').digest('hex');

function scan(path: string, source: string, useRepositoryConfig: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-secret-scan-'));
  try {
    const content = join(directory, 'source'), target = join(content, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    const defaults = join(directory, 'defaults.toml');
    writeFileSync(defaults, '[extend]\nuseDefault = true\n');
    const report = join(directory, 'report.json');
    const result = spawnSync(binary, ['dir', '--no-banner', '--redact', '--exit-code=2',
      '--config', useRepositoryConfig ? config : defaults, '--report-format=json',
      '--report-path', report, '.'], { cwd: content, encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.ok(result.status === 0 || result.status === 2,
      'Gitleaks must complete the scan: ' + result.stderr);
    const findings = JSON.parse(readFileSync(report, 'utf8')) as { RuleID: string; Secret: string }[];
    assert.equal(result.status, findings.length ? 2 : 0);
    for (const finding of findings) assert.equal(finding.Secret, 'REDACTED');
    return findings.map(finding => finding.RuleID);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the production scanner still reproduces the original selector false positive', () => {
  assert.deepEqual(scan(fixture, selector, false), ['generic-api-key']);
});

test('only the reviewed selector is allowed in its storage fixture', () => {
  assert.deepEqual(scan(fixture, selector, true), []);
});

test('other generic credentials in the same file are still detected', () => {
  assert.deepEqual(scan(fixture, selector + '\nconst api_key = "' + synthetic + '";', true), ['generic-api-key']);
});

test('the selector exception does not exempt a different path or value', () => {
  assert.deepEqual(scan('frontend/src/credentials.mts', selector, true), ['generic-api-key']);
  assert.deepEqual(scan(fixture, selector.replace(focus, focus + '/' + synthetic), true), ['generic-api-key']);
});

test('provider-specific credential rules remain enabled in the same file', () => {
  const token = 'ghp_' + synthetic.slice(0, 36);
  assert.ok(scan(fixture, selector + '\nconst credential = "' + token + '";', true).includes('github-pat'));
});
