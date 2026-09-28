import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { trackBrowserContext } from "../frontend/test/browser/browser-diagnostics.mts";

function probe(t: TestContext, traceError?: Error) {
  let after: Parameters<TestContext["after"]>[0] | undefined;
  let closed = false;
  let closes = 0,
    stops = 0;
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
        stops++;
        if (closed) throw new Error("Tracing stopped after its context closed");
        tracePath = options?.path;
        if (traceError) throw traceError;
      },
    },
    async close() {
      closes++;
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
    get calls() {
      return { closes, stops };
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

void test("multiple browser views retain separate traces for the same failed test", async (t) => {
  const views = [probe(t), probe(t)];
  for (const fixture of views) {
    await trackBrowserContext(fixture.context, fixture.browser, () => {
      throw new Error("Retain this view's diagnostic evidence");
    });
    await assert.rejects(fixture.finish(), AggregateError);
    assert.equal(fixture.closed, true);
    assert.ok(fixture.tracePath?.endsWith(".zip"));
    assert.deepEqual(fixture.diagnostics, [`Browser trace: ${fixture.tracePath}`]);
  }
  assert.notEqual(views[0]!.tracePath, views[1]!.tracePath);
});

void test("explicit browser cleanup verifies and stops tracing once before closing", async (t) => {
  const fixture = probe(t);
  let verifications = 0;
  const close = await trackBrowserContext(fixture.context, fixture.browser, () => {
    verifications++;
  });
  await close();
  await fixture.finish();
  assert.equal(verifications, 1);
  assert.deepEqual(fixture.calls, { closes: 1, stops: 1 });
});
