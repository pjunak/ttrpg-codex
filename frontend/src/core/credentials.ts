import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";

export interface CredentialStatus { readonly contractVersion: "credential-status.v1"; readonly revision: number; readonly playerEnabled: boolean }
export interface PasswordChange { readonly role: "dm" | "player"; readonly currentPassword: string; readonly newPassword: string; readonly expectedRevision: number }
export class CredentialRequestError extends Error { constructor(readonly code: string) { super(code); } }

export function parseCredentialStatus(value: unknown): CredentialStatus {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["contractVersion", "revision", "playerEnabled"])) || value["contractVersion"] !== "credential-status.v1" || !Number.isSafeInteger(value["revision"]) || Number(value["revision"]) < 1 || typeof value["playerEnabled"] !== "boolean") {
    throw new BoundaryValidationError("password settings", "invalid credential status");
  }
  return { contractVersion: "credential-status.v1", revision: Number(value["revision"]), playerEnabled: value["playerEnabled"] };
}

async function request(init: RequestInit): Promise<CredentialStatus> {
  const response = await sessionFetch("/api/passwords", { ...init, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const codes: Readonly<Record<number, string>> = { 400: "policy", 401: "currentIncorrect", 403: "forbidden", 409: "conflict", 429: "rateLimited" };
    throw new CredentialRequestError(codes[response.status] ?? "failed");
  }
  return parseCredentialStatus(await response.json());
}
export function getCredentialStatus(signal: AbortSignal): Promise<CredentialStatus> { return request({ signal, method: "GET" }); }
export function changePassword(change: PasswordChange, csrfToken: string, signal: AbortSignal): Promise<CredentialStatus> {
  return request({ signal, method: "POST", headers: { "Content-Type": "application/json", "X-Codex-CSRF": csrfToken }, body: JSON.stringify(change) });
}
