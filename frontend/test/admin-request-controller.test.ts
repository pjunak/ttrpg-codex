import { describe, expect, it, vi } from "vitest";
import { AdminRequestController } from "../src/app/admin-request-controller.js";
import { BusyLeases, busyLeaseRequestEvent, type BusyLeaseRequest } from "../src/app/busy-lease.js";
import { deferred } from "./deferred.js";

interface Lifecycle {
  hostConnected?: () => void;
  hostDisconnected?: () => void;
}

function view() {
  const controllers: Lifecycle[] = [];
  const leases = new BusyLeases(() => undefined);
  const host = Object.assign(new EventTarget(), {
    addController: (controller: Lifecycle) => {
      controllers.push(controller);
    },
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  });
  host.addEventListener(busyLeaseRequestEvent, (event) =>
    (event as CustomEvent<BusyLeaseRequest>).detail.grant(leases.acquire()),
  );
  const requests = new AdminRequestController(host, (cause) => `failed: ${String(cause)}`);
  return {
    requests,
    leases,
    disconnect: () => controllers.forEach((controller) => controller.hostDisconnected?.()),
    connect: () => controllers.forEach((controller) => controller.hostConnected?.()),
  };
}

describe("AdminRequestController", () => {
  it("runs one request at a time and reports its failure", async () => {
    const { requests } = view();
    const reply = deferred();
    const first = requests.run(() => reply.promise);
    expect(requests.pending).toBe(true);
    expect(await requests.run(async () => undefined)).toBe(false);
    reply.reject("offline");
    expect(await first).toBe(false);
    expect([requests.pending, requests.error]).toEqual([false, "failed: offline"]);
    expect(await requests.run(async () => undefined)).toBe(true);
    expect(requests.error).toBe("");
  });

  it("uses a request's own failure message", async () => {
    const { requests } = view();
    await requests.run(() => Promise.reject(new Error("conflict")), {
      failure: () => "Settings changed elsewhere.",
    });
    expect(requests.error).toBe("Settings changed elsewhere.");
  });

  it("holds the app busy only while a mutating request runs", async () => {
    const { requests, leases } = view();
    const reply = deferred();
    const running = requests.run(() => reply.promise, { mutating: true });
    expect(leases.busy).toBe(true);
    reply.resolve();
    await running;
    expect(leases.busy).toBe(false);
    await requests.run(async () => expect(leases.busy).toBe(false));
  });

  it("leaving the page cancels the request and releases the app", async () => {
    const { requests, leases, disconnect, connect } = view();
    const reply = deferred();
    let cancelled: AbortSignal | undefined;
    const running = requests.run(
      (signal) => {
        cancelled = signal;
        return reply.promise;
      },
      { mutating: true },
    );
    disconnect();
    expect([cancelled?.aborted, requests.pending, leases.busy]).toEqual([true, false, false]);
    expect(await requests.run(async () => undefined)).toBe(false);
    connect();
    const fresh = deferred();
    const next = requests.run(() => fresh.promise);
    reply.reject("late failure");
    expect(await running).toBe(false);
    expect([requests.pending, requests.error]).toEqual([true, ""]);
    fresh.resolve();
    expect(await next).toBe(true);
  });

  it("a reset starts a new lifetime that a late result cannot change", async () => {
    const { requests } = view();
    const reply = deferred();
    const running = requests.run(() => reply.promise);
    requests.reset();
    expect(requests.pending).toBe(false);
    const next = requests.run(async () => undefined);
    reply.reject("stale");
    expect(await running).toBe(false);
    expect(await next).toBe(true);
    expect(requests.error).toBe("");
  });
});
