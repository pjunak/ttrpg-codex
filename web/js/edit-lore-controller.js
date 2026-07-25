import { Store } from './store.js';
import { EditTemplates } from './edit_templates.js';
import { I18n } from './i18n.js';

export const EditLoreController = (() => {
  function create({
    store = Store,
    templates = EditTemplates,
    i18n = I18n,
    documentRef = globalThis.document,
    consumePrefill,
    setPrefill,
    collectVisibility,
    checkValues,
    toast,
    markClean,
    refreshTo,
    navigate = hash => { globalThis.window.location.hash = hash; },
  }) {
    function renderBuhEditor(entity) {
      if (!entity?.id) {
        const prefill = consumePrefill('buh');
        if (prefill) return templates.renderBuhEditor(prefill);
      }
      return templates.renderBuhEditor(entity);
    }

    function startNewBuh(prefill) {
      setPrefill('buh', prefill || {});
      refreshTo('#/buh/new');
    }

    function saveBuh(originalId) {
      const uid = originalId || 'new_god';
      const name = documentRef.getElementById(`gf-name-${uid}`)?.value.trim();
      if (!name) {
        toast(i18n.t('editmode.nameRequired'), false);
        return;
      }
      const id = originalId || store.generateId(name);
      const existing = originalId ? (store.getBuh(originalId) || {}) : {};
      store.saveBuh({
        ...existing,
        id,
        name,
        symbol: documentRef.getElementById(`gf-symbol-${uid}`)?.value.trim() || '',
        domain: documentRef.getElementById(`gf-domain-${uid}`)?.value.trim() || '',
        alignment: documentRef.getElementById(`gf-alignment-${uid}`)?.value.trim() || '',
        description: documentRef.getElementById(`gf-desc-${uid}`)?.value.trim() || '',
        ...collectVisibility(uid),
      });
      toast(i18n.t('editmode.deitySaved'));
      markClean();
      refreshTo(`#/buh/${id}`);
    }

    function deleteBuh(id) {
      store.deleteBuh(id);
      toast(i18n.t('editmode.deityDeleted'), true, {
        action: {
          label: `↶ ${i18n.t('action.undo')}`,
          onClick: () => {
            store.undelete('pantheon', id);
            toast(i18n.t('editmode.deityRestored'));
          },
        },
      });
      navigate('#/panteon');
    }

    function renderArtifactEditor(entity) {
      if (!entity?.id) {
        const prefill = consumePrefill('artifact');
        if (prefill) return templates.renderArtifactEditor(prefill);
      }
      return templates.renderArtifactEditor(entity);
    }

    function startNewArtifact(prefill) {
      setPrefill('artifact', prefill || {});
      refreshTo('#/artefakt/new');
    }

    function saveArtifact(originalId) {
      const uid = originalId || 'new_art';
      const name = documentRef.getElementById(`af-name-${uid}`)?.value.trim();
      if (!name) {
        toast(i18n.t('editmode.titleRequired'), false);
        return;
      }
      const id = originalId || store.generateId(name);
      const existing = originalId
        ? (store.getArtifact(originalId) || {})
        : {};
      const next = {
        ...existing,
        id,
        name,
        ownerCharacterId: documentRef.getElementById(`af-owner-${uid}`)?.value.trim() || '',
        locationId: documentRef.getElementById(`af-loc-${uid}`)?.value.trim() || '',
        description: documentRef.getElementById(`af-desc-${uid}`)?.value.trim() || '',
        ...collectVisibility(uid),
      };
      delete next.state;
      store.saveArtifact(next);
      toast(i18n.t('editmode.artifactSaved'));
      markClean();
      refreshTo(`#/artefakt/${id}`);
    }

    function deleteArtifact(id) {
      store.deleteArtifact(id);
      toast(i18n.t('editmode.artifactDeleted'), true, {
        action: {
          label: `↶ ${i18n.t('action.undo')}`,
          onClick: () => {
            store.undelete('artifacts', id);
            toast(i18n.t('editmode.artifactRestored'));
          },
        },
      });
      navigate('#/artefakty');
    }

    function renderHistoricalEventEditor(entity) {
      if (!entity?.id) {
        const prefill = consumePrefill('historicalEvent');
        if (prefill) return templates.renderHistoricalEventEditor(prefill);
      }
      return templates.renderHistoricalEventEditor(entity);
    }

    function startNewHistoricalEvent(prefill) {
      setPrefill('historicalEvent', prefill || {});
      refreshTo('#/historicka-udalost/new');
    }

    function saveHistoricalEvent(originalId) {
      const uid = originalId || 'new_hist';
      const name = documentRef
        .getElementById(`he-name-${uid}`)
        ?.value.trim();
      if (!name) {
        toast(i18n.t('editmode.titleRequired'), false);
        return;
      }
      const id = originalId || store.generateId(name);
      const existing = originalId
        ? (store.getHistoricalEvent(originalId) || {})
        : {};
      const tags = (
        documentRef.getElementById(`he-tags-${uid}`)?.value || ''
      )
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      store.saveHistoricalEvent({
        ...existing,
        ...collectVisibility(uid),
        id,
        name,
        start: documentRef.getElementById(`he-start-${uid}`)?.value.trim() || '',
        end: documentRef.getElementById(`he-end-${uid}`)?.value.trim() || '',
        summary: documentRef.getElementById(`he-summary-${uid}`)?.value.trim() || '',
        body: documentRef.getElementById(`he-body-${uid}`)?.value.trim() || '',
        characters: checkValues(`he-chars-${uid}`),
        locations: checkValues(`he-locs-${uid}`),
        tags,
      });
      toast(i18n.t('editmode.historicalEventSaved'));
      markClean();
      refreshTo(`#/historicka-udalost/${id}`);
    }

    function deleteHistoricalEvent(id) {
      store.deleteHistoricalEvent(id);
      toast(i18n.t('editmode.historicalEventDeleted'), true, {
        action: {
          label: `↶ ${i18n.t('action.undo')}`,
          onClick: () => {
            store.undelete('historicalEvents', id);
            toast(i18n.t('editmode.historicalEventRestored'));
          },
        },
      });
      navigate('#/historie');
    }

    return Object.freeze({
      renderBuhEditor,
      startNewBuh,
      saveBuh,
      deleteBuh,
      renderArtifactEditor,
      startNewArtifact,
      saveArtifact,
      deleteArtifact,
      renderHistoricalEventEditor,
      startNewHistoricalEvent,
      saveHistoricalEvent,
      deleteHistoricalEvent,
    });
  }

  return Object.freeze({ create });
})();
