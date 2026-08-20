import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const settings = readFileSync(join(here, '../web/js/settings.js'), 'utf8');

test('Add-on Manager exposes default and repository-specific GitHub token management', () => {
  assert.match(settings, /function _githubTokenManagerHtml\(\)/);
  assert.match(settings, /id="addon-manager-token-repo"/);
  assert.match(settings, /id="addon-manager-token-input"[^>]+type="password"/);
  assert.match(settings, /Settings\.saveManagedGithubToken/);
  assert.match(settings, /Settings\.removeGithubToken/);
  assert.match(settings, /_githubTokenRepos\.includes\(key\)/);
});

test('install wizard scopes saved credentials to the pasted repository', () => {
  const save = settings.match(/function saveGithubToken\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(save, /addon-wizard-url/);
  assert.match(save, /_postGithubToken\(token, repo,/);
  assert.doesNotMatch(save, /_postGithubToken\(token, 'settings\./);
});
