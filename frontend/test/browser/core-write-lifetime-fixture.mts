import type { Page } from "playwright";

declare global {
  interface Window {
    coreWriteHold: {
      started: boolean;
      settled: boolean;
      calls: number;
      release: () => void;
    };
  }
}

/** Hold a real server receipt using a transport that deliberately ignores abort. */
export async function holdCoreWrite(
  page: Page,
  endpoint: string,
  phase: "headers" | "body",
  outcome: "success" | "failure" = "success",
) {
  await page.evaluate(
    ({ endpoint, phase, outcome }) => {
      const nativeFetch = window.fetch.bind(window);
      const gate = Promise.withResolvers<void>();
      const state: Window["coreWriteHold"] = (window.coreWriteHold = {
        started: false,
        settled: false,
        calls: 0,
        release: () => gate.resolve(),
      });
      const hold = async () => {
        state.started = true;
        try {
          await gate.promise;
          if (outcome === "failure") throw new Error("Interrupted write response");
        } finally {
          state.settled = true;
        }
      };
      window.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.href,
        );
        if (url.pathname !== endpoint || ++state.calls !== 1) return nativeFetch(input, init);
        const response = await nativeFetch(input, { ...init, signal: undefined });
        if (!response.ok) throw new Error(`Held write returned ${response.status}`);
        if (phase === "headers") await hold();
        else {
          const text = response.text.bind(response);
          response.text = async () => {
            const body = await text();
            await hold();
            return body;
          };
        }
        return response;
      };
    },
    { endpoint, phase, outcome },
  );
  return {
    started: () => page.waitForFunction(() => window.coreWriteHold.started),
    release: async () => {
      await page.evaluate(() => window.coreWriteHold.release());
      await page.waitForFunction(() => window.coreWriteHold.settled);
      // Give obsolete continuations a turn before checking application state.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    },
  };
}
