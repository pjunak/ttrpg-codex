import { I18n } from './i18n.js';
import { esc } from './utils.js';

const DRAFT_PREFIX = 'md_draft:';
const DRAFT_DEBOUNCE_MS = 500;
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const EditDrafts = (() => {
  function create({
    documentRef = document,
    windowRef = window,
    storage = localStorage,
    confirmLeave = message => confirm(message),
    now = Date.now,
  } = {}) {
    let dirty = false;
    const draftTimers = new Map();

    function dispatch(name) {
      windowRef.dispatchEvent(new CustomEvent(name));
    }

    function draftKey(textareaId) {
      return DRAFT_PREFIX + textareaId;
    }

    function loadDraft(textareaId) {
      try {
        const raw = storage.getItem(draftKey(textareaId));
        if (!raw) return null;
        const draft = JSON.parse(raw);
        if (!draft || typeof draft.content !== 'string') return null;
        if (draft.savedAt && now() - draft.savedAt > DRAFT_TTL_MS) {
          storage.removeItem(draftKey(textareaId));
          return null;
        }
        return draft;
      } catch {
        return null;
      }
    }

    function saveDraft(textareaId, content) {
      try {
        storage.setItem(draftKey(textareaId), JSON.stringify({
          content,
          savedAt: now(),
        }));
      } catch {}
    }

    function clearDraft(textareaId) {
      try {
        storage.removeItem(draftKey(textareaId));
      } catch {}
    }

    function flush() {
      for (const [id, timer] of draftTimers) {
        clearTimeout(timer);
        const textarea = documentRef.getElementById(id);
        if (textarea?.classList.contains('md-easy')) {
          saveDraft(id, textarea.value || '');
        }
      }
      draftTimers.clear();
    }

    function markClean() {
      dirty = false;
      documentRef.querySelectorAll('textarea.md-easy').forEach(textarea => {
        if (textarea.id) clearDraft(textarea.id);
      });
      dispatch('editmode:clean');
    }

    function setDirty() {
      if (dirty) return;
      dirty = true;
      dispatch('editmode:dirty');
    }

    function discardDirty() {
      dirty = false;
      dispatch('editmode:clean');
    }

    function isDirty() {
      return dirty;
    }

    function showDraftBanner(textarea, draft, editor) {
      const host = textarea.closest('.EasyMDEContainer')?.parentElement
        || textarea.parentElement;
      if (!host
          || host.querySelector(`.md-draft-banner[data-for="${textarea.id}"]`)) {
        return;
      }
      const when = I18n.formatDate(draft.savedAt || now(), {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const banner = documentRef.createElement('div');
      banner.className = 'md-draft-banner';
      banner.setAttribute('data-for', textarea.id);
      banner.innerHTML = `
        <span class="md-draft-banner-icon">💾</span>
        <span class="md-draft-banner-text">${esc(I18n.t('editmode.draftFound', { when }))}</span>
        <button type="button" class="md-draft-btn md-draft-btn-restore">${esc(I18n.t('editmode.draftRestore'))}</button>
        <button type="button" class="md-draft-btn md-draft-btn-discard">${esc(I18n.t('editmode.draftDiscard'))}</button>
      `;
      banner.querySelector('.md-draft-btn-restore').addEventListener('click', () => {
        if (editor && typeof editor.value === 'function') editor.value(draft.content);
        else textarea.value = draft.content;
        setDirty();
        banner.remove();
      });
      banner.querySelector('.md-draft-btn-discard').addEventListener('click', () => {
        clearDraft(textarea.id);
        banner.remove();
      });
      host.insertBefore(banner, host.firstChild);
    }

    function wireEasyMDE(editor, textarea) {
      const id = textarea.id;
      if (!id) return;
      const draft = loadDraft(id);
      if (draft && draft.content !== (textarea.value || '')) {
        showDraftBanner(textarea, draft, editor);
      } else if (draft) {
        clearDraft(id);
      }
      try {
        editor.codemirror.on('change', () => {
          setDirty();
          clearTimeout(draftTimers.get(id));
          draftTimers.set(id, setTimeout(() => {
            const current = documentRef.getElementById(id);
            if (current) saveDraft(id, current.value || '');
          }, DRAFT_DEBOUNCE_MS));
        });
      } catch {}
    }

    documentRef.addEventListener('input', event => {
      if (event.target.closest?.('.edit-form')) setDirty();
    }, true);
    documentRef.addEventListener('change', event => {
      if (event.target.closest?.('.edit-form')) setDirty();
    }, true);
    windowRef.addEventListener('beforeunload', event => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
    windowRef.addEventListener('pagehide', flush);
    documentRef.addEventListener('click', event => {
      if (!dirty) return;
      const link = event.target?.closest?.('a[href^="#/"]');
      if (!link) return;
      if (!confirmLeave(I18n.t('editmode.unsavedLeaveQ'))) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        discardDirty();
      }
    }, true);

    return Object.freeze({
      discardDirty,
      isDirty,
      markClean,
      wireEasyMDE,
    });
  }

  return Object.freeze({ create });
})();
