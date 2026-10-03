import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  observeBrowser,
  publicFailureRecord,
  writePublicFailure,
} from "./public-failure-evidence.mts";

void test("Chromium failure metadata separates rejected, aborted and pending requests without their content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-public-browser-evidence-"));
  t.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    return rm(directory, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const collector = observeBrowser(context);
  t.after(() => {
    collector.stop();
  });
  const privateText = "private-request-response-and-credential-fixture";
  await context.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/campaign") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ privateText }),
      });
    } else if (path.includes("/services/")) {
      await route.abort("failed");
    } else if (path !== "/api/admin/rules-policy") {
      await route.fulfill({ contentType: "text/html", body: `<title>${privateText}</title>` });
    }
    // The policy request stays outstanding until context cleanup.
  });
  const page = await context.newPage();
  await page.goto(`https://fixture.invalid/#/settings?token=${privateText}`);
  const rejected = page.waitForEvent("requestfinished", {
    predicate: (request) => new URL(request.url()).pathname === "/api/campaign",
    timeout: 5_000,
  });
  const aborted = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().includes("/services/"),
    timeout: 5_000,
  });
  await Promise.all([
    rejected,
    aborted,
    page.evaluate(async (privateText) => {
      await Promise.all([
        fetch(`/api/campaign?token=${privateText}`, {
          method: "POST",
          headers: { "X-Fixture-Secret": privateText },
          body: JSON.stringify({ privateText }),
        }).then((response) => response.text()),
        fetch(
          `/api/addons/private-addon/generations/private-generation/services/call?token=${privateText}`,
        ).catch(() => undefined),
      ]);
    }, privateText),
  ]);
  const held = page.waitForEvent("request", {
    predicate: (request) => new URL(request.url()).pathname === "/api/admin/rules-policy",
    timeout: 5_000,
  });
  await page.evaluate((privateText) => {
    void fetch(`/api/admin/rules-policy?token=${privateText}`).catch(() => undefined);
  }, privateText);
  await held;
  const evidence = collector.stop();
  const campaign = evidence.requests.find((item) => item.group === "campaign");
  const service = evidence.requests.find((item) => item.group === "addon-service");
  const policy = evidence.requests.find((item) => item.group === "rules-policy");
  assert.equal(campaign?.status, 503);
  assert.equal(campaign?.outcome, "finished");
  assert.equal(service?.transport, "net::ERR_FAILED");
  assert.equal(service?.outcome, "failed");
  assert.equal(policy?.outcome, "pending");
  assert.ok([campaign, service, policy].every((item) => item?.view === "settings"));
  assert.equal(evidence.captureFailures, 0);
  assert.equal(evidence.failed, 1);
  await writePublicFailure(
    publicFailureRecord({
      source: "browser",
      stage: "browser",
      testName: t.name,
      browser: evidence,
    }),
    directory,
  );
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const saved = await readFile(join(directory, files[0]!), "utf8");
  assert.ok(!saved.includes(privateText));
  assert.ok(!saved.includes("private-addon"));
  assert.ok(!saved.includes("fixture.invalid"));
  assert.ok(!saved.includes("X-Fixture-Secret"));
  assert.ok(!saved.includes(t.name));
  await context.close();
  assert.equal(collector.stop(), evidence);
  assert.equal(evidence.failed, 1, "Cleanup cannot add its own request aborts to the capture");
});
