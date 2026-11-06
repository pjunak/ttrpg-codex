import { isRecord } from "../core/boundary.js";
import { localeFallbacks } from "../core/message-catalog.js";
import type { BrowserContributionDescriptor } from "./generation-manager.js";

export function validContributionLabels(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([locale, label]) =>
        (locale === "en" || locale === "cs") &&
        typeof label === "string" &&
        label.trim() !== "" &&
        Array.from(label).length <= 200 &&
        !/\p{Cc}/u.test(label),
    )
  );
}

/** Translated manifest texts by add-on; the browser catalog store provides them. */
export interface ContributionTranslations {
  manifestText(addonId: string, key: string, locale: string): string | undefined;
}

/**
 * A contribution's display label: the add-on catalog's translation when
 * given, then the deprecated `config.labels`, then the English `label`. IDs
 * and route identities never depend on locale.
 */
export function contributionLabel(
  descriptor: Pick<BrowserContributionDescriptor, "label" | "config">,
  locale: unknown = "en",
  translated?: string,
): string {
  if (translated !== undefined) return translated;
  const labels = descriptor.config["labels"];
  if (!isRecord(labels)) return descriptor.label;
  const key =
    typeof locale === "string"
      ? localeFallbacks(locale).find((tag) => Object.hasOwn(labels, tag))
      : undefined;
  if (key === undefined) return descriptor.label;
  const label = labels[key];
  return typeof label === "string" &&
    label.trim() !== "" &&
    Array.from(label).length <= 200 &&
    !/\p{Cc}/u.test(label)
    ? label
    : descriptor.label;
}

/** A mounted contribution's label in `locale`, translated through its add-on's catalog. */
export function activeContributionLabel(
  active: {
    readonly addonId: string;
    readonly descriptor: Pick<BrowserContributionDescriptor, "id" | "label" | "config">;
  },
  locale: string,
  translations?: ContributionTranslations,
): string {
  return contributionLabel(
    active.descriptor,
    locale,
    translations?.manifestText(
      active.addonId,
      `manifest.contribution.${active.descriptor.id}.label`,
      locale,
    ),
  );
}
