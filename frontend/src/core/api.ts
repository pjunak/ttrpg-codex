import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";

const anonymousAuthKeys = new Set(["role", "realRole"]);
const authenticatedAuthKeys = new Set([
  "ok",
  "role",
  "realRole",
  "csrfToken",
  "expiresAt",
]);
const sessionTokenPattern = /^[A-Za-z0-9_-]{32,512}$/;

export interface Health {
  status: "ok";
  version: string;
}

export type AuthState =
  | { readonly authenticated: false; readonly role: null; readonly realRole: null }
  | {
    readonly authenticated: true;
    readonly role: "dm" | "player";
    readonly realRole: "dm" | "player";
    readonly csrfToken: string;
    readonly expiresAt: string;
  };

export { BoundaryValidationError } from "./boundary.js";

export function parseHealth(value: unknown): Health {
  if (!isRecord(value)) {
    throw new BoundaryValidationError("GET /api/health", "response must be an object");
  }
  if (value["status"] !== "ok") {
    throw new BoundaryValidationError("GET /api/health", "status must be ok");
  }
  if (typeof value["version"] !== "string" || value["version"].length === 0) {
    throw new BoundaryValidationError("GET /api/health", "version must be a non-empty string");
  }
  return { status: value["status"], version: value["version"] };
}

export async function getHealth(signal: AbortSignal): Promise<Health> {
  const response = await sessionFetch("/api/health", {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`GET /api/health returned ${response.status}`);
  }
  return parseHealth(await response.json());
}

export function parseAuthState(value: unknown): AuthState {
  const boundary = "GET /api/auth";
  if (!isRecord(value)) {
    throw new BoundaryValidationError(boundary, "response must be an object");
  }
  if (value["role"] === null && value["realRole"] === null) {
    if (!hasOnlyKeys(value, anonymousAuthKeys)) {
      throw new BoundaryValidationError(boundary, "anonymous response has unknown fields");
    }
    return { authenticated: false, role: null, realRole: null };
  }
  if (!hasOnlyKeys(value, authenticatedAuthKeys) || value["ok"] !== true) {
    throw new BoundaryValidationError(boundary, "authenticated response has an invalid shape");
  }
  const role = value["role"];
  const realRole = value["realRole"];
  if ((role !== "dm" && role !== "player") || (realRole !== "dm" && realRole !== "player") ||
    (realRole === "player" && role !== "player")) {
    throw new BoundaryValidationError(boundary, "roles contain an invalid authority transition");
  }
  const csrfToken = value["csrfToken"];
  const expiresAt = value["expiresAt"];
  if (typeof csrfToken !== "string" || !sessionTokenPattern.test(csrfToken) ||
    typeof expiresAt !== "string" || !validTimestamp(expiresAt)) {
    throw new BoundaryValidationError(boundary, "session metadata is invalid");
  }
  return { authenticated: true, role, realRole, csrfToken, expiresAt };
}

export async function getAuth(signal: AbortSignal): Promise<AuthState> {
  return parseAuthState(await requestJSON("GET /api/auth", "/api/auth", { method: "GET", signal }));
}

export async function login(password: string, signal: AbortSignal): Promise<AuthState> {
  return parseAuthState(await requestJSON("POST /api/login", "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal,
  }));
}

export async function logout(signal: AbortSignal): Promise<void> {
  const value = await requestJSON("POST /api/logout", "/api/logout", { method: "POST", signal });
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["ok"])) || value["ok"] !== true) {
    throw new BoundaryValidationError("POST /api/logout", "response must confirm logout");
  }
}

export async function switchRole(
  role: "dm" | "player",
  csrfToken: string,
  signal: AbortSignal,
): Promise<AuthState> {
  if (csrfToken.length < 32) {
    throw new BoundaryValidationError("POST /api/view-as", "CSRF token is invalid");
  }
  return parseAuthState(await requestJSON("POST /api/view-as", "/api/view-as", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-CSRF": csrfToken,
    },
    body: JSON.stringify({ role }),
    signal,
  }));
}

export async function createPlayerPreview(csrfToken: string, signal: AbortSignal): Promise<string> {
  const value = await requestJSON("POST /api/player-preview", "/api/player-preview", {
    method: "POST", headers: { "X-Codex-CSRF": csrfToken }, signal,
  });
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["contractVersion", "token", "expiresAt"])) ||
    value["contractVersion"] !== "player-preview.v1" || typeof value["token"] !== "string" ||
    !sessionTokenPattern.test(value["token"]) || typeof value["expiresAt"] !== "string" || !validTimestamp(value["expiresAt"])) {
    throw new BoundaryValidationError("POST /api/player-preview", "invalid preview session");
  }
  return value["token"];
}

async function requestJSON(boundary: string, input: string, init: RequestInit): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const response = await sessionFetch(input, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    throw new Error(`${boundary} returned ${response.status}`);
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BoundaryValidationError(boundary, "response must be application/json");
  }
  return response.json() as Promise<unknown>;
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
