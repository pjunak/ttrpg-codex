'use strict';

class WriteLockTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Core write lock acquisition timed out after ${timeoutMs} ms`);
    this.name = 'WriteLockTimeoutError';
    this.code = 'WRITE_LOCK_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

class CoreWriteLock {
  constructor({ timeoutMs }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive finite number');
    }
    this.timeoutMs = timeoutMs;
    this.active = false;
    this.queue = [];
  }

  run(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');

    return new Promise((resolve, reject) => {
      const item = { fn, resolve, reject, cancelled: false, timer: null };
      if (this.active || this.queue.length) {
        item.timer = setTimeout(() => {
          item.cancelled = true;
          reject(new WriteLockTimeoutError(this.timeoutMs));
        }, this.timeoutMs);
        if (item.timer.unref) item.timer.unref();
      }
      this.queue.push(item);
      this.#drain();
    });
  }

  #drain() {
    if (this.active) return;

    let item;
    do {
      item = this.queue.shift();
    } while (item && item.cancelled);
    if (!item) return;

    this.active = true;
    if (item.timer) clearTimeout(item.timer);

    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active = false;
        this.#drain();
      });
  }
}

module.exports = { CoreWriteLock, WriteLockTimeoutError };
