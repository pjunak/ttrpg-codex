import type { TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

/** Owns context cleanup and keeps inspectable traces when a synthetic UI test fails. */
export async function trackBrowserContext(
  t: Pick<TestContext, "after" | "passed" | "name" | "diagnostic">,
  context: {
    tracing: Pick<BrowserContext["tracing"], "start" | "stop">;
    close: BrowserContext["close"];
  },
  verify?: () => void,
): Promise<void> {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  t.after(async () => {
    const failures: unknown[] = [];
    // Node stops later after hooks when one throws, so verification and cleanup
    // must share this hook to preserve diagnostics for page-error failures.
    try {
      verify?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!t.passed || failures.length > 0 || process.env.CODEX_TEST_TRACE === "1") {
        const directory = fileURLToPath(new URL("../../test-results/traces/", import.meta.url));
        await mkdir(directory, { recursive: true });
        const suffix = createHash("sha256").update(t.name).digest("hex").slice(0, 10);
        const name = t.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 90);
        const path = join(directory, `${name}-${suffix}.zip`);
        await context.tracing.stop({ path });
        t.diagnostic(`Browser trace: ${path}`);
      } else {
        await context.tracing.stop();
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
      throw new AggregateError(failures, "Browser verification or cleanup failed");
  });
}
