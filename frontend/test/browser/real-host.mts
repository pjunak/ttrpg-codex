import type { APIRequestContext } from "playwright";
import type { AddressInfo } from "node:net";
import type { FixtureCollection, FixtureRecord } from "./fixture-types.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { request as playwrightRequest } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** One host binary for a suite, built into `frontend/test-results/<name>`. */
export interface RealHostBuild {
  readonly name: string;
  readonly binary: string;
  remove(): Promise<void>;
}

export interface RealHost {
  readonly origin: string;
  /** Signed in as the DM. */
  readonly admin: APIRequestContext;
  readonly csrf: string;
  password(role: "dm" | "player"): string;
  stop(): Promise<void>;
}

export async function buildRealHost(name: string): Promise<RealHostBuild> {
  const output = resolve(root, "frontend/test-results", name);
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(resolve(output, "build-"));
  const binary = resolve(directory, process.platform === "win32" ? "codex.exe" : "codex");
  await promisify(execFile)("go", ["build", "-o", binary, "./cmd/codex"], {
    cwd: root,
    windowsHide: true,
    timeout: 120_000,
  });
  return { name, binary, remove: () => removeInside(output, directory) };
}

/** Starts the built host on a free port with its own throwaway campaign. */
export async function startRealHost(build: RealHostBuild): Promise<RealHost> {
  const output = resolve(root, "frontend/test-results", build.name);
  const directory = await mkdtemp(resolve(output, "host-"));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = (role: "dm" | "player") => `local-${build.name}-${role}`;
  const host = spawn(
    build.binary,
    [
      "-listen",
      `127.0.0.1:${port}`,
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
        CODEX_DM_PASSWORD: password("dm"),
        CODEX_PLAYER_PASSWORD: password("player"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  host.stdout.on("data", (chunk) => {
    log += chunk;
  });
  host.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const admin = await playwrightRequest.newContext({ baseURL: origin });
  let ready = false;
  for (let i = 0; i < 150 && host.exitCode === null; i++) {
    try {
      if ((await admin.get("/api/health")).ok()) {
        ready = true;
        break;
      }
    } catch {
      /* Startup. */
    }
    await sleep(100);
  }
  assert.ok(ready, log);
  const login = await jsonResponse(
    await admin.post("/api/login", { data: { password: password("dm") } }),
  );
  return {
    origin,
    admin,
    csrf: login.csrfToken as string,
    password,
    async stop() {
      await admin.dispose();
      if (host.exitCode === null) {
        const closed = once(host, "close");
        host.kill();
        await closed;
      }
      await removeInside(output, directory);
    },
  };
}

async function removeInside(output: string, directory: string): Promise<void> {
  const child = relative(output, directory);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The stored record as the DM sees it, if it exists. */
export async function storedRecord<Value = Record<string, unknown>>(
  host: RealHost,
  collection: string,
  key: string,
): Promise<FixtureRecord<Value> | undefined> {
  const data = await jsonResponse(await host.admin.get("/api/campaign"));
  return (data.collections as FixtureCollection[])
    .find((item) => item.name === collection)
    ?.records.find((item) => item.key === key) as FixtureRecord<Value> | undefined;
}

const keyedCollections = new Set(["factions", "settings", "campaign"]);

/** The key the host derives from a relationship's endpoints and type. */
export function relationshipKey(source: string, target: string, type: string): string {
  return `relationship:${Buffer.from(JSON.stringify([source, target, type])).toString("base64url")}`;
}

/** List records carry their key as `id`; the host refuses one that differs. */
function withIdentity(collection: string, key: string, value: unknown): unknown {
  return keyedCollections.has(collection) ||
    collection === "relationships" ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    "id" in value
    ? value
    : { id: key, ...value };
}

/** Writes records as another author would, each over its current revision. */
export async function storeRecords(
  host: RealHost,
  records: readonly { collection: string; key: string; value: unknown }[],
): Promise<void> {
  if (records.length === 0) return;
  const mutations = [];
  for (const { collection, key, value } of records)
    mutations.push({
      operation: "put",
      collection,
      key,
      expectedRevision: (await storedRecord(host, collection, key))?.revision ?? 0,
      value: withIdentity(collection, key, value),
    });
  await jsonResponse(
    await host.admin.post("/api/campaign/transactions", {
      headers: { "X-Codex-CSRF": host.csrf },
      data: { contractVersion: "campaign-mutation.v1", mutations },
    }),
  );
}

/** Writes one record as another author would and returns what is stored. */
export async function storeRecord(
  host: RealHost,
  collection: string,
  key: string,
  value: unknown,
): Promise<FixtureRecord> {
  await storeRecords(host, [{ collection, key, value }]);
  return (await storedRecord(host, collection, key))!;
}

/** Deletes a record as another author would. */
export async function removeRecord(host: RealHost, collection: string, key: string): Promise<void> {
  const current = await storedRecord(host, collection, key);
  if (current === undefined) return;
  await jsonResponse(
    await host.admin.post("/api/campaign/transactions", {
      headers: { "X-Codex-CSRF": host.csrf },
      data: {
        contractVersion: "campaign-mutation.v1",
        mutations: [{ operation: "delete", collection, key, expectedRevision: current.revision }],
      },
    }),
  );
}
