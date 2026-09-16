import { BoundaryValidationError, isRecord } from "../core/boundary.js";
import { HostRequestError } from "../core/api.js";
import { BrowserGraphHTTPError } from "./browser-graph-client.js";

export type BrowserDiagnosticPhase = "activation" | "dependency" | "disposal" | "refresh" | "contribution";
export interface BrowserDiagnostic {
  readonly reference: string;
  readonly at: string;
  readonly phase: BrowserDiagnosticPhase;
  readonly addonId: string;
  readonly generationId: string;
  readonly code: "INVALID_RESPONSE" | "AUTHORIZATION" | "UNAVAILABLE" | "FAILED";
}

/** This tab only; never stores exception messages, URLs, payloads or stack traces. */
export class BrowserDiagnostics {
  #enabled = false;
  #sequence = 0;
  #entries: BrowserDiagnostic[] = [];
  readonly #listeners = new Set<() => void>();
  enable(value: boolean): void { this.#enabled = value; if (!value) { this.#entries = []; this.#notify(); } }
  record(phase: BrowserDiagnosticPhase, failure: unknown): void {
    if (!this.#enabled) return;
    const details = isRecord(failure) ? failure : undefined;
    const cause: unknown = details?.["cause"] ?? failure;
    const addonId = details?.["addonId"], generationId = details?.["generationId"];
    const status = cause instanceof HostRequestError || cause instanceof BrowserGraphHTTPError ? cause.status : undefined;
    const code = cause instanceof BoundaryValidationError ? "INVALID_RESPONSE" :
      status === 401 || status === 403 ? "AUTHORIZATION" : status !== undefined && status >= 500 ? "UNAVAILABLE" : "FAILED";
    this.#entries.push(Object.freeze({ reference: "browser-" + ++this.#sequence, at: new Date().toISOString(), phase,
      addonId: typeof addonId === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(addonId) ? addonId : "",
      generationId: typeof generationId === "string" && /^[a-f0-9]{64}$/.test(generationId) ? generationId : "", code }));
    this.#entries = this.#entries.slice(-32); this.#notify();
  }
  list(): readonly BrowserDiagnostic[] { return [...this.#entries]; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #notify(): void { for (const listener of this.#listeners) listener(); }
}
export const browserDiagnostics = new BrowserDiagnostics();
