import { html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import { formText, formTextValues } from "../core/forms.js";
import { editorOptionsFor, type CampaignEditorField } from "./campaign-record-editor.js";
import { text } from "./campaign-projection.js";
import { uiText } from "./ui-localization.js";

/** A control's value in the shape its form data submits. */
export type FieldFormValue = string | readonly string[] | boolean;

/**
 * What a field's control shows for a stored value. An untouched control
 * submits exactly this, so an edit can tell which fields actually changed.
 */
export function fieldFormValue(
  campaign: CampaignDataset,
  field: CampaignEditorField,
  value: Readonly<Record<string, unknown>>,
  currentKey: string,
): FieldFormValue {
  switch (field.kind) {
    case "string-list":
      return editorStringList(value[field.key]).join("\n");
    case "tags":
      return editorStringList(value[field.key]).join(", ");
    case "owner":
      return ownerValue(value);
    case "reference":
    case "enum": {
      const stored = editorValue(value[field.key]);
      return currentKey === "" && field.key === "faction" && stored === "" ? "neutral" : stored;
    }
    case "references":
    case "attitudes": {
      const selected = new Set(
        field.kind === "attitudes"
          ? editorAttitudes(value[field.key])
          : editorStringList(value[field.key]),
      );
      return editorOptionsFor(campaign, field, currentKey)
        .filter((option) => selected.has(option.value))
        .map((option) => option.value);
    }
    case "boolean":
      return value[field.key] === true;
    case "line":
    case "text":
    case "markdown":
    case "number":
      return editorValue(value[field.key]);
    // Structured fields have their own editors (see initialStructuredDraft).
    case "questions":
    case "rank-assignment":
    case "rank-chains":
    case "location-roles":
      return "";
  }
}

/** What a field's control submitted, or undefined when it submitted nothing. */
export function submittedFieldFormValue(
  data: FormData,
  field: CampaignEditorField,
): FieldFormValue | undefined {
  if (field.kind === "references" || field.kind === "attitudes")
    return formTextValues(data, field.key);
  if (field.kind === "boolean") return data.has(field.key);
  // A disabled or missing control submits nothing.
  return data.has(field.key) ? formText(data, field.key) : undefined;
}

export function sameFieldFormValue(left: FieldFormValue, right: FieldFormValue): boolean {
  if (typeof left === "string" && typeof right === "string")
    return left.replaceAll("\r\n", "\n") === right.replaceAll("\r\n", "\n");
  if (typeof left === "object" && typeof right === "object")
    return left.length === right.length && left.every((item, index) => item === right[index]);
  return left === right;
}

/** The field value a save sends for a submitted control value. */
export function formFieldValue(field: CampaignEditorField, submitted: FieldFormValue): unknown {
  if (typeof submitted !== "string") return submitted;
  if (field.kind === "tags") return submitted.split(",");
  if (field.kind === "string-list") return submitted.split(/\r?\n/u);
  return field.kind === "line" ? submitted.trim() : submitted;
}

export function recordFieldControl(
  campaign: CampaignDataset,
  field: CampaignEditorField,
  value: Readonly<Record<string, unknown>>,
  currentKey: string,
  onFactionChange?: (event: Event) => void,
) {
  const shown = fieldFormValue(campaign, field, value, currentKey);
  const shownText = typeof shown === "string" ? shown : "";
  const wide = ["text", "string-list", "references", "attitudes"].includes(field.kind);
  const help =
    field.help === undefined
      ? nothing
      : html`<small data-ui-help class="field-help">${field.help}</small>`;
  if (field.kind === "text" || field.kind === "string-list") {
    return html`
        <label data-ui-field class=${wide ? "wide-field" : ""}>
          <span>${field.label}</span>
          <textarea
            name=${field.key}
            maxlength=${field.kind === "text" ? field.maximumLength : nothing}
            .value=${shownText}
            ?required=${field.required === true}
          ></textarea>
          ${help}
        </label>
      `;
  }
  if (field.kind === "reference" || field.kind === "owner" || field.kind === "enum") {
    const options = editorOptionsFor(campaign, field, currentKey);
    const selected = shownText;
    const orphaned = selected !== "" && !options.some(({ value: option }) => option === selected);
    return html`
        <label data-ui-field>
          <span>${field.label}</span>
          <select name=${field.key} @change=${field.key === "faction" ? onFactionChange : nothing}>
            ${
              field.kind === "reference" || field.kind === "enum"
                ? html`<option value="" ?selected=${selected === ""}>${uiText("Not set")}</option>`
                : nothing
            }
            ${orphaned ? html`<option value=${selected} selected>${uiText("{0} (not in the list)", { "0": selected })}</option>` : nothing}
            ${options.map(
              (option) => html`
              <option value=${option.value} ?selected=${option.value === selected}>${option.label}</option>
            `,
            )}
          </select>
          ${help}
        </label>
      `;
  }
  if (field.kind === "references" || field.kind === "attitudes") {
    const options = editorOptionsFor(campaign, field, currentKey);
    const selected = new Set(typeof shown === "object" ? shown : []);
    return html`
        <label data-ui-field class="wide-field structured-picker">
          <span>${field.label}</span>
          <select name=${field.key} multiple data-ui="chips">
            ${options.map(
              (option) => html`
              <option value=${option.value} ?selected=${selected.has(option.value)}>${option.label}</option>
            `,
            )}
          </select>
          ${help}
        </label>
      `;
  }
  if (field.kind === "boolean") {
    return html`
        <label data-ui-field class="boolean-field">
          <input name=${field.key} type="checkbox" .checked=${shown === true} />
          <span>${field.label}</span>
          ${help}
        </label>
      `;
  }
  return html`
      <label data-ui-field>
        <span>${field.label}</span>
        <input
          name=${field.key}
          type=${field.kind === "number" ? "number" : "text"}
          step=${field.kind === "number" ? "any" : nothing}
          min=${field.minimum ?? nothing}
          max=${field.maximum ?? nothing}
          maxlength=${field.kind === "number" ? nothing : field.maximumLength}
          .value=${shownText}
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
