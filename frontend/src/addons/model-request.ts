import { waitForSignal } from "../core/abort-signal.js";
import type { ActiveBrowserContribution } from "./browser-sdk.js";

/**
 * Asks an active model provider for a value. The request ends when the
 * caller, the provider's generation or the deadline does; a provider that
 * ignores its signal is no longer awaited.
 */
export async function requestModel(
  active: ActiveBrowserContribution,
  request: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  if (active.binding.kind !== "model-provider") throw new TypeError("Model provider unavailable");
  const binding = active.binding,
    deadline = new AbortController(),
    combined = AbortSignal.any([signal, active.signal, deadline.signal]);
  // An explicit timer is cleared with the request, unlike AbortSignal.timeout.
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    combined.throwIfAborted();
    // A provider may answer synchronously, asynchronously or by throwing.
    return await waitForSignal(
      (async () => binding.provide(structuredClone(request), { signal: combined }))(),
      combined,
    );
  } finally {
    clearTimeout(timer);
  }
}
