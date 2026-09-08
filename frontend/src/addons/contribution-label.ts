import { isRecord } from "../core/boundary.js";
import type { BrowserContributionDescriptor } from "./generation-manager.js";

export function validContributionLabels(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([locale, label]) =>
    (locale === "en" || locale === "cs") && typeof label === "string" &&
    label.trim() !== "" && [...label].length <= 200 && !/\p{Cc}/u.test(label));
}

/** Optional reviewed display metadata. IDs and route identities never depend on locale. */
export function contributionLabel(descriptor: Pick<BrowserContributionDescriptor, "label" | "config">, locale: unknown = "en"): string {
  const labels = descriptor.config["labels"], key = locale === "cs" ? "cs" : "en";
  if (!isRecord(labels) || !Object.hasOwn(labels, key)) return descriptor.label;
  const label = labels[key];
  return typeof label === "string" && label.trim() !== "" && [...label].length <= 200 && !/\p{Cc}/u.test(label)
    ? label : descriptor.label;
}
