/** Stops awaiting cancelled work while still observing its eventual failure. */
export function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(signal.aborted ? signal.reason : cause);
      },
    );
  });
}
