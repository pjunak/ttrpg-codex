export interface Health {
  status: "ok";
  version: string;
}

export class BoundaryValidationError extends Error {
  override readonly name = "BoundaryValidationError";

  constructor(readonly boundary: string, message: string) {
    super(`${boundary}: ${message}`);
  }
}

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
  const response = await fetch("/api/health", {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`GET /api/health returned ${response.status}`);
  }
  return parseHealth(await response.json());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
