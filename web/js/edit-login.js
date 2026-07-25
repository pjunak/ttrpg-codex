import { I18n } from './i18n.js';
import { Role } from './role.js';
import { esc, trapFocus } from './utils.js';

export const EditLogin = (() => {
  function create({
    toast,
    documentRef = document,
    windowRef = window,
    fetchImpl = (...args) => fetch(...args),
    promptPassword,
    schedule = callback => requestAnimationFrame(callback),
  }) {
    function passwordPrompt(message) {
      return new Promise(resolve => {
        let settled = false;
        const overlay = documentRef.createElement('div');
        overlay.className = 'pw-modal';
        overlay.innerHTML = `
          <div class="pw-backdrop"></div>
          <form class="pw-panel" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title" autocomplete="on">
            <div class="pw-title" id="pw-modal-title">${esc(message || I18n.t('editmode.passwordPrompt'))}</div>
            <div class="pw-row">
              <input class="pw-input" type="password" name="password"
                     autocomplete="current-password" autofocus
                     spellcheck="false" autocapitalize="off">
              <button type="button" class="pw-toggle" aria-label="${esc(I18n.t('editmode.showPassword'))}">👁</button>
            </div>
            <div class="pw-actions">
              <button type="button" class="pw-btn pw-cancel">${esc(I18n.t('action.cancel'))}</button>
              <button type="submit" class="pw-btn pw-ok">${esc(I18n.t('editmode.unlock'))}</button>
            </div>
          </form>
        `;
        documentRef.body.appendChild(overlay);

        const form = overlay.querySelector('.pw-panel');
        const input = overlay.querySelector('.pw-input');
        const backdrop = overlay.querySelector('.pw-backdrop');
        const toggle = overlay.querySelector('.pw-toggle');
        const cancel = overlay.querySelector('.pw-cancel');
        const releaseTrap = trapFocus(form);

        const onKey = event => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          finish(null);
        };
        const cleanup = () => {
          documentRef.removeEventListener('keydown', onKey, true);
          releaseTrap();
          overlay.remove();
        };
        const finish = value => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        form.addEventListener('submit', event => {
          event.preventDefault();
          finish(input.value);
        });
        cancel.addEventListener('click', () => finish(null));
        backdrop.addEventListener('click', () => finish(null));
        toggle.addEventListener('click', () => {
          const wasPassword = input.type === 'password';
          input.type = wasPassword ? 'text' : 'password';
          toggle.setAttribute(
            'aria-label',
            wasPassword
              ? I18n.t('editmode.hidePassword')
              : I18n.t('editmode.showPassword'),
          );
          input.focus();
        });
        documentRef.addEventListener('keydown', onKey, true);
        schedule(() => input.focus());
      });
    }

    const askPassword = promptPassword || passwordPrompt;

    async function promptLogin() {
      if (!Role.isAnonymous()) return true;
      const password = await askPassword(I18n.t('editmode.loginPrompt'));
      if (!password) return false;
      try {
        const response = await fetchImpl('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
          credentials: 'same-origin',
        });
        if (!response.ok) {
          toast(I18n.t('editmode.wrongPassword'), false);
          return false;
        }
        await Role.refresh();
        toast(Role.isDM()
          ? I18n.t('editmode.dmAccess')
          : I18n.t('editmode.playerAccess'));
        return true;
      } catch (error) {
        console.warn(error);
        toast(I18n.t('editmode.loginError'), false);
        return false;
      }
    }

    windowRef.addEventListener('auth:prompt-login', () => {
      promptLogin();
    });

    return Object.freeze({ promptLogin });
  }

  return Object.freeze({ create });
})();
