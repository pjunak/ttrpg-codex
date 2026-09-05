import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import defaultLogo from "../assets/logo-default.svg";

export { defaultLogo };
export interface CampaignBranding {
  readonly title: string;
  readonly subtitle: string;
  readonly logoUrl: string;
}
export interface BrandingSaveDetail extends CampaignBranding { readonly expectedRevision: number; readonly file?: File }
export class BrandingEditError extends Error {
  override readonly name = "BrandingEditError";
  constructor(readonly kind: "invalid" | "stale") { super(`branding is ${kind}`); }
}
export function brandingRecord(campaign: CampaignDataset) {
  return campaignCollection(campaign, "settings").records.find(({ key }) => key === "branding");
}
export function campaignBranding(campaign?: CampaignDataset): CampaignBranding {
  const raw = campaign === undefined ? undefined : brandingRecord(campaign)?.value;
  const value = isRecord(raw) ? raw : {};
  return { title: line(value["title"], 200) || "TTRPG Codex", subtitle: line(value["subtitle"], 300) || "Wiki & World Atlas",
    logoUrl: safeLogo(value["logoUrl"]) ? value["logoUrl"] : "" };
}
export function prepareBrandingSave(campaign: CampaignDataset, detail: BrandingSaveDetail): CampaignMutation {
  const current = brandingRecord(campaign);
  if (!Number.isSafeInteger(detail.expectedRevision) || detail.expectedRevision < 0 ||
    typeof detail.title !== "string" || typeof detail.subtitle !== "string" ||
    detail.title.trim().length > 200 || detail.subtitle.trim().length > 300 || /[\r\n]/u.test(detail.title + detail.subtitle) ||
    !(detail.logoUrl === "" || safeLogo(detail.logoUrl))) throw new BrandingEditError("invalid");
  if (detail.expectedRevision !== (current?.revision ?? 0)) throw new BrandingEditError("stale");
  const value = current === undefined ? {} : current.value;
  if (!isRecord(value)) throw new BrandingEditError("invalid");
  return { operation: "put", collection: "settings", key: "branding", expectedRevision: detail.expectedRevision,
    value: { ...value, title: detail.title.trim() || "TTRPG Codex", subtitle: detail.subtitle.trim() || "Wiki & World Atlas", logoUrl: detail.logoUrl } };
}
export function applyBrandingFavicon(branding: CampaignBranding): void {
  document.title = branding.title;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) { link = document.createElement("link"); link.rel = "icon"; document.head.append(link); }
  link.removeAttribute("type"); link.href = branding.logoUrl || defaultLogo;
}
function safeLogo(value: unknown): value is string { return typeof value === "string" && /^\/api\/media\/b_[0-9a-f]{32}$/u.test(value); }
function line(value: unknown, maximum: number): string { return typeof value === "string" && value.length <= maximum && !/[\r\n]/u.test(value) ? value.trim() : ""; }
