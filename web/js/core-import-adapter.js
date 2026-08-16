import { createAddonImportClient } from './addon-imports.js';
import { I18n } from './i18n.js';
import { Role } from './role.js';
import { Store } from './store.js';
import { announce, dataAction, dataOn, esc } from './utils.js';

const PROVIDER_ID = 'campaign-bundle';
const CORE_ROUTES = Object.freeze({
  characters: 'postava',
  locations: 'misto',
  factions: 'frakce',
  mysteries: 'zahada',
  artifacts: 'artefakt',
  events: 'udalost',
});

export const CoreImportAdapter = (() => {
  const client = createAddonImportClient({
    addonId: 'core',
    enabled: true,
    isDM: () => Role.isDM(),
  });
  let state = freshState();
  let invalidate = () => {};
  let generation = 0;

  function freshState() {
    return {
      file: null,
      fileName: '',
      source: '',
      jobId: '',
      preview: null,
      result: null,
      error: '',
      busy: '',
      confirmed: false,
    };
  }

  const refresh = () => { try { invalidate(); } catch (_) {} };
  const button = (label, action, className = 'inline-create-btn', disabled = false) => (
    `<button type="button" class="${className}"${dataAction(action)}${disabled ? ' disabled' : ''}>${esc(label)}</button>`
  );

  function descriptor() {
    return Object.freeze({
      id: 'core-campaign-bundle',
      label: I18n.t('import.adapterTitle'),
      description: I18n.t('import.intro'),
      accept: '.json,application/json',
      links: Object.freeze([
        Object.freeze({ label: I18n.t('import.schema'), href: '/api/content-import/schemas/campaign-bundle-v1' }),
        Object.freeze({ label: I18n.t('import.inventory'), href: '/api/content-import/inventory?includeBodies=true' }),
      ]),
    });
  }

  function diagnosticsHtml(items = []) {
    if (!items.length) return `<p class="import-empty">${esc(I18n.t('import.noDiagnostics'))}</p>`;
    return `<ul class="import-diagnostics">${items.map(item => `
      <li class="is-${['error', 'warning'].includes(item.severity) ? item.severity : 'info'}">
        <div class="import-diagnostic-head"><strong>${esc(item.severity || 'info')}</strong>${item.code ? `<code>${esc(item.code)}</code>` : ''}</div>
        <p>${esc(item.message || '')}</p>
        ${Array.isArray(item.path) && item.path.length ? `<code class="import-diagnostic-path">${esc(item.path.join('.'))}</code>` : ''}
      </li>`).join('')}</ul>`;
  }

  function recordLink(change) {
    const route = CORE_ROUTES[change.collection];
    if (!route || !change.id) return '';
    return `<a class="inline-create-btn" href="#/${route}/${encodeURIComponent(change.id)}">${esc(I18n.t('import.openRecord'))}</a>`;
  }

  function changesHtml(changes = []) {
    if (!changes.length) return `<p class="import-empty">${esc(I18n.t('import.none'))}</p>`;
    return `<div class="import-change-list">${changes.map(change => `
      <details class="import-change">
        <summary><span class="import-change-kind">${esc(change.collection || '')}</span>
          <strong>${esc(change.after?.name || change.after?.title || change.after?.label || change.id || '')}</strong>
          <span class="codex-badge">${esc(I18n.t(change.status === 'update' ? 'import.update' : 'import.create'))}</span>
        </summary>
        <div class="import-change-body">
          <div class="import-diff">
            <section><h4>${esc(I18n.t('import.before'))}</h4><pre class="codex-code-input">${esc(JSON.stringify(change.before ?? null, null, 2))}</pre></section>
            <section><h4>${esc(I18n.t('import.after'))}</h4><pre class="codex-code-input">${esc(JSON.stringify(change.after ?? null, null, 2))}</pre></section>
          </div>
          ${recordLink(change)}
        </div>
      </details>`).join('')}</div>`;
  }

  function reviewHtml() {
    const plan = state.preview?.plan || {};
    const review = plan.review || {};
    const changes = Array.isArray(review.changes) ? review.changes : [];
    const references = Array.isArray(review.references) ? review.references : [];
    return `<section class="import-ledger">
      <div class="import-ledger-head"><h2>${esc(I18n.t('import.reviewTitle'))}</h2>
        <span class="import-verdict ${state.preview.committable ? 'is-ready' : 'is-blocked'}">${esc(I18n.t(state.preview.committable ? 'import.ready' : 'import.blocked'))}</span></div>
      <div class="import-metrics">
        <div><strong>${changes.length}</strong><span>${esc(I18n.t('import.records'))}</span></div>
        <div><strong>${Number(review.materializedWriteCount) || changes.length}</strong><span>${esc(I18n.t('import.writes'))}</span></div>
        <div><strong>${references.length}</strong><span>${esc(I18n.t('import.references'))}</span></div>
        <div><strong>${(plan.diagnostics || []).filter(item => item.severity === 'error').length}</strong><span>${esc(I18n.t('import.errors'))}</span></div>
      </div>
      <section class="import-review-section"><h3>${esc(I18n.t('import.diagnostics'))}</h3>${diagnosticsHtml(plan.diagnostics)}</section>
      <section class="import-review-section"><h3>${esc(I18n.t('import.changes'))}</h3>${changesHtml(changes)}</section>
      <section class="import-review-section">
        <h3>${esc(I18n.t('import.sourceDocument'))}</h3>
        <p class="settings-hint">${esc(I18n.t('import.sourceDocumentHint'))}</p>
        <textarea class="edit-input codex-code-input" id="core-import-source" rows="16">${esc(state.source)}</textarea>
        ${button(I18n.t('import.revalidateEdits'), 'CoreImportAdapter.revalidate', 'inline-create-btn', !!state.busy)}
      </section>
      <div class="import-confirm"><label><input type="checkbox" ${state.confirmed ? 'checked' : ''}${dataOn('change', 'CoreImportAdapter.setConfirmed', '$checked')}>
        <span>${esc(I18n.t('import.confirmExactPlan'))}</span></label>
        <div class="import-actions">${button(I18n.t('import.startOver'), 'CoreImportAdapter.reset')}
          ${button(I18n.t('import.commit'), 'CoreImportAdapter.commit', 'edit-save-btn', !state.preview.committable || !state.confirmed || !!state.busy)}</div>
      </div>
    </section>`;
  }

  function uploadHtml() {
    return `<section class="import-dropzone">
      <div class="import-drop-icon" aria-hidden="true">⌁</div>
      <div><h2>${esc(I18n.t('import.chooseTitle'))}</h2><p>${esc(I18n.t('import.chooseHint'))}</p></div>
      <label class="inline-create-btn import-file-button">${esc(I18n.t('import.chooseFile'))}
        <input type="file" accept=".json,application/json"${dataOn('change', 'CoreImportAdapter.selectFile', '$el')}></label>
      ${state.file ? `<div class="import-file"><strong>${esc(state.fileName)}</strong><span>${esc(I18n.t('import.fileBytes', { count: state.file.size }))}</span></div>
        ${button(state.busy ? I18n.t('import.reviewing') : I18n.t('import.preview'), 'CoreImportAdapter.preview', 'edit-save-btn', !!state.busy)}` : ''}
    </section>`;
  }

  function resultHtml() {
    return `<section class="import-complete" role="status"><span aria-hidden="true">✓</span><div>
      <h2>${esc(I18n.t('import.completeTitle'))}</h2>
      <p>${esc(I18n.t('import.completeHint', { count: Number(state.result?.operationCount) || 0 }))}</p>
      ${state.result?.commitId ? `<code>${esc(state.result.commitId)}</code>` : ''}</div>
      ${button(I18n.t('import.another'), 'CoreImportAdapter.reset', 'edit-save-btn')}</section>`;
  }

  function render() {
    if (!Role.isDM()) return `<div class="codex-notice">${esc(I18n.t('import.dmOnly'))}</div>`;
    return `<div class="import-center">
      ${state.error ? `<div class="import-error" role="alert"><strong>${esc(I18n.t('import.error'))}</strong> ${esc(state.error)}</div>` : ''}
      ${state.result ? resultHtml() : (state.preview ? reviewHtml() : uploadHtml())}
    </div>`;
  }

  function activate(context = {}) {
    invalidate = typeof context.invalidate === 'function' ? context.invalidate : () => {};
    return () => { invalidate = () => {}; };
  }

  function selectFile(input) {
    state = { ...freshState(), file: input?.files?.[0] || null };
    state.fileName = state.file?.name || '';
    refresh();
  }

  async function createPreview(file) {
    const providers = await client.listProviders();
    if (!providers.providers.some(provider => provider.id === PROVIDER_ID)) throw new Error(I18n.t('import.providerUnavailable'));
    const job = await client.createJob({ providerId: PROVIDER_ID, file });
    const preview = await client.preview(job.id);
    return { job, preview };
  }

  async function preview() {
    if (!state.file || state.busy) return;
    const current = ++generation;
    state.busy = 'preview'; state.error = ''; refresh();
    try {
      const { job, preview: result } = await createPreview(state.file);
      if (current !== generation) { await client.cancel(job.id).catch(() => {}); return; }
      state.jobId = job.id;
      state.preview = result;
      state.source = await state.file.text();
      state.confirmed = false;
      announce(I18n.t(result.committable ? 'import.previewReady' : 'import.previewBlocked'));
    } catch (error) {
      if (current === generation) state.error = error?.message || I18n.t('import.error');
    } finally {
      if (current === generation) { state.busy = ''; refresh(); }
    }
  }

  async function revalidate() {
    if (state.busy) return;
    const value = document.getElementById('core-import-source')?.value;
    if (typeof value !== 'string') return;
    const current = ++generation;
    const previousJob = state.jobId;
    state.busy = 'preview'; state.error = ''; state.confirmed = false; refresh();
    try {
      const file = new File([value], state.fileName || 'campaign-bundle.json', { type: 'application/json' });
      const { job, preview: result } = await createPreview(file);
      if (current !== generation) { await client.cancel(job.id).catch(() => {}); return; }
      state.file = file; state.jobId = job.id; state.preview = result; state.source = value;
      if (previousJob) client.cancel(previousJob).catch(() => {});
    } catch (error) {
      if (current === generation) state.error = error?.message || I18n.t('import.adjustFailed');
    } finally {
      if (current === generation) { state.busy = ''; refresh(); }
    }
  }

  function setConfirmed(value) { if (!state.busy) { state.confirmed = !!value; refresh(); } }

  async function commit() {
    if (!state.jobId || !state.preview?.previewToken || !state.preview.committable || !state.confirmed || state.busy) return;
    const current = generation;
    state.busy = 'commit'; state.error = ''; refresh();
    try {
      state.result = await client.commit(state.jobId, state.preview.previewToken);
      await Store.load();
      if (current === generation) announce(I18n.t('import.completeTitle'));
    } catch (error) {
      if (current === generation) state.error = error?.message || I18n.t('import.error');
    } finally {
      if (current === generation) { state.busy = ''; refresh(); }
    }
  }

  async function reset() {
    const jobId = state.jobId;
    const committing = state.busy === 'commit';
    generation++;
    state = freshState();
    if (jobId && !committing) await client.cancel(jobId).catch(() => {});
    refresh();
  }

  async function leave() { await reset(); }

  const service = Object.freeze({ apiVersion: 1, descriptor, activate, render, leave });
  return Object.freeze({ service, selectFile, preview, revalidate, setConfirmed, commit, reset, leave });
})();
