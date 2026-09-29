import { describe, expect, it, vi } from "vitest";
import { waitForSignal } from "../src/core/abort-signal.js";
import { deferred } from "./deferred.js";

describe("waitForSignal", () => {
  for (const outcome of ["response", "failure"] as const) {
    it(`preserves an uncancelled ${outcome} and removes its abort listener`, async () => {
      const owner = new AbortController();
      const added = vi.spyOn(owner.signal, "addEventListener");
      const removed = vi.spyOn(owner.signal, "removeEventListener");
      const source = deferred<string>();
      const pending = waitForSignal(source.promise, owner.signal);
      const expected =
        outcome === "response"
          ? expect(pending).resolves.toBe("ready")
          : expect(pending).rejects.toBe("offline");
      if (outcome === "response") source.resolve("ready");
      else source.reject("offline");
      await expected;
      expect(added).toHaveBeenCalledOnce();
      expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]![1]);
    });

    it(`releases the caller before a cancelled ${outcome} settles`, async () => {
      const owner = new AbortController();
      const source = deferred<string>();
      const pending = waitForSignal(source.promise, owner.signal);
      const rejected = expect(pending).rejects.toBe("left-page");
      owner.abort("left-page");
      await rejected;
      if (outcome === "response") source.resolve("obsolete");
      else source.reject(new Error("late failure"));
      await expect(pending).rejects.toBe("left-page");
    });
  }

  it("observes already-started work even when its signal is already aborted", async () => {
    const owner = new AbortController();
    owner.abort("disposed");
    const source = Promise.reject(new Error("late failure"));
    await expect(waitForSignal(source, owner.signal)).rejects.toBe("disposed");
  });
});
