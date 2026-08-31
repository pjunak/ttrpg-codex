import { BrowserAddonRuntime } from "../addons/browser-addon-runtime.js";
import {
  BrowserAddonSession,
  type BrowserAddonSessionCallbacks,
} from "../addons/browser-addon-session.js";
import { BrowserGraphClient } from "../addons/browser-graph-client.js";
import { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import { createDocumentStyleLoader } from "../addons/browser-styles.js";
import {
  BrowserGenerationManager,
  createModuleActivator,
} from "../addons/generation-manager.js";
import { SharedEventStream } from "../core/event-stream.js";

export interface BrowserAddonComposition {
  readonly session: BrowserAddonSession;
  readonly contributions: BrowserContributionRegistry;
}

/** Browser-only composition root; add-on modules never receive these owners. */
export function createBrowserAddonComposition(
  document: Document,
  callbacks: BrowserAddonSessionCallbacks = {},
): BrowserAddonComposition {
  const contributions = new BrowserContributionRegistry();
  const manager = new BrowserGenerationManager(createModuleActivator(
    (entryUrl) => import(/* @vite-ignore */ entryUrl) as Promise<unknown>,
    (descriptor, scope) => contributions.open(descriptor, scope),
    createDocumentStyleLoader(document),
  ));
  const runtime = new BrowserAddonRuntime(new BrowserGraphClient(), manager);
  return {
    session: new BrowserAddonSession(runtime, new SharedEventStream(), callbacks),
    contributions,
  };
}
