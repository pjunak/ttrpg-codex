import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { trackBrowserContext } from "../frontend/test/browser/browser-diagnostics.mts";
import type { PublicFailureRecord } from "../frontend/test/browser/public-failure-evidence.mts";

function probe(t: TestContext, traceError?: Error, startupError?: Error, closeError?: Error) {
  let after: Parameters<TestContext["after"]>[0] | undefined;
  let closed = false;
  let starts = 0,
    closes = 0,
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
        starts++;
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
    get starts() {
      return starts;
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
  await fixture.finish();
  assert.deepEqual(fixture.calls, { closes: 1, stops: 0 });
  assert.equal(fixture.records.length, 1);
});

void test("a real Node deadline closes a context whose tracing startup settles late", () => {
  const env = { ...process.env };
  // Run an independent test owner rather than inheriting this runner's child mode.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(new URL("./fixtures/late-browser-start.mts", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true, env },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, "The original test deadline must remain a cancellation");
  assert.match(result.stdout, /test timed out after 15ms/);
  assert.match(result.stdout, /# cancelled 1/);
  const summary = result.stdout.match(/^(?:# )?LATE_CONTEXT (.+)$/m);
  assert.ok(summary, result.stdout);
  assert.deepEqual(JSON.parse(summary[1]!), {
    closes: 1,
    stops: 0,
    reports: 1,
    resumed: true,
  });
});

void test("an already cancelled owner closes a late context before tracing starts", async (t) => {
  const fixture = probe(t);
  const controller = new AbortController();
  const original = new Error("Owner already cancelled");
  controller.abort(original);
  const owner = { ...fixture.context, signal: controller.signal };
  await assert.rejects(
    trackBrowserContext(owner, fixture.browser, undefined, fixture.report),
    (cause) => cause === original,
  );
  await fixture.finish();
  assert.equal(fixture.starts, 0);
  assert.deepEqual(fixture.calls, { closes: 1, stops: 0 });
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0]!.stage, "trace-start");
});

void test("cleanup registration failure releases the context without starting tracing", async (t) => {
  const fixture = probe(t);
  const original = new Error("Owner hook registration failed");
  fixture.context.after = () => {
    throw original;
  };
  await assert.rejects(
    trackBrowserContext(fixture.context, fixture.browser, undefined, fixture.report),
    (cause) => cause === original,
  );
  assert.equal(fixture.starts, 0);
  assert.deepEqual(fixture.calls, { closes: 1, stops: 0 });
  assert.equal(fixture.records.length, 1);
});

void test("tracing rejection keeps its original cause when context cleanup also fails", async (t) => {
  const original = new Error("Tracing startup failed");
  const closeError = new Error("Context close failed");
  const fixture = probe(t, undefined, original, closeError);
  await assert.rejects(
    trackBrowserContext(fixture.context, fixture.browser, undefined, fixture.report),
    (cause) => cause === original,
  );
  await assert.rejects(fixture.finish(), (cause) => {
    assert.ok(cause instanceof AggregateError);
    assert.deepEqual(cause.errors, [closeError]);
    return true;
  });
  assert.deepEqual(fixture.calls, { closes: 1, stops: 0 });
  assert.equal(fixture.records.length, 1);
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
