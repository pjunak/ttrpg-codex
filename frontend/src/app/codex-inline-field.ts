import { LitElement, html, nothing } from "lit";
import { pencilIcon } from "./edit-icon.js";
import type { InlineCommit, InlineDraft } from "./inline-draft.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";

export interface InlineOption {
  readonly value: string;
  readonly label: string;
}

/** The control a field is edited with. */
export type InlineControl =
  | {
      readonly kind: "text";
      readonly type?: "text" | "number";
      /** A paragraph rather than one line; Enter adds a line. */
      readonly multiline?: boolean;
      readonly maxLength?: number;
      readonly min?: number;
      readonly max?: number;
      readonly required?: boolean;
    }
  /** One choice, saved as soon as it is picked; twelve or more become searchable. */
  | { readonly kind: "choice"; readonly options: readonly InlineOption[] }
  /** Several choices in the shared chip picker. */
  | { readonly kind: "multi"; readonly options: readonly InlineOption[] };

/** A value as its control shows it: text, one choice, or several choices. */
export type InlineInput = string | readonly string[];

/** This field's part of a draft that several fields edit together. */
export interface InlineProjection {
  read(value: unknown): InlineInput;
  write(value: unknown, input: InlineInput): unknown;
}

const whole: InlineProjection = {
  read: (value) => value as InlineInput,
  write: (_value, input) => input,
};

/**
 * One value edited in place. It reads as text with a pencil; activating it
 * swaps in a control with the same typography. Enter or ✓ saves and Escape or
 * ✕ restores the saved value; `commit` adds saving when focus leaves (`blur`)
 * or after a pause while typing (`pause`, where Escape saves instead). An
 * `explicit` field saves only then: its actions read Save and Cancel, and
 * Cancel asks before discarding a change. Choices save when picked. A failed
 * save keeps the draft open with Retry, or after a conflict with Keep my draft
 * and Use current value. Typing may continue while a save runs; the newer text
 * saves next.
 *
 * The owner keeps the draft (see `InlineDraftController`): `begin` opens it
 * and `draft` passes it back, so a draft survives the field moving on the page.
 */
export class CodexInlineField extends LitElement {
  static override properties = {
    label: { attribute: false },
    editLabel: { attribute: false },
    placeholder: { attribute: false },
    name: { attribute: false },
    value: { attribute: false },
    current: { attribute: false },
    display: { attribute: false },
    linked: { type: Boolean },
    control: { attribute: false },
    commit: { attribute: false },
    canEdit: { type: Boolean },
    disabled: { type: Boolean },
    draft: { attribute: false },
    draftPart: { attribute: false },
    begin: { attribute: false },
    project: { attribute: false },
    onRemove: { attribute: false },
  };
  /** The field's name, as it labels the control. */
  declare label: string;
  /** The read-mode button's name; "Edit {label}" by default. */
  declare editLabel: string | undefined;
  /** Read-mode text for an empty value; "Add {label}" by default. */
  declare placeholder: string | undefined;
  /** The owner's key for this field; focus returns to it after editing. */
  declare name: string;
  /** The value as the control shows it. */
  declare value: InlineInput;
  /** The saved value shown after a conflict, when `value` reflects an owner's draft. */
  declare current: InlineInput | undefined;
  /** Read-mode content; the value's text or choice labels by default. */
  declare display: unknown;
  /** Read mode shows `display` (such as links) beside a separate pencil. */
  declare linked: boolean;
  declare control: InlineControl;
  declare commit: InlineCommit;
  declare canEdit: boolean;
  /** The field cannot start editing now; read mode shows its button disabled. */
  declare disabled: boolean;
  /** The owner's open draft for this field, if any. */
  declare draft: InlineDraft | undefined;
  /** Which part of `draft` this field edits, when several fields share it. */
  declare draftPart: string | undefined;
  /** Opens, or reuses, the owner's draft for this field; the owner passes it back as `draft`. */
  declare begin: (() => void) | undefined;
  declare project: InlineProjection;
  /** Adds Remove while editing, for list items. */
  declare onRemove: (() => void) | undefined;

  constructor() {
    super();
    new UiLocalizationController(this);
    this.label = "";
    this.name = "";
    this.value = "";
    this.linked = false;
    this.control = { kind: "text" };
    this.commit = "blur";
    this.canEdit = false;
    this.disabled = false;
    this.project = whole;
  }
  protected override createRenderRoot() {
    return this;
  }

  /** Opens the field for editing, as its read-mode button does. */
  open(): Promise<void> {
    return this.#start();
  }

