import { html, nothing, type TemplateResult } from "lit";
import type { CampaignEnumCategory } from "../core/campaign-mutations.js";
import { attitudeRing } from "./campaign-attitude-glow.js";
import { bundledMarkerIcon } from "./campaign-map.js";
import { cssHexColor } from "./campaign-projection.js";
import { uiText } from "./ui-localization.js";

type Values = Readonly<Record<string, unknown>>;

/**
 * A definition's mark as the campaign draws it: a relationship's line, a
 * status's symbol, a priority's flag, an attitude's glow or a map marker.
 * Genders have no look of their own, so they have no mark.
 */
export function definitionMark(
  category: CampaignEnumCategory,
  id: string,
  values: Values,
): TemplateResult | undefined {
  const color = definitionColor(category, values);
  switch (category) {
    case "relationshipTypes":
      return html`<span class="definition-line" aria-hidden="true"
        style=${`--definition-color: ${color ?? "currentColor"}; --line-style: ${lineStyle(values)}`}></span>`;
    case "characterStatuses":
      return html`<span class="definition-symbol" aria-hidden="true"
        style=${color ? `--definition-color: ${color}` : nothing}>${text(values["icon"]) || "?"}</span>`;
    case "eventPriorities":
      return html`<span class="definition-flag" aria-hidden="true"
        style=${color ? `--definition-color: ${color}` : nothing}>⚑</span>`;
    case "attitudes":
      return html`<span class="definition-glow" aria-hidden="true"
        style=${glow(color, values) ?? nothing}></span>`;
    case "pinTypes": {
      const icon = bundledMarkerIcon(text(values["defaultIconId"]) || id);
      const size = markerSize(values);
      return icon === undefined
        ? html`<span class="definition-marker" aria-hidden="true">📍</span>`
        : html`<img class="definition-marker" src=${icon} alt="" width=${size} height=${size} />`;
    }
    case "genders":
      return undefined;
  }
}

/**
 * The whole sample the definition editor shows beside its fields: the mark
 * with the label in the same chip, badge or line the campaign's pages use.
 */
export function definitionPreview(
  category: CampaignEnumCategory,
  id: string,
  values: Values,
): TemplateResult | typeof nothing {
  const label = text(values["label"]).trim() || id || "—";
  const color = definitionColor(category, values);
  const mark = definitionMark(category, id, values);
  switch (category) {
    case "relationshipTypes": {
      const target = text(values["target"]) === "location" ? "Location" : "Character";
      return html`<span class="definition-relationship"
          style=${`--definition-color: ${color ?? "currentColor"}; --line-style: ${lineStyle(values)}`}>
          <span>${uiText("Character")}</span><i>${label}</i><span>${uiText(target)}</span>
        </span>`;
    }
    case "characterStatuses":
      return html`${mark}<span class="record-status" style=${color ? `--status-color: ${color}` : nothing}>${label}</span>`;
    case "eventPriorities":
      return html`<span class="definition-flag" style=${color ? `--definition-color: ${color}` : nothing}>⚑ ${label}</span>`;
    case "attitudes":
      return html`<span class="definition-portrait" aria-hidden="true" style=${glow(color, values) ?? nothing}>${label[0]?.toLocaleUpperCase()}</span>
        <span class="record-badges"><span class="attitude-badge" style=${color ? `--attitude-color: ${color}` : nothing}>${label}</span></span>`;
    case "pinTypes":
      return html`<span class="definition-map-marker">${mark}<span>${label}</span></span>`;
    case "genders":
      return nothing;
  }
}

function definitionColor(category: CampaignEnumCategory, values: Values): string | undefined {
  return category === "attitudes"
    ? cssHexColor(values["labelColor"] ?? values["bg"])
    : cssHexColor(values["color"]);
}

function lineStyle(values: Values): string {
  const style = text(values["style"]);
  return style === "dashed" || style === "dotted" ? style : "solid";
}

function glow(color: string | undefined, values: Values): string | undefined {
  if (color === undefined) return undefined;
  const strength = numberValue(values["strength"]);
  const ring = attitudeRing([
    { color, strength: strength === undefined ? 1 : Math.min(1, Math.max(0, strength)) },
  ]);
  return `--definition-color: ${color}${ring ? `; box-shadow: ${ring}` : ""}`;
}

/** The marker's size as the map draws it. */
function markerSize(values: Values): number {
  const size = numberValue(values["size"]) ?? 28;
  return Math.min(64, Math.max(14, size));
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
