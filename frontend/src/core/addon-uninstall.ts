import { BoundaryValidationError, isRecord } from "./boundary.js";

export interface AddonUninstallReview {
  addonId: string; name: string; version: string; reviewSha256: string;
  unlinksSource: boolean; rulesetName: string; generations: string[]; stopped: string[];
  effects: { addonId: string; name: string; disabled: boolean; reasons: string[] }[];
  retainedData: { kind: string; id: string; documents: number }[];
}
const fail = (): never => { throw new BoundaryValidationError("Add-on uninstall", "invalid server response"); };
const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail();
const text = (value: unknown): string => typeof value === "string" ? value : fail();
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();
const id = (value: unknown): string => { const result = text(value); return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(result) && result.length <= 80 ? result : fail(); };
const hash = (value: unknown): string => { const result = text(value); return /^[a-f0-9]{64}$/u.test(result) ? result : fail(); };

export function parseAddonUninstallReview(value: unknown, addonId: string): AddonUninstallReview {
  const record = object(value);
  if (record["contractVersion"] !== "addon-uninstall-review.v1" || record["addonId"] !== addonId) fail();
  return { addonId: id(record["addonId"]), name: text(record["name"]), version: text(record["version"]), reviewSha256: hash(record["reviewSha256"]),
    unlinksSource: bool(record["unlinksSource"]), rulesetName: text(record["rulesetName"]), generations: list(record["generations"]).map(hash),
    stopped: list(record["stoppedAddonIds"]).map(id), effects: list(record["effects"]).map(value => {
      const effect = object(value); return { addonId: id(effect["addonId"]), name: text(effect["name"]), disabled: bool(effect["disabled"]), reasons: list(effect["reasons"]).map(text) };
    }), retainedData: list(record["retainedData"]).map(value => {
      const data = object(value), count = data["documents"];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !["collection", "record-extension"].includes(text(data["kind"]))) fail();
      return { kind: text(data["kind"]), id: text(data["id"]), documents: count as number };
    }) };
}
