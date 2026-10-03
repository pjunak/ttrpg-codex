import type { TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

/** Owns context cleanup; use the returned function for an explicit early close. */
export async function trackBrowserContext(
  t: Pick<TestContext, "after" | "passed" | "name" | "diagnostic"> &
    Partial<Pick<TestContext, "signal">>,
  context: {
    tracing: Pick<BrowserContext["tracing"], "start" | "stop">;
    close: BrowserContext["close"];
  },
  verify?: () => void,
): Promise<() => Promise<void>> {
  let traceStarted = false;
  const finish = async (): Promise<void> => {
    // Startup can settle after the owner's deadline and during context.close().
    // Keep this cleanup's stage fixed before either operation can resume.
    const initialized = traceStarted;
    const failures: unknown[] = [];
    // Node stops later after hooks when one throws, so verification and cleanup
    // must share this hook to preserve diagnostics for page-error failures.
    try {
      if (initialized) verify?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (initialized) {
        if (!t.passed || failures.length > 0 || process.env.CODEX_TEST_TRACE === "1") {
          const directory = fileURLToPath(new URL("../../test-results/traces/", import.meta.url));
          await mkdir(directory, { recursive: true });
          const suffix = createHash("sha256").update(t.name).digest("hex").slice(0, 10);
          const name = t.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 90);
          const path = join(directory, `${name}-${suffix}-${randomUUID()}.zip`);
          await context.tracing.stop({ path });
          t.diagnostic(`Browser trace: ${path}`);
        } else {
          await context.tracing.stop();
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await context.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Browser verification or cleanup failed", {
        cause: failures[0],
      });
  };
  let cleanup: Promise<void> | undefined;
  const close = (): Promise<void> => (cleanup ??= finish());
  try {
    // Register ownership before awaiting tracing: Node runs after hooks when the
    // test times out, even while the startup promise is still pending.
    t.after(close);
    t.signal?.throwIfAborted();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
  } catch (cause) {
    try {
      await close();
    } catch {
      /* Preserve the original startup failure. */
    }
    throw cause;
  }
  return close;
}
