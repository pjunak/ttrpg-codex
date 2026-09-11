import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InstalledFixture } from './fixture-types.mts';
import { installReviewedPackage, jsonResponse, zip } from './installed-graph-fixture.mts';

export async function exerciseRecordPanels({ t, open, admin, csrf, mode }: Pick<InstalledFixture, 't' | 'open' | 'admin' | 'csrf'> & { mode: string }): Promise<void> {
  const id = `record-panels-${mode}`, key = `panel-location-${mode}`, hidden = `${key}-hidden`, headers = { 'X-Codex-CSRF': csrf };
  const permission = { id: 'core.data.read', resources: ['locations'], reason: 'Read selected location context.' };
  const files: Record<string, string> = {
    'addon.json': JSON.stringify({ packageFormat: 1, id, name: id, version: '1.0.0', compatibility: { host: '^2.0.0', addonApi: '^3.0.0' },
      capabilities: { required: ['ui.contributions'], optional: [] }, permissions: [permission], runtime: { ui: { mode, entry: 'web/index.js' } },
      contributions: [
        { id: 'map', surface: 'slot', label: 'Map context', roles: ['dm', 'player'], config: { contractVersion: 1, slot: 'map:pin:panel' } },
        { id: 'editor', surface: 'editor-panel', label: 'Location options', roles: ['dm'], config: { contractVersion: 1, collection: 'locations' } },
        { id: 'wrong', surface: 'editor-panel', label: 'Must not mount', roles: ['dm'], config: { contractVersion: 1, collection: 'characters' } },
      ] }),
    'web/index.js': `export function activate(context) {
      const tag = 'test-record-panel-' + context.addon.generation.slice(0, 12);
      customElements.define(tag, class extends HTMLElement {
        set codexContribution(value) { this.context = value; if (this.output) this.output.textContent = JSON.stringify(value.host); }
        connectedCallback() {
          this.output = document.createElement('output'); this.output.setAttribute('aria-label', 'Record context'); this.output.style.overflowWrap = 'anywhere'; this.output.textContent = JSON.stringify(this.context.host); this.append(this.output);
          if (this.context.host.readOnly) return;
          const input = document.createElement('input'); input.setAttribute('aria-label', 'Panel draft'); input.oninput = () => this.context.edits.set({ dirty: true, saving: false });
          const fail = document.createElement('button'); fail.textContent = 'Fail panel save'; fail.onclick = () => { this.context.edits.set({ dirty: true, saving: false }); status.textContent = 'Panel save failed'; };
          const discard = document.createElement('button'); discard.textContent = 'Discard panel draft'; discard.onclick = () => { input.value = ''; this.context.edits.set({ dirty: false, saving: false }); };
          const status = document.createElement('p'); status.setAttribute('role', 'status'); this.append(input, fail, discard, status);
        }
      });
      for (const declaration of context.ui.declarations()) context.ui.bind(declaration.id, { kind: 'element', tag });
    }`,
  };
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  await installReviewedPackage(admin, csrf, id, zip(files), [permission]);
  t.after(async () => { const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`)); await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers, data: { expectedStateRevision: snapshot.state.revision } })); });
  await jsonResponse(await admin.post('/api/campaign/transactions', { headers, data: { contractVersion: 'campaign-mutation.v1', mutations: [key, hidden].map(value => ({ operation: 'put', collection: 'locations', key: value, expectedRevision: 0,
    value: { id: value, name: value === hidden ? 'Hidden panel location' : 'Panel harbor', visibility: value === hidden ? 'dm' : 'public', x: .3, y: .4, parentId: null, notes: 'Private body must not enter context' } })) } }));
  const page = await open(t); page.setDefaultTimeout(10000);
  const panel = page.locator(`codex-record-contributions [data-addon-id="${id}"]`);
  const view = mode === 'isolated' ? panel.frameLocator('iframe') : panel;
  await page.goto(`/#/map/world/location/${key}/show`);
  await view.getByLabel('Record context').waitFor();
  const map = JSON.parse((await view.getByLabel('Record context').textContent())!);
  assert.equal(map.readOnly, true); assert.deepEqual(Object.keys(map.record).sort(), ['collection', 'href', 'id', 'label', 'revision']); assert.equal(map.record.id, key);
  assert.doesNotMatch(JSON.stringify(map), /Private body/);
  await page.goto(`/#/locations/${key}`); await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await view.getByLabel('Panel draft').fill('Retained extension draft');
  assert.equal(JSON.parse((await view.getByLabel('Record context').textContent())!).readOnly, false);
  assert.equal(await page.locator('[data-contribution-id="wrong"]').count(), 0);
  const core = page.locator('form.record-editor'); assert.equal(await core.locator('codex-record-contributions').count(), 0);
  await core.getByLabel('Name', { exact: true }).fill('Saved core harbor');
  await core.getByRole('button', { name: 'Save entry', exact: true }).click();
  await view.getByLabel("Record context").filter({ hasText: "Saved core harbor" }).waitFor();
  await page.getByText('Core fields saved. Add-on panels save separately.', { exact: true }).waitFor();
  assert.equal(await view.getByLabel('Panel draft').inputValue(), 'Retained extension draft');
  await view.getByRole('button', { name: 'Fail panel save', exact: true }).click(); await view.getByText('Panel save failed').waitFor();
  page.once("dialog", dialog => dialog.dismiss()); await core.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await view.getByLabel('Panel draft').inputValue(), 'Retained extension draft');
  await view.getByRole('button', { name: 'Discard panel draft', exact: true }).click(); await core.getByRole('button', { name: 'Cancel', exact: true }).click();
  const player = await open(t, 'player'); await player.goto(`/#/map/world/location/${key}/show`);
  const playerPanel = player.locator(`codex-record-contributions [data-addon-id="${id}"]`);
  const playerView = mode === 'isolated' ? playerPanel.frameLocator('iframe') : playerPanel;
  await playerView.getByLabel('Record context').waitFor();
  await player.goto(`/#/map/world/location/${hidden}/show`); await playerPanel.waitFor({ state: 'detached' });
  assert.equal(await player.locator('[data-contribution-id="editor"]').count(), 0);
}
