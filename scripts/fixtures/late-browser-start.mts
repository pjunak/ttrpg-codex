import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { trackBrowserContext } from "../../frontend/test/browser/browser-diagnostics.mts";

let closes = 0,
  stops = 0,
  reports = 0,
  resumed = false;
// A browser driver keeps the process alive after Node cancels its test owner.
const keepAlive = setInterval(() => {}, 1000);
void test("late tracing startup after a real Node test deadline", { timeout: 15 }, async (t) => {
  try {
    await trackBrowserContext(
      t,
      {
        tracing: {
          async start() {
            await new Promise<void>((resolve) =>
              t.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            await immediate();
            resumed = true;
          },
          async stop() {
            stops++;
          },
        },
        async close() {
          closes++;
        },
      },
      undefined,
      async () => {
        reports++;
      },
    );
  } finally {
    clearInterval(keepAlive);
  }
});
process.once("exit", () =>
  console.log("LATE_CONTEXT " + JSON.stringify({ closes, stops, reports, resumed })),
);
