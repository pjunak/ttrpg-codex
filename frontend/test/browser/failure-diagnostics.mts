import { writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { Locator, Page } from "playwright";

type StartupPage = Pick<Page, "url" | "screenshot"> & {
  locator(selector: string): Pick<Locator, "innerText">;
};

/** Best-effort evidence must never replace the failure being investigated. */
export async function reportBrowserFailure(
  t: Pick<TestContext, "diagnostic">,
  page: StartupPage,
  artifact: string,
  evidence: {
    errors: readonly string[];
    requests?: ReadonlyMap<string, string>;
    state?: () => Promise<unknown>;
  },
  cause: unknown,
): Promise<never> {
  try {
    const unavailable: string[] = [],
      saved: string[] = [];
    const state = {
      url: "unavailable",
      errors: evidence.errors.slice(0, 32).map((error) => error.slice(0, 1000)),
      requests: Object.fromEntries(
        [...(evidence.requests ?? [])]
          .slice(0, 80)
          .map(([path, status]) => [path.slice(0, 2000), status.slice(0, 1000)]),
      ),
      body: "unavailable",
      state: undefined as unknown,
      captureFailures: unavailable,
    };
    try {
      state.url = page.url().slice(0, 2000);
    } catch {
      unavailable.push("url");
    }
    if (evidence.state) {
      try {
        state.state = await evidence.state();
      } catch {
        unavailable.push("state");
      }
    }
    try {
      state.body = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 4000);
    } catch {
      unavailable.push("body");
    }
    try {
      await page.screenshot({ path: artifact + ".png", timeout: 2000 });
      saved.push(artifact + ".png");
    } catch {
      unavailable.push("screenshot");
    }
    // Write after the screenshot so a closed page still leaves a JSON record
    // explaining which captures failed. Each operation is independent.
    try {
      await writeFile(artifact + ".json", JSON.stringify(state, null, 2) + "\n");
      saved.push(artifact + ".json");
    } catch {
      unavailable.push("json");
    }
    t.diagnostic(`Browser failure evidence: ${saved.join(", ") || "none saved"}`);
    if (unavailable.length) t.diagnostic(`Browser captures unavailable: ${unavailable.join(", ")}`);
  } catch {
    // Reporting itself can fail during teardown; preserve the original error.
  }
  throw cause;
}
