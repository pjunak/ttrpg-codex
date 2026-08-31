import type { BrowserGenerationResourceFactory } from "./generation-manager.js";

export function createDocumentStyleLoader(document: Document): BrowserGenerationResourceFactory {
  return async (descriptor, scope) => {
    if (descriptor.styleUrls.length === 0) {
      return undefined;
    }
    const links = descriptor.styleUrls.map((url) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      link.dataset["codexAddon"] = descriptor.addonId;
      link.dataset["codexGeneration"] = descriptor.generationId;
      return link;
    });
    const dispose = () => {
      for (const link of links) {
        link.remove();
      }
    };
    const abort = () => dispose();
    scope.signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.all(links.map((link) => loadStylesheet(document, link, scope.signal)));
    } catch (error: unknown) {
      scope.signal.removeEventListener("abort", abort);
      dispose();
      throw error;
    }
    scope.signal.removeEventListener("abort", abort);
    return dispose;
  };
}

function loadStylesheet(document: Document, link: HTMLLinkElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      link.removeEventListener("load", loaded);
      link.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error(`failed to load browser add-on stylesheet ${link.href}`));
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    link.addEventListener("load", loaded, { once: true });
    link.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    document.head.append(link);
  });
}
