import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, Request, Response } from "playwright";

type ObservedRequest = Pick<Request, "url" | "method" | "failure"> & {
  frame?: () => Pick<Frame, "url">;
};
type ObservedResponse = Pick<Response, "request" | "status">;
export interface BrowserEvidenceSource {
  on(
    event: "request" | "requestfinished" | "requestfailed",
    listener: (request: ObservedRequest) => void,
  ): unknown;
  on(event: "response", listener: (response: ObservedResponse) => void): unknown;
  on(event: "weberror", listener: () => void): unknown;
  removeListener(
    event: "request" | "requestfinished" | "requestfailed",
    listener: (request: ObservedRequest) => void,
  ): unknown;
  removeListener(event: "response", listener: (response: ObservedResponse) => void): unknown;
  removeListener(event: "weberror", listener: () => void): unknown;
}
const groups = [
  "document",
  "assets",
  "health",
  "session",
  "events",
  "campaign",
  "campaign-write",
  "rules-policy",
  "addon-admin",
  "addon-query",
  "addon-write",
  "addon-service",
  "addon-content",
  "media",
  "other",
] as const;
type Group = (typeof groups)[number];
const views = ["dm", "timeline", "settings", "records", "addon", "other", "unavailable"] as const;
type View = (typeof views)[number];
const methods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "load",
  "save",
  "command",
  "preview",
  "import",
  "export",
  "upgrade",
  "other",
] as const;
type Method = (typeof methods)[number];
const stages = [
  "browser",
  "trace-start",
  "start-host",
  "login",
  "install",
  "enable-rule-sources",
  "seed-character",
  "launch-browser",
  "read-generation",
  "connect-service",
  "call-service",
  "other",
] as const;
const transportCodes = [
  "net::ERR_ABORTED",
  "net::ERR_FAILED",
  "net::ERR_NO_BUFFER_SPACE",
  "net::ERR_TIMED_OUT",
  "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_INTERNET_DISCONNECTED",
  "other",
] as const;
type TransportCode = (typeof transportCodes)[number];
const signals = [
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGABRT",
  "SIGSEGV",
  "SIGPIPE",
  "SIGQUIT",
] as const;
const limit = 64;
const choose = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  values.find((candidate) => candidate === value) ?? fallback;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)))
    : 0;
const status = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

function group(url: string): Group {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "other";
  }
  if (path === "/") return "document";
  if (path.startsWith("/assets/")) return "assets";
  if (path === "/api/health") return "health";
  if (/^\/api\/(login|logout|session|role)(\/|$)/.test(path)) return "session";
  if (path === "/api/events") return "events";
  if (path === "/api/campaign/transactions") return "campaign-write";
  if (path.startsWith("/api/campaign")) return "campaign";
  if (path === "/api/admin/rules-policy") return "rules-policy";
  if (path.startsWith("/api/admin/addons/")) return "addon-admin";
  if (path.startsWith("/api/media/")) return "media";
  const addon = /^\/api\/addons\/[^/]+\/generations\/[^/]+\/(data|services|content)\/(\w+)/.exec(
    path,
  );
  if (addon?.[1] === "data" && addon[2] === "query") return "addon-query";
  if (addon?.[1] === "data" && addon[2] === "transactions") return "addon-write";
  if (addon?.[1] === "services") return "addon-service";
  if (addon?.[1] === "content") return "addon-content";
  return "other";
}

function view(request: ObservedRequest): View {
  try {
    if (!request.frame) return "unavailable";
    const name = new URL(request.frame().url()).hash.slice(1).split(/[/?]/)[1];
    if (name === "dm" || name === "timeline" || name === "settings") return name;
    if (name === "addons") return "addon";
    if (name === "records" || name === "wiki" || name === "characters") return "records";
    return "other";
  } catch {
    // Service-worker and pre-navigation requests may not have a usable frame.
    return "unavailable";
  }
}

interface RequestEvidence {
  group: Group;
  view: View;
  method: Method;
  outcome: "pending" | "finished" | "failed";
  milliseconds: number;
  status?: number;
  transport?: TransportCode;
}
export interface BrowserEvidence {
  started: number;
  finished: number;
  failed: number;
  pageErrors: number;
  captureFailures: number;
  omitted: number;
  requests: RequestEvidence[];
}

export function canObserveBrowser(
  source: Partial<BrowserEvidenceSource>,
): source is BrowserEvidenceSource {
  return typeof source.on === "function" && typeof source.removeListener === "function";
}

