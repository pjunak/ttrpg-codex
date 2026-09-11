import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { InstalledFixture } from './fixture-types.mts';
import { installReviewedPackage, jsonResponse, zip } from './installed-graph-fixture.mts';

export function settingsPackage(id: string, mode: string, version = '1.0.0', failure = false, order = 10, dynamic = false): Buffer {
  const files: Record<string, string> = {
    'addon.json': JSON.stringify({ packageFormat: 1, id, name: 'Settings fixture', version,
      compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, capabilities: { required: ['ui.contributions'], optional: [] },
      permissions: [], runtime: { ui: { mode, entry: 'web/index.js' } },
      collections: [{ id: 'options', keyed: true, visibility: 'public', schema: 'contracts/options.json', schemaVersion: '1.0.0' }],
      contributions: [
        { id: 'campaign', surface: 'settings', label: 'Campaign options', roles: ['dm'], order: 20 },
        { id: 'preferences', surface: 'settings', label: 'Shared preferences', roles: ['dm', 'player'], order, config: { labels: { cs: 'Sdílené předvolby' } } },
        ...(dynamic ? [{ id: 'alternate', surface: 'settings', label: 'Alternate options', roles: ['dm', 'player'], order: 100 }] : []),
      ] }),
    'contracts/options.json': JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }),
    'web/index.js': `export function activate(context) {
      const bindings = new Map();
      const tag = 'fixture-settings-' + context.addon.id + '-' + context.addon.generation.slice(0, 8);
      let failOnce = ${failure};
      if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
        set codexContribution(value) {
          if (failOnce && value.contribution.id === 'campaign') { failOnce = false; throw new Error('Private settings failure'); }
          this.context = value;
          if (this.output) this.output.textContent = JSON.stringify(value.host);
        }
        connectedCallback() {
          this.abort = new AbortController();
          const title = document.createElement('h4'); title.textContent = this.context.contribution.label + ' ${version}';
          const scope = document.createElement('p'); scope.textContent = 'Shared options for this website.';
          const label = document.createElement('label'); label.textContent = 'Saved option';
          this.input = document.createElement('input'); this.input.setAttribute('aria-label', 'Saved option'); this.input.style.maxWidth = '100%';
          this.input.disabled = true; label.append(this.input);
          this.output = document.createElement('output'); this.output.setAttribute('aria-label', 'Settings context');
          this.output.style.overflowWrap = 'anywhere';
          this.output.textContent = JSON.stringify(this.context.host);
          this.status = document.createElement('p'); this.status.setAttribute('role', 'status'); this.status.textContent = 'Loading options';
          this.save = document.createElement('button'); this.save.textContent = 'Save option'; this.save.disabled = true;
          this.replaceChildren(title, scope, label, this.save, this.status, this.output);
          if (${dynamic} && this.context.contribution.id === 'alternate') {
            const hide = document.createElement('button'); hide.textContent = 'Hide shared preferences';
            hide.onclick = () => bindings.get('preferences')?.dispose(); this.append(hide);
          }
          this.input.oninput = () => this.context.edits.set({ dirty: true, saving: false });
          const data = context.data.collection('options'), key = this.context.contribution.id;
          data.query({ signal: this.abort.signal }).then(result => {
            if (this.abort.signal.aborted) return;
            const current = result.documents.find(item => item.key === key); this.revision = current?.revision ?? 0;
            this.input.value = current?.value.text ?? ''; this.input.disabled = false; this.save.disabled = false; this.status.textContent = 'Options ready';
          }).catch(() => { if (!this.abort.signal.aborted) this.status.textContent = 'Options failed'; });
          this.save.onclick = async () => {
            this.context.edits.set({ dirty: true, saving: true }); this.input.disabled = true; this.save.disabled = true; this.status.textContent = 'Saving option';
            try {
              const result = await data.put(key, { text: this.input.value }, this.revision, { signal: this.abort.signal });
              if (this.abort.signal.aborted) return;
              this.revision = result.results[0].afterRevision; this.context.edits.set({ dirty: false, saving: false }); this.status.textContent = 'Option saved';
            } catch { if (!this.abort.signal.aborted) { this.context.edits.set({ dirty: true, saving: false }); this.status.textContent = 'Save failed'; } }
            if (!this.abort.signal.aborted) { this.input.disabled = false; this.save.disabled = false; }
          };
        }
        disconnectedCallback() { this.abort?.abort(); }
      });
      for (const declaration of context.ui.declarations()) bindings.set(declaration.id, context.ui.bind(declaration.id, { kind: 'element', tag }));
    }`,
  };
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files)
    .map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')])) });
  return zip(files);
}

