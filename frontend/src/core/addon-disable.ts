import { BoundaryValidationError, isRecord } from "./boundary.js";

export interface AddonDisableReview {
  addonId: string; name: string; version: string; reviewSha256: string;
  targets: { addonId: string; generationId: string; expectedStateRevision: number }[];
  stopped: string[]; restarted: string[];
  effects: { addonId: string; name: string; disabled: boolean; reasons: string[] }[];
}
const fail = (): never => { throw new BoundaryValidationError("Add-on disable", "invalid server response"); };
const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail();
const text = (value: unknown): string => typeof value === "string" ? value : fail();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();
const id = (value: unknown): string => { const result = text(value); return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(result) && result.length <= 80 ? result : fail(); };
const hash = (value: unknown): string => { const result = text(value); return /^[a-f0-9]{64}$/u.test(result) ? result : fail(); };
const revision = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
export function parseAddonDisableReview(value: unknown, addonId: string): AddonDisableReview {
  const r = object(value);
  if (r["contractVersion"] !== "addon-disable-review.v1" || r["addonId"] !== addonId) return fail();
  hash(r["graphRevision"]); revision(r["configurationRevision"]);
  const targets = list(r["targets"]).map(value => { const target = object(value);
    return { addonId: id(target["addonId"]), generationId: hash(target["generationId"]), expectedStateRevision: revision(target["expectedStateRevision"]) }; });
  if (!targets.some(target => target.addonId === addonId) || new Set(targets.map(target => target.addonId)).size !== targets.length) return fail();
  const stopped = list(r["stoppedAddonIds"]).map(id);
  const restarted = list(r["restartedAddonIds"]).map(id);
  const effects = list(r["effects"]).map(value => { const effect = object(value);
    if (typeof effect["disabled"] !== "boolean") return fail();
    return { addonId: id(effect["addonId"]), name: text(effect["name"]), disabled: effect["disabled"], reasons: list(effect["reasons"]).map(text) }; });
  if (new Set(restarted).size !== restarted.length || restarted.some(id => targets.some(target => target.addonId === id)) ||
      new Set(stopped).size !== stopped.length || new Set(effects.map(effect => effect.addonId)).size !== effects.length ||
      effects.some(effect => effect.addonId === addonId || effect.disabled !== targets.some(target => target.addonId === effect.addonId)) ||
      targets.some(target => target.addonId !== addonId && !effects.some(effect => effect.addonId === target.addonId && effect.disabled))) return fail();
  return { addonId: id(r["addonId"]), name: text(r["name"]), version: text(r["version"]), reviewSha256: hash(r["reviewSha256"]), targets, stopped, restarted, effects };
}
