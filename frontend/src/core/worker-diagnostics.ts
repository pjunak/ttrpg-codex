import { BoundaryValidationError, isRecord } from "./boundary.js";

export interface WorkerDiagnostics {
  readonly pid: number;
  readonly startedAt: string;
  readonly exitedAt: string;
  readonly exitCode: number | undefined;
  readonly lastError: string;
  readonly health: { status: string; at: string } | undefined;
  readonly requests: readonly { method: string; requestRef: string; correlationRef: string; outcome: string; at: string; milliseconds: number }[];
}
const fail = (): never => { throw new BoundaryValidationError("Worker diagnostics", "invalid server response"); };
const text = (value: unknown, maximum = 160): string => typeof value === "string" && value.length <= maximum ? value : fail();
const optional = (value: unknown): string => value === undefined ? "" : text(value);
const integer = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
const at = (value: unknown): string => value === undefined ? "" : Number.isFinite(Date.parse(text(value))) ? value as string : fail();
const reference = (value: unknown): string => value === undefined ? "" : /^[a-f0-9]{16}$/.test(text(value)) ? value as string : fail();
export function parseWorkerDiagnostics(value: unknown): WorkerDiagnostics | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail();
  const health = value["health"], requests = value["requests"] ?? [];
  if (!Array.isArray(requests) || requests.length > 32) return fail();
  if (health !== undefined && (!isRecord(health) || !["ok", "degraded", "failed"].includes(String(health["status"])))) return fail();
  const exitCode = value["exitCode"];
  if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < -1 || exitCode > 2147483647)) return fail();
  return { exitCode: exitCode as number | undefined, pid: integer(value["pid"] ?? 0), startedAt: at(value["startedAt"]), exitedAt: at(value["exitedAt"]), lastError: optional(value["lastError"]),
    health: isRecord(health) ? { status: text(health["status"]), at: at(health["at"]) } : undefined,
    requests: requests.map(entry => {
      if (!isRecord(entry)) return fail();
      return { method: text(entry["method"], 120), requestRef: reference(entry["requestRef"]), correlationRef: reference(entry["correlationRef"]),
        outcome: text(entry["outcome"], 40), at: at(entry["at"]), milliseconds: integer(entry["milliseconds"]) };
    }) };
}
