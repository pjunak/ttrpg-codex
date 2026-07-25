import { ApiClient } from './api-client.js';
import { I18n } from './i18n.js';
import { Role } from './role.js';
import { Store } from './store.js';
import { dataAction, esc } from './utils.js';

export const SettingsAccount = (() => {
  function create({ render, flash, requireDM }) {
    let passwordStatus = null;
    let canRestart = null;
    let serverInfoPending = false;

    function ensureServerInfo() {
      if (canRestart !== null || serverInfoPending) return;
      serverInfoPending = true;
      Store.getCanRestart().then(value => {
        canRestart = !!value;
        serverInfoPending = false;
        render();
      });
    }

    function loadPasswordStatus() {
      return ApiClient.requestJson('/api/passwords')
        .then(result => {
          passwordStatus = result;
        })
        .catch(() => {
          passwordStatus = null;
        });
    }

    function open() {
      passwordStatus = null;
      if (Role.getReal() !== 'dm') return Promise.resolve();
      return loadPasswordStatus().then(render);
    }

    function roleChip() {
      const role = Role.get();
      const realRole = Role.getReal();
      if (role === 'dm') {
        return '<span class="role-badge-chip role-badge-dm">🛡 DM</span>';
      }
      if (role === 'player' && realRole === 'dm') {
        return `<span class="role-badge-chip role-badge-impersonating">👁 ${esc(I18n.t('settings.rolePlayerViewDM'))}</span>`;
      }
      if (role === 'player') {
        return `<span class="role-badge-chip role-badge-player">👤 ${esc(I18n.t('settings.rolePlayer'))}</span>`;
      }
      return `<span class="role-badge-chip role-badge-anonymous">👁 ${esc(I18n.t('settings.rolePublic'))}</span>`;
    }

    function passwordFormHtml(role, title, info) {
      const statusLine = (() => {
        if (info.stored) {
          const when = info.updatedAt
            ? ` ${I18n.t('settings.pwdChangedAt', {
              when: I18n.formatDate(info.updatedAt, {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
            })}`
            : '';
          return `<span class="settings-password-status is-set">● ${esc(I18n.t('settings.pwdSet'))}${esc(when)}</span>`;
        }
        if (role === 'dm' && info.isDefault) {
          return `<span class="settings-password-status is-danger">⚠ ${esc(I18n.t('settings.pwdDefault'))}</span>`;
        }
        if (role === 'player' && info.disabled) {
          return `<span class="settings-password-status is-muted">○ ${esc(I18n.t('settings.pwdDisabled'))}</span>`;
        }
        if (info.envFallback) {
          return `<span class="settings-password-status is-muted">○ ${esc(I18n.t('settings.pwdFromEnv'))}</span>`;
        }
        return `<span class="settings-password-status is-muted">○ ${esc(I18n.t('settings.pwdNotSet'))}</span>`;
      })();
      const placeholder = role === 'player'
        ? I18n.t('settings.pwdNewPlaceholderPlayer')
        : I18n.t('settings.pwdNewPlaceholderDM');
      return `
        <div class="settings-panel settings-password-card">
          <div class="settings-password-card-head">
            <strong>${esc(title)}</strong>
            ${statusLine}
          </div>
          <div class="settings-form-row">
            <label class="settings-field">
              <span class="settings-field-label">${esc(I18n.t('settings.currentDMPassword'))}</span>
              <input class="edit-input" type="password" autocomplete="current-password"
                     id="pwd-${esc(role)}-current"
                     placeholder="${esc(I18n.t('settings.forConfirmation'))}">
            </label>
            <label class="settings-field">
              <span class="settings-field-label">${esc(I18n.t('settings.newPassword'))}</span>
              <input class="edit-input" type="password" autocomplete="new-password"
                     id="pwd-${esc(role)}-new"
                     placeholder="${esc(placeholder)}">
            </label>
            <label class="settings-field">
              <span class="settings-field-label">${esc(I18n.t('settings.confirmNewPassword'))}</span>
              <input class="edit-input" type="password" autocomplete="new-password"
                     id="pwd-${esc(role)}-confirm"
                     placeholder="${esc(I18n.t('settings.repeatNewPassword'))}">
            </label>
          </div>
          <div class="settings-form-actions settings-password-actions">
            <button type="button" class="edit-save-btn"
              ${dataAction('Settings.changePassword', role)}>💾 ${esc(role === 'player' && info.stored
                ? I18n.t('settings.changeOrClearPassword')
                : I18n.t('settings.savePassword'))}</button>
          </div>
        </div>`;
    }

    function passwordSectionHtml() {
      if (!passwordStatus) {
        return `<hr class="settings-section-divider">
          <div class="settings-mapviews-group-title">🔑 ${esc(I18n.t('settings.accountPasswords'))}</div>
          <p class="settings-hint settings-account-section-hint">${esc(I18n.t('settings.loadingStatus'))}</p>`;
      }
      return `
        <hr class="settings-section-divider">
        <div class="settings-mapviews-group-title">🔑 ${esc(I18n.t('settings.accountPasswords'))}</div>
        <p class="settings-hint settings-account-section-copy">
          ${esc(I18n.t('settings.passwordsIntro'))}
        </p>
        ${passwordFormHtml('dm', `🛡 ${I18n.t('settings.dmPassword')}`, passwordStatus.dm)}
        ${passwordFormHtml('player', `👤 ${I18n.t('settings.playerPassword')}`, passwordStatus.player)}`;
    }

    function html() {
      const role = Role.get();
      const realRole = Role.getReal();
      const logoutButton = role
        ? `<button type="button" class="edit-delete-btn"
             ${dataAction('Settings.logout')}>↩ ${esc(I18n.t('action.logout'))}</button>`
        : `<button type="button" class="inline-create-btn"
             ${dataAction('EditMode.promptLogin')}>🔑 ${esc(I18n.t('action.login'))}</button>`;
      const viewAsButton = (() => {
        if (realRole !== 'dm') return '';
        if (role === 'dm') {
          return `<button type="button" class="inline-create-btn"
                    ${dataAction('Role.viewAsPlayer')}
                    title="${esc(I18n.t('settings.viewAsPlayerTitle'))}">👁 ${esc(I18n.t('settings.viewAsPlayer'))}</button>`;
        }
        return `<button type="button" class="inline-create-btn"
                  ${dataAction('Role.backToDM')}
                  title="${esc(I18n.t('settings.backToDMTitle'))}">← ${esc(I18n.t('settings.backToDM'))}</button>`;
      })();
      const passwordSection = realRole === 'dm'
        ? passwordSectionHtml()
        : `<p class="settings-hint settings-account-dm-note">
             ${esc(I18n.t('settings.passwordDMOnly'))}
           </p>`;

      if (realRole === 'dm') ensureServerInfo();
      const serverSection = realRole === 'dm' && canRestart ? `
          <hr class="settings-section-divider">
          <div class="settings-mapviews-group-title">♻ ${esc(I18n.t('settings.serverOps'))}</div>
          <p class="settings-hint settings-account-server-hint">
            ${esc(I18n.t('settings.serverOpsHint'))}
          </p>
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.restartServer')}>♻ ${esc(I18n.t('settings.restartServer'))}</button>` : '';

      return `
        <div class="settings-editor-head">
          <h2>🖥 ${esc(I18n.t('settings.tabAccount'))}</h2>
        </div>
        <div class="settings-panel">
          <div class="settings-field settings-account-role">
            <span class="settings-field-label">${esc(I18n.t('settings.currentRole'))}</span>
            <div>${roleChip()}</div>
          </div>
          <p class="settings-hint settings-account-hint">
            ${esc(I18n.t('settings.logoutHint'))}
          </p>
          <div class="settings-account-actions">
            ${logoutButton}
            ${viewAsButton}
          </div>
          ${passwordSection}
          ${serverSection}
        </div>`;
    }

    function changePassword(role) {
      if (role !== 'dm' && role !== 'player') return;
      const valueOf = id => document.getElementById(id)?.value || '';
      const current = valueOf(`pwd-${role}-current`);
      const next = valueOf(`pwd-${role}-new`);
      const confirmation = valueOf(`pwd-${role}-confirm`);
      if (!current) {
        flash(I18n.t('settings.enterCurrentDMPassword'), false);
        return;
      }
      if (next !== confirmation) {
        flash(I18n.t('settings.passwordsMismatch'), false);
        return;
      }
      if (role === 'dm' && next.length < 4) {
        flash(I18n.t('settings.dmPasswordTooShort'), false);
        return;
      }
      if (role === 'player' && next.length > 0 && next.length < 4) {
        flash(I18n.t('settings.playerPasswordTooShort'), false);
        return;
      }
      if (next.length > 200) {
        flash(I18n.t('settings.passwordTooLong'), false);
        return;
      }

      ApiClient.requestJson('/api/passwords', {
        method: 'POST',
        json: { role, currentPassword: current, newPassword: next },
      })
        .then(() => {
          const message = role === 'player' && next === ''
            ? I18n.t('settings.playerAccountDisabled')
            : I18n.t('settings.passwordChanged', {
              role: role === 'dm'
                ? I18n.t('settings.roleDMShort')
                : I18n.t('settings.rolePlayerShort'),
            });
          flash(message);
          return loadPasswordStatus().then(render);
        })
        .catch(() => flash(I18n.t('settings.passwordChangeFailed'), false));
    }

    function logout() {
      if (!confirm(I18n.t('settings.logoutConfirm'))) return;
      Role.logout().then(() => flash(I18n.t('settings.loggedOut')));
    }

    function showRestartOverlay() {
      let overlay = document.getElementById('server-restart-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'server-restart-overlay';
        document.body.appendChild(overlay);
      }
      overlay.innerHTML = `<div class="sro-card"><div class="sro-spinner" aria-hidden="true"></div>`
        + `<div class="sro-msg">${esc(I18n.t('settings.restarting'))}</div></div>`;
      let phase = 'down';
      let tries = 0;
      const timeout = () => {
        overlay.innerHTML = `<div class="sro-card"><div class="sro-msg">${esc(I18n.t('settings.restartTimeout'))}</div>`
          + `<button type="button" class="edit-save-btn" ${dataAction('reload')}>${esc(I18n.t('settings.reloadNow'))}</button></div>`;
      };
      const poll = () => {
        tries++;
        fetch('/api/version', { cache: 'no-store' })
          .then(response => {
            if (!response.ok) throw new Error('down');
            if (phase === 'up') {
              window.location.reload();
              return;
            }
            if (tries < 90) setTimeout(poll, 800);
            else timeout();
          })
          .catch(() => {
            phase = 'up';
            if (tries < 90) setTimeout(poll, 800);
            else timeout();
          });
      };
      setTimeout(poll, 800);
    }

    function restartServer() {
      if (!requireDM()) return;
      if (!confirm(I18n.t('settings.restartQ'))) return;
      Store.restartServer().then(result => {
        if (!result.ok) {
          flash(I18n.t('settings.restartFailed'), false);
          return;
        }
        showRestartOverlay();
      });
    }

    return Object.freeze({
      canRestart: () => canRestart === true,
      changePassword,
      ensureServerInfo,
      html,
      logout,
      open,
      restartServer,
    });
  }

  return Object.freeze({ create });
})();
