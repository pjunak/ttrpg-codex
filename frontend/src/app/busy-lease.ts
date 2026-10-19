import type { ReactiveController, ReactiveControllerHost } from "lit";

/** One held claim on the app's busy state; releasing it twice is harmless. */
export interface BusyLease {
  release(): void;
}

/**
 * The app is busy while any lease is held: a campaign write, a sign-in or
 * view change, or an add-on administration request. Busy blocks new writes
 * and leaving open edits. Each holder releases only its own lease, so one
 * operation ending cannot clear another's.
 */
export class BusyLeases {
  readonly #held = new Set<BusyLease>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  get busy(): boolean {
    return this.#held.size > 0;
  }

  acquire(): BusyLease {
    const lease: BusyLease = {
      release: () => {
        if (this.#held.delete(lease)) this.#changed();
      },
    };
    this.#held.add(lease);
    this.#changed();
    return lease;
  }

  /** Drops every lease when the app that granted them leaves the page. */
  clear(): void {
    if (this.#held.size === 0) return;
    this.#held.clear();
    this.#changed();
  }
}

export const busyLeaseRequestEvent = "codex-busy-lease";

export interface BusyLeaseRequest {
  grant(lease: BusyLease): void;
}

/** Asks the enclosing app for a lease; undefined when no app answers. */
export function requestBusyLease(source: EventTarget): BusyLease | undefined {
  let granted: BusyLease | undefined;
  source.dispatchEvent(
    new CustomEvent<BusyLeaseRequest>(busyLeaseRequestEvent, {
      detail: {
        grant: (lease) => {
          granted = lease;
        },
      },
      bubbles: true,
      composed: true,
    }),
  );
  return granted;
}

/**
 * Holds the app's busy lease for a Lit element while it runs a blocking
 * operation. The lease is released when the element leaves the page, where
 * an event could no longer reach the app.
 */
export class BusyLeaseController implements ReactiveController {
  readonly #host: ReactiveControllerHost & EventTarget;
  #lease: BusyLease | undefined;

  constructor(host: ReactiveControllerHost & EventTarget) {
    this.#host = host;
    host.addController(this);
  }

  get held(): boolean {
    return this.#lease !== undefined;
  }

  hold(): void {
    this.#lease ??= requestBusyLease(this.#host);
  }

  release(): void {
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release();
  }

  hostDisconnected(): void {
    this.release();
  }
}
