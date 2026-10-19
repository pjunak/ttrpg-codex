import { describe, expect, it, vi } from "vitest";
import {
  BusyLeaseController,
  BusyLeases,
  busyLeaseRequestEvent,
  requestBusyLease,
  type BusyLeaseRequest,
} from "../src/app/busy-lease.js";

function host() {
  const controllers: { hostDisconnected?: () => void }[] = [];
  return Object.assign(new EventTarget(), {
    controllers,
    addController: (controller: { hostDisconnected?: () => void }) => {
      controllers.push(controller);
    },
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  });
}

/** An app stand-in that grants leases to requests dispatched on `target`. */
function grantFrom(target: EventTarget, leases: BusyLeases): void {
  target.addEventListener(busyLeaseRequestEvent, (event) =>
    (event as CustomEvent<BusyLeaseRequest>).detail.grant(leases.acquire()),
  );
}

describe("BusyLeases", () => {
  it("stays busy until every holder has released its own lease", () => {
    const changed = vi.fn();
    const leases = new BusyLeases(changed);
    const write = leases.acquire();
    const signIn = leases.acquire();
    write.release();
    expect(leases.busy).toBe(true);
    write.release();
    expect(leases.busy).toBe(true);
    signIn.release();
    expect(leases.busy).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("drops every lease when cleared, and a late release changes nothing", () => {
    const changed = vi.fn();
    const leases = new BusyLeases(changed);
    const lease = leases.acquire();
    leases.clear();
    expect(leases.busy).toBe(false);
    lease.release();
    leases.clear();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe("requestBusyLease", () => {
  it("returns the lease an app grants, or nothing without an app", () => {
    const leases = new BusyLeases(() => undefined);
    const source = new EventTarget();
    expect(requestBusyLease(source)).toBeUndefined();
    grantFrom(source, leases);
    const lease = requestBusyLease(source);
    expect(leases.busy).toBe(true);
    lease?.release();
    expect(leases.busy).toBe(false);
  });
});

describe("BusyLeaseController", () => {
  it("holds one lease at a time and releases it when its owner leaves the page", () => {
    const leases = new BusyLeases(() => undefined);
    const owner = host();
    grantFrom(owner, leases);
    const busy = new BusyLeaseController(owner);
    busy.hold();
    busy.hold();
    expect([busy.held, leases.busy]).toEqual([true, true]);
    for (const controller of owner.controllers) controller.hostDisconnected?.();
    expect([busy.held, leases.busy]).toEqual([false, false]);
    busy.hold();
    busy.release();
    expect(leases.busy).toBe(false);
  });
});
