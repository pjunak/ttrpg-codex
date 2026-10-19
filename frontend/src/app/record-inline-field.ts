import { html } from "lit";
import type {
  CampaignCollectionName,
  CampaignDataset,
  CampaignRecord,
} from "../core/campaign-data.js";
import { articleReferences } from "./article-context.js";
import { renderArticleReferences } from "./article-context-view.js";
import {
  editorOptionsFor,
  sameCampaignValue,
  type CampaignEditorField,
} from "./campaign-record-editor.js";
import { recordValue, stringList } from "./campaign-projection.js";
import { saveCampaign, type CampaignWriteResult } from "./campaign-writes.js";
import type { InlineControl, InlineInput } from "./codex-inline-field.js";
import type { InlineDraftController } from "./inline-draft.js";
import "./codex-inline-field.js";

/** Field kinds that edit comfortably in one line on a record page. */
export const inlineFieldKinds: ReadonlySet<CampaignEditorField["kind"]> = new Set([
  "line",
  "number",
  "enum",
  "reference",
  "references",
  "attitudes",
  "tags",
]);

/** One field's new value over the record it was edited from. */
export interface RecordFieldPatch {
  readonly base: CampaignRecord;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface RecordInlineField {
  /** The element that sends the save; usually the page that renders the field. */
  readonly owner: Element;
  readonly drafts: InlineDraftController;
  readonly campaign: CampaignDataset;
  readonly collection: CampaignCollectionName;
  readonly record: CampaignRecord;
  readonly field: CampaignEditorField;
  readonly canEdit: boolean;
  readonly label?: string;
  /** Whether a set reference reads as links beside a pencil; true by default. */
  readonly links?: boolean;
  /** Edits the text as a paragraph that saves after a pause. */
  readonly paragraph?: boolean;
  /** The record as currently saved, for a draft kept after a conflict. */
  latest(): CampaignRecord | undefined;
  /** Sends the patch; a record-patch write from `owner` by default. */
  readonly send?: (patch: RecordFieldPatch) => Promise<CampaignWriteResult>;
}

/**
 * One record field edited in place, saved as a patch of that field over the
 * record as it was when editing began. Text saves on Enter, ✓ or leaving the
 * field; choices save when picked. The draft is keyed by the field, so owners
 * discard their drafts when the shown record changes.
 */
export function recordInlineField(options: RecordInlineField) {
  const { owner, drafts, campaign, collection, record, field } = options;
  const key = field.key;
  const multi = field.kind === "references" || field.kind === "attitudes";
  const choice = field.kind === "enum" || field.kind === "reference";
  const choices = choice || multi ? editorOptionsFor(campaign, field, record.key) : [];
  const value = inputValue(field, record);
  const reference =
    field.kind === "reference" || field.kind === "references"
      ? field.referenceCollection
      : undefined;
  // A linked value reads as its links, with a separate pencil to edit it.
  const display =
    reference !== undefined && value.length > 0 && options.links !== false
      ? renderArticleReferences(
          articleReferences(campaign, reference, recordValue(record)[field.key]),
        )
      : undefined;
  const control: InlineControl = multi
    ? { kind: "multi", options: choices }
    : choice
      ? { kind: "choice", options: choices }
      : {
          kind: "text",
          type: field.kind === "number" ? "number" : "text",
          ...(options.paragraph ? { multiline: true } : {}),
          ...(field.kind === "tags" ? {} : { maxLength: field.maximumLength }),
          ...(field.minimum === undefined ? {} : { min: field.minimum }),
          ...(field.maximum === undefined ? {} : { max: field.maximum }),
          ...(field.required ? { required: true } : {}),
        };
  const send =
    options.send ??
    ((patch: RecordFieldPatch) => saveCampaign(owner, "record-patch", { collection, ...patch }));
  return html`<codex-inline-field .name=${key} .label=${options.label ?? field.label}
    .value=${value} .control=${control} .commit=${options.paragraph ? "pause" : "blur"}
    .canEdit=${options.canEdit}
    .display=${display} ?linked=${display !== undefined} .draft=${drafts.get(key)}
    .begin=${() =>
      drafts.open(key, () => ({
        value,
        base: record,
        same: (left: unknown, right: unknown) =>
          sameCampaignValue(
            saveValue(field, left as InlineInput),
            saveValue(field, right as InlineInput),
          ),
        current: () => {
          const latest = options.latest() ?? record;
          return { base: latest, value: inputValue(field, latest) };
        },
        save: (draft: unknown, base: unknown) =>
          send({
            base: base as CampaignRecord,
            fields: { [field.key]: saveValue(field, draft as InlineInput) },
          }),
        ...(field.required ? { required: true } : {}),
      }))}></codex-inline-field>`;
}

/** A stored value as the field's control shows it. */
function inputValue(field: CampaignEditorField, record: CampaignRecord): InlineInput {
  const value = recordValue(record)[field.key];
  if (field.kind === "references") return stringList(value);
  // Attitudes are stored as objects; edits send their IDs.
  if (field.kind === "attitudes")
    return Array.isArray(value)
      ? value.flatMap((item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { id?: unknown }).id === "string"
            ? [(item as { id: string }).id]
            : [],
        )
      : [];
  if (field.kind === "tags") return stringList(value).join(", ");
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** The control's value as the record patch sends it. */
function saveValue(field: CampaignEditorField, input: InlineInput): unknown {
  if (typeof input !== "string") return [...input];
  if (field.kind === "tags")
    return input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return field.kind === "line" ? input.trim() : input;
}
