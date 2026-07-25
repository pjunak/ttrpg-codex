export const StoreTransport = (() => {
  function create({
    fetchImpl = (...args) => fetch(...args),
    eventTarget = globalThis.window,
    delay = ms => new Promise(resolve => { setTimeout(resolve, ms); }),
    logger = console,
  } = {}) {
    let available = false;
    let writeChain = Promise.resolve();
    let inflightCount = 0;

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

    async function patchOnce(type, action, payload) {
      const response = await fetchImpl('/api/data', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, action, payload }),
      });
      if (response.status === 401) {
        dispatch('store:auth-failed');
        return { ok: false, terminal: true, status: 401 };
      }
      if (response.ok) return { ok: true };
      if (response.status >= 400 && response.status < 500) {
        return { ok: false, terminal: true, status: response.status };
      }
      return { ok: false, terminal: false, status: response.status };
    }

    function sync(type, action, payload) {
      if (!available) return false;
      const body = (payload && typeof payload === 'object')
        ? JSON.parse(JSON.stringify(payload))
        : payload;
      setInflight(inflightCount + 1);
      writeChain = writeChain.then(async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const result = await patchOnce(type, action, body);
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
                });
              }
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
        dispatch('store:save-failed', { type, action });
      }).finally(() => {
        setInflight(Math.max(0, inflightCount - 1));
      });
      return true;
    }

    async function settled() {
      await writeChain;
    }

    return Object.freeze({
      setAvailable,
      isAvailable,
      loadDataset,
      sync,
      settled,
    });
  }

  return Object.freeze({ create });
})();
