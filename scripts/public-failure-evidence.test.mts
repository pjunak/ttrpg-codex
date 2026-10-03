import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  observeBrowser,
  publicFailureRecord,
  writePublicFailure,
} from "../frontend/test/browser/public-failure-evidence.mts";

const privateText = "private-fixture-content-and-credentials";
function request(path: string, error = "net::ERR_FAILED") {
  return {
    url: () => `https://user:${privateText}@fixture.invalid${path}?token=${privateText}`,
    method: () => "POST",
    failure: () => ({ errorText: error }),
    frame: () => ({ url: () => `https://fixture.invalid/#/dm?private=${privateText}` }),
    headers: () => {
      throw new Error("Headers must never be read");
    },
    postData: () => {
      throw new Error("Bodies must never be read");
    },
  };
}

void test("HTTP rejection, transport failure and pending reads retain separate bounded evidence", () => {
  const source = new EventEmitter();
  let now = 0;
  const collector = observeBrowser(source, () => now);
  const rejected = request("/api/addons/private-id/generations/private-generation/data/query");
  const failed = request("/api/campaign", "net::ERR_NO_BUFFER_SPACE");
  const held = request("/api/admin/rules-policy");
  source.emit("request", rejected);
  source.emit("response", { request: () => rejected, status: () => 503 });
  now = 10;
  source.emit("requestfinished", rejected);
  source.emit("request", failed);
  source.emit("requestfailed", failed);
  source.emit("request", held);
  source.emit("weberror", new Error(privateText));
  now = 25;
  const evidence = collector.stop();
  assert.deepEqual(evidence.requests, [
    {
      group: "addon-query",
      view: "dm",
      method: "POST",
      outcome: "finished",
      milliseconds: 10,
      status: 503,
    },
    {
      group: "campaign",
      view: "dm",
      method: "POST",
      outcome: "failed",
      milliseconds: 0,
      transport: "net::ERR_NO_BUFFER_SPACE",
    },
    { group: "rules-policy", view: "dm", method: "POST", outcome: "pending", milliseconds: 15 },
  ]);
  assert.equal(evidence.failed, 1, "HTTP 503 is a completed response, not a transport failure");
  assert.equal(evidence.pageErrors, 1);
  assert.ok(!JSON.stringify(evidence).includes("private"));
  assert.deepEqual(source.eventNames(), []);
  source.emit("request", request("/"));
  assert.equal(collector.stop(), evidence);
  assert.equal(evidence.started, 3, "Cleanup does not add its own aborted requests");
});

void test("completed and outstanding request history stays bounded under pressure", () => {
  const source = new EventEmitter();
  const collector = observeBrowser(source);
  for (let i = 0; i < 200; i++) {
    const value = request("/api/health");
    source.emit("request", value);
    source.emit("requestfinished", value);
  }
  for (let i = 0; i < 100; i++) source.emit("request", request("/api/events"));
  const evidence = collector.stop();
  assert.equal(evidence.requests.length, 128);
  assert.equal(evidence.requests.filter((value) => value.outcome === "pending").length, 64);
  assert.equal(evidence.started, 300);
  assert.equal(evidence.finished, 200);
  assert.equal(evidence.omitted, 172);
  assert.ok(evidence.requests.every((value) => value.milliseconds >= 0));
});

void test("broken diagnostic readers and listener removal do not throw or keep collecting", () => {
  const source = new EventEmitter();
  const collector = observeBrowser(source);
  source.emit("request", {
    url: () => {
      throw new Error(privateText);
    },
  });
  source.removeListener = () => {
    throw new Error(privateText);
  };
  const evidence = collector.stop();
  assert.equal(evidence.captureFailures, 6);
  source.emit("request", request("/api/health"));
  assert.equal(collector.stop(), evidence);
  assert.equal(evidence.started, 1);
  assert.ok(!JSON.stringify(evidence).includes(privateText));
});

void test("partial observer startup detaches listeners and preserves its original cause", () => {
  const source = new EventEmitter();
  const failure = new Error(privateText);
  const on = source.on.bind(source);
  source.on = (event, listener) => {
    if (event === "requestfailed") throw failure;
    return on(event, listener);
  };
  assert.throws(
    () => observeBrowser(source),
    (cause) => cause === failure,
  );
  assert.deepEqual(source.eventNames(), []);
});

void test("frame routing publishes only shared view categories", () => {
  const source = new EventEmitter();
  const collector = observeBrowser(source);
  for (const hash of [
    "#/dm",
    "#/settings/addons",
    "#/addons/private-addon/private-path",
    "#/wiki/private-record",
    "#/private-view",
  ]) {
    source.emit("request", {
      ...request("/api/health"),
      frame: () => ({ url: () => `https://fixture.invalid/${hash}?token=${privateText}` }),
    });
  }
  source.emit("request", {
    ...request("/api/health"),
    frame: () => {
      throw new Error(privateText);
    },
  });
  const evidence = collector.stop();
  assert.deepEqual(
    evidence.requests.map((item) => item.view),
    ["dm", "settings", "addon", "records", "other", "unavailable"],
  );
  assert.ok(!JSON.stringify(evidence).includes("private"));
});

void test("publication projects nested fields and never copies request, host or error content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-public-evidence-"));
  t.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    return rm(directory, { recursive: true, force: true });
  });
  const source = new EventEmitter();
  const collector = observeBrowser(source);
  const value = request(
    "/api/addons/private-id/generations/private-generation/services/call",
    privateText,
  );
  source.emit("request", value);
  source.emit("requestfailed", value);
  const record = publicFailureRecord({
    source: "browser",
    stage: privateText,
    method: privateText,
    testName: privateText,
    browser: collector.stop(),
    host: { pid: 42, exitCode: -1073741515, signalCode: null },
  });
  const extra = {
    ...record,
    hostOutput: privateText,
    error: { message: privateText },
    browser: {
      ...record.browser!,
      privateData: privateText,
      requests: record.browser!.requests.map((item) => ({
        ...item,
        url: privateText,
        headers: { Authorization: privateText },
        body: privateText,
      })),
    },
  };
  await writePublicFailure(extra, directory);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const text = await readFile(join(directory, files[0]!), "utf8");
  const saved = JSON.parse(text);
  assert.ok(!text.includes(privateText));
  assert.equal(saved.stage, "other");
  assert.equal(saved.method, "other");
  assert.equal(saved.browser.requests[0].group, "addon-service");
  assert.equal(saved.browser.requests[0].transport, "other");
  assert.equal(saved.host.exitCode, -1073741515);
  assert.equal(saved.testHash.length, 64);
  assert.equal(saved.at, record.at);
});
