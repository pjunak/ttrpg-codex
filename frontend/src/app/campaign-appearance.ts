import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import type { MessageKey } from "./ui-localization.js";

export type CampaignThemeID = "classic" | "moonlit";

export interface CampaignThemeDefinition {
  readonly id: CampaignThemeID;
  readonly labelKey: MessageKey;
  readonly hintKey: MessageKey;
  readonly browserColor: string;
}

export interface CampaignAppearanceSaveDetail {
  readonly expectedRevision: number;
  readonly theme: CampaignThemeID;
}

export class CampaignAppearanceEditError extends Error {
  override readonly name = "CampaignAppearanceEditError";

  constructor(message: string, readonly kind: "invalid" | "stale" = "invalid") { super(message); }
}

export const campaignThemes: readonly CampaignThemeDefinition[] = Object.freeze([
  Object.freeze({
    id: "classic",
    labelKey: "settings.appearanceClassic",
    hintKey: "settings.appearanceClassicHint",
    browserColor: "#1c1509",
  }),
  Object.freeze({
    id: "moonlit",
    labelKey: "settings.appearanceMoonlit",
    hintKey: "settings.appearanceMoonlitHint",
    browserColor: "#101c24",
  }),
]);

export function campaignAppearanceRecord(campaign: CampaignDataset): CampaignRecord | undefined {
  return campaignCollection(campaign, "settings").records.find(({ key }) => key === "appearance");
}

export function campaignTheme(campaign: CampaignDataset): CampaignThemeID {
  const value = campaignAppearanceRecord(campaign)?.value;
  return isRecord(value) && isCampaignThemeID(value["theme"]) ? value["theme"] : "classic";
}

export function prepareCampaignAppearanceSave(
  campaign: CampaignDataset,
  detail: CampaignAppearanceSaveDetail,
): CampaignMutation {
  const record = campaignAppearanceRecord(campaign);
  if (!Number.isSafeInteger(detail.expectedRevision) || !isCampaignThemeID(detail.theme)) throw invalidAppearance();
  if (detail.expectedRevision !== (record?.revision ?? 0)) {
    throw new CampaignAppearanceEditError("campaign appearance revision is stale", "stale");
  }
  const current = record === undefined ? {} : record.value;
  if (!isRecord(current)) throw invalidAppearance();
  return Object.freeze({
    operation: "put",
    collection: "settings",
    key: "appearance",
    expectedRevision: detail.expectedRevision,
    value: Object.freeze({ ...current, theme: detail.theme }),
  });
}

export function initializeCachedCampaignTheme(): void {
  const cached = readStorage("codex_theme");
  applyCampaignThemeID(isCampaignThemeID(cached) ? cached : "classic");
}

export function applyCampaignTheme(campaign: CampaignDataset): void {
  applyCampaignThemeID(campaignTheme(campaign));
}

export function applyCampaignThemeID(theme: CampaignThemeID): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["theme"] = theme;
  const definition = campaignThemes.find(({ id }) => id === theme) ?? campaignThemes[0]!;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  meta?.setAttribute("content", definition.browserColor);
  writeStorage("codex_theme", theme);
}

export function isCampaignThemeID(value: unknown): value is CampaignThemeID {
  return value === "classic" || value === "moonlit";
}

function invalidAppearance(): CampaignAppearanceEditError {
  return new CampaignAppearanceEditError("campaign appearance edit is invalid");
}

function readStorage(key: string): string | null {
  try { return typeof window === "undefined" ? null : window.localStorage.getItem(key); }
  catch { return null; }
}

function writeStorage(key: string, value: string): void {
  try { if (typeof window !== "undefined") window.localStorage.setItem(key, value); }
  catch { /* Cached appearance is optional; campaign data remains authoritative. */ }
}