  get #open(): InlineDraft | undefined {
    // Only the owner's draft counts: an element Lit reuses for another field
    // must not keep editing the previous field's draft.
    const draft = this.draft;
    return draft !== undefined &&
      !draft.closed &&
      (this.draftPart === undefined || draft.active === this.draftPart)
      ? draft
      : undefined;
  }

  protected override render() {
    const draft = this.canEdit ? this.#open : undefined;
    return draft === undefined ? this.#reading() : this.#editing(draft);
  }

  #reading() {
    const text = this.#text(this.value);
    if (!this.canEdit)
      return this.display !== undefined ? this.display : html`<span>${text || "—"}</span>`;
    const edit = this.editLabel ?? uiText("Edit {0}", { "0": this.label });
    if (this.linked)
      return html`${this.display ?? text}<button type="button" class="inline-edit-button"
        data-edit-field=${this.name} aria-label=${edit} title=${edit} ?disabled=${this.disabled}
        @click=${this.#start}>${pencilIcon()}</button>`;
    const empty = text === "" && this.display === undefined;
    return html`<button type="button" class=${`inline-field-value${empty ? " is-empty" : ""}`}
      data-edit-field=${this.name} aria-label=${edit} ?disabled=${this.disabled}
      @click=${this.#start}>${
        empty
          ? (this.placeholder ?? uiText("Add {0}", { "0": this.label.toLocaleLowerCase() }))
          : (this.display ?? text)
      }</button>`;
  }

  #editing(draft: InlineDraft) {
    const labelled = this.commit === "explicit";
    const actions =
      this.control.kind === "choice" || (this.control.kind === "text" && this.control.multiline)
        ? nothing
        : html`<span class=${`inline-edit-actions${labelled ? " is-labelled" : ""}`}>
        <button type="button" class="inline-edit-confirm"
          aria-label=${labelled ? nothing : uiText("inlineEdit.save", { "0": this.label })}
          title=${labelled ? nothing : uiText("inlineEdit.save", { "0": this.label })}
          ?disabled=${draft.pending || draft.conflict}
          @pointerdown=${(event: PointerEvent) => event.preventDefault()}
          @click=${() => void draft.commit(true)}>${labelled ? uiText("inlineEdit.confirm") : "✓"}</button>
        <button type="button" class="inline-edit-cancel"
          aria-label=${labelled ? nothing : uiText("inlineEdit.cancel", { "0": this.label })}
          title=${labelled ? nothing : uiText("inlineEdit.cancel", { "0": this.label })}
          ?disabled=${draft.pending}
          @pointerdown=${(event: PointerEvent) => event.preventDefault()}
          @click=${() => this.#cancel(draft)}>${labelled ? uiText("Cancel") : "✕"}</button>
      </span>`;
    return html`<span class=${`inline-field-editor${draft.pending ? " is-pending" : ""}`}
      data-field=${this.name}
      @focusout=${(event: FocusEvent) => this.#leave(event, draft)}
      @keydown=${(event: KeyboardEvent) => this.#key(event, draft)}>
      <span class="inline-edit-row">${this.#control(draft)}${actions}</span>
      ${
        draft.pending
          ? html`<small class="inline-edit-hint">${uiText("Saving…")}</small>`
          : this.commit === "pause"
            ? html`<small class="inline-edit-hint">${uiText("Saves after a short pause")}</small>`
            : nothing
      }
      ${
        this.onRemove
          ? html`<button type="button" class="inline-edit-remove" ?disabled=${draft.pending}
          @pointerdown=${(event: PointerEvent) => event.preventDefault()}
          @click=${() => this.onRemove?.()}>${uiText("Remove")}</button>`
          : nothing
      }
      ${draft.error ? this.#recovery(draft) : nothing}
    </span>`;
  }

  #control(draft: InlineDraft) {
    const control = this.control;
    const input = this.project.read(draft.value);
    const write = (next: InlineInput, autosave = false) =>
      draft.input(this.project.write(draft.value, next), autosave);
    if (control.kind === "multi") {
      const selected = typeof input === "string" ? [] : input;
      return html`<select aria-label=${this.label} multiple data-ui="chips" ?disabled=${draft.pending}
        @change=${(event: Event) =>
          write(
            [...(event.target as HTMLSelectElement).selectedOptions].map((option) => option.value),
          )}>
        ${selected
          .filter((value) => !control.options.some((option) => option.value === value))
          .map((value) => html`<option value=${value} selected>${value}</option>`)}
        ${control.options.map(
          (option) =>
            html`<option value=${option.value} ?selected=${selected.includes(option.value)}>${option.label}</option>`,
        )}</select>`;
    }
    const text = typeof input === "string" ? input : "";
    if (control.kind === "choice")
      return html`<select aria-label=${this.label} ?disabled=${draft.pending}
        data-ui=${control.options.length >= 12 ? "combobox" : nothing}
        @change=${(event: Event) => {
          write((event.target as HTMLSelectElement).value);
          void draft.commit(true);
        }}>
        <option value="" ?selected=${text === ""}>${uiText("None")}</option>
        ${
          text && !control.options.some((option) => option.value === text)
            ? html`<option value=${text} selected>${text}</option>`
            : nothing
        }
        ${control.options.map(
          (option) =>
            html`<option value=${option.value} ?selected=${option.value === text}>${option.label}</option>`,
        )}</select>`;
    if (control.multiline)
      return html`<textarea aria-label=${this.label} .value=${text}
        maxlength=${control.maxLength ?? nothing}
        @input=${(event: Event) =>
          write((event.target as HTMLTextAreaElement).value, this.commit === "pause")}></textarea>`;
    return html`<input aria-label=${this.label} .value=${text}
      type=${control.type === "number" ? "number" : "text"} min=${control.min ?? nothing}
      max=${control.max ?? nothing} maxlength=${control.maxLength ?? nothing}
      ?required=${control.required === true}
      title=${this.commit === "explicit" ? nothing : uiText("Enter to confirm · Esc to cancel")}
      @input=${(event: Event) =>
        write((event.target as HTMLInputElement).value, this.commit === "pause")} />`;
  }

  #recovery(draft: InlineDraft) {
    return html`<span class="inline-edit-error" role="alert">${draft.error}</span>
      ${
        draft.conflict
          ? html`<small class="inline-edit-hint">${uiText("Current saved value")}: ${this.#text(this.current ?? this.value) || "—"}</small>`
          : nothing
      }
      <span class="inline-edit-recovery">${
        draft.conflict
          ? html`<button type="button" @click=${() => draft.keep()}>${uiText("Keep my draft")}</button>`
          : html`<button type="button" ?disabled=${draft.pending}
            @click=${() => void draft.commit(true)}>${uiText("Retry")}</button>`
      }
        <button type="button" ?disabled=${draft.pending}
          @click=${() => this.#cancel(draft)}>${uiText("Use current value")}</button></span>`;
  }

  #text(value: InlineInput): string {
    const options = this.control.kind === "text" ? [] : this.control.options;
    const label = (item: string) => options.find((option) => option.value === item)?.label ?? item;
    return typeof value === "string" ? label(value) : value.map(label).join(", ");
  }

  readonly #start = async (): Promise<void> => {
    if (!this.canEdit || this.begin === undefined) return;
    if (this.#open === undefined) {
      if (this.disabled) return;
      this.begin();
    }
    // The owner renders first and passes the draft back before this updates.
    this.requestUpdate();
    await this.updateComplete;
    // Searchable selects are enhanced by the page's shared controls after this render.
    if (this.querySelector('select[data-ui="combobox"], select[data-ui="chips"]'))
      await new Promise((resolve) => requestAnimationFrame(resolve));
    const control =
      this.querySelector<HTMLInputElement>(".ui-combobox input, .ui-chip-input") ??
      this.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        ".inline-edit-row :is(input, textarea, select)",
      );
    control?.focus();
    if (control instanceof HTMLInputElement) control.select();
  };

  #key(event: KeyboardEvent, draft: InlineDraft): void {
    // Open lists and chip pickers handle their own Escape and Enter first.
    if (event.isComposing || event.defaultPrevented) return;
    const target = event.target as Element;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.commit === "pause") void draft.commit(true);
      else this.#cancel(draft);
    } else if (
      event.key === "Enter" &&
      (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) &&
      !target.closest(".ui-combobox")
    ) {
      event.preventDefault();
      void draft.commit(true);
    }
  }

  #leave(event: FocusEvent, draft: InlineDraft): void {
    const next = event.relatedTarget;
    if (next instanceof Element && (this.contains(next) || next.closest(".ui-popup"))) return;
    if (this.commit !== "explicit" && !draft.error) void draft.commit(true);
  }

  #cancel(draft: InlineDraft): void {
    if (draft.pending) return;
    // An explicit draft never saves itself, so leaving it changed asks first.
    if (
      this.commit === "explicit" &&
      !confirmDiscardUnsavedEdit(draft.dirty, (message) => window.confirm(message))
    )
      return;
    draft.discard();
  }
}

if (!customElements.get("codex-inline-field"))
  customElements.define("codex-inline-field", CodexInlineField);
