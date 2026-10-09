import { BoundaryValidationError, isRecord } from "./boundary.js";

/** Add-on IDs: lowercase words joined by single hyphens, at most 80 characters. */
export const addonIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/** Package generations and other content addresses are lowercase SHA-256 hex. */
export const sha256Pattern = /^[a-f0-9]{64}$/u;

export function isAddonId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && addonIdPattern.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

/**
 * Strict readers for one response boundary. Each returns the checked value or
 * throws that boundary's validation error, so parsers read like the shape.
 * Readers take one argument, so they can be passed straight to `map`.
 */
export function responseReaders(boundary: string, message = "invalid server response") {
  const fail = (): never => {
    throw new BoundaryValidationError(boundary, message);
  };
  const textUpTo =
    (max: number) =>
    (value: unknown): string =>
      typeof value === "string" && value.length <= max ? value : fail();
  const listUpTo =
    (max: number) =>
    (value: unknown): unknown[] =>
      Array.isArray(value) && value.length <= max ? value : fail();
  const text = textUpTo(Number.POSITIVE_INFINITY);
  return {
    fail,
    text,
    textUpTo,
    object: (value: unknown): Record<string, unknown> => (isRecord(value) ? value : fail()),
    optionalText: (value: unknown): string => (value === undefined ? "" : text(value)),
    list: listUpTo(Number.POSITIVE_INFINITY),
    listUpTo,
    boolean: (value: unknown): boolean => (typeof value === "boolean" ? value : fail()),
    /** A non-negative safe integer. */
    count: (value: unknown): number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(),
    addonId: (value: unknown): string => (isAddonId(value) ? value : fail()),
    hash: (value: unknown): string => (isSha256(value) ? value : fail()),
  };
}
