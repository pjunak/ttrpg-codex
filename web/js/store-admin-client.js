import { ApiClient } from './api-client.js';
import { I18n } from './i18n.js';

export const StoreAdminClient = (() => {
  function failure(error) {
    if (error.status === 401 || error.status === 403) {
      return { ok: false, error: I18n.t('store.dmRequired') };
    }
    return {
      ok: false,
      error: error.message || I18n.t('store.networkError'),
    };
  }

  async function resolveAddonConflict(target, winner) {
    try {
      const body = await ApiClient.requestJson('/api/addons/resolve', {
        method: 'POST',
        json: { target, winner },
      });
      return { ok: true, resolutions: body.resolutions };
    } catch (error) {
      return failure(error);
    }
  }

  async function checkAddonUpdates() {
    try {
      const body = await ApiClient.requestJson('/api/addons/check-updates', {
        method: 'POST',
      });
      return {
        ok: true,
        updates: Array.isArray(body.updates) ? body.updates : [],
      };
    } catch (error) {
      return failure(error);
    }
  }

  async function rollbackAddon(id, hash) {
    try {
      const body = await ApiClient.requestJson(
        `/api/addons/${encodeURIComponent(id)}/rollback`,
        {
          method: 'POST',
          json: hash ? { hash } : {},
        },
      );
      return { ok: true, version: body.version };
    } catch (error) {
      return failure(error);
    }
  }

  async function updateAllAddons() {
    try {
      const body = await ApiClient.requestJson('/api/addons/update-all', {
        method: 'POST',
      });
      return {
        ok: true,
        updated: Array.isArray(body.updated) ? body.updated : [],
        skipped: Array.isArray(body.skipped) ? body.skipped : [],
        errors: Array.isArray(body.errors) ? body.errors : [],
        serverChanged: !!body.serverChanged,
      };
    } catch (error) {
      return failure(error);
    }
  }

  async function restartServer() {
    try {
      await ApiClient.requestJson('/api/restart', { method: 'POST' });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async function getCanRestart() {
    try {
      const body = await ApiClient.requestJson('/api/version', {
        cache: 'no-store',
      });
      return !!body.canRestart;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    resolveAddonConflict,
    checkAddonUpdates,
    rollbackAddon,
    updateAllAddons,
    restartServer,
    getCanRestart,
  });
})();
