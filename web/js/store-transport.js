import { writeRevision } from './write-revision.js';

export const StoreTransport = (() => {
  const KEYED_COLLECTIONS = new Set([
    'factions',
    'settings',
    'campaign',
    'deletedDefaults',
  ]);

  function create({
    fetchImpl = (...args) => fetch(...args),
    eventTarget = globalThis.window,
    delay = ms => new Promise(resolve => { setTimeout(resolve, ms); }),
    logger = console,
  } = {}) {
    let available = false;
    let writeChain = Promise.resolve();
    let inflightCount = 0;
    let confirmed = {};
    let recoveryRequired = false;
    const revisions = new Map();

    function dispatch(type, detail) {
      if (!eventTarget?.dispatchEvent) return;
      eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
    }

    function setAvailable(value) {
      available = value === true;
    }

    function isAvailable() {
      return available;
    }

    function acceptDataset(data) {
      confirmed = structuredClone(data || {});
      revisions.clear();
      recoveryRequired = false;
    }

    function needsRecovery() {
      return recoveryRequired;
    }

    async function loadDataset() {
      const response = await fetchImpl('/api/data');
      if (!response.ok) return { ok: false };
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new TypeError('Store: /api/data returned a non-object payload');
      }
      return { ok: true, data };
    }

    function setInflight(count) {
      inflightCount = count;
      dispatch('store:inflight', { count });
    }

    async function requestOnce(url, options) {
      const response = await fetchImpl(url, options);
      let data = null;
      try { data = await response.json(); } catch {}
      if (response.status === 401) {
        dispatch('store:auth-failed');
        return { ok: false, terminal: true, status: 401, data };
      }
      if (response.ok) return { ok: true, data };
      if (response.status >= 400 && response.status < 500) {
        return { ok: false, terminal: true, status: response.status, data };
      }
      return { ok: false, terminal: false, status: response.status, data };
    }

    function enqueueWrite(type, action, request) {
      if (!available || recoveryRequired) {
        if (recoveryRequired) {
          dispatch('store:write-recovery-needed', { type, action });
        }
        return false;
      }
      setInflight(inflightCount + 1);
      writeChain = writeChain.then(async () => {
        if (recoveryRequired) return;
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const result = await request();
            if (result.ok) return;
            if (result.terminal) {
              if (result.status !== 401) {
                logger.warn(
                  `Store: ${type}/${action} rejected (${result.status}).`,
                );
                dispatch('store:save-failed', {
                  type,
                  action,
                  status: result.status,
                  code: result.data?.code,
                });
              }
              recoveryRequired = true;
              dispatch('store:write-recovery-needed', {
                type,
                action,
                status: result.status,
                code: result.data?.code,
              });
              return;
            }
            lastError = new Error(`HTTP ${result.status}`);
          } catch (error) {
            lastError = error;
          }
          if (attempt < 3) await delay(attempt * attempt * 200);
        }
        logger.warn(
          `Store: ${type}/${action} sync failed after retries.`,
          lastError,
        );
        recoveryRequired = true;
        dispatch('store:save-failed', { type, action });
        dispatch('store:write-recovery-needed', { type, action });
      }).finally(() => {
        setInflight(Math.max(0, inflightCount - 1));
      });
      return true;
    }

    function recordKey(type, payload) {
      if (type === 'relationships') {
        return `${type}\0${payload?.source || ''}\0${payload?.target || ''}\0${payload?.type || ''}`;
      }
      return `${type}\0${payload?.id || ''}`;
    }

    function recordFrom(dataset, type, payload) {
      const collection = dataset[type];
      if (Array.isArray(collection)) {
        if (type === 'relationships') {
          return collection.find(record =>
            record?.source === payload?.source
            && record?.target === payload?.target
            && record?.type === payload?.type) || null;
        }
        return collection.find(record => record?.id === payload?.id) || null;
      }
      if (KEYED_COLLECTIONS.has(type)
          && collection && typeof collection === 'object') {
        return collection[payload?.id] ?? null;
      }
      return null;
    }

    function applyConfirmed(type, action, payload) {
      let collection = confirmed[type];
      if (!collection) {
        collection = KEYED_COLLECTIONS.has(type) ? {} : [];
        confirmed[type] = collection;
      }
      if (Array.isArray(collection)) {
        const matches = type === 'relationships'
          ? record => record?.source === payload?.source
            && record?.target === payload?.target
            && record?.type === payload?.type
          : record => record?.id === payload?.id;
        const index = collection.findIndex(matches);
        if (action === 'delete') {
          if (index >= 0) collection.splice(index, 1);
        } else if (index >= 0) {
          collection[index] = structuredClone(payload);
        } else {
          collection.push(structuredClone(payload));
        }
        return;
      }
      if (action === 'delete') delete collection[payload.id];
      else collection[payload.id] = structuredClone(payload.data);
    }

    function sync(type, action, payload) {
      const body = (payload && typeof payload === 'object')
        ? JSON.parse(JSON.stringify(payload))
        : payload;
      const key = recordKey(type, body);
      return enqueueWrite(type, action, async () => {
        const baseRevision = revisions.get(key)
          || writeRevision(recordFrom(confirmed, type, body));
        const result = await requestOnce('/api/data', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            action,
            payload: body,
            baseRevision,
          }),
        });
        if (result.ok) {
          applyConfirmed(type, action, body);
          revisions.set(
            key,
            result.data?.revision || writeRevision(
              recordFrom(confirmed, type, body),
            ),
          );
        }
        return result;
      });
    }

    function deleteEnumItem(command) {
      const body = JSON.parse(JSON.stringify(command || {}));
      const category = encodeURIComponent(body.category || '');
      const id = encodeURIComponent(body.id || '');
      const key = `settings\0${body.category || ''}`;
      return enqueueWrite('settings', 'delete-enum', async () => {
        const baseRevision = revisions.get(key)
          || writeRevision(confirmed.settings?.[body.category] ?? null);
        const result = await requestOnce(`/api/campaign/enums/${category}/${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            replaceWith: body.replaceWith || '',
            force: body.force === true,
            tombstone: body.tombstone === true,
            baseRevision,
          }),
        });
        if (result.ok) {
          if (Array.isArray(confirmed.settings?.[body.category])) {
            confirmed.settings[body.category] = confirmed.settings[body.category]
              .filter(item => item?.id !== body.id);
          }
          revisions.set(
            key,
            result.data?.revision
              || writeRevision(confirmed.settings?.[body.category] ?? null),
          );
        }
        return result;
      });
    }

    async function settled() {
      await writeChain;
    }

    return Object.freeze({
      setAvailable,
      isAvailable,
      acceptDataset,
      needsRecovery,
      loadDataset,
      sync,
      deleteEnumItem,
      settled,
    });
  }

  return Object.freeze({ create });
})();
