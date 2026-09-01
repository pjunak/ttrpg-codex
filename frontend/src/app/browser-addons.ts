import { BrowserAddonRuntime } from "../addons/browser-addon-runtime.js";
import {
  BrowserAddonSession,
  type BrowserAddonSessionCallbacks,
} from "../addons/browser-addon-session.js";
import { BrowserGraphClient } from "../addons/browser-graph-client.js";
import { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import { BrowserAddonDataClient } from "../addons/data-client.js";
import { BrowserAddonContentClient } from "../addons/content-client.js";
import { BrowserAddonServiceClient } from "../addons/service-client.js";
import { createDocumentStyleLoader } from "../addons/browser-styles.js";
import { createIsolatedFrameActivator } from "../addons/isolated-frame.js";
import {
  BrowserGenerationManager,
  createModuleActivator,
} from "../addons/generation-manager.js";

export interface BrowserAddonComposition {
  readonly session: BrowserAddonSession;
  readonly contributions: BrowserContributionRegistry;
}

/** Browser-only composition root; add-on modules never receive these owners. */
export function createBrowserAddonComposition(
  document: Document,
  csrfToken: string,
  callbacks: BrowserAddonSessionCallbacks = {},
): BrowserAddonComposition {
  const contributions = new BrowserContributionRegistry(
    (cause) => callbacks.onDiagnostic?.(cause),
    (descriptor, signal) => new BrowserAddonDataClient({
      addonId: descriptor.addonId,
      generationId: descriptor.generationId,
      csrfToken,
      signal,
    }).api(),
    (descriptor, signal) => new BrowserAddonContentClient({
      addonId: descriptor.addonId,
      generationId: descriptor.generationId,
      signal,
    }).api(),
    (descriptor, signal) => new BrowserAddonServiceClient({
      addonId: descriptor.addonId,
      generationId: descriptor.generationId,
      csrfToken,
      signal,
    }).api(),
  );
  const activateModule = createModuleActivator(
    (entryUrl) => import(/* @vite-ignore */ entryUrl) as Promise<unknown>,
    (descriptor, scope) => contributions.open(descriptor, scope),
    createDocumentStyleLoader(document),
  );
  const activateFrame = createIsolatedFrameActivator(
    document,
    contributions,
    (cause) => callbacks.onDiagnostic?.(cause),
  );
  const manager = new BrowserGenerationManager((descriptor, context) =>
    descriptor.mode === "isolated"
      ? activateFrame(descriptor, context)
      : activateModule(descriptor, context)
  );
  const runtime = new BrowserAddonRuntime(new BrowserGraphClient(), manager);
  return {
    session: new BrowserAddonSession(runtime, callbacks),
    contributions,
  };
}
