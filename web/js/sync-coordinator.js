export function createSyncCoordinator({ load, render }) {
  let acceptedHash = null;
  let requested = null;
  let activeRequest = null;
  let requestId = 0;
  let active = false;
  let idleWaiters = [];

  async function drain() {
    if (active) return;
    active = true;
    try {
      while (requested) {
        const current = requested;
        requested = null;
        activeRequest = current;
        const loaded = await load({
          shouldCommit: () => current.id === requestId,
        });
        activeRequest = null;
        if (current.id !== requestId || !loaded) continue;
        if (current.hash !== null) acceptedHash = current.hash;
        await render();
      }
    } finally {
      active = false;
      if (requested) void drain();
      else {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  function request(hash = null) {
    const normalizedHash = typeof hash === 'string' ? hash : null;
    if (normalizedHash !== null && normalizedHash === acceptedHash) return false;
    if (!requested && activeRequest && normalizedHash !== null
        && activeRequest.hash === normalizedHash) return false;
    if (requested && normalizedHash !== null && requested.hash === normalizedHash) return false;
    requested = { id: ++requestId, hash: normalizedHash };
    void drain();
    return true;
  }

  return {
    request,
    getAcceptedHash: () => acceptedHash,
    isActive: () => active,
    whenIdle: () => active || requested
      ? new Promise(resolve => { idleWaiters.push(resolve); })
      : Promise.resolve(),
  };
}
