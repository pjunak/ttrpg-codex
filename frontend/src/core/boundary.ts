export class BoundaryValidationError extends Error {
  override readonly name = "BoundaryValidationError";

  constructor(readonly boundary: string, message: string) {
    super(`${boundary}: ${message}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}
