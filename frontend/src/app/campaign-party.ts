import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";

export interface CampaignPartyIdentity {
  readonly name: string;
  readonly icon: string;
  readonly badge: string;
  readonly color: string;
  readonly textColor: string;
}

export interface CampaignPartySaveDetail {
  readonly expectedRevision: number;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly textColor: string;
}

export class CampaignPartyEditError extends Error {
  override readonly name = "CampaignPartyEditError";
  constructor(readonly kind: "invalid" | "stale") { super(`party settings are ${kind}`); }
}

const defaults: CampaignPartyIdentity = Object.freeze({
  name: "Our Party", icon: "🛡", badge: "🛡", color: "#f5f0e4", textColor: "#1a1410",
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
    textColor: hexColor(value["textColor"]) ?? defaults.textColor,
  });
}

export function prepareCampaignPartySave(campaign: CampaignDataset, detail: CampaignPartySaveDetail): CampaignMutation {
  const record = campaignPartyRecord(campaign);
  if (!Number.isSafeInteger(detail.expectedRevision) || detail.expectedRevision < 0 ||
    typeof detail.name !== "string" || typeof detail.icon !== "string" ||
    detail.name.trim().length > 200 || detail.icon.trim().length > 100 ||
    /[\r\n]/u.test(detail.name + detail.icon) || !hexColor(detail.color) || !hexColor(detail.textColor)) {
    throw new CampaignPartyEditError("invalid");
  }
  if (detail.expectedRevision !== (record?.revision ?? 0)) throw new CampaignPartyEditError("stale");
  const current = record === undefined ? {} : record.value;
  if (!isRecord(current)) throw new CampaignPartyEditError("invalid");
  const icon = detail.icon.trim() || defaults.icon;
  return Object.freeze({ operation: "put", collection: "settings", key: "playerParty",
    expectedRevision: detail.expectedRevision,
    value: Object.freeze({ ...current, name: detail.name.trim() || defaults.name,
      icon, badge: icon, color: hexColor(detail.color)!, textColor: hexColor(detail.textColor)! }),
  });
}

function boundedLine(value: unknown, limit: number): string {
  return typeof value === "string" && value.trim().length <= limit && !/[\r\n]/u.test(value) ? value.trim() : "";
}

function hexColor(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(value)) return undefined;
  return (value.length === 4 ? `#${[...value.slice(1)].map(character => character.repeat(2)).join("")}` : value).toLowerCase();
}
