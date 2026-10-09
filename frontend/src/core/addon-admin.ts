import { responseReaders } from "./validators.js";
import { readJSONResponse } from "./http.js";
import { parseSchemaReview, type SchemaReview } from "./addon-schema-upgrade.js";
import { parseWorkerDiagnostics, type WorkerDiagnostics } from "./worker-diagnostics.js";
import { isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";
import { HostRequestError } from "./api.js";
import {
  parseRulesPolicy,
  parseServiceSelections,
  parseConfigurationResult,
  type ConfigurationSnapshot,
  type SourceTarget,
  type ServiceSelection,
} from "./addon-configuration.js";
import { parseAddonDisableReview, type AddonDisableReview } from "./addon-disable.js";
import { parseAddonUninstallReview, type AddonUninstallReview } from "./addon-uninstall.js";

// Inventories include diagnostics and history; reviews include manifests.
const maximumAdminResponseBytes = 8 * 1024 * 1024;

export class AddonAdminRequestError extends HostRequestError {
  constructor(
    status: number,
    readonly code: string,
    message?: string,
  ) {
    super(status, "Add-on management", message);
  }
}

export interface InstalledGeneration {
  addonId: string;
  generationId: string;
  version: string;
  installedAt: string;
  lastError: string;
  /** The package manifest's display name and description. */
  name: string;
  description: string;
}
export interface AddonSnapshot {
  state: { addonId: string; revision: number; activeGenerationId: string };
  generations: InstalledGeneration[];
  events: { kind: string; message: string; occurredAt: string }[];
  runtimeState: string;
  runtime?: WorkerDiagnostics | undefined;
}
export interface AddonReview {
  suggested: string[];
  dependencies: { id: string; range: string; required: boolean }[];
  services: { contract: string; range: string; required: boolean }[];
  rulesetName: string;
  supportedRulesets: string[];
  disabledSources: string[];
  reviewId: string;
  addonId: string;
  generationId: string;
  proposalSha256: string;
  status: string;
  name: string;
  version: string;
  currentVersion: string;
  permissions: { id: string; reason: string; resources: string[] }[];
  required: string[];
  restarted: string[];
  changes: { category: string; added: string[]; changed: string[]; removed: string[] }[];
  runtimeChanged: boolean;
  blockers: { code: string; message: string }[];
}
const {
  fail,
  object,
  text,
  optionalText,
  list,
  addonId: id,
  hash,
} = responseReaders("Add-on administration");
const strings = (value: unknown): string[] => list(value ?? []).map(text);

export function parseInstalledGeneration(value: unknown): InstalledGeneration {
  const record = object(value);
  return {
    addonId: id(record["addonId"]),
    generationId: hash(record["generationId"]),
    version: text(record["version"]),
    installedAt: text(record["installedAt"]),
    lastError: optionalText(record["lastError"]),
    name: optionalText(record["name"]),
    description: optionalText(record["description"]),
  };
}
function parseAddonSnapshot(value: unknown): AddonSnapshot {
  const record = object(value),
    state = object(record["state"]),
    revision = state["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) fail();
  return {
    state: {
      addonId: id(state["addonId"]),
      revision: revision as number,
      activeGenerationId:
        state["activeGenerationId"] === undefined ? "" : hash(state["activeGenerationId"]),
    },
    generations: list(record["generations"]).map(parseInstalledGeneration),
    events: list(record["events"]).map((value) => {
      const event = object(value);
      return {
        kind: text(event["kind"]),
        message: optionalText(event["message"]),
        occurredAt: text(event["occurredAt"]),
      };
    }),
    runtime: parseWorkerDiagnostics(record["runtime"]),
    runtimeState: record["runtime"] ? optionalText(object(record["runtime"])["state"]) : "",
  };
}
function parseAddonReview(value: unknown): AddonReview {
  const record = object(value),
    proposal = object(record["proposal"]),
    manifest = object(proposal["targetManifest"]),
    changes = object(proposal["changes"]);
  const reviewId = text(record["reviewId"]),
    addonId = id(record["addonId"]),
    generationId = hash(record["generationId"]);
  if (
    !/^[a-zA-Z0-9._-]{1,128}$/u.test(reviewId) ||
    proposal["addonId"] !== addonId ||
    proposal["generationId"] !== generationId ||
    manifest["id"] !== addonId ||
    !["prepared", "approved", "consumed"].includes(text(record["status"]))
  )
    fail();
  const required = strings(proposal["requiredPermissionIds"]),
    suggested = strings(proposal["suggestedPermissionIds"]);
  const permissions = list(manifest["permissions"] ?? []).map((value) => {
    const permission = object(value);
    return {
      id: text(permission["id"]),
      reason: text(permission["reason"]),
      resources: strings(permission["resources"]),
    };
  });
  if (
    [...required, ...suggested].some(
      (id) => !permissions.some((permission) => permission.id === id),
    )
  )
    fail();
  return {
    reviewId,
    addonId,
    generationId,
    proposalSha256: hash(record["proposalSha256"]),
    status: text(record["status"]),
    name: text(manifest["name"]),
    version: text(manifest["version"]),
    rulesetName:
      manifest["rules"] && object(manifest["rules"])["defines"]
        ? text(object(object(manifest["rules"])["defines"])["name"])
        : "",
    supportedRulesets: manifest["rules"] ? strings(object(manifest["rules"])["supports"]) : [],
    disabledSources: list(proposal["sourceChoices"] ?? [])
      .filter((value) => object(value)["enabled"] === false)
      .map((value) => text(object(value)["name"])),
    currentVersion: proposal["currentManifest"]
      ? text(object(proposal["currentManifest"])["version"])
      : "",
    permissions,
    required,
    suggested,
    restarted: strings(proposal["restartedAddonIds"]),
    dependencies: list(manifest["dependencies"] ?? []).map((v) => {
      const d = object(v);
      return {
        id: id(d["id"]),
        range: text(d["range"]),
        required: typeof d["required"] === "boolean" ? d["required"] : fail(),
      };
    }),
    services: list(
      manifest["services"] ? (object(manifest["services"])["consumes"] ?? []) : [],
    ).map((v) => {
      const d = object(v);
      return {
        contract: text(d["contract"]),
        range: text(d["range"]),
        required: typeof d["required"] === "boolean" ? d["required"] : fail(),
      };
    }),
    runtimeChanged:
      typeof changes["runtimeChanged"] === "boolean" ? changes["runtimeChanged"] : fail(),
    changes: Object.entries(changes)
      .filter(([key]) => key !== "runtimeChanged")
      .map(([category, value]) => {
        const change = object(value);
        return {
          category,
          added: strings(change["added"]),
          changed: strings(change["changed"]),
          removed: strings(change["removed"]),
        };
      }),
    blockers: list(proposal["blockers"] ?? []).map((value) => {
      const blocker = object(value);
      return { code: text(blocker["code"]), message: text(blocker["message"]) };
    }),
  };
}

export class AddonAdminClient {
  constructor(
    readonly csrfToken: string,
    readonly signal: AbortSignal,
  ) {}
  async reviewUpdateData(review: AddonReview): Promise<SchemaReview> {
    const result = parseSchemaReview(
      await this.#request(
        `addon-activation-reviews/${encodeURIComponent(review.reviewId)}/update/saved-data`,
        {},
      ),
      review,
    );
    if (!result.forActivation || result.status !== "prepared") fail();
    return result;
  }
  async resolveUpdate(
    review: AddonReview,
    schema: SchemaReview,
    action: "heal" | "remove",
    grants: readonly string[],
  ): Promise<void> {
    const result = object(
      await this.#request(
        `addon-activation-reviews/${encodeURIComponent(review.reviewId)}/update/resolve`,
        {
          proposalSha256: review.proposalSha256,
          schemaReviewId: schema.reviewId,
          schemaReviewSha256: schema.reviewSha256,
          action,
          grantedPermissionIds: grants,
        },
      ),
    );
    const state = object(result["state"]);
    if (
      result["reviewId"] !== review.reviewId ||
      state["addonId"] !== review.addonId ||
      state["activeGenerationId"] !== review.generationId
    )
      fail();
  }
  async cancelReview(review: AddonReview): Promise<void> {
    const result = object(
      await this.#request(
        `addon-activation-reviews/${encodeURIComponent(review.reviewId)}/update/cancel`,
        {},
      ),
    );
    if (result["cancelled"] !== true) fail();
  }
  async reviewDisable(addonId: string): Promise<AddonDisableReview> {
    return parseAddonDisableReview(
      await this.#request(`addons/${id(addonId)}/disable-review`, {}),
      addonId,
    );
  }
  async disable(review: AddonDisableReview) {
    const result = object(
      await this.#request(`addons/${id(review.addonId)}/disable-reviewed`, {
        reviewSha256: hash(review.reviewSha256),
      }),
    );
    if (result["addonId"] !== review.addonId || result["applied"] !== true) fail();
    return parseConfigurationResult(result);
  }
  async reviewUninstall(addonId: string): Promise<AddonUninstallReview> {
    return parseAddonUninstallReview(
      await this.#request(`addons/${id(addonId)}/uninstall-review`, {}),
      addonId,
    );
  }
  async uninstall(review: AddonUninstallReview) {
    const result = object(
      await this.#request(`addons/${id(review.addonId)}/uninstall`, {
        reviewSha256: hash(review.reviewSha256),
      }),
    );
    if (
      result["addonId"] !== review.addonId ||
      result["applied"] !== true ||
      typeof result["alreadyRemoved"] !== "boolean"
    )
      fail();
    return parseConfigurationResult(result);
  }
  async rulesPolicy() {
    return parseRulesPolicy(await this.#request("rules-policy"));
  }
  async serviceSelections() {
    return parseServiceSelections(await this.#request("service-selections"));
  }
  async selectSources(snapshot: ConfigurationSnapshot, enabled: SourceTarget[]) {
    return parseConfigurationResult(
      await this.#request("rules-policy", {
        expectedRevision: snapshot.revision,
        expectedGraphRevision: snapshot.graphRevision,
        enabled,
      }),
    );
  }
  async selectService(
    snapshot: ConfigurationSnapshot,
    service: ServiceSelection,
    automatic: boolean,
    providerAddonIds: string[],
  ) {
    return parseConfigurationResult(
      await this.#request("service-selections", {
        expectedRevision: snapshot.revision,
        expectedGraphRevision: snapshot.graphRevision,
        consumerAddonId: service.requirement.consumerAddonId,
        generationId: service.generationId,
        contract: service.requirement.contract,
        expectedBindingRevision: service.resolution.binding?.revision ?? 0,
        automatic,
        providerAddonIds,
      }),
    );
  }
  async #request(path: string, body?: unknown, archive?: File): Promise<unknown> {
    const response = await sessionFetch(`/api/admin/${path}`, {
      signal: this.signal,
      method: body !== undefined || archive ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        "X-Codex-CSRF": this.csrfToken,
        ...(archive
          ? { "Content-Type": "application/zip" }
          : body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
      },
      ...(archive ? { body: archive } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return readJSONResponse(response, {
      boundary: "add-on administration",
      maxBytes: maximumAdminResponseBytes,
      signal: this.signal,
      httpError: (status, body) => {
        const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
        return new AddonAdminRequestError(
          status,
          typeof error?.["kind"] === "string" ? error["kind"] : "",
          typeof error?.["message"] === "string" ? error["message"] : undefined,
        );
      },
    });
  }
  async inventory(): Promise<AddonSnapshot[]> {
    const value = object(await this.#request("addons"));
    if (value["contractVersion"] !== "addon-inventory.v1") fail();
    const ids = list(value["addonIds"]).map(id);
    return Promise.all(
      ids.map(async (id) => parseAddonSnapshot(await this.#request(`addons/${id}?eventLimit=10`))),
    );
  }
  async stage(file: File): Promise<InstalledGeneration> {
    return parseInstalledGeneration(await this.#request("addons/generations", undefined, file));
  }
  async review(addonId: string, generationId: string): Promise<AddonReview> {
    return parseAddonReview(
      await this.#request(`addons/${id(addonId)}/activation-reviews`, {
        generationId: hash(generationId),
      }),
    );
  }
  async activate(review: AddonReview, grants: string[]): Promise<void> {
    const path = `addon-activation-reviews/${encodeURIComponent(review.reviewId)}`;
    const approved = parseAddonReview(
      await this.#request(`${path}/approval`, { grantedPermissionIds: grants }),
    );
    if (
      approved.status !== "approved" ||
      approved.proposalSha256 !== review.proposalSha256 ||
      approved.generationId !== review.generationId ||
      approved.addonId !== review.addonId
    )
      fail();
    const result = object(await this.#request(`${path}/activation`, {}));
    const state = object(result["state"]);
    if (state["addonId"] !== review.addonId || state["activeGenerationId"] !== review.generationId)
      fail();
  }
  async action(snapshot: AddonSnapshot, action: "reload" | "disable"): Promise<void> {
    const result = object(
      await this.#request(`addons/${id(snapshot.state.addonId)}/${action}`, {
        expectedStateRevision: snapshot.state.revision,
      }),
    );
    if (object(result["state"])["addonId"] !== snapshot.state.addonId) fail();
  }
}
