import type { APIRequestContext, Browser } from "playwright";
import type { AddressInfo } from "node:net";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, request } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";

// The test plays the role of Docker's restart policy: when the host exits to
// install a staged backup, it is started again on the same data directory.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(root, "frontend/test-results/full-restore");
const restartExitCode = 75;
let directory: string,
  binary: string,
  address: string,
  host: ChildProcessByStdio<null, Readable, Readable>,
  browser: Browser,
  admin: APIRequestContext,
  origin: string,
  hostOutput = "",
  restarts = 0;

function startHost(): void {
  host = spawn(
    binary,
    [
      "-listen",
      address,
      "-data-dir",
      resolve(directory, "data"),
      "-web-dir",
      resolve(root, "frontend/dist"),
    ],
    {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_DM_PASSWORD: "local-full-restore-dm",
        CODEX_PLAYER_PASSWORD: "local-full-restore-player",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  host.stdout.on("data", (chunk) => (hostOutput += chunk));
  host.stderr.on("data", (chunk) => (hostOutput += chunk));
  host.on("exit", (code) => {
    if (code === restartExitCode) {
      restarts++;
      startHost();
    }
  });
}

async function healthy(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await admin.get("/api/health")).ok()) return;
    } catch {
      /* Starting. */
    }
    await sleep(100);
  }
  assert.fail(hostOutput);
}

async function signIn(): Promise<string> {
  return (
    await jsonResponse(
      await admin.post("/api/login", { data: { password: "local-full-restore-dm" } }),
    )
  ).csrfToken;
}

async function putCharacter(csrf: string, key: string, name: string): Promise<void> {
  await jsonResponse(
    await admin.post("/api/campaign/transactions", {
      headers: { "X-Codex-CSRF": csrf },
      data: {
        contractVersion: "campaign-mutation.v1",
        mutations: [
          {
            operation: "put",
            collection: "characters",
            key,
            expectedRevision: 0,
            value: { id: key, name },
          },
        ],
      },
    }),
  );
}

async function characterNames(): Promise<string[]> {
  const campaign = await jsonResponse(await admin.get("/api/campaign"));
  const characters = campaign.collections.find(
    (collection: { name: string }) => collection.name === "characters",
  );
  return characters.records.map((record: { value: { name: string } }) => record.value.name).sort();
}

before(async () => {
  await mkdir(output, { recursive: true });
  directory = await mkdtemp(resolve(output, "host-"));
  binary = resolve(directory, process.platform === "win32" ? "codex.exe" : "codex");
  await promisify(execFile)("go", ["build", "-o", binary, "./cmd/codex"], {
    cwd: root,
    windowsHide: true,
    timeout: 120_000,
  });
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  address = `127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise((resolve) => probe.close(resolve));
  origin = `http://${address}`;
  admin = await request.newContext({ baseURL: origin });
  startHost();
  await healthy();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await admin?.dispose();
  if (host && host.exitCode === null) {
    host.removeAllListeners("exit");
    const closed = once(host, "close");
    host.kill();
    await closed;
  }
  if (directory) {
    const child = relative(output, directory);
    assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

void test("a full backup uploaded in Settings replaces the site after a restart", async (t) => {
  const csrf = await signIn();
  await putCharacter(csrf, "kept", "Kept in the backup");
  const download = await admin.get("/api/backup");
  assert.equal(download.status(), 200);
  const archive = resolve(directory, "backup.zip");
  await writeFile(archive, await download.body());
  await putCharacter(csrf, "later", "Added after the backup");
  assert.deepEqual(await characterNames(), ["Added after the backup", "Kept in the backup"]);

  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
  });
  t.after(() => context.close());
  await jsonResponse(
    await context.request.post("/api/login", { data: { password: "local-full-restore-dm" } }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto("/#/settings");
  await page.locator("[data-category=backup]").click();
  const form = page.locator(".settings-full-restore");
  await form.getByRole("heading", { name: "Restore a full backup", exact: true }).waitFor();
  const submit = form.getByRole("button", { name: "⚠ Restore and restart", exact: true });

  // Without the confirmation the browser refuses to submit.
  await form.getByLabel("Backup ZIP", { exact: true }).setInputFiles(archive);
  await submit.click();
  assert.equal(restarts, 0);

  await form.getByLabel("Replace all current data with this backup", { exact: true }).check();
  const reloaded = page.waitForEvent("load", { timeout: 60_000 });
  await submit.click();
  await form.getByText(/Backup from .* accepted/u).waitFor();
  await reloaded.catch((error: unknown) =>
    assert.fail(`${String(error)}
${hostOutput}`),
  );
  assert.equal(restarts, 1, hostOutput);

  await healthy();
  await signIn();
  assert.deepEqual(await characterNames(), ["Kept in the backup"]);
});

void test("an invalid upload is refused and leaves the site running", async (t) => {
  await signIn();
  const before = await characterNames();
  const context = await browser.newContext({ baseURL: origin });
  t.after(() => context.close());
  await jsonResponse(
    await context.request.post("/api/login", { data: { password: "local-full-restore-dm" } }),
  );
  const page = await context.newPage();
  await page.goto("/#/settings");
  await page.locator("[data-category=backup]").click();
  const form = page.locator(".settings-full-restore");
  await form.getByLabel("Backup ZIP", { exact: true }).setInputFiles({
    name: "not-a-backup.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not a zip"),
  });
  await form.getByLabel("Replace all current data with this backup", { exact: true }).check();
  await form.getByRole("button", { name: "⚠ Restore and restart", exact: true }).click();
  await form.getByRole("alert").filter({ hasText: "This file is not a valid backup" }).waitFor();
  assert.equal(restarts, 1);
  assert.deepEqual(await characterNames(), before);
});
