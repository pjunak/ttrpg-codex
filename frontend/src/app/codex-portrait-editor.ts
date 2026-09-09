import { LitElement, html, nothing } from "lit";
import { previewResourceURL } from "../core/player-preview.js";
import { safeMediaURL } from "./campaign-projection.js";
import { portraitAccept, validPortraitFile } from "./character-portrait.js";
import { UiLocalizationController, uiText } from "./ui-localization.js";

export class CodexPortraitEditor extends LitElement {
  static override properties = {
    portrait: { attribute: false }, disabled: { type: Boolean }, creating: { type: Boolean },
    preview: { state: true }, error: { state: true },
  };
  declare portrait: unknown;
  declare disabled: boolean;
  declare creating: boolean;
  declare private preview: string | undefined;
  declare private error: boolean;
  #draft: File | null | undefined;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super(); this.disabled = false; this.creating = false; this.error = false;
  }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void {
    this.#releasePreview(); super.disconnectedCallback();
  }
  editorValue(): File | null | undefined { return this.#draft; }
  protected override render() {
    void this.#ui;
    const image = this.#draft === null ? undefined : this.preview ?? safeMediaURL(this.portrait);
    return html`<section class="portrait-editor" aria-label=${uiText("Character portrait")}>
      ${image === undefined ? html`<div class="portrait-editor-preview portrait-editor-empty" aria-hidden="true">👤</div>`
        : html`<img class="portrait-editor-preview" src=${this.preview ?? previewResourceURL(image)} alt=${uiText("Portrait preview")} />`}
      <div class="portrait-editor-controls">
        ${this.creating ? html`<p>${uiText("Save the character first, then edit it to add a portrait.")}</p>` : html`
          <label><span>${image === undefined ? uiText("Upload portrait") : uiText("Replace portrait")}</span>
            <input type="file" accept=${portraitAccept} aria-label=${uiText("Choose portrait")}
              ?disabled=${this.disabled} @change=${this.#select} /></label>
          ${this.#draft instanceof File ? html`<small class="field-help">${this.#draft.name}</small>` : nothing}
          <small class="field-help">${uiText("PNG, JPEG, WebP, GIF or SVG, up to 20 MiB. Changes apply when you save the entry.")}</small>
          ${image === undefined ? nothing : html`<button class="record-action" type="button" ?disabled=${this.disabled}
            @click=${this.#remove}>${uiText("Remove portrait")}</button>`}
          ${this.#draft === undefined ? nothing : html`<button class="record-action" type="button" ?disabled=${this.disabled}
            @click=${this.#undo}>${uiText("Undo portrait change")}</button>`}
          ${this.error ? html`<p role="alert">${uiText("Choose a supported image between 1 byte and 20 MiB.")}</p>` : nothing}
        `}
      </div>
    </section>`;
  }
  readonly #select = (event: Event): void => {
    if (this.disabled || this.creating) return;
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = "";
    if (file === undefined) return;
    this.error = !validPortraitFile(file);
    if (this.error) return;
    this.#releasePreview(); this.#draft = file; this.preview = URL.createObjectURL(file);
    this.#changed();
  };
  readonly #remove = (): void => {
    if (this.disabled || this.creating) return;
    this.#releasePreview(); this.#draft = null; this.error = false; this.#changed();
  };
  readonly #undo = (): void => {
    if (this.disabled || this.creating) return;
    this.#releasePreview(); this.#draft = undefined; this.error = false; this.#changed();
  };
  #releasePreview(): void {
    if (this.preview !== undefined) URL.revokeObjectURL(this.preview);
    this.preview = undefined;
  }
  #changed(): void {
    this.requestUpdate(); this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
}
customElements.define("codex-portrait-editor", CodexPortraitEditor);
