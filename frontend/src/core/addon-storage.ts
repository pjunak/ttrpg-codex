import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";
import { readJSONResponse } from "./http.js";
import { HostRequestError } from "./api.js";

/** The server's package cleanup policy and any cleanup it is still retrying. */
export interface PackageStorage {
  contractVersion: "addon-package-storage.v1";
  automatic: boolean;
  pending: number;
}
export class PackageStorageError extends HostRequestError {
  constructor(
    status: number,
    readonly code: string,
  ) {
    super(status, "Package storage");
  }
}
const boundary = "Package storage";
export function parsePackageStorage(value: unknown): PackageStorage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["contractVersion", "automatic", "pending"])) ||
    value["contractVersion"] !== "addon-package-storage.v1" ||
    typeof value["automatic"] !== "boolean" ||
    !Number.isSafeInteger(value["pending"]) ||
    Number(value["pending"]) < 0
  )
    throw new BoundaryValidationError(boundary, "invalid response");
  return {
    contractVersion: "addon-package-storage.v1",
    automatic: value["automatic"],
    pending: Number(value["pending"]),
  };
}
export class AddonStorageClient {
  constructor(
    readonly csrf: string,
    readonly signal: AbortSignal,
  ) {}
  async status(): Promise<PackageStorage> {
    const response = await sessionFetch("/api/admin/addon-package-storage", {
      signal: this.signal,
      cache: "no-store",
      headers: { Accept: "application/json", "X-Codex-CSRF": this.csrf },
    });
    return parsePackageStorage(
      await readJSONResponse(response, {
        boundary,
        maxBytes: 64 * 1024,
        signal: this.signal,
        httpError: (status, body) =>
          new PackageStorageError(
            status,
            isRecord(body) && isRecord(body["error"]) && typeof body["error"]["kind"] === "string"
              ? body["error"]["kind"]
              : "",
          ),
      }),
    );
  }
}
