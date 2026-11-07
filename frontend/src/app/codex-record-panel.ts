import { LitElement, html, nothing } from "lit";
import type { CampaignCollectionName, CampaignRecord } from "../core/campaign-data.js";
import type { CampaignCharacterPatch } from "./campaign-record-editor.js";
import { recordValue, text } from "./campaign-projection.js";
import { saveCampaign } from "./campaign-writes.js";
import type { CodexPortraitEditor } from "./codex-portrait-editor.js";
import { UiLocalizationController, uiText } from "./ui-localization.js";
import { reportEditState } from "./unsaved-edit.js";
import "./codex-portrait-editor.js";

export type RecordPanelKind = "picture" | "visibility";

/**
 * A record page's small edit panel for a faction's picture or a record's
 * visibility, opened beside what it edits. It saves one in-place patch
 * against the record it opened with; `record-panel-closed` ends it.
 */
export class CodexRecordPanel extends LitElement {
  static override properties = {
    record: { attribute: false },
    collection: { attribute: false },
    kind: { attribute: false },
    saving: { state: true },
    error: { state: true },
  };
  declare record: CampaignRecord;
  declare collection: CampaignCollectionName;
  declare kind: RecordPanelKind;
  declare private saving: boolean;
  declare private error: string;
  #dirty = false;

  constructor() {
    super();
    new UiLocalizationController(this);
    this.saving = false;
    this.error = "";
  }
  protected override createRenderRoot() {
    return this;
  }
  /** Whether the panel holds a change not saved yet. */
  get dirty(): boolean {
    return this.#dirty;
  }
  override disconnectedCallback(): void {
    reportEditState(this, { dirty: false });
    super.disconnectedCallback();
  }
  override firstUpdated(): void {
    this.scrollIntoView({ block: "nearest" });
    this.querySelector<HTMLElement>("input")?.focus();
  }
  protected override render() {
    const value = recordValue(this.record);
    const dm = value["visibility"] === "dm";
    return html`<section class="character-section-editor record-panel" @input=${this.#changed} @change=${this.#changed}>
      <fieldset ?disabled=${this.saving}>
        ${
          this.kind === "picture"
            ? html`<codex-portrait-editor .noun=${"picture"} .fallback=${text(value["badge"])}
              .portrait=${value["portrait"]} .disabled=${this.saving}></codex-portrait-editor>`
            : html`<fieldset data-ui="choices" class="record-choices">
              <legend>${uiText("Visibility")}</legend>
              <label><input type="radio" name="visibility" value="public" ?checked=${!dm} />${uiText("Public")}</label>
              <label><input type="radio" name="visibility" value="dm" ?checked=${dm} />${uiText("DM only")}</label>
            </fieldset>`
        }
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        <div class="character-local-actions">
          <button class="ui-action" type="button" @click=${this.#close}>${uiText("Cancel")}</button>
          <button class="ui-action" data-ui-variant="primary" type="button" @click=${this.#save}>${uiText(this.saving ? "Saving…" : "Save changes")}</button>
        </div>
      </fieldset>
    </section>`;
  }
  readonly #changed = (): void => {
    if (this.#dirty) return;
    this.#dirty = true;
    reportEditState(this, { dirty: true });
  };
  readonly #close = (): void => {
    if (this.saving) return;
    this.dispatchEvent(new CustomEvent("record-panel-closed", { bubbles: true, composed: true }));
  };
  readonly #save = async (): Promise<void> => {
    if (this.saving) return;
    let patch: CampaignCharacterPatch = {
      collection: this.collection,
      base: this.record,
      fields: {},
    };
    if (this.kind === "picture") {
      const picture =
        this.querySelector<CodexPortraitEditor>("codex-portrait-editor")?.editorValue();
      if (picture === undefined) return this.#close();
      patch = { ...patch, portrait: picture };
    } else {
      const picked = this.querySelector<HTMLInputElement>('input[name="visibility"]:checked');
      patch = { ...patch, visibility: picked?.value === "dm" ? "dm" : "public" };
    }
    this.saving = true;
    this.error = "";
    reportEditState(this, { dirty: true, saving: true });
    const result = await saveCampaign(this, "record-patch", patch, () => this.isConnected);
    this.saving = false;
    if (!this.isConnected) return;
    if (!result.ok) {
      this.error = result.message;
      reportEditState(this, { dirty: true });
      return;
    }
    this.#dirty = false;
    reportEditState(this, { dirty: false });
    this.#close();
  };
}

if (!customElements.get("codex-record-panel"))
  customElements.define("codex-record-panel", CodexRecordPanel);
