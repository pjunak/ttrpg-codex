import type { ReactiveController, ReactiveControllerHost } from "lit";
import { BusyLeaseController } from "./busy-lease.js";
import { uiRequestError } from "./ui-errors.js";

export interface AdminRequestOptions {
  /** Holds the app's busy lease while the request runs. */
  readonly mutating?: boolean;
  /** This request's failure message. Runs only while the request is current. */
  readonly failure?: (cause: unknown) => string;
}

/**
 * The request lifetime of one admin view. Leaving the page cancels the
 * running request and a reconnected view starts a fresh lifetime, so a late
 * result or failure never reaches the view that replaced it. One request runs
 * at a time; mutating requests also hold the app's busy lease.
 */
export class AdminRequestController implements ReactiveController {
  pending = false;
  error = "";
  readonly #host: ReactiveControllerHost;
  readonly #busy: BusyLeaseController;
  readonly #describe: (cause: unknown) => string;
  #scope = new AbortController();

  constructor(
    host: ReactiveControllerHost & EventTarget,
    describe: (cause: unknown) => string = uiRequestError,
  ) {
    this.#host = host;
    this.#describe = describe;
    host.addController(this);
    this.#busy = new BusyLeaseController(host);
  }

  /** Aborted when the current lifetime ends. */
  get signal(): AbortSignal {
    return this.#scope.signal;
  }

  hostConnected(): void {
    if (this.#scope.signal.aborted) this.#scope = new AbortController();
  }

  hostDisconnected(): void {
    this.#end("component-disconnected");
  }

  /** Cancels the running request and starts a new lifetime. */
  reset(): void {
    this.#end("superseded");
    this.#scope = new AbortController();
  }

  /** Runs one request unless another is pending. True when it completed. */
  async run(
    operation: (signal: AbortSignal) => Promise<void>,
    options: AdminRequestOptions = {},
  ): Promise<boolean> {
    const scope = this.#scope;
    if (this.pending || scope.signal.aborted) return false;
    const current = () => scope === this.#scope && !scope.signal.aborted;
    this.pending = true;
    this.error = "";
    if (options.mutating) this.#busy.hold();
    this.#host.requestUpdate();
    try {
      await operation(scope.signal);
      return current();
    } catch (cause: unknown) {
      if (current()) this.error = (options.failure ?? this.#describe)(cause);
      return false;
    } finally {
      if (current()) {
        this.pending = false;
        if (options.mutating) this.#busy.release();
        this.#host.requestUpdate();
      }
    }
  }

  #end(reason: string): void {
    this.#scope.abort(reason);
    this.pending = false;
    this.#busy.release();
    this.#host.requestUpdate();
  }
}
