import { waitForSignal } from "./abort-signal.js";
import { BoundaryValidationError } from "./boundary.js";

export interface JSONResponseRules {
  /** Names the request in validation errors, for example "add-on data get". */
  readonly boundary: string;
  /** The largest accepted body, in bytes. */
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  /**
   * The error for a non-success status. `body` is the parsed error body when it
   * is JSON within the size limit; proxies can answer with HTML instead.
   */
  readonly httpError: (status: number, body: unknown) => Error;
}

/**
 * Reads a bounded JSON response: a non-success status becomes the caller's
 * error, and a wrong content type, an oversized body or invalid JSON becomes a
 * boundary validation error. Parsing the value's shape stays with the caller.
 */
export async function readJSONResponse(
  response: Response,
  rules: JSONResponseRules,
): Promise<unknown> {
  const { boundary, maxBytes, signal } = rules;
  signal.throwIfAborted();
  const declared = response.headers.get("Content-Length");
  const tooLarge = declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes);
  if (!response.ok) {
    const body = tooLarge ? undefined : await readBody(response, signal, maxBytes);
    throw rules.httpError(response.status, body === undefined ? undefined : parseJSON(body));
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BoundaryValidationError(boundary, "response must be application/json");
  }
  const body = tooLarge ? undefined : await readBody(response, signal, maxBytes);
  if (body === undefined) {
    throw new BoundaryValidationError(boundary, `response exceeds ${byteLabel(maxBytes)}`);
  }
  const value = parseJSON(body);
  if (value === undefined) {
    throw new BoundaryValidationError(boundary, "response must be valid JSON");
  }
  return value;
}

async function readBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string | undefined> {
  const text = await waitForSignal(response.text(), signal);
  signal.throwIfAborted();
  // A UTF-8 byte count lies between the UTF-16 length and three times it, so
  // only a body near the limit needs encoding to measure.
  if (text.length > maxBytes) return undefined;
  if (text.length * 3 <= maxBytes) return text;
  return new TextEncoder().encode(text).byteLength > maxBytes ? undefined : text;
}

function parseJSON(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function byteLabel(bytes: number): string {
  const mebibyte = 1024 * 1024;
  if (bytes % mebibyte === 0) return `${bytes / mebibyte} MiB`;
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
}
