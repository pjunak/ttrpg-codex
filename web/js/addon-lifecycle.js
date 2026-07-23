export const DISPOSE_TIMEOUT_MS = 2000;

export function createDisposalStack() {
  return { disposers: [], disposed: false };
}

export function addDisposer(stack, fn) {
  if (typeof fn !== 'function') throw new Error('onDispose: fn must be a function');
  if (stack.disposed) throw new Error('onDispose: addon instance is already disposed');
  stack.disposers.push(fn);
}

export function addReturnedDisposer(stack, value) {
  if (typeof value === 'function') stack.disposers.push(value);
}

export async function disposeStack(stack, opts = {}) {
  if (!stack || stack.disposed) return { started: false, errors: [], timedOut: false };
  stack.disposed = true;
  const errors = [];
  const pending = [];
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};

  for (const fn of stack.disposers.slice().reverse()) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        pending.push(Promise.resolve(result).catch((error) => {
          errors.push(error);
          onError(error);
        }));
      }
    } catch (error) {
      errors.push(error);
      onError(error);
    }
  }

  if (!pending.length) return { started: true, errors, timedOut: false };
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : DISPOSE_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([
    Promise.allSettled(pending).then(() => 'settled'),
    timeout,
  ]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    const error = new Error(`addon disposal timed out after ${timeoutMs} ms`);
    errors.push(error);
    onError(error);
  }
  return { started: true, errors, timedOut: outcome === 'timeout' };
}

export function reverseRegistrations(undo, onError = () => {}) {
  for (const fn of Array.isArray(undo) ? undo.slice().reverse() : []) {
    try { fn(); } catch (error) { onError(error); }
  }
}
