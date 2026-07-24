export function createMapGenerationController(timers = {}) {
  const setTimer = timers.setTimeout || globalThis.setTimeout;
  const clearTimer = timers.clearTimeout || globalThis.clearTimeout;
  let generation = 0;
  let current = null;

  function _cleanup(state) {
    if (!state || state.cleaned) return;
    state.cleaned = true;
    for (let i = state.cleanups.length - 1; i >= 0; i--) {
      try { state.cleanups[i](); } catch (_) {}
    }
    state.cleanups.length = 0;
  }

  function invalidate() {
    generation++;
    const stale = current;
    current = null;
    _cleanup(stale);
  }

  function begin(container) {
    invalidate();
    const token = Object.freeze({ generation, container });
    current = { token, cleanups: [], cleaned: false };
    return token;
  }

  function isCurrent(token, container = token?.container) {
    return !!token
      && !!current
      && current.token === token
      && token.generation === generation
      && token.container === container;
  }

  function track(token, cleanup) {
    if (typeof cleanup !== 'function') return false;
    if (!isCurrent(token)) {
      try { cleanup(); } catch (_) {}
      return false;
    }
    current.cleanups.push(cleanup);
    return true;
  }

  function schedule(token, callback, delay = 0) {
    if (!isCurrent(token) || typeof callback !== 'function') return null;
    let pending = true;
    const timer = setTimer(() => {
      pending = false;
      if (isCurrent(token)) callback();
    }, delay);
    track(token, () => {
      if (pending) clearTimer(timer);
      pending = false;
    });
    return timer;
  }

  return { begin, invalidate, isCurrent, track, schedule };
}
