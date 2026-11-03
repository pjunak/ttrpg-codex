import { html, nothing, type TemplateResult } from "lit";
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
  if (field.control === "color") return colorControl(field, shownText, help);
  if (field.control === "icon") return iconControl(field, shownText, help);
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

/** A colour as the picker takes it (#rrggbb), or undefined for anything else. */
function pickerColor(value: string): string | undefined {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(color)) return color;
  if (/^#[0-9a-f]{3}$/u.test(color)) return `#${color.slice(1).replaceAll(/./gu, (c) => c + c)}`;
  return undefined;
}

/**
 * A colour picker beside the colour's hex code. The code is the submitted
 * value, so an untouched field submits exactly what is stored, even when that
 * is empty or not a colour the picker can show.
 */
function colorControl(
  field: CampaignEditorField,
  shown: string,
  help: TemplateResult | typeof nothing,
) {
  const sync = (event: Event, fromPicker: boolean): void => {
    const row = (event.currentTarget as HTMLElement).closest(".color-field-row")!;
    const code = row.querySelector<HTMLInputElement>(".color-field-code")!;
    const picker = row.querySelector<HTMLInputElement>(".color-field-picker")!;
    if (fromPicker) {
      code.value = picker.value;
      code.dispatchEvent(new Event("input", { bubbles: true }));
    } else picker.value = pickerColor(code.value) ?? picker.value;
  };
  return html`<label data-ui-field class="color-field">
      <span>${field.label}</span>
      <span class="color-field-row">
        <input class="color-field-code" name=${field.key} maxlength=${field.maximumLength}
          .value=${shown} placeholder="#555555" spellcheck="false" autocomplete="off"
          @input=${(event: Event) => sync(event, false)} />
        <input class="color-field-picker" type="color" aria-label=${uiText("Pick a colour")}
          .value=${pickerColor(shown) ?? "#555555"} @input=${(event: Event) => sync(event, true)} />
      </span>
      ${help}
    </label>`;
}

/** Symbols that read well as a faction's mark; any other emoji or text can be typed. */
const iconChoices = Object.freeze([
  "🛡",
  "⚔",
  "🗡",
  "🏹",
  "👑",
  "🏰",
  "⚖",
  "🗝",
  "📜",
  "🕯",
  "🔥",
  "🌙",
  "☀",
  "⭐",
  "💀",
  "🐉",
  "🦅",
  "🐺",
  "🦁",
  "🐍",
  "🦉",
  "🌹",
  "🌲",
  "⚓",
  "💎",
  "🪙",
  "🎭",
  "⚒",
  "🔮",
  "⚜",
  "☠",
  "⚑",
]);

/** A short icon typed freely or chosen from a grid of common symbols. */
function iconControl(
  field: CampaignEditorField,
  shown: string,
  help: TemplateResult | typeof nothing,
) {
  const choose = (event: Event, icon: string): void => {
    const control = (event.currentTarget as HTMLElement).closest(".icon-field")!;
    const input = control.querySelector<HTMLInputElement>(".icon-field-input")!;
    input.value = icon;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    control.querySelector("details")?.removeAttribute("open");
    input.focus();
  };
  return html`<div data-ui-field class="icon-field">
      <label><span>${field.label}</span>
        <input class="icon-field-input" name=${field.key} maxlength=${field.maximumLength}
          .value=${shown} autocomplete="off" /></label>
      <details class="icon-field-choices">
        <summary>${uiText("Choose an icon")}</summary>
        <div class="icon-field-grid">${iconChoices.map(
          (
            icon,
          ) => html`<button type="button" class="icon-field-choice" aria-label=${uiText("Use {0}", { "0": icon })}
            @click=${(event: Event) => choose(event, icon)}>${icon}</button>`,
        )}</div>
      </details>
      ${help}
    </div>`;
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
