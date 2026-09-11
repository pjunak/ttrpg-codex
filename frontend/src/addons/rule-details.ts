import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";
import type { WikiReference } from "./wiki-links.js";

export interface RuleReference { readonly kind: string; readonly id: string }
export interface SavedRuleEvidence {
  readonly reference: RuleReference; readonly name: string; readonly summary: string; readonly hash: string;
}
export interface RuleDetails {
  readonly label: string;
  readonly reference?: RuleReference;
  readonly wiki?: WikiReference;
  readonly summary?: string;
  readonly savedSources?: readonly SavedRuleEvidence[];
  readonly explanation?: {
    readonly label: string; readonly formula: string; readonly value: unknown; readonly unit?: string;
    readonly minimum?: number; readonly maximum?: number;
    readonly terms: readonly { readonly label: string; readonly value: unknown; readonly source?: RuleReference; readonly status?: string; readonly grantId?: string }[];
    readonly sources: readonly RuleReference[];
  };
}
const rootKeys = new Set(["label", "reference", "wiki", "summary", "explanation", "savedSources"]);
const referenceKeys = new Set(["kind", "id"]);
const explanationKeys = new Set(["label", "formula", "value", "unit", "minimum", "maximum", "terms", "sources"]);
const termKeys = new Set(["label", "value", "source", "status", "grantId"]);
const evidenceKeys = new Set(["reference", "name", "summary", "hash"]);
const boundedText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
const optionalText = (value: unknown, limit: number): boolean => value === undefined || boundedText(value, limit);
const reference = (value: unknown): boolean => isRecord(value) && hasOnlyKeys(value, referenceKeys) && boundedText(value["kind"], 80) && !!value["kind"] && boundedText(value["id"], 300) && !!value["id"];

export function parseRuleDetails(value: unknown): RuleDetails {
  const fail = (): never => { throw new BoundaryValidationError("rule details", "Expected bounded rule details with a label and valid references."); };
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return fail(); }
  if (!encoded || new TextEncoder().encode(encoded).length > 60000 || !isRecord(value) || !hasOnlyKeys(value, rootKeys) || !boundedText(value["label"], 300) || !value["label"]) return fail();
  if (value["reference"] !== undefined && !reference(value["reference"])) return fail();
  if (!optionalText(value["summary"], 5000)) return fail();
  const wiki = value["wiki"];
  if (wiki !== undefined && (!isRecord(wiki) || !(hasOnlyKeys(wiki, new Set(["path"])) && boundedText(wiki["path"], 2000) || hasOnlyKeys(wiki, new Set(["label", "hint"])) && boundedText(wiki["label"], 300) && boundedText(wiki["hint"], 300)))) return fail();
  const evidence = value["savedSources"];
  if (evidence !== undefined && (!Array.isArray(evidence) || evidence.length > 100 || !evidence.every(entry => isRecord(entry) && hasOnlyKeys(entry, evidenceKeys) && reference(entry["reference"]) && boundedText(entry["name"], 300) && boundedText(entry["summary"], 1000) && boundedText(entry["hash"], 64) && /^[a-f0-9]{64}$/u.test(entry["hash"])))) return fail();
  const explanation = value["explanation"];
  if (explanation !== undefined) {
    if (!isRecord(explanation) || !hasOnlyKeys(explanation, explanationKeys) || !boundedText(explanation["label"], 300) || !boundedText(explanation["formula"], 5000) || !optionalText(explanation["unit"], 80)) return fail();
    for (const key of ["minimum", "maximum"]) if (explanation[key] !== undefined && (typeof explanation[key] !== "number" || !Number.isFinite(explanation[key]))) return fail();
    if (!Array.isArray(explanation["sources"]) || !explanation["sources"].every(reference) || !Array.isArray(explanation["terms"]) || !explanation["terms"].every(term => isRecord(term) && hasOnlyKeys(term, termKeys) && boundedText(term["label"], 1000) && optionalText(term["status"], 80) && optionalText(term["grantId"], 300) && (term["source"] === undefined || reference(term["source"])))) return fail();
  }
  return JSON.parse(encoded) as RuleDetails;
}

export const showRuleDetailsEvent = "codex-show-rule-details";
export function showRuleDetails(details: RuleDetails, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("The add-on generation is no longer active.", "AbortError");
  const parsed = parseRuleDetails(details);
  return new Promise((closed, reject) => {
    const event = new CustomEvent(showRuleDetailsEvent, { cancelable: true, detail: { details: parsed, signal, closed } });
    if (document.dispatchEvent(event)) reject(new Error("The rules details surface is unavailable."));
  });
}
