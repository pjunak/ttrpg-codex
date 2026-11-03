import { LitElement, html, nothing } from "lit";
import { previewResourceURL } from "../core/player-preview.js";
import { safeMediaURL } from "./campaign-projection.js";
import { portraitAccept, validPortraitFile } from "./record-picture.js";
import { UiLocalizationController, uiText } from "./ui-localization.js";
import { artwork } from "../ui/artwork.js";

/** Wording for a character's portrait or a faction's picture. */
const wording = Object.freeze({
  portrait: {
    section: "Character portrait",
    preview: "Portrait preview",
    unavailable: "Portrait preview unavailable",
    upload: "Upload portrait",
    replace: "Replace portrait",
    choose: "Choose portrait",
    remove: "Remove portrait",
    undo: "Undo portrait change",
    saveFirst: "Save the character first, then edit it to add a portrait.",
    fallback: "👤",
  },
  picture: {
    section: "Faction picture",
    preview: "Picture preview",
    unavailable: "Picture preview unavailable",
    upload: "Upload picture",
    replace: "Replace picture",
    choose: "Choose picture",
    remove: "Remove picture",
    undo: "Undo picture change",
    saveFirst: "Save the faction first, then edit it to add a picture.",
    fallback: "🛡️",
  },
} as const);

/** Chooses, replaces or removes a record's uploaded image; the save uploads it. */
export class CodexPortraitEditor extends LitElement {
  static override properties = {
    portrait: { attribute: false },
    noun: { attribute: false },
    disabled: { type: Boolean },
    creating: { type: Boolean },
    preview: { state: true },
    error: { state: true },
  };
  declare portrait: unknown;
  declare noun: keyof typeof wording;
  declare disabled: boolean;
  declare creating: boolean;
  declare private preview: string | undefined;
  declare private error: boolean;
  #draft: File | null | undefined;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.noun = "portrait";
    this.disabled = false;
    this.creating = false;
    this.error = false;
  }
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    if (this.#draft instanceof File && this.preview === undefined)
      this.preview = URL.createObjectURL(this.#draft);
  }
  override disconnectedCallback(): void {
    this.#releasePreview();
    super.disconnectedCallback();
  }
  editorValue(): File | null | undefined {
    return this.#draft;
  }
  protected override render() {
    void this.#ui;
    const image = this.#draft === null ? undefined : (this.preview ?? safeMediaURL(this.portrait));
    const words = wording[this.noun];
    return html`<section class="portrait-editor" aria-label=${uiText(words.section)}>
      ${artwork({
        source: this.preview ?? previewResourceURL(image),
        className: "portrait-editor-preview portrait-editor-empty",
        fallback: words.fallback,
        label: image === undefined ? undefined : uiText(words.preview),
        unavailableLabel: uiText(words.unavailable),
      })}
      <div class="portrait-editor-controls">
        ${
          this.creating
            ? html`<p>${uiText(words.saveFirst)}</p>`
            : html`
          <label><span>${uiText(image === undefined ? words.upload : words.replace)}</span>
            <input type="file" accept=${portraitAccept} aria-label=${uiText(words.choose)}
              ?disabled=${this.disabled} @change=${this.#select} /></label>
          ${this.#draft instanceof File ? html`<small class="field-help">${this.#draft.name}</small>` : nothing}
          <small class="field-help">${uiText("PNG, JPEG, WebP, GIF or SVG, up to 20 MiB. Changes apply when you save the entry.")}</small>
          ${
            image === undefined
              ? nothing
              : html`<button class="ui-action" type="button" ?disabled=${this.disabled}
            @click=${this.#remove}>${uiText(words.remove)}</button>`
          }
          ${
            this.#draft === undefined
              ? nothing
              : html`<button class="ui-action" type="button" ?disabled=${this.disabled}
            @click=${this.#undo}>${uiText(words.undo)}</button>`
          }
          ${this.error ? html`<p role="alert">${uiText("Choose a supported image between 1 byte and 20 MiB.")}</p>` : nothing}
        `
        }
      </div>
    </section>`;
  }
  readonly #select = (event: Event): void => {
    if (this.disabled || this.creating) return;
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file === undefined) return;
    this.error = !validPortraitFile(file);
    if (this.error) return;
    this.#releasePreview();
    this.#draft = file;
    this.preview = URL.createObjectURL(file);
    this.#changed();
  };
  readonly #remove = (): void => {
    if (this.disabled || this.creating) return;
    this.#releasePreview();
    this.#draft = null;
    this.error = false;
    this.#changed();
  };
  readonly #undo = (): void => {
    if (this.disabled || this.creating) return;
    this.#releasePreview();
    this.#draft = undefined;
    this.error = false;
    this.#changed();
  };
  #releasePreview(): void {
    if (this.preview !== undefined) URL.revokeObjectURL(this.preview);
    this.preview = undefined;
  }
  #changed(): void {
    this.requestUpdate();
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
}
customElements.define("codex-portrait-editor", CodexPortraitEditor);