export async function exerciseSettings({ t, open, admin, csrf, output, mobile, mode }: InstalledFixture & { mode: string }): Promise<void> {
  const id = `settings-${mode}-${mobile ? 'phone' : 'desktop'}`, headers = { 'X-Codex-CSRF': csrf };
  const install = (version = '1.0.0') => installReviewedPackage(admin, csrf, id, settingsPackage(id, mode, version), []);
  const disable = async () => {
    const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
    if (snapshot.state.activeGenerationId) await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers, data: { expectedStateRevision: snapshot.state.revision } }));
  };
  await install(); t.after(disable);
  const page = await open(t, 'dm', mobile); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto('/#/settings/addons');
  const row = page.locator(`.addon-row[data-addon-id="${id}"]`), dropdown = row.locator('codex-addon-settings');
  const toggle = dropdown.getByRole('button', { name: `Settings for ${id}`, exact: true });
  await toggle.waitFor(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await dropdown.locator('.addon-contribution').count(), 0, 'closed settings are lazy');
  await toggle.focus(); await page.keyboard.press('Enter');
  const panel = dropdown.locator('[data-contribution-id="preferences"]');
  const view = mode === 'isolated' ? panel.frameLocator('iframe') : panel;
  await view.getByText('Options ready', { exact: true }).waitFor();
  assert.deepEqual(await dropdown.locator('.addon-contribution').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.contributionId)), ['preferences', 'campaign']);
  assert.deepEqual(JSON.parse((await view.getByLabel('Settings context').textContent())!), { contractVersion: 'addon-settings-context.v1', locale: 'en', role: 'dm' });
  await view.getByLabel('Saved option').fill('Keep this draft');
  await toggle.focus(); await page.keyboard.press('Space');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('[data-category="language"]').click();
  assert.equal(await toggle.count(), 1, 'category navigation respects collapsed drafts');
  page.once('dialog', dialog => dialog.dismiss()); await row.getByRole('button', { name: 'Reload', exact: true }).click();
  await toggle.click(); assert.equal(await view.getByLabel('Saved option').inputValue(), 'Keep this draft');
  await page.getByRole('button', { name: 'Refresh list', exact: true }).first().click();
  await page.locator('.addon-manager[aria-busy="false"]').waitFor();
  assert.equal(await view.getByLabel('Saved option').inputValue(), 'Keep this draft');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await view.getByRole('button', { name: 'Save option', exact: true }).click(); await view.getByText('Option saved', { exact: true }).waitFor();
  await page.goto(`/#/settings/addons/${id}`); await page.reload();
  await view.getByText('Options ready', { exact: true }).waitFor(); assert.equal(await view.getByLabel('Saved option').inputValue(), 'Keep this draft');

  let release = () => undefined as void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  await page.route(`**/api/addons/${id}/generations/*/data/transactions`, async route => { await held; await route.continue(); });
  await view.getByLabel('Saved option').fill('Durable option'); await view.getByRole('button', { name: 'Save option', exact: true }).click();
  await view.getByText('Saving option', { exact: true }).waitFor();
  await page.locator('[data-category="language"]').click(); assert.equal(await dropdown.count(), 1);
  await row.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('Wait for the add-on save to finish before changing installed add-ons.', { exact: true }).waitFor();
  release(); await view.getByText('Option saved', { exact: true }).waitFor(); await page.unrouteAll({ behavior: 'wait' });
  if (mode === 'isolated') {
    const frameHeight = (await panel.locator('iframe').boundingBox())!.height;
    assert.ok(frameHeight < 450, `settings frames size to content: ${frameHeight}`);
    assert.equal(await view.locator('body').evaluate(element => element.scrollHeight > window.innerHeight), false, 'content is not clipped by iframe margins');
  }
  await dropdown.screenshot({ path: resolve(output, `settings-${mode}-${mobile ? 'phone' : 'desktop'}.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);

  const player = await open(t, 'player', mobile), adminRequests: string[] = [];
  player.on('request', request => { if (request.url().includes('/api/admin/')) adminRequests.push(request.url()); });
  await player.goto(`/#/settings/addons/${id}`);
  const playerSettings = player.locator(`.addon-row[data-addon-id="${id}"] codex-addon-settings`);
  const playerPanel = playerSettings.locator('[data-contribution-id="preferences"]');
  const playerView = mode === 'isolated' ? playerPanel.frameLocator('iframe') : playerPanel;
  await playerView.getByText('Options ready', { exact: true }).waitFor();
  assert.equal(await playerView.getByLabel('Saved option').inputValue(), 'Durable option');
  assert.equal(await playerSettings.locator('[data-contribution-id="campaign"]').count(), 0);
  assert.equal(await player.locator('codex-addon-github, codex-addon-configuration, .addon-upload').count(), 0);
  assert.deepEqual(adminRequests, []);
  assert.deepEqual(JSON.parse((await playerView.getByLabel('Settings context').textContent())!).role, 'player');
  await player.locator('[data-category="language"]').click();
  await player.locator('.settings-preference-field select').selectOption('cs');
  await player.locator('[data-category="addons"]').click();
  await playerSettings.getByRole('button', { name: `Nastavení doplňku ${id}`, exact: true }).waitFor();
  await playerSettings.locator('.addon-contribution-heading strong').getByText('Sdílené předvolby', { exact: true }).waitFor();
  assert.equal(JSON.parse((await playerView.getByLabel('Settings context').textContent())!).locale, 'cs');
  await player.locator('[data-category="language"]').click();
  await player.locator('.settings-preference-field select').selectOption('en');
  await player.locator('[data-category="addons"]').click();

  await view.getByLabel('Saved option').fill('Retired generation draft');
  await install('1.0.1');
  await view.getByRole('heading', { name: 'Shared preferences 1.0.1', exact: true }).waitFor();
  await view.getByText('Options ready', { exact: true }).waitFor();
  assert.equal(await view.getByLabel('Saved option').inputValue(), 'Durable option');
  await page.locator('[data-category="language"]').click(); await dropdown.waitFor({ state: 'detached' });
  await page.locator('[data-category="addons"]').click(); await view.getByText('Options ready', { exact: true }).waitFor();
  await disable(); await toggle.waitFor({ state: 'detached' });
  await playerSettings.waitFor({ state: 'detached' });
  await player.getByText('These settings are unavailable.', { exact: false }).waitFor();
}

export async function exerciseSettingsFailure({ t, open, admin, csrf }: InstalledFixture): Promise<void> {
  const id = 'settings-failure';
  await installReviewedPackage(admin, csrf, id, settingsPackage(id, 'integrated', '1.0.0', true), []);
  t.after(async () => {
    const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
    await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: snapshot.state.revision } }));
  });
  const page = await open(t); await page.goto(`/#/settings/addons/${id}`);
  const dropdown = page.locator(`.addon-row[data-addon-id="${id}"] codex-addon-settings`);
  await dropdown.getByRole('alert').waitFor();
  assert.equal((await dropdown.textContent())!.includes('Private settings failure'), false);
  const view = dropdown.locator('[data-contribution-id="preferences"]');
  await view.getByText('Options ready', { exact: true }).waitFor();
  await view.getByLabel('Saved option').fill('Draft survives retry');
  await dropdown.getByRole('button', { name: 'Retry settings', exact: true }).click();
  await dropdown.locator('[data-contribution-id="campaign"]').getByText('Options ready', { exact: true }).waitFor();
  assert.equal(await view.getByLabel('Saved option').inputValue(), 'Draft survives retry');
}

