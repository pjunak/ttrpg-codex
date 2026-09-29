import type { BrowserAddonRefreshResult, BrowserAddonRuntime } from "./browser-addon-runtime.js";
import { BrowserGraphHTTPError } from "./browser-graph-client.js";
import type { BrowserDisposalFailure } from "./generation-manager.js";
import type { EventRefresh } from "../core/event-stream.js";
import { waitForSignal } from "../core/abort-signal.js";

export interface BrowserAddonRuntimePort {
  refresh(signal: AbortSignal): Promise<BrowserAddonRefreshResult>;
  reset(reason: "authority-changed"): Promise<readonly BrowserDisposalFailure[]>;
}

export interface BrowserAddonSessionCallbacks {
  readonly onRefresh?: (
    cause: "initial" | EventRefresh["cause"],
    result: BrowserAddonRefreshResult,
  ) => void;
  readonly onDiagnostic?: (error: unknown) => void;
  readonly onAuthorityLost?: () => void;
  readonly onRecoveryRequested?: () => Promise<boolean>;
}

interface AuthorityLoss {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

/** Owns one authenticated browser add-on runtime; the application owns SSE. */
export class BrowserAddonSession {
  readonly #runtime: BrowserAddonRuntimePort;
  readonly #callbacks: BrowserAddonSessionCallbacks;
  #controller: AbortController | undefined;
  #authorityLoss: AuthorityLoss | undefined;
  #epoch = 0;
  #needsCleanup = false;
  #cleanup: Promise<readonly BrowserDisposalFailure[]> = Promise.resolve([]);

  constructor(
    runtime: BrowserAddonRuntimePort | BrowserAddonRuntime,
    callbacks: BrowserAddonSessionCallbacks = {},
  ) {
    this.#runtime = runtime;
    this.#callbacks = callbacks;
  }

  async start(): Promise<void> {
    const epoch = this.#epoch;
    await this.#cleanup;
    await this.#authorityLoss?.promise;
    if (epoch !== this.#epoch || this.#controller !== undefined) {
      return;
    }
    const controller = new AbortController();
    this.#needsCleanup = true;
    this.#controller = controller;
    await this.#refresh("initial", controller);
  }

  async handleEvent(event: EventRefresh): Promise<void> {
    const controller = this.#controller;
    if (
      controller === undefined ||
      event.cause === "campaign-data-changed" ||
      event.cause === "addon-data-changed"
    ) {
      return;
    }
    await this.#refresh(event.cause, controller);
  }

  stop(): Promise<readonly BrowserDisposalFailure[]> {
    this.#epoch += 1;
    this.#controller?.abort("authority-changed");
    this.#controller = undefined;
    this.#authorityLoss?.controller.abort("authority-changed");
    this.#authorityLoss = undefined;
    return this.#resetRuntime();
  }

  #resetRuntime(): Promise<readonly BrowserDisposalFailure[]> {
    if (this.#needsCleanup) {
      this.#needsCleanup = false;
      this.#cleanup = this.#runtime.reset("authority-changed");
    }
    return this.#cleanup;
  }

  async #refresh(cause: "initial" | EventRefresh["cause"], owner: AbortController): Promise<void> {
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
      if (
        error instanceof BrowserGraphHTTPError &&
        (error.status === 401 || error.status === 403)
      ) {
        const epoch = this.#epoch;
        const controller = new AbortController();
        const loss = (this.#authorityLoss ??= {
          controller,
          promise: Promise.resolve().then(() =>
            this.#loseAuthority(owner, epoch, controller.signal),
          ),
        });
        try {
          await loss.promise;
        } finally {
          if (this.#authorityLoss === loss) this.#authorityLoss = undefined;
        }
        return;
      }
      this.#callbacks.onDiagnostic?.(error);
    }
  }

  async #loseAuthority(owner: AbortController, epoch: number, signal: AbortSignal): Promise<void> {
    if (this.#controller !== owner || signal.aborted || epoch !== this.#epoch) {
      return;
    }
    this.#controller = undefined;
    owner.abort("authority-changed");
    try {
      // The application may retain mounted views for same-role sign-in. This
      // does not authorize requests; the server still rejects the old session.
      const retain = await waitForSignal(
        Promise.resolve(this.#callbacks.onRecoveryRequested?.() ?? false),
        signal,
      );
      if (signal.aborted || epoch !== this.#epoch || retain) return;
    } catch (error) {
      if (signal.aborted || epoch !== this.#epoch) return;
      this.#callbacks.onDiagnostic?.(error);
    }
    const failures = await this.#resetRuntime();
    if (signal.aborted || epoch !== this.#epoch) return;
    for (const failure of failures) {
      this.#callbacks.onDiagnostic?.(failure);
    }
    this.#callbacks.onAuthorityLost?.();
  }
}
