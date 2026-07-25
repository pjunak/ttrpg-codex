import { Store } from './store.js';
import { Role } from './role.js';
import { esc, dataAction, dataOn } from './utils.js';
import { I18n } from './i18n.js';
import { ApiClient } from './api-client.js';

export const SettingsBackup = (() => {
  function create({
    store = Store,
    role = Role,
    api = ApiClient,
    i18n = I18n,
    render,
    flash,
    confirmAction = message => confirm(message),
    documentRef = globalThis.document,
    FormDataClass = globalThis.FormData,
  }) {
    let snapshots = [];

    function formatDate(iso) {
      return i18n.formatDate(iso, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function snapshotRow(snapshot) {
      const when = formatDate(snapshot.createdAt);
      const size = Number.isFinite(snapshot.size)
        ? `<span class="settings-row-usage" title="${esc(i18n.t('settings.sizeTitle'))}">${Math.max(1, Math.round(snapshot.size / 1024))} kB</span>`
        : '';
      const tag = snapshot.reason === 'manual'
        ? `✦ ${i18n.t('settings.snapshotManual')}`
        : snapshot.reason === 'pre-restore'
          ? `⚠ ${i18n.t('settings.snapshotPreRestore')}`
          : `✎ ${i18n.t('settings.snapshotEdit')}`;
      const actions = role.isDM() ? `
        <div class="settings-row-actions">
          <button type="button" class="settings-btn-edit"
                  title="${esc(i18n.t('settings.restoreThisStateTitle'))}"
                  ${dataAction('Settings.restoreSnapshot', snapshot.id)}>↶</button>
          <button type="button" class="settings-btn-del"
                  title="${esc(i18n.t('settings.deleteSnapshotTitle'))}"
                  ${dataAction('Settings.deleteSnapshot', snapshot.id)}>🗑</button>
        </div>` : '';
      return `
        <div class="settings-row">
          <span class="settings-row-icon">🕒</span>
          <span class="settings-row-label">${esc(when)}</span>
          <code class="settings-row-id">${esc(tag)}</code>
          ${size}
          ${actions}
        </div>`;
    }

    function html() {
      const isDM = role.isDM();
      const rows = snapshots.length
        ? snapshots.map(snapshotRow).join('')
        : `<div class="settings-empty">${esc(i18n.t('settings.noSnapshots'))}</div>`;
      const downloadButton = isDM ? `
          <a class="inline-create-btn" href="/api/backup"
             title="${esc(i18n.t('settings.downloadZipTitle'))}">📥 ${esc(i18n.t('settings.downloadZip'))}</a>` : '';
      const restoreButton = isDM ? `
          <label class="inline-create-btn" style="cursor:pointer"
             title="${esc(i18n.t('settings.restoreFromBackupTitle'))}">
            📤 ${esc(i18n.t('settings.restoreFromBackup'))}
            <input type="file" accept=".zip,.json,application/zip,application/json"
                   style="display:none"
                   ${dataOn('change', 'Settings.uploadRestore', '$el')}>
          </label>` : '';
      const revertRow = isDM ? `
        <div class="settings-revert-row">
          <label class="settings-field" style="margin-right:0.6rem">
            <span class="settings-field-label">${esc(i18n.t('settings.revertLastN'))}</span>
            <input class="edit-input" type="number" min="1" max="50"
                   value="1" id="settings-revert-n" style="width:5rem">
          </label>
          <button type="button" class="edit-delete-btn"
                  ${dataAction('Settings.revertLastN')}>↶ ${esc(i18n.t('action.undo'))}</button>
        </div>` : '';
      const playerHint = isDM ? '' : `
        <p class="settings-hint" style="margin-bottom:0.8rem;font-style:italic">
          ${esc(i18n.t('settings.backupPlayerHint'))}
        </p>`;
      return `
        <div class="settings-editor-head">
          <h2>💾 ${esc(i18n.t('settings.tabBackup'))}</h2>
          <div class="settings-editor-actions">
            ${downloadButton}
            ${restoreButton}
            <button type="button" class="inline-create-btn"
                    ${dataAction('Settings.createSnapshot')}>＋ ${esc(i18n.t('settings.createSnapshot'))}</button>
            <button type="button" class="inline-create-btn"
                    ${dataAction('Settings.refreshSnapshots')}>↻ ${esc(i18n.t('action.refresh'))}</button>
          </div>
        </div>
        <div class="settings-panel">
          <p class="settings-hint" style="margin-bottom:0.8rem">
            ${esc(i18n.t('settings.backupIntro'))}${isDM ? ` ${esc(i18n.t('settings.backupIntroDM'))}` : ''}
          </p>
          ${playerHint}
          ${revertRow}
          <div class="settings-snapshots">${rows}</div>
        </div>`;
    }

    function load() {
      return api.requestJson('/api/snapshots')
        .then(body => {
          snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
        })
        .catch(() => { snapshots = []; });
    }

    function open() {
      render();
      return load().then(render);
    }

    function refreshSnapshots() {
      return load().then(render);
    }

    function createSnapshot() {
      flash(i18n.t('settings.creatingSnapshot'));
      return api.requestJson('/api/snapshots', { method: 'POST' })
        .then(() => load())
        .then(render)
        .then(() => flash(i18n.t('settings.snapshotCreated')))
        .catch(() => flash(i18n.t('settings.snapshotCreateFailed'), false));
    }

    function restoreSnapshot(id) {
      const snapshot = snapshots.find(entry => entry.id === id);
      const when = snapshot ? formatDate(snapshot.createdAt) : id;
      if (!confirmAction(i18n.t('settings.restoreSnapshotQ', { when }))) {
        return undefined;
      }
      flash(i18n.t('settings.restoring'));
      return api.requestJson(
        `/api/snapshots/${encodeURIComponent(id)}/restore`,
        { method: 'POST' },
      )
        .then(() => {
          flash(i18n.t('settings.restored'));
          return store.load().then(() => load().then(render));
        })
        .catch(() => flash(i18n.t('settings.restoreFailed'), false));
    }

    function deleteSnapshot(id) {
      const snapshot = snapshots.find(entry => entry.id === id);
      const when = snapshot ? formatDate(snapshot.createdAt) : id;
      if (!confirmAction(i18n.t('settings.deleteSnapshotQ', { when }))) {
        return undefined;
      }
      return api.requestJson(
        `/api/snapshots/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      )
        .then(() => load())
        .then(render)
        .then(() => flash(i18n.t('settings.deleted')))
        .catch(() => flash(i18n.t('settings.deleteFailed'), false));
    }

    function revertLastN() {
      const input = documentRef.getElementById('settings-revert-n');
      const count = Math.max(1, Math.min(50, Number(input?.value) || 1));
      if (!confirmAction(i18n.plural('settings.revertLastNQ', count))) {
        return undefined;
      }
      flash(i18n.plural('settings.revertingLastN', count));
      return api.requestJson(`/api/snapshots/revert-last/${count}`, {
        method: 'POST',
      })
        .then(() => {
          flash(i18n.t('settings.restored'));
          return store.load().then(() => load().then(render));
        })
        .catch(() => flash(i18n.t('settings.revertFailed'), false));
    }

    function uploadRestore(input) {
      const file = input?.files?.[0];
      if (!file) return undefined;
      if (!confirmAction(i18n.t('settings.restoreFromFileQ', {
        name: file.name,
      }))) {
        input.value = '';
        return undefined;
      }
      const form = new FormDataClass();
      form.append('backup', file);
      flash(i18n.t('settings.uploadingRestoring'));
      return api.uploadJson('/api/restore', form, { method: 'POST' })
        .then(result => {
          const format = result.format === 'zip' ? 'ZIP' : 'JSON';
          flash(i18n.plural(
            'settings.restoredFromFmt',
            result.restored,
            { fmt: format },
          ));
          return store.load().then(() => load().then(render));
        })
        .catch(() => flash(i18n.t('settings.restoreFailed'), false))
        .finally(() => { input.value = ''; });
    }

    return Object.freeze({
      html,
      open,
      refreshSnapshots,
      createSnapshot,
      restoreSnapshot,
      deleteSnapshot,
      revertLastN,
      uploadRestore,
    });
  }

  return Object.freeze({ create });
})();
