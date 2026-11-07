import { cssHexColor, safeMediaURL } from "./campaign-projection.js";
import { campaignPages, recordHref } from "./routes.js";
import { isRecord } from "../core/boundary.js";
import { uiText } from "./ui-localization.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";

export interface CampaignPartyIdentity {
  readonly name: string;
  readonly icon: string;
  readonly badge: string;
  readonly color: string;
}

export interface CampaignPartySaveDetail {
  readonly expectedRevision: number;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
}

export class CampaignPartyEditError extends Error {
  override readonly name = "CampaignPartyEditError";
  constructor(readonly kind: "invalid" | "stale") {
    super(`party settings are ${kind}`);
  }
}

const defaults: CampaignPartyIdentity = Object.freeze({
  get name() {
    return uiText("Our Party");
  },
  icon: "🛡",
  badge: "🛡",
  color: "#f5f0e4",
});

export function campaignPartyRecord(campaign: CampaignDataset): CampaignRecord | undefined {
  return campaignCollection(campaign, "settings").records.find(({ key }) => key === "playerParty");
}

export function campaignPartyIdentity(campaign: CampaignDataset): CampaignPartyIdentity {
  const raw = campaignPartyRecord(campaign)?.value;
  const value = isRecord(raw) ? raw : {};
  const icon = boundedLine(value["icon"], 100) || defaults.icon;
  return Object.freeze({
    name: boundedLine(value["name"], 200) || defaults.name,
    icon,
    badge: boundedLine(value["badge"], 100) || icon,
    color: hexColor(value["color"]) ?? defaults.color,
  });
}

/** How a character's faction shows on its chip: the party or a faction record. */
export interface CampaignFactionIdentity {
  readonly name: string;
  readonly icon: string;
  /** A hex colour, or undefined for the theme's default. */
  readonly color: string | undefined;
  readonly picture: string | undefined;
  readonly href: string | undefined;
}

/** The faction a character's `faction` value names; none for "No faction" or a missing one. */
export function campaignFactionIdentity(
  campaign: CampaignDataset,
  factionId: unknown,
): CampaignFactionIdentity | undefined {
  if (factionId === "party") {
    const party = campaignPartyIdentity(campaign);
    return Object.freeze({
      name: party.name,
      icon: party.badge,
      color: party.color,
      picture: undefined,
      href: "/party",
    });
  }
  if (typeof factionId !== "string" || factionId === "" || factionId === "neutral")
    return undefined;
  const record = campaignCollection(campaign, "factions").records.find(
    ({ key }) => key === factionId,
  );
  if (record === undefined || !isRecord(record.value)) return undefined;
  const value = record.value;
  return Object.freeze({
    name: boundedLine(value["name"], 200) || record.key,
    icon: boundedLine(value["badge"], 100) || "⚑",
    color: hexColor(value["color"]),
    picture: safeMediaURL(value["portrait"]),
    href: recordHref(
      campaignPages.find(({ collection }) => collection === "factions")!,
      record.key,
    ),
  });
}

export function prepareCampaignPartySave(
  campaign: CampaignDataset,
  detail: CampaignPartySaveDetail,
): CampaignMutation {
  const record = campaignPartyRecord(campaign);
  if (
    !Number.isSafeInteger(detail.expectedRevision) ||
    detail.expectedRevision < 0 ||
    typeof detail.name !== "string" ||
    typeof detail.icon !== "string" ||
    detail.name.trim().length > 200 ||
    detail.icon.trim().length > 100 ||
    /[\r\n]/u.test(detail.name + detail.icon) ||
    !hexColor(detail.color)
  ) {
    throw new CampaignPartyEditError("invalid");
  }
  if (detail.expectedRevision !== (record?.revision ?? 0))
    throw new CampaignPartyEditError("stale");
  const current = record === undefined ? {} : record.value;
  if (!isRecord(current)) throw new CampaignPartyEditError("invalid");
  const icon = detail.icon.trim() || defaults.icon;
  return Object.freeze({
    operation: "put",
    collection: "settings",
    key: "playerParty",
    expectedRevision: detail.expectedRevision,
    value: Object.freeze({
      ...current,
      name: detail.name.trim() || defaults.name,
      icon,
      badge: icon,
      color: hexColor(detail.color)!,
    }),
  });
}

function boundedLine(value: unknown, limit: number): string {
  return typeof value === "string" && value.trim().length <= limit && !/[\r\n]/u.test(value)
    ? value.trim()
    : "";
}

function hexColor(value: unknown): string | undefined {
  if (cssHexColor(value) === undefined || typeof value !== "string") return undefined;
  return (
    value.length === 4
      ? `#${value
          .slice(1)
          .split("")
          .map((character) => character.repeat(2))
          .join("")}`
      : value
  ).toLowerCase();
}