export async function exerciseSettingsCardStability({ t, open, admin, csrf }: InstalledFixture): Promise<void> {
  const ids = ['settings-stable-a', 'settings-stable-b'];
  for (const [index, id] of ids.entries()) {
    await installReviewedPackage(admin, csrf, id, settingsPackage(id, 'integrated', '1.0.0', false, index ? 0 : 10, index === 1), []);
    t.after(async () => {
      const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
      await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: snapshot.state.revision } }));
    });
  }
  const page = await open(t, 'player'); await page.goto('/#/settings/addons/settings-stable-a');
  const cards = page.locator('.addon-row'), first = cards.filter({ has: page.locator('[aria-label="Settings for settings-stable-a"]') });
  const second = cards.filter({ has: page.locator('[aria-label="Settings for settings-stable-b"]') });
  await first.getByText('Options ready', { exact: true }).waitFor();
  await first.getByLabel('Saved option').fill('Unrelated add-on draft');
  assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.addonId)), ids);
  await second.getByRole('button', { name: 'Settings for settings-stable-b' }).click();
  await second.locator('[data-contribution-id="preferences"]').getByText('Options ready', { exact: true }).waitFor();
  await second.getByRole('button', { name: 'Hide shared preferences', exact: true }).click();
  await second.getByRole('heading', { name: 'Shared preferences 1.0.0', exact: true }).waitFor({ state: 'detached' });
  await second.getByRole('heading', { name: 'Alternate options 1.0.0', exact: true }).waitFor();
  assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.addonId)), ids);
  assert.equal(await first.getByLabel('Saved option').inputValue(), 'Unrelated add-on draft');
}