/** Keep categories and timings, never URLs, headers, bodies or exception text. */
export function observeBrowser(source: BrowserEvidenceSource, now = () => performance.now()) {
  const pending = new Map<ObservedRequest, { at: number; evidence: RequestEvidence }>();
  const complete: RequestEvidence[] = [];
  const counters = {
    started: 0,
    finished: 0,
    failed: 0,
    pageErrors: 0,
    captureFailures: 0,
    omitted: 0,
  };
  let stopped = false;
  const safely =
    <T extends unknown[]>(action: (...args: T) => void) =>
    (...args: T): void => {
      if (stopped) return;
      try {
        action(...args);
      } catch {
        counters.captureFailures++;
      }
    };
  const started = safely((request: ObservedRequest): void => {
    if (pending.has(request)) return;
    counters.started++;
    pending.set(request, {
      at: now(),
      evidence: {
        group: group(request.url()),
        view: view(request),
        method: choose(methods, request.method(), "other"),
        outcome: "pending",
        milliseconds: 0,
      },
    });
    if (pending.size > limit) {
      pending.delete(pending.keys().next().value!);
      counters.omitted++;
    }
  });
  const response = safely((response: ObservedResponse): void => {
    const record = pending.get(response.request());
    if (record) record.evidence.status = status(response.status());
  });
  const finish = (request: ObservedRequest, failed: boolean): void => {
    if (failed) counters.failed++;
    else counters.finished++;
    const record = pending.get(request);
    if (!record) return;
    pending.delete(request);
    record.evidence.outcome = failed ? "failed" : "finished";
    record.evidence.milliseconds = count(now() - record.at);
    if (failed)
      record.evidence.transport = choose(transportCodes, request.failure()?.errorText, "other");
    complete.push(record.evidence);
    if (complete.length > limit) {
      complete.shift();
      counters.omitted++;
    }
  };
  const finished = safely((request: ObservedRequest): void => finish(request, false));
  const failed = safely((request: ObservedRequest): void => finish(request, true));
  const pageError = safely((): void => {
    counters.pageErrors++;
  });
  let saved: BrowserEvidence | undefined;
  const collector = {
    stop(): BrowserEvidence {
      if (saved) return saved;
      stopped = true;
      for (const detach of [
        () => source.removeListener("request", started),
        () => source.removeListener("response", response),
        () => source.removeListener("requestfinished", finished),
        () => source.removeListener("requestfailed", failed),
        () => source.removeListener("weberror", pageError),
      ]) {
        try {
          detach();
        } catch {
          counters.captureFailures++;
        }
      }
      saved = {
        ...counters,
        requests: [
          ...complete,
          ...[...pending.values()].map(({ at, evidence }) => ({
            ...evidence,
            milliseconds: count(now() - at),
          })),
        ],
      };
      pending.clear();
      complete.length = 0;
      return saved;
    },
  };
  try {
    source.on("request", started);
    source.on("response", response);
    source.on("requestfinished", finished);
    source.on("requestfailed", failed);
    source.on("weberror", pageError);
    return collector;
  } catch (cause) {
    collector.stop();
    throw cause;
  }
}

type HostProcess = { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null };
export interface PublicFailureInput {
  source: "browser" | "host";
  stage: string;
  testName?: string;
  runId?: string;
  method?: string;
  status?: number;
  host?: HostProcess;
  browser?: BrowserEvidence;
}
export function publicFailureRecord(input: PublicFailureInput) {
  // Project an explicit allowlist again at the publication boundary. Structural
  // typing alone does not stop an input object carrying additional private fields.
  return {
    contractVersion: "test-failure-metadata.v1",
    at: new Date().toISOString(),
    source: input.source === "browser" ? ("browser" as const) : ("host" as const),
    stage: input.stage.startsWith("install-") ? "install" : choose(stages, input.stage, "other"),
    testHash:
      input.testName === undefined
        ? undefined
        : createHash("sha256").update(input.testName).digest("hex"),
    runId: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.runId ?? "")
      ? input.runId
      : undefined,
    method: input.method === undefined ? undefined : choose(methods, input.method, "other"),
    status: status(input.status),
    host: input.host
      ? {
          pid:
            typeof input.host.pid === "number" &&
            Number.isSafeInteger(input.host.pid) &&
            input.host.pid > 0
              ? input.host.pid
              : undefined,
          exitCode:
            input.host.exitCode !== null && Number.isSafeInteger(input.host.exitCode)
              ? input.host.exitCode
              : null,
          signal: signals.find((signal) => signal === input.host?.signalCode) ?? null,
        }
      : undefined,
    browser: input.browser
      ? {
          started: count(input.browser.started),
          finished: count(input.browser.finished),
          failed: count(input.browser.failed),
          pageErrors: count(input.browser.pageErrors),
          captureFailures: count(input.browser.captureFailures),
          omitted: count(input.browser.omitted),
          requests: input.browser.requests.slice(-limit * 2).map((request) => ({
            group: choose(groups, request.group, "other"),
            view: choose(views, request.view, "other"),
            method: choose(methods, request.method, "other"),
            outcome: choose(["pending", "finished", "failed"] as const, request.outcome, "pending"),
            milliseconds: count(request.milliseconds),
            status: status(request.status),
            transport:
              request.transport === undefined
                ? undefined
                : choose(transportCodes, request.transport, "other"),
          })),
        }
      : undefined,
  };
}
export type PublicFailureRecord = ReturnType<typeof publicFailureRecord>;
export type FailureReporter = (record: PublicFailureRecord) => Promise<void>;
export async function writePublicFailure(
  record: PublicFailureRecord,
  directory = fileURLToPath(new URL("../../test-results/public-diagnostics/", import.meta.url)),
): Promise<void> {
  const safe = {
    ...publicFailureRecord({
      source: record.source,
      stage: record.stage,
      runId: record.runId,
      method: record.method,
      status: record.status,
      host: record.host
        ? { pid: record.host.pid, exitCode: record.host.exitCode, signalCode: record.host.signal }
        : undefined,
      browser: record.browser,
    }),
    testHash: /^[a-f0-9]{64}$/.test(record.testHash ?? "") ? record.testHash : undefined,
    at:
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at) &&
      Number.isFinite(Date.parse(record.at))
        ? record.at
        : new Date().toISOString(),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(
      directory,
      `${safe.source}-${safe.testHash?.slice(0, 10) ?? safe.runId ?? "unknown"}-${randomUUID()}.json`,
    ),
    JSON.stringify(safe, null, 2) + "\n",
    { flag: "wx" },
  );
}
