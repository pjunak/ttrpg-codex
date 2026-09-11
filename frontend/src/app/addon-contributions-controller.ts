import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserContributionSurface, BrowserRole } from "../addons/generation-manager.js";

/** Shares role-filtered discovery and registry subscription ownership across host views. */
export class AddonContributionsController implements ReactiveController {
  #registry: BrowserContributionRegistry | undefined;
  #unsubscribe: (() => void) | undefined;
  constructor(private readonly host: ReactiveControllerHost, private readonly source: () => {
    registry: BrowserContributionRegistry | undefined; role: BrowserRole | undefined;
  }) { host.addController(this); }
  hostConnected(): void { this.host.requestUpdate(); }
  hostUpdate(): void {
    const { registry } = this.source();
    if (registry === this.#registry && this.#unsubscribe) return;
    this.#unsubscribe?.(); this.#registry = registry;
    this.#unsubscribe = registry?.subscribe(() => this.host.requestUpdate());
  }
  hostDisconnected(): void { this.#unsubscribe?.(); this.#unsubscribe = undefined; }
  list(surface: BrowserContributionSurface) {
    const { registry, role } = this.source();
    return role ? registry?.list(surface, role) ?? [] : [];
  }
}
