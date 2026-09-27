import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { trackBrowserContext } from "../frontend/test/browser/browser-diagnostics.mts";

function probe(t: TestContext, traceError?: Error) {
  let after: Parameters<TestContext["after"]>[0] | undefined;
  let closed = false;
  let tracePath: string | undefined;
  const diagnostics: string[] = [];
  const context: Parameters<typeof trackBrowserContext>[0] = {
    after: (callback) => {
      after = callback;
    },
    passed: true,
    name: t.name,
    diagnostic: (message) => diagnostics.push(message),
  };
  const browser: Parameters<typeof trackBrowserContext>[1] = {
    tracing: {
      async start() {},
      async stop(options) {
        tracePath = options?.path;
        if (traceError) throw traceError;
      },
    },
    async close() {
      closed = true;
    },
  };
  return {
    context,
    browser,
    diagnostics,
    get closed() {
      return closed;
    },
    get tracePath() {
      return tracePath;
    },
    async finish() {
      assert.ok(after, "The browser context must register cleanup");
      await after(t, (error?: unknown) => {
        if (error) throw error;
      });
    },
  };
}

void test("page-error verification retains a trace and closes its context", async (t) => {
  const fixture = probe(t);
  const failure = new Error("Unhandled page error");
  await trackBrowserContext(fixture.context, fixture.browser, () => {
    throw failure;
  });
  await assert.rejects(fixture.finish(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal(fixture.closed, true);
  assert.ok(fixture.tracePath?.endsWith(".zip"));
  assert.deepEqual(fixture.diagnostics, [`Browser trace: ${fixture.tracePath}`]);
});

void test("failed trace saving still closes the context and preserves the page error", async (t) => {
  const traceError = new Error("Trace writing failed");
  const fixture = probe(t, traceError);
  const pageError = new Error("Unhandled page error");
  await trackBrowserContext(fixture.context, fixture.browser, () => {
    throw pageError;
  });
  await assert.rejects(fixture.finish(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [pageError, traceError]);
    return true;
  });
  assert.equal(fixture.closed, true);
});
