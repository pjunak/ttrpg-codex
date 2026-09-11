import { BoundaryValidationError, isRecord } from "./boundary.js";

export interface SourceTarget { addonId: string; setId: string; id: string }
export interface SourceChoice extends SourceTarget { addonName: string; name: string; enabled: boolean; pending: boolean; required: boolean }
export interface ConfigurationSnapshot { revision: number; graphRevision: string; restartedAddonIds: string[] }
export interface RulesPolicy extends ConfigurationSnapshot { ruleset: { id: string; name: string; addonId: string } | null; sources: SourceChoice[] }
export interface ServiceCandidate { addonId: string; addonVersion: string; contractVersion: string; activeGeneration: string; compatible: boolean }
export interface ServiceSelection {
  consumerName: string; generationId: string; version: string; active: boolean;
  requirement: { consumerAddonId: string; contract: string; range: string; cardinality: "one" | "many"; selection: "operator" | "all-compatible"; required: boolean };
  resolution: { status: string; providers: string[]; binding: { revision: number; providerAddonIds: string[] } | null; staleTargets: string[] };
  candidates: ServiceCandidate[];
}
export interface ServiceSelections extends ConfigurationSnapshot { services: ServiceSelection[] }
export interface ConfigurationResult { applied: boolean; failures: { addonId: string; error: string }[]; recoveryError: string }
export const sourceKey = (source: SourceTarget): string => JSON.stringify([source.addonId, source.setId, source.id]);
export const serviceKey = (service: ServiceSelection): string => JSON.stringify([service.requirement.consumerAddonId, service.generationId, service.requirement.contract]);

const fail = (): never => { throw new BoundaryValidationError("Add-on configuration", "invalid server response"); };
const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail();
const string = (value: unknown): string => typeof value === "string" ? value : fail();
const boolean = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();
const strings = (value: unknown): string[] => array(value).map(string);
const revision = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : fail();
const hash = (value: unknown): string => /^[a-f0-9]{64}$/u.test(string(value)) ? string(value) : fail();
const choice = <T extends string>(value: unknown, allowed: readonly T[]): T => allowed.includes(string(value) as T) ? value as T : fail();
function snapshot(value: Record<string, unknown>): ConfigurationSnapshot {
  return { revision: revision(value["revision"]), graphRevision: hash(value["graphRevision"]), restartedAddonIds: strings(value["restartedAddonIds"]) };
}
export function parseRulesPolicy(input: unknown): RulesPolicy {
  const value = object(input);
  if (value["contractVersion"] !== "rules-policy.v1") fail();
  const rules = value["ruleset"] === null ? null : object(value["ruleset"]);
  const sources = array(value["sources"]).map(input => {
    const row = object(input);
    return { addonId: string(row["addonId"]), addonName: string(row["addonName"]), setId: string(row["setId"]), id: string(row["id"]), name: string(row["name"]), enabled: boolean(row["enabled"]), pending: boolean(row["pending"]), required: boolean(row["required"]) };
  });
  if (new Set(sources.map(sourceKey)).size !== sources.length) fail();
  return { ...snapshot(value), ruleset: rules === null ? null : { id: string(rules["id"]), name: string(rules["name"]), addonId: string(rules["addonId"]) }, sources };
}
export function parseServiceSelections(input: unknown): ServiceSelections {
  const value = object(input);
  if (value["contractVersion"] !== "service-selections.v1") fail();
  return { ...snapshot(value), services: array(value["services"]).map(input => {
    const row = object(input), requirement = object(row["requirement"]), resolution = object(row["resolution"]);
    const binding = resolution["binding"] === undefined ? null : object(resolution["binding"]);
    return {
      consumerName: string(row["consumerName"]), generationId: hash(row["generationId"]), version: string(row["version"]), active: boolean(row["active"]),
      requirement: { consumerAddonId: string(requirement["consumerAddonId"]), contract: string(requirement["contract"]), range: string(requirement["range"]), cardinality: choice(requirement["cardinality"], ["one", "many"]), selection: choice(requirement["selection"], ["operator", "all-compatible"]), required: boolean(requirement["required"]) },
      resolution: { status: string(resolution["status"]), providers: array(resolution["providers"]).filter(provider => resolution["status"] === "resolved" && object(provider)["activeGeneration"]).map(provider => string(object(provider)["addonId"])), staleTargets: strings(resolution["staleTargets"] ?? []), binding: binding === null ? null : { revision: revision(binding["revision"]), providerAddonIds: strings(binding["providerAddonIds"]) } },
      candidates: array(row["candidates"]).map(input => { const candidate = object(input); return { addonId: string(candidate["addonId"]), addonVersion: string(candidate["addonVersion"]), contractVersion: string(candidate["contractVersion"]), activeGeneration: candidate["activeGeneration"] === undefined ? "" : hash(candidate["activeGeneration"]), compatible: boolean(candidate["compatible"]) }; }),
    };
  }) };
}
export function parseConfigurationResult(input: unknown): ConfigurationResult {
  const value = object(input);
  if (value["contractVersion"] !== "addon-configuration-result.v1") fail();
  return { applied: boolean(value["applied"]), recoveryError: string(value["recoveryError"] ?? ""), failures: array(value["recoveryResults"]).flatMap(input => { const result = object(input); return result["error"] ? [{ addonId: string(result["addonId"]), error: string(result["error"]) }] : []; }) };
}
