import { BrowserAddonRuntime } from "./browser-addon-runtime.js";
import { BrowserAddonSession, type BrowserAddonSessionCallbacks } from "./browser-addon-session.js";
import { BrowserGraphClient } from "./browser-graph-client.js";
import { BrowserContributionRegistry } from "./browser-sdk.js";
import { BrowserCatalogStore } from "./catalog-store.js";
import { BrowserAddonDataClient } from "./data-client.js";
import { BrowserAddonDataChanges } from "./data-changes.js";
import { BrowserAddonContentClient } from "./content-client.js";
import { BrowserAddonServiceClient } from "./service-client.js";
import { createDocumentStyleLoader } from "./browser-styles.js";
import { BrowserGenerationManager, createModuleActivator } from "./generation-manager.js";

export interface BrowserAddonComposition {
  readonly dataChanges: BrowserAddonDataChanges;
  readonly session: BrowserAddonSession;
  readonly contributions: BrowserContributionRegistry;
  /** Every active add-on's message catalogs; dispose it when the session stops. */
  readonly catalogs: BrowserCatalogStore;
  renewCsrfToken(token: string): void;
}

export interface BrowserAddonCompositionCallbacks extends BrowserAddonSessionCallbacks {
  /** A catalog failed to load; its language falls back to English. */
  readonly onCatalogError?: (cause: unknown) => void;
}

/** Browser-only composition root; add-on modules never receive these owners. */
export function createBrowserAddonComposition(
  document: Document,
  csrfToken: string,
  callbacks: BrowserAddonCompositionCallbacks = {},
): BrowserAddonComposition {
  const graphClient = new BrowserGraphClient();
  const catalogs = new BrowserCatalogStore({
    onError: (cause) => callbacks.onCatalogError?.(cause),
  });
  catalogs.followUiLocale();
  const dataChanges = new BrowserAddonDataChanges((cause) => callbacks.onDiagnostic?.(cause));
  const contributions = new BrowserContributionRegistry(
    (cause) => callbacks.onDiagnostic?.(cause),
    (descriptor, signal) =>
      new BrowserAddonDataClient({
        addonId: descriptor.addonId,
        generationId: descriptor.generationId,
        csrfToken,
        currentCsrfToken: () => csrfToken,
        signal,
        subscribe: dataChanges.scoped(descriptor.addonId, signal),
      }).api(),
    (descriptor, signal) =>
      new BrowserAddonContentClient({
        addonId: descriptor.addonId,
        generationId: descriptor.generationId,
        signal,
      }).api(),
    (descriptor, signal) =>
      new BrowserAddonServiceClient({
        addonId: descriptor.addonId,
        generationId: descriptor.generationId,
        csrfToken,
        currentCsrfToken: () => csrfToken,
        signal,
      }).api(),
    catalogs,
  );
  const loadStyles = createDocumentStyleLoader(document);
  const activateModule = createModuleActivator(
    (entryUrl) => import(/* @vite-ignore */ entryUrl) as Promise<unknown>,
    (descriptor, scope) => contributions.open(descriptor, scope),
    async (descriptor, scope) => {
      // Catalogs load before the module so its first render is translated.
      catalogs.settleIndex(graphClient.current()?.catalogs);
      await catalogs.prepare(descriptor.addonId, undefined, scope.signal);
      return loadStyles(descriptor, scope);
    },
  );
  const manager = new BrowserGenerationManager(activateModule, (failure) =>
    callbacks.onDiagnostic?.(failure),
  );
  const runtime = new BrowserAddonRuntime(graphClient, manager);
  return {
    dataChanges,
    session: new BrowserAddonSession(runtime, {
      ...callbacks,
      onRefresh: (cause, result) => {
        catalogs.settleIndex(result.transport.graph.catalogs);
        void catalogs.prepareAll();
        contributions.settleGraph(result.transport.graph);
        callbacks.onRefresh?.(cause, result);
      },
    }),
    contributions,
    catalogs,
    renewCsrfToken(token: string): void {
      if (token.length < 32) throw new TypeError("invalid renewed session token");
      csrfToken = token;
    },
  };
}
