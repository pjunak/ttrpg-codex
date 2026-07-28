import { createAddonImportClient } from './addon-imports.js';
import { I18n } from './i18n.js';
import { PinTypes } from './pin-types.js';
import { Role } from './role.js';
import { Store } from './store.js';
import { announce, dataAction, dataOn, esc, safeColor } from './utils.js';

const PROVIDER_ID = 'campaign-bundle';
const WORLD_MAP_IMAGE = '/maps/swordcoast/sword_coast.jpg';

export const ImportCenter = (() => {
  let _file = null;
  let _preview = null;
  let _result = null;
  let _error = null;
  let _busy = '';
  let _confirmed = false;
  let _jobId = '';
  let _generation = 0;

  const _client = createAddonImportClient({
    addonId: 'core',
    enabled: true,
    isDM: () => Role.isDM(),
  });

  function _main() {
    return document.getElementById('main-content');
  }

  function _json(value) {
    return esc(JSON.stringify(value, null, 2));
  }

  function _button(label, action, className = 'inline-create-btn', disabled = false) {
    return `<button type="button" class="${className}"${dataAction(action)}${disabled ? ' disabled' : ''}>${label}</button>`;
  }

  function _diagnosticsHtml(diagnostics = []) {
    if (!diagnostics.length) {
      return `<p class="import-empty">${esc(I18n.t('import.noDiagnostics'))}</p>`;
    }
    return `<ul class="import-diagnostics">${diagnostics.map(item => `
      <li class="is-${item.severity === 'error' ? 'error' : 'warning'}">
        <strong>${esc(item.code || item.severity || '')}</strong>
        <span>${esc(item.message || '')}</span>
        ${Array.isArray(item.path) && item.path.length
          ? `<code>${esc(item.path.join('.'))}</code>`
          : ''}
      </li>`).join('')}</ul>`;
  }

  function _referencesHtml(references = []) {
    if (!references.length) return `<p class="import-empty">${esc(I18n.t('import.none'))}</p>`;
    return `
      <div class="import-table-wrap">
        <table class="import-table">
          <thead><tr>
            <th>${esc(I18n.t('import.localRef'))}</th>
            <th>${esc(I18n.t('import.collection'))}</th>
            <th>${esc(I18n.t('import.reservedId'))}</th>
          </tr></thead>
          <tbody>${references.map(item => `
            <tr>
              <td><code>${esc(item.ref)}</code></td>
              <td>${esc(item.collection)}</td>
              <td><code>${esc(item.id)}</code></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function _changeHtml(change) {
    const label = change.after?.name || change.after?.label || change.sourceRef || change.id;
    const statusKey = change.status === 'update' ? 'import.update' : 'import.create';
    return `
      <details class="import-change">
        <summary>
          <span class="import-change-kind">${esc(change.collection)}</span>
          <strong>${esc(label)}</strong>
          <span class="codex-badge">${esc(I18n.t(statusKey))}</span>
          ${change.derived ? `<span class="codex-badge is-warning">${esc(I18n.t('import.derived'))}</span>` : ''}
        </summary>
        <div class="import-change-body">
          ${change.sourceRef ? `<p><span>${esc(I18n.t('import.localRef'))}</span> <code>${esc(change.sourceRef)}</code></p>` : ''}
          <div class="import-diff">
            <section>
              <h4>${esc(I18n.t('import.before'))}</h4>
              <pre>${_json(change.before)}</pre>
            </section>
            <section>
              <h4>${esc(I18n.t('import.after'))}</h4>
              <pre>${_json(change.after)}</pre>
            </section>
          </div>
        </div>
      </details>`;
  }

  function _changesHtml(changes = []) {
    if (!changes.length) return `<p class="import-empty">${esc(I18n.t('import.none'))}</p>`;
    return `<div class="import-change-list">${changes.map(_changeHtml).join('')}</div>`;
  }

  function _mapGroups(changes = []) {
    const changedLocations = new Map(
      changes
        .filter(change => change.collection === 'locations' && change.after)
        .map(change => [change.id, change.after]),
    );
    const groups = new Map();
    for (const [id, location] of changedLocations) {
      if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) continue;
      const parentId = typeof location.parentId === 'string' ? location.parentId : '';
      if (!groups.has(parentId)) groups.set(parentId, []);
      groups.get(parentId).push({ id, ...location });
    }
    return [...groups].map(([parentId, changedPins]) => {
      const parent = parentId
        ? (changedLocations.get(parentId) || Store.getLocation(parentId))
        : null;
      const pins = new Map(
        (Store.getLocationsOnMap(parentId || null) || [])
          .filter(location => Number.isFinite(location.x) && Number.isFinite(location.y))
          .map(location => [location.id, { ...location, changed: false }]),
      );
      for (const pin of changedPins) pins.set(pin.id, { ...pin, changed: true });
      return {
        parentId,
        label: parent?.name || I18n.t('import.worldMap'),
        image: parentId ? parent?.localMap : WORLD_MAP_IMAGE,
        changedCount: changedPins.length,
        pins: [...pins.values()],
      };
    });
  }

  function _mapPreviewHtml(changes = []) {
    const pinTypes = Store.getEnum('pinTypes') || [];
    const groups = _mapGroups(changes);
    if (!groups.length) return `<p class="import-empty">${esc(I18n.t('import.noMapChanges'))}</p>`;
    return `<div class="import-map-list">${groups.map(group => `
      <figure class="import-map-card">
        <figcaption>
          <strong>${esc(group.label)}</strong>
          <span>${esc(I18n.t('import.changedPins', { count: group.changedCount }))}</span>
        </figcaption>
        <div class="import-map-stage${group.image ? '' : ' has-no-image'}">
          ${group.image
            ? `<img src="${esc(group.image)}" alt="" loading="lazy">`
            : `<p>${esc(I18n.t('import.mapUnavailable'))}</p>`}
          ${group.pins.map(pin => {
            const definition = PinTypes.resolve(pinTypes, pin.pinType);
            const size = Math.max(
              PinTypes.sizeMin,
              Math.min(PinTypes.sizeMax, Number(pin.size) || Number(definition.size) || PinTypes.sizeDefault),
            );
            const x = Math.max(0, Math.min(1, pin.x));
            const y = Math.max(0, Math.min(1, pin.y));
            return `<span class="import-map-pin${pin.changed ? ' is-changed' : ' is-existing'}"
              style="--import-pin-x:${(x * 100).toFixed(4)}%;--import-pin-y:${(y * 100).toFixed(4)}%;--import-pin-size:${size}px;--import-pin-color:${safeColor(definition.color)}"
              title="${esc(pin.name || pin.id)}">
                <span aria-hidden="true">${esc(definition.icon || '📌')}</span>
                <b>${esc(pin.name || pin.id)}</b>
              </span>`;
          }).join('')}
        </div>
      </figure>`).join('')}</div>`;
  }

  function _reviewHtml() {
    const plan = _preview?.plan || {};
    const review = plan.review || {};
    const projection = review.playerProjection || {};
    const publicCount = Object.values(projection)
      .reduce((total, records) => total + (Array.isArray(records) ? records.length : 0), 0);
    const errorCount = (plan.diagnostics || []).filter(item => item.severity === 'error').length;
    return `
      <section class="import-ledger" aria-labelledby="import-review-title">
        <div class="import-ledger-head">
          <div>
            <p class="import-kicker">${esc(I18n.t('import.reviewKicker'))}</p>
            <h2 id="import-review-title">${esc(I18n.t('import.reviewTitle'))}</h2>
          </div>
          <span class="import-verdict ${_preview.committable ? 'is-ready' : 'is-blocked'}">
            ${esc(I18n.t(_preview.committable ? 'import.ready' : 'import.blocked'))}
          </span>
        </div>
        <div class="import-metrics">
          <div><strong>${Number(review.logicalRecordCount) || 0}</strong><span>${esc(I18n.t('import.records'))}</span></div>
          <div><strong>${Number(review.materializedWriteCount) || 0}</strong><span>${esc(I18n.t('import.writes'))}</span></div>
          <div><strong>${publicCount}</strong><span>${esc(I18n.t('import.playerVisible'))}</span></div>
          <div class="${errorCount ? 'is-danger' : ''}"><strong>${errorCount}</strong><span>${esc(I18n.t('import.errors'))}</span></div>
        </div>

        <section class="import-review-section">
          <h3>${esc(I18n.t('import.diagnostics'))}</h3>
          ${_diagnosticsHtml(plan.diagnostics)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.mapPreview'))}</h3>
          <p class="import-section-copy">${esc(I18n.t('import.mapPreviewHint'))}</p>
          ${_mapPreviewHtml(review.changes)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.references'))}</h3>
          ${_referencesHtml(review.references)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.changes'))}</h3>
          ${_changesHtml(review.changes)}
        </section>
        <div class="import-confirm">
          <label>
            <input type="checkbox"${_confirmed ? ' checked' : ''}${dataOn('change', 'ImportCenter.setConfirmed', '$checked')}>
            <span>${esc(I18n.t('import.confirmExactPlan'))}</span>
          </label>
          <div class="import-actions">
            ${_button(esc(I18n.t('import.startOver')), 'ImportCenter.reset')}
            ${_button(
              `✓ ${esc(I18n.t('import.commit'))}`,
              'ImportCenter.commit',
              'edit-save-btn',
              !_preview.committable || !_confirmed || !!_busy,
            )}
          </div>
        </div>
      </section>`;
  }

  function _uploadHtml() {
    return `
      <section class="import-dropzone">
        <div class="import-drop-icon" aria-hidden="true">⌁</div>
        <div>
          <h2>${esc(I18n.t('import.chooseTitle'))}</h2>
          <p>${esc(I18n.t('import.chooseHint'))}</p>
        </div>
        <label class="inline-create-btn import-file-button">
          ${esc(I18n.t('import.chooseFile'))}
          <input type="file" accept=".json,application/json"${dataOn('change', 'ImportCenter.selectFile', '$el')}>
        </label>
        ${_file ? `
          <div class="import-file">
            <strong>${esc(_file.name || 'import.json')}</strong>
            <span>${esc(I18n.t('import.fileBytes', { count: _file.size }))}</span>
          </div>
          ${_button(
            _busy === 'preview' ? esc(I18n.t('import.reviewing')) : esc(I18n.t('import.preview')),
            'ImportCenter.preview',
            'edit-save-btn',
            !!_busy,
          )}` : ''}
      </section>`;
  }

  function _resultHtml() {
    return `
      <section class="import-complete" role="status">
        <span aria-hidden="true">✓</span>
        <div>
          <h2>${esc(I18n.t('import.completeTitle'))}</h2>
          <p>${esc(I18n.t('import.completeHint', {
            count: Number(_result?.operationCount) || 0,
          }))}</p>
          ${_result?.commitId ? `<code>${esc(_result.commitId)}</code>` : ''}
        </div>
        ${_button(esc(I18n.t('import.another')), 'ImportCenter.reset', 'edit-save-btn')}
      </section>`;
  }

  function render() {
    if (typeof window !== 'undefined') {
      const route = (window.location.hash || '#/').replace(/^#/, '') || '/';
      if (route !== '/import') return;
    }
    const main = _main();
    if (!main) return;
    if (!Role.isDM()) {
      main.innerHTML = `
        <div class="dm-panel">
          <h1>⌁ ${esc(I18n.t('import.title'))}</h1>
          <p class="dm-stub">${esc(I18n.t('import.dmOnly'))}</p>
        </div>`;
      return;
    }
    main.innerHTML = `
      <div class="import-center">
        <header class="page-header import-header">
          <div>
            <p class="import-kicker">${esc(I18n.t('import.kicker'))}</p>
            <h1>⌁ ${esc(I18n.t('import.title'))}</h1>
            <p class="subtitle">${esc(I18n.t('import.intro'))}</p>
          </div>
          <nav class="import-resources" aria-label="${esc(I18n.t('import.resources'))}">
            <a href="/api/content-import/schemas/campaign-bundle-v1" target="_blank" rel="noopener">${esc(I18n.t('import.schema'))}</a>
            <a href="/api/content-import/inventory?includeBodies=true" target="_blank" rel="noopener">${esc(I18n.t('import.inventory'))}</a>
          </nav>
        </header>
        ${_error ? `<div class="import-error" role="alert"><strong>${esc(I18n.t('import.error'))}</strong> ${esc(_error)}</div>` : ''}
        ${_result ? _resultHtml() : (_preview ? _reviewHtml() : _uploadHtml())}
      </div>`;
  }

  function selectFile(input) {
    _file = input?.files?.[0] || null;
    _preview = null;
    _result = null;
    _error = null;
    _confirmed = false;
    render();
  }

  async function preview() {
    if (!_file || _busy) return;
    const generation = ++_generation;
    _busy = 'preview';
    _error = null;
    render();
    try {
      const providers = await _client.listProviders();
      if (!providers.providers.some(provider => provider.id === PROVIDER_ID)) {
        throw new Error(I18n.t('import.providerUnavailable'));
      }
      const job = await _client.createJob({ providerId: PROVIDER_ID, file: _file });
      if (generation !== _generation) {
        await _client.cancel(job.id).catch(() => {});
        return;
      }
      _jobId = job.id;
      _preview = await _client.preview(job.id);
      if (generation !== _generation) return;
      _confirmed = false;
      announce(I18n.t(_preview.committable ? 'import.previewReady' : 'import.previewBlocked'));
    } catch (error) {
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.error');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  function setConfirmed(value) {
    _confirmed = !!value;
    render();
  }

  async function commit() {
    if (!_jobId || !_preview?.previewToken || !_preview.committable || !_confirmed || _busy) return;
    const generation = _generation;
    _busy = 'commit';
    _error = null;
    render();
    try {
      _result = await _client.commit(_jobId, _preview.previewToken);
      await Store.load();
      if (generation === _generation) announce(I18n.t('import.completeTitle'));
    } catch (error) {
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.error');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  async function reset() {
    _generation++;
    if (_jobId && !_result) {
      await _client.cancel(_jobId).catch(() => {});
    }
    _file = null;
    _preview = null;
    _result = null;
    _error = null;
    _busy = '';
    _confirmed = false;
    _jobId = '';
    render();
  }

  function leave() {
    _generation++;
    const jobId = _jobId;
    const committing = _busy === 'commit';
    _file = null;
    _preview = null;
    _result = null;
    _error = null;
    _busy = '';
    _confirmed = false;
    _jobId = '';
    if (jobId && !committing) _client.cancel(jobId).catch(() => {});
  }

  return Object.freeze({
    commit,
    leave,
    preview,
    render,
    reset,
    selectFile,
    setConfirmed,
  });
})();
