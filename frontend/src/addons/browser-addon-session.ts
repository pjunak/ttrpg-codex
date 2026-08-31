import type {
  BrowserAddonRefreshResult,
  BrowserAddonRuntime,
} from "./browser-addon-runtime.js";
import { BrowserGraphHTTPError } from "./browser-graph-client.js";
import type { BrowserDisposalFailure } from "./generation-manager.js";
import type {
  EventRefresh,
  EventStreamCallbacks,
  SharedEventStream,
} from "../core/event-stream.js";

export interface BrowserAddonRuntimePort {
  refresh(signal: AbortSignal): Promise<BrowserAddonRefreshResult>;
  reset(reason: "authority-changed"): Promise<readonly BrowserDisposalFailure[]>;
}

export interface SharedEventStreamPort {
  open(callbacks: EventStreamCallbacks): void;
  close(): void;
}

export interface BrowserAddonSessionCallbacks {
  readonly onRefresh?: (cause: "initial" | EventRefresh["cause"], result: BrowserAddonRefreshResult) => void;
  readonly onDiagnostic?: (error: unknown) => void;
  readonly onConnectionError?: () => void;
  readonly onAuthorityLost?: () => void;
}

/** Owns one authenticated browser add-on runtime and the one shared SSE feed. */
export class BrowserAddonSession {
  readonly #runtime: BrowserAddonRuntimePort;
  readonly #events: SharedEventStreamPort;
  readonly #callbacks: BrowserAddonSessionCallbacks;
  #controller: AbortController | undefined;
  #authorityLoss: Promise<void> | undefined;

  constructor(
    runtime: BrowserAddonRuntimePort | BrowserAddonRuntime,
    events: SharedEventStreamPort | SharedEventStream,
    callbacks: BrowserAddonSessionCallbacks = {},
  ) {
    this.#runtime = runtime;
    this.#events = events;
    this.#callbacks = callbacks;
  }

  async start(): Promise<void> {
    await this.#authorityLoss;
    if (this.#controller !== undefined) {
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    this.#events.open({
      onRefresh: (event) => {
        void this.#refresh(event.cause, controller);
      },
      onBoundaryError: (error) => this.#callbacks.onDiagnostic?.(error),
      onConnectionError: () => this.#callbacks.onConnectionError?.(),
    });
    await this.#refresh("initial", controller);
  }

  async stop(): Promise<readonly BrowserDisposalFailure[]> {
    const controller = this.#controller;
    if (controller === undefined) {
      await this.#authorityLoss;
      return [];
    }
    this.#controller = undefined;
    this.#events.close();
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
        this.#authorityLoss ??= this.#loseAuthority(owner);
        await this.#authorityLoss;
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
    this.#events.close();
    owner.abort("authority-changed");
    const failures = await this.#runtime.reset("authority-changed");
    for (const failure of failures) {
      this.#callbacks.onDiagnostic?.(failure);
    }
    this.#callbacks.onAuthorityLost?.();
    this.#authorityLoss = undefined;
  }
}
