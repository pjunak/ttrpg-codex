import assert from "node:assert/strict";
import { mock } from "node:test";
import { trackBrowserContext } from "../../frontend/test/browser/browser-diagnostics.mts";
import type { Fixture } from "../../frontend/test/browser/installed-character-builder-fixture.mts";

const stage = process.env.CODEX_CREATION_FAILURE_STAGE;
if (stage !== "login" && stage !== "navigation") throw new Error("Unknown creation failure stage");
let opened = 0,
  closes = 0,
  starts = 0,
  stops = 0,
  traces = 0,
  screenshots = 0,
  reports = 0;
const failure = new Error("Controlled creation " + stage + " failure");
const response = { ok: () => true, status: () => 200, text: async () => "{}" };
const fixture = {
  admin: { post: async () => response },
  call: async () => ({ status: "ready", evaluation: {} }),
  browser: {
    async newContext() {
      opened++;
      return {
        tracing: {
          async start() {
            starts++;
          },
          async stop(options?: { path?: string }) {
            stops++;
            if (options?.path) traces++;
          },
        },
        request: {
          async post() {
            if (stage === "login") throw failure;
            return response;
          },
        },
        async addInitScript() {},
        async newPage() {
          return {
            on() {},
            async goto() {
              throw failure;
            },
            async screenshot() {
              screenshots++;
              throw new Error("Controlled screenshot failure");
            },
          };
        },
        async close() {
          closes++;
        },
      };
    },
  },
  csrf: "local-creation-fixture",
  origin: "http://127.0.0.1:1",
  output: "unused-creation-output",
} as unknown as Fixture;

// Keep intentional failures out of the CI metadata inventory; run the real tracker.
mock.module(new URL("../../frontend/test/browser/browser-diagnostics.mts", import.meta.url), {
  exports: {
    trackBrowserContext(
      t: Parameters<typeof trackBrowserContext>[0],
      context: Parameters<typeof trackBrowserContext>[1],
      verify?: Parameters<typeof trackBrowserContext>[2],
    ) {
      return trackBrowserContext(t, context, verify, async (record) => {
        assert.equal(record.source, "browser");
        assert.equal(record.stage, "browser");
        assert.ok(!JSON.stringify(record).includes(failure.message));
        reports++;
      });
    },
  },
});
const { registerCharacterCreationTests } =
  await import("../../frontend/test/browser/installed-character-creation-fixture.mts");
// Run the real creation fixtures under Node's owner/after-hook failure handling.
registerCharacterCreationTests(true, () => fixture);
process.once("exit", () =>
  console.log(
    "CREATION_CONTEXT " +
      JSON.stringify({ opened, closes, starts, stops, traces, screenshots, reports }),
  ),
);
