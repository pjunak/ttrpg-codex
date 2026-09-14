import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";
import { parseInstalledGeneration, type InstalledGeneration } from "./addon-admin.js";
import { HostRequestError } from "./api.js";

export interface StoredPackage { addonId: string; generationId: string; version: string; available: boolean; active: boolean; downloadable: boolean }
export interface PackageStorage { contractVersion: "addon-package-storage.v1"; automatic: boolean; pending: number; packages: StoredPackage[] }
export class PackageStorageError extends HostRequestError { constructor(status: number, readonly code: string) { super(status, "Package storage"); } }
const id = (value: unknown): value is string => typeof value === "string" && value.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const fail = (): never => { throw new BoundaryValidationError("Package storage", "invalid response"); };
export function parsePackageStorage(value: unknown): PackageStorage {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["contractVersion", "automatic", "pending", "packages"])) ||
    value["contractVersion"] !== "addon-package-storage.v1" || typeof value["automatic"] !== "boolean" ||
    !Number.isSafeInteger(value["pending"]) || Number(value["pending"]) < 0 || !Array.isArray(value["packages"]) || value["packages"].length > 512) return fail();
  const packages = value["packages"].map((item: unknown): StoredPackage => {
    if (!isRecord(item) || !hasOnlyKeys(item, new Set(["addonId", "generationId", "version", "available", "active", "downloadable"])) ||
      !id(item["addonId"]) || !hash(item["generationId"]) || typeof item["version"] !== "string" || item["version"].length > 200 ||
      typeof item["available"] !== "boolean" || typeof item["active"] !== "boolean" || typeof item["downloadable"] !== "boolean") return fail();
    return { addonId: item["addonId"], generationId: item["generationId"], version: item["version"], available: item["available"], active: item["active"], downloadable: item["downloadable"] };
  });
  if (new Set(packages.map(item => item.addonId + ":" + item.generationId)).size !== packages.length) return fail();
  return { contractVersion: "addon-package-storage.v1", automatic: value["automatic"], pending: Number(value["pending"]), packages };
}
export class AddonStorageClient {
  constructor(readonly csrf: string, readonly signal: AbortSignal) {}
  async #request(operation = "", body?: unknown): Promise<unknown> {
    const response = await sessionFetch("/api/admin/addon-package-storage" + (operation ? "/" + operation : ""), {
      signal: this.signal, cache: "no-store", method: body === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", "X-Codex-CSRF": this.csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json().catch((error: unknown) => { if (response.ok) throw error; return undefined; });
    if (!response.ok) throw new PackageStorageError(response.status, isRecord(value) && isRecord(value["error"]) && typeof value["error"]["kind"] === "string" ? value["error"]["kind"] : "");
    return value;
  }
  async status(): Promise<PackageStorage> { return parsePackageStorage(await this.#request()); }
  async recovery(pointId: number, expectedRevision: number, prepare = false): Promise<PackageStorage> {
    if (!Number.isSafeInteger(pointId) || pointId < 1 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail();
    return parsePackageStorage(await this.#request(prepare ? "prepare" : "review", { pointId, expectedRevision }));
  }
  async restore(item: StoredPackage): Promise<InstalledGeneration> {
    if (!id(item.addonId) || !hash(item.generationId)) return fail();
    const generation = parseInstalledGeneration(await this.#request("restore", { addonId: item.addonId, generationId: item.generationId }));
    if (generation.addonId !== item.addonId || generation.generationId !== item.generationId) return fail();
    return generation;
  }
  async retry(): Promise<PackageStorage> { return parsePackageStorage(await this.#request("retry", {})); }
}
