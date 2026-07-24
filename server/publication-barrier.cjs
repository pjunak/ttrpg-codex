'use strict';

class PublicationBarrier {
  constructor() {
    this.readers = 0;
    this.writer = false;
    this.queue = [];
    this.poisonError = null;
  }

  read(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    if (this.poisonError) return Promise.reject(this.poisonError);
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: 'read', fn, resolve, reject });
      this.#drain();
    });
  }

  publish(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    if (this.poisonError) return Promise.reject(this.poisonError);
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: 'write', fn, resolve, reject });
      this.#drain();
    });
  }

  poison(error) {
    if (this.poisonError) return;
    this.poisonError = error instanceof Error ? error : new Error(String(error || 'Publication barrier poisoned'));
    const queued = this.queue.splice(0);
    for (const item of queued) item.reject(this.poisonError);
  }

  #drain() {
    if (this.writer) return;
    const first = this.queue[0];
    if (!first) return;
    if (first.kind === 'write') {
      if (this.readers) return;
      this.queue.shift();
      this.writer = true;
      Promise.resolve()
        .then(first.fn)
        .then(first.resolve, first.reject)
        .finally(() => {
          this.writer = false;
          this.#drain();
        });
      return;
    }

    while (this.queue[0]?.kind === 'read' && !this.writer) {
      const item = this.queue.shift();
      this.readers++;
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.readers--;
          this.#drain();
        });
    }
  }
}

module.exports = { PublicationBarrier };
