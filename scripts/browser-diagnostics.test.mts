import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { trackBrowserContext } from "../frontend/test/browser/browser-diagnostics.mts";
import type { PublicFailureRecord } from "../frontend/test/browser/public-failure-evidence.mts";

function probe(t: TestContext, traceError?: Error, startupError?: Error, closeError?: Error) {
  let after: Parameters<TestContext["after"]>[0] | undefined;
  let closed = false;
  let closes = 0,
    stops = 0;
  let tracePath: string | undefined;
  const diagnostics: string[] = [];
  const records: PublicFailureRecord[] = [];
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
      async start() {
        if (startupError) throw startupError;
      },
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
      if (closeError) throw closeError;
    },
  };
  return {
    context,
    browser,
    diagnostics,
    records,
    report: async (record: PublicFailureRecord) => {
      records.push(record);
    },
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
  await trackBrowserContext(
    fixture.context,
    fixture.browser,
    () => {
      throw failure;
    },
    fixture.report,
  );
  await assert.rejects(fixture.finish(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal(fixture.closed, true);
  assert.ok(fixture.tracePath?.endsWith(".zip"));
  assert.deepEqual(fixture.diagnostics, [`Browser trace: ${fixture.tracePath}`]);
  assert.equal(fixture.records.length, 1);
});

void test("failed trace saving still closes the context and preserves the page error", async (t) => {
  const traceError = new Error("Trace writing failed");
  const fixture = probe(t, traceError);
  const pageError = new Error("Unhandled page error");
  await trackBrowserContext(
    fixture.context,
    fixture.browser,
    () => {
      throw pageError;
    },
    fixture.report,
  );
  await assert.rejects(fixture.finish(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [pageError, traceError]);
    return true;
  });
  assert.equal(fixture.closed, true);
  assert.equal(fixture.records.length, 1, "Trace write failure still leaves public metadata");
});

void test("multiple browser views retain separate traces for the same failed test", async (t) => {
  const views = [probe(t), probe(t)];
  for (const fixture of views) {
    await trackBrowserContext(
      fixture.context,
      fixture.browser,
      () => {
        throw new Error("Retain this view's diagnostic evidence");
      },
      fixture.report,
    );
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
  const close = await trackBrowserContext(
    fixture.context,
    fixture.browser,
    () => {
      verifications++;
    },
    fixture.report,
  );
  await close();
  await fixture.finish();
  assert.equal(verifications, 1);
  assert.deepEqual(fixture.calls, { closes: 1, stops: 1 });
  assert.deepEqual(fixture.records, []);
});

void test("tracing startup failure releases its context and preserves the original cause", async (t) => {
  const original = new Error("Private tracing startup failure");
  const fixture = probe(t, undefined, original);
  await assert.rejects(
    trackBrowserContext(fixture.context, fixture.browser, undefined, fixture.report),
    (cause) => cause === original,
  );
  assert.deepEqual(fixture.calls, { closes: 1, stops: 0 });
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0]!.stage, "trace-start");
  assert.ok(!JSON.stringify(fixture.records).includes(original.message));
});

void test("metadata reporting failure cannot replace verification or skip cleanup", async (t) => {
  const fixture = probe(t);
  const original = new Error("Original verification error");
  await trackBrowserContext(
    fixture.context,
    fixture.browser,
    () => {
      throw original;
    },
    async () => {
      throw new Error("Metadata disk failure");
    },
  );
  await assert.rejects(fixture.finish(), (cause) => {
    assert.ok(cause instanceof AggregateError);
    assert.deepEqual(cause.errors, [original]);
    return true;
  });
  assert.deepEqual(fixture.calls, { closes: 1, stops: 1 });
});

void test("context close failure is retained once with independent metadata", async (t) => {
  const original = new Error("Context cleanup failed");
  const fixture = probe(t, undefined, undefined, original);
  const close = await trackBrowserContext(
    fixture.context,
    fixture.browser,
    undefined,
    fixture.report,
  );
  await assert.rejects(close(), (cause) => {
    assert.ok(cause instanceof AggregateError);
    assert.deepEqual(cause.errors, [original]);
    return true;
  });
  await assert.rejects(fixture.finish(), AggregateError);
  assert.deepEqual(fixture.calls, { closes: 1, stops: 1 });
  assert.equal(fixture.records.length, 1);
});
