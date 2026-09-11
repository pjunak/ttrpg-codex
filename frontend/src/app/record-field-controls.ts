import { html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import { editorOptionsFor, type CampaignEditorField } from "./campaign-record-editor.js";
import { text } from "./campaign-projection.js";
import { uiText } from "./ui-localization.js";

export function recordFieldControl(campaign: CampaignDataset, field: CampaignEditorField, value: Readonly<Record<string, unknown>>, currentKey: string, onFactionChange?: (event: Event) => void) {
    const wide = ["text", "string-list", "references", "attitudes"].includes(field.kind);
    const help = field.help === undefined ? nothing : html`<small class="field-help">${field.help}</small>`;
    if (field.kind === "text" || field.kind === "string-list") {
      return html`
        <label class=${wide ? "wide-field" : ""}>
          <span>${field.label}</span>
          <textarea
            name=${field.key}
            maxlength=${field.kind === "text" ? field.maximumLength : nothing}
            .value=${field.kind === "string-list"
              ? editorStringList(value[field.key]).join("\n")
              : editorValue(value[field.key])}
            ?required=${field.required === true}
          ></textarea>
          ${help}
        </label>
      `;
    }
    if (field.kind === "reference" || field.kind === "owner" || field.kind === "enum") {
      const options = editorOptionsFor(campaign, field, currentKey);
      const stored = field.kind === "owner" ? ownerValue(value) : editorValue(value[field.key]);
      const selected = currentKey === "" && field.key === "faction" && stored === "" ? "neutral" : stored;
      const orphaned = selected !== "" && !options.some(({ value: option }) => option === selected);
      return html`
        <label>
          <span>${field.label}</span>
          <select name=${field.key} @change=${field.key === "faction" ? onFactionChange : nothing}>
            ${field.kind === "reference" || field.kind === "enum"
              ? html`<option value="" ?selected=${selected === ""}>${uiText("Not set")}</option>` : nothing}
            ${orphaned ? html`<option value=${selected} selected>${uiText("{0} (stored)", { "0": selected })}</option>` : nothing}
            ${options.map((option) => html`
              <option value=${option.value} ?selected=${option.value === selected}>${option.label}</option>
            `)}
          </select>
          ${help}
        </label>
      `;
    }
    if (field.kind === "references" || field.kind === "attitudes") {
      const options = editorOptionsFor(campaign, field, currentKey);
      const selected = new Set(field.kind === "attitudes"
        ? editorAttitudes(value[field.key])
        : editorStringList(value[field.key]));
      return html`
        <label class="wide-field structured-picker">
          <span>${field.label}</span>
          <select name=${field.key} multiple size=${Math.min(8, Math.max(3, options.length))}>
            ${options.map((option) => html`
              <option value=${option.value} ?selected=${selected.has(option.value)}>${option.label}</option>
            `)}
          </select>
          ${field.help === undefined
            ? html`<small class="field-help">${uiText("Use Ctrl or Command to select more than one entry.")}</small>`
            : help}
        </label>
      `;
    }
    if (field.kind === "boolean") {
      return html`
        <label class="boolean-field">
          <input name=${field.key} type="checkbox" .checked=${value[field.key] === true} />
          <span>${field.label}</span>
          ${help}
        </label>
      `;
    }
    return html`
      <label>
        <span>${field.label}</span>
        <input
          name=${field.key}
          type=${field.kind === "number" ? "number" : "text"}
          step=${field.kind === "number" ? "any" : nothing}
          min=${field.minimum ?? nothing}
          max=${field.maximum ?? nothing}
          maxlength=${field.kind === "number" ? nothing : field.maximumLength}
          .value=${field.kind === "tags"
            ? editorStringList(value[field.key]).join(", ")
            : editorValue(value[field.key])}
          placeholder=${field.placeholder ?? ""}
          ?required=${field.required === true}
        />
        ${help}
      </label>
    `;
}

export function editorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function editorStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === "string")
    : [];
}

function editorAttitudes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
    const id = (candidate as Readonly<Record<string, unknown>>)["id"];
    return typeof id === "string" && id.trim() !== "" ? [id] : [];
  });
}

function ownerValue(value: Readonly<Record<string, unknown>>): string {
  const ownerType = text(value["ownerType"]);
  const ownerID = text(value["ownerId"]);
  if (ownerType === "character" || ownerType === "faction") return `${ownerType}:${ownerID}`;
  if (ownerType === "party") return "party:";
  return "none:";
}
