import { LitElement, html, nothing } from "lit";
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
  type CampaignCharacterSaveRequest,
  type CampaignCharacterSaveResult,
  type CampaignEditorField,
} from "./campaign-record-editor.js";
import { recordValue, stringList } from "./campaign-projection.js";
import { pencilIcon } from "./edit-icon.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { reportEditState } from "./unsaved-edit.js";

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

// One write at a time keeps optimistic revisions in order across fields.
let queue: Promise<unknown> = Promise.resolve();

/**
 * One record field edited in place: text and numbers confirm with Enter or ✓,
 * choices save on selection, and Escape or ✕ restores the saved value.
 */
export class CodexInlineField extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    record: { attribute: false },
    collection: { attribute: false },
    field: { attribute: false },
    label: { attribute: false },
    canEdit: { type: Boolean },
    editing: { state: true },
    pending: { state: true },
    error: { state: true },
  };
  declare campaign: CampaignDataset;
  declare record: CampaignRecord;
  declare collection: CampaignCollectionName;
  declare field: CampaignEditorField;
  declare label: string | undefined;
  declare canEdit: boolean;
  declare private editing: boolean;
  declare private pending: boolean;
  declare private error: string;
  #base: CampaignRecord | undefined;
  #draft = "";
  #list: readonly string[] = [];
  #conflict = false;
  #reportedDirty = false;

  constructor() {
    super();
    new UiLocalizationController(this);
    this.canEdit = false;
    this.editing = false;
    this.pending = false;
    this.error = "";
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const previous = changed.get("record") as CampaignRecord | undefined;
    if (
      (previous && previous.key !== this.record?.key) ||
      // A save turns the page read-only while it runs; the saving field stays
      // open so a rejection can show its message next to the kept draft.
      (changed.has("canEdit") && !this.canEdit && !this.pending)
    )
      this.#close();
  }
  get #name(): string {
    return this.label ?? this.field.label;
  }
  get #saved(): string {
    return fieldText(this.field, recordValue(this.record)[this.field.key]);
  }
  get #multi(): boolean {
    return this.field.kind === "references" || this.field.kind === "attitudes";
  }
  #savedList(record = this.record): readonly string[] {
    return fieldList(this.field, recordValue(record)[this.field.key]);
  }
  #listLabels(values: readonly string[]): string {
    const options = this.#options();
    return values
      .map((value) => options.find((option) => option.value === value)?.label ?? value)
      .join(", ");
  }
  protected override render() {
    if (!this.record || !this.field) return nothing;
    const saved = recordValue(this.record)[this.field.key];
    const reference =
      (this.field.kind === "reference" || this.field.kind === "references") &&
      this.field.referenceCollection;
    if (!this.editing && this.#multi && this.#savedList().length) {
      const content = reference
        ? renderArticleReferences(articleReferences(this.campaign, reference, this.#savedList()))
        : html`<span>${this.#listLabels(this.#savedList())}</span>`;
      if (!this.canEdit) return content;
      const edit = uiText("Edit {0}", { "0": this.#name });
      return html`${content}
        <button type="button" class="inline-edit-button" aria-label=${edit} title=${edit} @click=${this.#open}>${pencilIcon()}</button>`;
    }
    if (!this.editing) {
      const shown =
        reference || this.#multi
          ? undefined
          : this.field.kind === "enum"
            ? (this.#options().find((option) => option.value === this.#saved)?.label ?? this.#saved)
            : this.#saved;
      if (!this.canEdit)
        return reference
          ? renderArticleReferences(articleReferences(this.campaign, reference, saved))
          : html`<span>${shown || "—"}</span>`;
      const edit = uiText("Edit {0}", { "0": this.#name });
      if (reference && this.#saved)
        return html`${renderArticleReferences(articleReferences(this.campaign, reference, saved))}
          <button type="button" class="inline-edit-button" aria-label=${edit} title=${edit} @click=${this.#open}>${pencilIcon()}</button>`;
      return html`<button type="button" class=${`inline-field-value${shown ? "" : " is-empty"}`} aria-label=${edit} @click=${this.#open}>${
        shown || uiText("Add {0}", { "0": this.#name.toLocaleLowerCase() })
      }</button>`;
    }
    const choice = this.field.kind === "enum" || this.field.kind === "reference";
    const options = choice ? this.#options() : [];
    return html`<span class=${`inline-field-editor${this.pending ? " is-pending" : ""}`}
      @focusout=${this.#leave} @keydown=${this.#key}>
      <span class="inline-edit-row">${
        this.#multi
          ? html`<select aria-label=${this.#name} multiple data-ui="chips" ?disabled=${this.pending}
          @change=${(event: Event) => {
            this.#list = [...(event.target as HTMLSelectElement).selectedOptions].map(
              (option) => option.value,
            );
            this.error = "";
            this.#dirty(!sameCampaignValue(this.#list, this.#savedList()));
          }}>
          ${this.#list.filter((value) => !this.#options().some((option) => option.value === value)).map((value) => html`<option value=${value} selected>${value}</option>`)}
          ${this.#options().map((option) => html`<option value=${option.value} ?selected=${this.#list.includes(option.value)}>${option.label}</option>`)}</select>
          ${this.#actions()}`
          : choice
            ? html`<select aria-label=${this.#name} ?disabled=${this.pending} data-ui=${options.length >= 12 ? "combobox" : nothing}
          @change=${(event: Event) => {
            this.#draft = (event.target as HTMLSelectElement).value;
            void this.#save();
          }}>
          <option value="" ?selected=${this.#draft === ""}>${uiText("None")}</option>
          ${this.#draft && !options.some((option) => option.value === this.#draft) ? html`<option value=${this.#draft} selected>${this.#draft}</option>` : nothing}
          ${options.map((option) => html`<option value=${option.value} ?selected=${option.value === this.#draft}>${option.label}</option>`)}</select>`
            : html`<input aria-label=${this.#name} .value=${this.#draft} ?disabled=${this.pending}
          type=${this.field.kind === "number" ? "number" : "text"} min=${this.field.minimum ?? nothing} max=${this.field.maximum ?? nothing}
          maxlength=${this.field.kind === "tags" ? nothing : this.field.maximumLength} ?required=${this.field.required === true}
          title=${uiText("Enter to confirm · Esc to cancel")}
          @input=${(event: Event) => {
            this.#draft = (event.target as HTMLInputElement).value;
            this.error = "";
            this.#dirty(this.#draft !== this.#saved);
          }} />
          ${this.#actions()}`
      }</span>
      ${this.pending ? html`<small class="inline-edit-hint">${uiText("Saving…")}</small>` : nothing}
      ${
        this.error
          ? html`<span class="inline-edit-error" role="alert">${this.error}</span>
        ${this.#conflict ? html`<small class="inline-edit-hint">${uiText("Current saved value")}: ${(this.#multi ? this.#listLabels(this.#savedList()) : this.#saved) || "—"}</small>` : nothing}
        <span class="inline-edit-recovery">${this.#conflict ? nothing : html`<button type="button" @click=${() => this.#save()}>${uiText("Retry")}</button>`}
          <button type="button" @click=${this.#cancel}>${uiText("Use current value")}</button></span>`
          : nothing
      }
    </span>`;
  }
  #actions() {
    return html`<span class="inline-edit-actions">
      <button type="button" class="inline-edit-confirm" aria-label=${uiText("inlineEdit.save", { "0": this.#name })} title=${uiText("inlineEdit.save", { "0": this.#name })}
        ?disabled=${this.pending} @pointerdown=${(event: PointerEvent) => event.preventDefault()} @click=${() => this.#save()}>✓</button>
      <button type="button" class="inline-edit-cancel" aria-label=${uiText("inlineEdit.cancel", { "0": this.#name })} title=${uiText("inlineEdit.cancel", { "0": this.#name })}
        ?disabled=${this.pending} @pointerdown=${(event: PointerEvent) => event.preventDefault()} @click=${this.#cancel}>✕</button>
    </span>`;
  }
  #options() {
    return editorOptionsFor(this.campaign, this.field, this.record.key);
  }
  readonly #open = async (): Promise<void> => {
    this.#base = this.record;
    this.#draft = this.#saved;
    this.#list = this.#savedList();
    this.#conflict = false;
    this.error = "";
    this.editing = true;
    await this.updateComplete;
    // Searchable selects are enhanced by the page's shared controls after this render.
    if (this.querySelector('select[data-ui="combobox"], select[data-ui="chips"]'))
      await new Promise((resolve) => requestAnimationFrame(resolve));
    const control =
      this.querySelector<HTMLInputElement>(".ui-combobox input, .ui-chip-input") ??
      this.querySelector<HTMLInputElement | HTMLSelectElement>(".inline-edit-row input, select");
    control?.focus();
    if (control instanceof HTMLInputElement) control.select();
  };
  readonly #key = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      !event.defaultPrevented
    ) {
      if (event.target.closest(".ui-combobox")) return;
      event.preventDefault();
      void this.#save();
    } else if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      this.#cancel();
    }
  };
  readonly #leave = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Element && (this.contains(next) || next.closest(".ui-popup"))) return;
    if (!this.error && !this.pending) void this.#save();
  };
  readonly #cancel = (): void => {
    if (this.pending) return;
    const focused = this.contains(document.activeElement);
    this.#close();
    if (focused)
      void this.updateComplete.then(() =>
        this.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }),
      );
  };
  #close(): void {
    this.#dirty(false);
    this.editing = false;
    this.pending = false;
    this.error = "";
    this.#conflict = false;
    this.#base = undefined;
  }
  async #save(): Promise<void> {
    if (!this.editing || this.pending || this.#conflict || !this.#base) return;
    const value = this.#multi ? [...this.#list] : fieldValue(this.field, this.#draft);
    const before = this.#multi
      ? this.#savedList(this.#base)
      : fieldValue(this.field, fieldText(this.field, recordValue(this.#base)[this.field.key]));
    if (sameCampaignValue(value, before)) {
      this.#cancel();
      return;
    }
    if (this.field.required && this.#draft.trim() === "") {
      this.error = uiText("A name is required.");
      return;
    }
    this.pending = true;
    const base = this.#base;
    const result = await new Promise<CampaignCharacterSaveResult>((resolve) => {
      queue = queue.then(
        () =>
          new Promise<void>((done) => {
            const respond = (outcome: CampaignCharacterSaveResult) => {
              resolve(outcome);
              done();
            };
            const event = new CustomEvent<CampaignCharacterSaveRequest>("campaign-character-save", {
              detail: {
                collection: this.collection,
                base,
                fields: { [this.field.key]: value },
                respond,
              },
              bubbles: true,
              composed: true,
              cancelable: true,
            });
            if (!this.isConnected || this.dispatchEvent(event))
              respond({
                ok: false,
                message: uiText("The entry cannot be saved right now. Your draft is kept."),
              });
          }),
      );
    });
    this.pending = false;
    if (!this.isConnected) return;
    if (result.ok) {
      this.record = result.record;
      this.campaign = result.campaign;
      const focused = this.contains(document.activeElement);
      this.#close();
      if (focused)
        void this.updateComplete.then(() =>
          this.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }),
        );
    } else {
      this.error = result.message;
      this.#conflict = result.conflict === true;
    }
  }
  #dirty(dirty: boolean): void {
    if (dirty === this.#reportedDirty) return;
    this.#reportedDirty = dirty;
    reportEditState(this, { dirty });
  }
}

function fieldText(field: CampaignEditorField, value: unknown): string {
  if (field.kind === "tags") return stringList(value).join(", ");
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function fieldList(field: CampaignEditorField, value: unknown): readonly string[] {
  if (field.kind !== "attitudes") return stringList(value);
  // Attitudes are stored as objects; edits send their IDs.
  return Array.isArray(value)
    ? value.flatMap((item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string"
          ? [(item as { id: string }).id]
          : [],
      )
    : [];
}

function fieldValue(field: CampaignEditorField, text: string): unknown {
  if (field.kind === "tags")
    return text
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return field.kind === "line" ? text.trim() : text;
}

if (!customElements.get("codex-inline-field"))
  customElements.define("codex-inline-field", CodexInlineField);
