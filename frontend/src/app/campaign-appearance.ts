import { isRecord } from "../core/boundary.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
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

  constructor(
    message: string,
    readonly kind: "invalid" | "stale" = "invalid",
  ) {
    super(message);
  }
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

/** The cached site default, so startup and the sign-in page avoid a flash. */
const siteStorageKey = "codex_theme";
/** This browser's own theme; absent while it follows the site. */
const personalStorageKey = "codex_personal_theme";
const themeChangeTarget = new EventTarget();
let personalThemeValue = readTheme(personalStorageKey);
let siteThemeValue = readTheme(siteStorageKey) ?? "classic";
let activeThemeValue = resolveActiveTheme();

export function campaignAppearanceRecord(campaign: CampaignDataset): CampaignRecord | undefined {
  return campaignCollection(campaign, "settings").records.find(({ key }) => key === "appearance");
}

/** The campaign's site default theme. */
export function campaignTheme(campaign: CampaignDataset): CampaignThemeID {
  const value = campaignAppearanceRecord(campaign)?.value;
  return isRecord(value) && isCampaignThemeID(value["theme"]) ? value["theme"] : "classic";
}

export function prepareCampaignAppearanceSave(
  campaign: CampaignDataset,
  detail: CampaignAppearanceSaveDetail,
): CampaignMutation {
  const record = campaignAppearanceRecord(campaign);
  if (!Number.isSafeInteger(detail.expectedRevision) || !isCampaignThemeID(detail.theme))
    throw invalidAppearance();
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

/** Shows this browser's theme before the campaign loads. */
export function initializeCachedCampaignTheme(): void {
  applyThemeToDocument(activeThemeValue);
}

/** Makes the campaign's default the site theme this browser resolves against. */
export function applyCampaignTheme(campaign: CampaignDataset): void {
  applySiteTheme(campaignTheme(campaign));
}

export function applySiteTheme(theme: CampaignThemeID): void {
  if (!isCampaignThemeID(theme)) return;
  const changed = theme !== siteThemeValue;
  siteThemeValue = theme;
  writeStorage(siteStorageKey, theme);
  update(changed);
}

/** This browser's own theme, or undefined when it follows the site default. */
export function personalTheme(): CampaignThemeID | undefined {
  return personalThemeValue;
}

export function siteTheme(): CampaignThemeID {
  return siteThemeValue;
}

/** The theme this browser shows: its own choice, otherwise the site default. */
export function activeTheme(): CampaignThemeID {
  return activeThemeValue;
}

/** Chooses this browser's theme, or follows the site default when undefined. */
export function setPersonalTheme(theme: CampaignThemeID | undefined): void {
  if (theme !== undefined && !isCampaignThemeID(theme)) return;
  const changed = theme !== personalThemeValue;
  personalThemeValue = theme;
  if (theme === undefined) removeStorage(personalStorageKey);
  else writeStorage(personalStorageKey, theme);
  update(changed);
}

/**
 * Notifies `listener` after the personal choice, the site default or the
 * active theme changes; returns an unsubscribe function.
 */
export function onThemeChange(listener: () => void, signal?: AbortSignal): () => void {
  const handler = (): void => listener();
  themeChangeTarget.addEventListener("change", handler, signal ? { signal } : undefined);
  return () => themeChangeTarget.removeEventListener("change", handler);
}

export function isCampaignThemeID(value: unknown): value is CampaignThemeID {
  return value === "classic" || value === "moonlit";
}

function resolveActiveTheme(): CampaignThemeID {
  return personalThemeValue ?? siteThemeValue;
}

function update(changed: boolean): void {
  const next = resolveActiveTheme();
  if (next === activeThemeValue && !changed) return;
  activeThemeValue = next;
  applyThemeToDocument(next);
  themeChangeTarget.dispatchEvent(new Event("change"));
}

function applyThemeToDocument(theme: CampaignThemeID): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["theme"] = theme;
  const definition = campaignThemes.find(({ id }) => id === theme) ?? campaignThemes[0]!;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  meta?.setAttribute("content", definition.browserColor);
}

function invalidAppearance(): CampaignAppearanceEditError {
  return new CampaignAppearanceEditError("campaign appearance edit is invalid");
}

function readTheme(key: string): CampaignThemeID | undefined {
  const stored = readStorage(key);
  return isCampaignThemeID(stored) ? stored : undefined;
}

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    /* A blocked preference store must not break the campaign UI. */
  }
}

function removeStorage(key: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  } catch {
    /* A blocked preference store must not break the campaign UI. */
  }
}
