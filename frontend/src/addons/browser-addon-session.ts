import type {
  BrowserAddonRefreshResult,
  BrowserAddonRuntime,
} from "./browser-addon-runtime.js";
import { BrowserGraphHTTPError } from "./browser-graph-client.js";
import type { BrowserDisposalFailure } from "./generation-manager.js";
import type {
  EventRefresh,
} from "../core/event-stream.js";

export interface BrowserAddonRuntimePort {
  refresh(signal: AbortSignal): Promise<BrowserAddonRefreshResult>;
  reset(reason: "authority-changed"): Promise<readonly BrowserDisposalFailure[]>;
}

export interface BrowserAddonSessionCallbacks {
  readonly onRefresh?: (cause: "initial" | EventRefresh["cause"], result: BrowserAddonRefreshResult) => void;
  readonly onDiagnostic?: (error: unknown) => void;
  readonly onAuthorityLost?: () => void;
  readonly onRecoveryRequested?: () => Promise<boolean>;
}

/** Owns one authenticated browser add-on runtime; the application owns SSE. */
export class BrowserAddonSession {
  readonly #runtime: BrowserAddonRuntimePort;
  readonly #callbacks: BrowserAddonSessionCallbacks;
  #controller: AbortController | undefined;
  #authorityLoss: Promise<void> | undefined;
  #retained = false;

  constructor(
    runtime: BrowserAddonRuntimePort | BrowserAddonRuntime,
    callbacks: BrowserAddonSessionCallbacks = {},
  ) {
    this.#runtime = runtime;
    this.#callbacks = callbacks;
  }

  async start(): Promise<void> {
    await this.#authorityLoss;
    if (this.#controller !== undefined) {
      return;
    }
    const controller = new AbortController();
    this.#retained = false;
    this.#controller = controller;
    await this.#refresh("initial", controller);
  }

  async handleEvent(event: EventRefresh): Promise<void> {
    const controller = this.#controller;
    if (controller === undefined || event.cause === "campaign-data-changed" || event.cause === "addon-data-changed") {
      return;
    }
    await this.#refresh(event.cause, controller);
  }

  async stop(): Promise<readonly BrowserDisposalFailure[]> {
    const controller = this.#controller;
    if (controller === undefined) {
      await this.#authorityLoss;
      if (!this.#retained) return [];
      this.#retained = false;
      return this.#runtime.reset("authority-changed");
    }
    this.#controller = undefined;
    controller?.abort("authority-changed");
    const failures = await this.#runtime.reset("authority-changed");
    await this.#authorityLoss;
    return failures;
  }

  async #refresh(
    cause: "initial" | EventRefresh["cause"],
    owner: AbortController,
  ): Promise<void> {
    if (this.#controller !== owner || owner.signal.aborted) {
      return;
    }
    try {
      const result = await this.#runtime.refresh(owner.signal);
      if (this.#controller === owner && !owner.signal.aborted) {
        this.#callbacks.onRefresh?.(cause, result);
      }
    } catch (error: unknown) {
      if (owner.signal.aborted || this.#controller !== owner) {
        return;
      }
      if (error instanceof BrowserGraphHTTPError && (error.status === 401 || error.status === 403)) {
        const loss = this.#authorityLoss ??= this.#loseAuthority(owner);
        try { await loss; } finally { if (this.#authorityLoss === loss) this.#authorityLoss = undefined; }
        return;
      }
      this.#callbacks.onDiagnostic?.(error);
    }
  }

  async #loseAuthority(owner: AbortController): Promise<void> {
    if (this.#controller !== owner) {
      return;
    }
    this.#controller = undefined;
    owner.abort("authority-changed");
    try {
      // The application may retain mounted views for same-role sign-in. This
      // does not authorize requests; the server still rejects the old session.
      if (await this.#callbacks.onRecoveryRequested?.()) { this.#retained = true; return; }
    } catch (error) { this.#callbacks.onDiagnostic?.(error); }
    const failures = await this.#runtime.reset("authority-changed");
    for (const failure of failures) {
      this.#callbacks.onDiagnostic?.(failure);
    }
    this.#callbacks.onAuthorityLost?.();
  }
}
