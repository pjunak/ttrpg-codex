import { describe, expect, it, vi } from "vitest";
import {
  GenerationClosedError,
  GenerationScope,
} from "../src/addons/generation-scope.js";

describe("GenerationScope", () => {
  it("aborts first and disposes owned handles once in LIFO order", async () => {
    const scope = new GenerationScope("example-addon@42");
    const events: string[] = [];
    scope.signal.addEventListener("abort", () => {
      events.push("abort");
    });
    scope.add("first", () => {
      events.push("first");
    });
    scope.add("second", async () => {
      await Promise.resolve();
      events.push("second");
    });

    const firstDisposal = scope.dispose("updated");
    const repeatedDisposal = scope.dispose("updated");
    expect(repeatedDisposal).toBe(firstDisposal);
    await firstDisposal;

    expect(events).toEqual(["abort", "second", "first"]);
    expect(scope.signal.reason).toBe("updated");
    expect(scope.active).toBe(false);
  });

  it("can release ownership before disposal", async () => {
    const scope = new GenerationScope("example-addon@42");
    const disposer = vi.fn();
    const release = scope.add("transferred", disposer);
    release();

    await scope.dispose("disabled");

    expect(disposer).not.toHaveBeenCalled();
  });

  it("isolates disposer failures and reports their labels", async () => {
    const scope = new GenerationScope("example-addon@42");
    const completed = vi.fn();
    scope.add("completed", completed);
    scope.add("broken", () => {
      throw new Error("boom");
    });

    const disposal = scope.dispose("activation-failed");
    await expect(disposal).rejects.toMatchObject({
      generationId: "example-addon@42",
      reason: "activation-failed",
      failures: [{ label: "broken", cause: expect.any(Error) }],
    });
    expect(completed).toHaveBeenCalledOnce();
  });

  it("rejects registration after teardown begins", async () => {
    const scope = new GenerationScope("example-addon@42");
    await scope.dispose("uninstalled");

    expect(() => scope.add("late", () => undefined)).toThrow(GenerationClosedError);
    expect(() => scope.assertActive()).toThrow(GenerationClosedError);
  });
});
