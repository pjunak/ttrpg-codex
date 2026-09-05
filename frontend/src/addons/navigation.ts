import type {
  ActiveBrowserContribution,
  BrowserContributionRegistry,
} from "./browser-sdk.js";
import type { BrowserRole } from "./generation-manager.js";
import type { Disposer } from "./generation-scope.js";

export interface BrowserNavigationEntry {
  readonly addonId: string;
  readonly generationId: string;
  readonly contributionId: string;
  readonly label: string;
  readonly routeContributionId: string;
  readonly hash: string;
}

export interface BrowserNavigationOutletOptions {
  readonly document: Document;
  readonly root: HTMLElement;
  readonly registry: BrowserContributionRegistry;
  readonly role: BrowserRole;
  readonly currentHash: () => string;
  readonly include?: (entry: BrowserNavigationEntry) => boolean;
  readonly onError?: (cause: unknown) => void;
  readonly onCountChange?: (count: number) => void;
}

interface MountedNavigationEntry {
  readonly identity: string;
  readonly anchor: HTMLAnchorElement;
}

/** Returns the host-owned hash for one already-validated route declaration. */
export function browserAddonRouteHash(active: ActiveBrowserContribution): string {
  if (active.descriptor.surface !== "route") {
    throw new TypeError("only route contributions have an add-on route hash");
  }
  const path = active.descriptor.config["path"];
  if (typeof path !== "string") {
    throw new TypeError(`route ${active.addonId}:${active.descriptor.id} has no canonical path`);
  }
  return `#/addons/${encodeURIComponent(active.addonId)}/${path}`;
}

export function isBrowserAddonRouteHash(value: string): boolean {
  return parseBrowserAddonLocation(value) !== undefined;
}

/** Query values are navigation input, never record identity or write authority. */
export function parseBrowserAddonLocation(hash: string): { readonly routeHash: string; readonly query: readonly (readonly [string, string])[] } | undefined {
  if (new TextEncoder().encode(hash).length > 4096) return undefined;
  const separator = hash.indexOf("?");
  const routeHash = separator === -1 ? hash : hash.slice(0, separator);
  if (!/^#\/addons\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u.test(routeHash)) return undefined;
  const raw = separator === -1 ? "" : hash.slice(separator + 1);
  try { decodeURIComponent(raw.replace(/\+/gu, " ")); } catch { return undefined; }
  const query = [...new URLSearchParams(raw).entries()];
  if (query.length > 32 || query.some(([key, value]) => !key || key.length > 64 || value.length > 1024 || /\p{Cc}/u.test(key + value))) return undefined;
  return { routeHash, query };
}

/** Projects declarative sidebar metadata only when its exact route is active. */
export function listBrowserNavigation(
  registry: BrowserContributionRegistry,
  role: BrowserRole,
): readonly BrowserNavigationEntry[] {
  const routes = new Map<string, ActiveBrowserContribution>();
  for (const active of registry.list("route", role)) {
    if (active.binding.kind === "element" || active.binding.kind === "isolated-frame") {
      routes.set(routeIdentity(active.addonId, active.generationId, active.descriptor.id), active);
    }
  }

  const entries: BrowserNavigationEntry[] = [];
  for (const active of registry.list("sidebar", role)) {
    if (active.binding.kind !== "declarative") {
      continue;
    }
    const routeContributionId = active.descriptor.config["route"];
    if (typeof routeContributionId !== "string") {
      continue;
    }
    const route = routes.get(routeIdentity(active.addonId, active.generationId, routeContributionId));
    if (route === undefined) {
      // Integrated activation publishes metadata before module bindings. A
      // missing route is therefore temporarily normal and stays invisible.
      continue;
    }
    entries.push(Object.freeze({
      addonId: active.addonId,
      generationId: active.generationId,
      contributionId: active.descriptor.id,
      label: active.descriptor.label,
      routeContributionId,
      hash: browserAddonRouteHash(route),
    }));
  }
  return Object.freeze(entries);
}

/** Reconciles reviewed sidebar metadata into host-created anchors. */
export class BrowserNavigationOutlet {
  readonly #document: Document;
  readonly #root: HTMLElement;
  readonly #registry: BrowserContributionRegistry;
  readonly #role: BrowserRole;
  readonly #currentHash: () => string;
  readonly #include: (entry: BrowserNavigationEntry) => boolean;
  readonly #onError: (cause: unknown) => void;
  readonly #onCountChange: (count: number) => void;
  readonly #mounted = new Map<string, MountedNavigationEntry>();
  readonly #unsubscribe: Disposer;
  #disposed = false;

  constructor(options: BrowserNavigationOutletOptions) {
    this.#document = options.document;
    this.#root = options.root;
    this.#registry = options.registry;
    this.#role = options.role;
    this.#currentHash = options.currentHash;
    this.#include = options.include ?? (() => true);
    this.#onError = options.onError ?? (() => undefined);
    this.#onCountChange = options.onCountChange ?? (() => undefined);
    this.#unsubscribe = this.#registry.subscribe(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (this.#disposed) {
      return;
    }
    try {
      const ordered: HTMLAnchorElement[] = [];
      const retained = new Set<string>();
      const currentHash = this.#currentHash();
      for (const entry of listBrowserNavigation(this.#registry, this.#role)) {
        if (!this.#include(entry)) continue;
        const key = `${entry.addonId}:${entry.generationId}:${entry.contributionId}`;
        const identity = `${entry.hash}:${entry.label}`;
        let mounted = this.#mounted.get(key);
        if (mounted === undefined || mounted.identity !== identity) {
          const anchor = this.#document.createElement("a");
          anchor.className = "addon-navigation-link";
          anchor.href = entry.hash;
          anchor.textContent = entry.label;
          anchor.dataset["addonId"] = entry.addonId;
          anchor.dataset["contributionId"] = entry.contributionId;
          mounted = { identity, anchor };
          this.#mounted.set(key, mounted);
        }
        if (entry.hash === parseBrowserAddonLocation(currentHash)?.routeHash) {
          mounted.anchor.setAttribute("aria-current", "page");
        } else {
          mounted.anchor.removeAttribute("aria-current");
        }
        retained.add(key);
        ordered.push(mounted.anchor);
      }
      for (const key of this.#mounted.keys()) {
        if (!retained.has(key)) {
          this.#mounted.delete(key);
        }
      }
      this.#root.replaceChildren(...ordered);
      this.#root.hidden = ordered.length === 0;
      this.#onCountChange(ordered.length);
    } catch (cause: unknown) {
      this.#onError(cause);
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribe();
    this.#mounted.clear();
    try {
      this.#root.replaceChildren();
      this.#root.hidden = true;
      this.#onCountChange(0);
    } catch (cause: unknown) {
      this.#onError(cause);
    }
  }
}

function routeIdentity(addonId: string, generationId: string, contributionId: string): string {
  return `${addonId}:${generationId}:${contributionId}`;
}
