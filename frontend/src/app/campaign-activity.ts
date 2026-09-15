import { characterKnowledge } from "./character-reading.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import { recordActivity } from "../core/campaign-activity.js";
import { editorFieldsFor, editorOptionsFor } from "./campaign-record-editor.js";
import { text, type EntitySummary } from "./campaign-projection.js";
import { campaignPages } from "./routes.js";
import { uiText } from "./ui-localization.js";

/** Resolve only current authorized values; never interpolate saved historical text. */
export function describeActivity(campaign: CampaignDataset, entity: EntitySummary): string {
  if (entity.route.startsWith("#/characters/") && characterKnowledge(entity.raw) < 2) return uiText("activity.updated");
  const change = recordActivity(entity.raw);
  if (!change) return uiText("activity.updated");
  if (change.kind === "created") return uiText("activity.created");
  const page = campaignPages.find(page => entity.route.startsWith(`#/${page.id}/`));
  const definitions = page ? editorFieldsFor(page.collection) : [];
  const messages = definitions.filter(field => change.fields.includes(field.key)).map(field => {
    const value = entity.raw[field.key];
    if (["markdown", "text", "references", "attitudes", "tags", "string-list", "questions", "location-roles", "rank-chains", "rank-assignment", "owner"].includes(field.kind)) {
      return uiText("activity.fieldUpdated", { field: field.label });
    }
    if (value === undefined) return uiText("activity.fieldUpdated", { field: field.label });
    if (value === null || value === "") return uiText("activity.cleared", { field: field.label });
    const label = field.kind === "reference" || field.kind === "enum"
      ? editorOptionsFor(campaign, field, entity.key).find(option => option.value === value)?.label
      : field.kind === "boolean" ? uiText(value === true ? "Yes" : "No") : typeof value === "number" ? String(value) : text(value);
    return label ? uiText("activity.value", { field: field.label, value: label.replace(/\s+/gu, " ").slice(0, 100) }) : uiText("activity.fieldUpdated", { field: field.label });
  });
  if (change.fields.includes("relationships")) messages.push(uiText("activity.relationships"));
  if (change.fields.some(field => ["x", "y", "mapX", "mapY", "mapParentId"].includes(field))) messages.push(uiText("activity.position"));
  if (change.fields.includes("visibility")) messages.push(uiText("activity.visibility"));
  const unique = [...new Set(messages)];
  return unique.length ? unique.slice(0, 2).join(" · ") + (unique.length > 2 ? uiText("activity.more", { count: unique.length - 2 }) : "") : uiText("activity.updated");
}
