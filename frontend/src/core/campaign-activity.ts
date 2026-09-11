import { isRecord } from "./boundary.js";

export interface RecordActivity { readonly kind: "created" | "updated"; readonly fields: readonly string[]; readonly at: number }

export function recordActivity(value: Readonly<Record<string, unknown>>): RecordActivity | undefined {
  const envelope = value["lastChange"];
  const change = isRecord(envelope) && envelope["contractVersion"] === "activity.v1" ? envelope["change"] : undefined;
  if (!isRecord(change) || !["created", "updated"].includes(String(change["kind"])) ||
    typeof change["at"] !== "number" || !Number.isSafeInteger(change["at"]) || change["at"] <= 0 || change["at"] > 8_640_000_000_000_000 ||
    !Array.isArray(change["fields"]) || change["fields"].length > 24 || !change["fields"].every(key => typeof key === "string" && key.length <= 100)) return undefined;
  return { kind: change["kind"] as RecordActivity["kind"], fields: change["fields"] as string[], at: change["at"] };
}

export function activityTimestamp(value: Readonly<Record<string, unknown>>, fallback: string | undefined): string | undefined {
  const envelope = value["lastChange"];
  if (!isRecord(envelope) || envelope["contractVersion"] !== "activity.v1") return fallback;
  const activity = recordActivity(value);
  return activity ? new Date(activity.at).toISOString() : undefined;
}
