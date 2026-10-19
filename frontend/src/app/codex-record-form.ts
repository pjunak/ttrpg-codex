import { LitElement, html, nothing } from "lit";
import { UIControlsController } from "../ui/controller.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import { previewResourceURL } from "../core/player-preview.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import {
  collectionManagesVisibility,
  createCampaignRecordKey,
  editorFieldsFor,
  editorOptionsFor,
  relationshipBaseFor,
  sameCampaignValue,
  type CampaignEditorField,
  type CampaignRecordSaveDetail,
} from "./campaign-record-editor.js";
import {
  initialStructuredDraft,
  type CampaignRelationshipEditorElement,
  type CampaignStructuredFieldElement,
} from "./campaign-structured-editors.js";
import type { CampaignMarkdownContext } from "./campaign-markdown.js";
import { recordValue, safeMediaURL, text } from "./campaign-projection.js";
import { saveCampaign } from "./campaign-writes.js";
import type { CodexMarkdownEditor } from "./codex-markdown-editor.js";
import type { CodexPortraitEditor } from "./codex-portrait-editor.js";
import { contextualCreationFields, creationBackHash, creationSource } from "./context-creation.js";
import {
  editorValue,
  fieldFormValue,
  formFieldValue,
  recordFieldControl,
  sameFieldFormValue,
  submittedFieldFormValue,
} from "./record-field-controls.js";
import { locationPlacementLinks } from "./record-map-links.js";
import { mapHash, recordHash, type AppRoute, type CampaignPageDefinition } from "./routes.js";
import { saveFailure } from "./save-failure.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit, reportEditState } from "./unsaved-edit.js";
import "./codex-markdown-editor.js";
import "./codex-portrait-editor.js";

export type RecordFormRoute = Extract<AppRoute, { kind: "collection" | "record" | "create" }>;

/** A confirmed save; the page returns to `destination` unless add-on sections stay open. */
export interface RecordFormSavedDetail {
  readonly destination: string;
}

/** The form ended: cancelled by the user, or its record was deleted. */
export interface RecordFormClosedDetail {
  readonly reason: "cancel" | "deleted";
}

type CharacterTab = "details" | "connections" | "knowledge";

/**
 * The full record form. It opens on a snapshot of the campaign and keeps that
 * snapshot, its own drafts and its dirty state while live updates arrive; a
 * save sends only the fields that differ from the snapshot, against the
 * snapshot's revision, so another author's change fails as a conflict. The
 * form takes no input while any write runs, its own included.
 */
export class CodexRecordForm extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    page: { attribute: false },
    recordKey: { attribute: false },
    route: { attribute: false },
    canManageVisibility: { type: Boolean },
    actorRole: { attribute: false },
    registry: { attribute: false },
    wiki: { attribute: false },
    busy: { type: Boolean },
    saving: { state: true },
    saveError: { state: true },
    characterTab: { state: true },
  };
  /** The live campaign; the form keeps its own opening snapshot. */
  declare campaign: CampaignDataset;
  declare page: CampaignPageDefinition;
  /** The edited record, or undefined for a new one. */
  declare recordKey: string | undefined;
  declare route: RecordFormRoute;
  declare canManageVisibility: boolean;
  declare actorRole: BrowserRole | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare wiki: CampaignMarkdownContext["addonWiki"];
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  declare private saving: boolean;
  declare private saveError: string;
  declare private characterTab: CharacterTab;
  #opening: CampaignDataset | undefined;
  #dirty = false;
  /** Changes when the fields must reload from the saved record. */
  #generation = 0;
  #factionDraft: string | undefined;
  readonly #markdownDrafts = new Map<string, string>();
  /** Only the first long-text field explains local recovery; the others stay quiet. */
  #firstMarkdownField: string | undefined;
  #submittedMarkdown: readonly { editor: CodexMarkdownEditor; value: string }[] = [];
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    new UIControlsController(this);
    this.recordKey = undefined;
    this.canManageVisibility = false;
    this.busy = false;
    this.saving = false;
    this.saveError = "";
    this.characterTab = "details";
  }
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("invalid", this.#revealInvalidField, true);
  }
  override disconnectedCallback(): void {
    this.removeEventListener("invalid", this.#revealInvalidField, true);
    this.#setDirty(false);
    super.disconnectedCallback();
  }
  protected override willUpdate(): void {
    this.#opening ??= this.campaign;
  }

  /** Whether the form differs from what it opened with. */
  get dirty(): boolean {
    return this.#dirty;
  }

  get #snapshot(): CampaignDataset {
    return this.#opening ?? this.campaign;
  }

  get #record(): CampaignRecord | undefined {
    return this.recordKey === undefined
      ? undefined
      : campaignCollection(this.#snapshot, this.page.collection).records.find(
          ({ key }) => key === this.recordKey,
        );
  }

  get #locked(): boolean {
    return this.busy || this.saving;
  }

  protected override render() {
    const record = this.#record;
    if (this.recordKey !== undefined && record === undefined)
      return html`<p class="empty-state">${uiText("This entry is not available in the current campaign view.")}</p>`;
    const fields = editorFieldsFor(this.page.collection, this.canManageVisibility);
    this.#firstMarkdownField = fields.find((field) => field.kind === "markdown")?.key;
    const value = this.#openingValue(record);
    const creating = record === undefined;
    const character = this.page.collection === "characters";
    return html`
      <form class=${`record-editor ${character ? "character-editor" : ""}`} @submit=${this.#submit}
        @input=${this.#markDirty} @change=${this.#markDirty}>
        <header>
          <h2 id="record-editor-title">${creating ? uiText("Add {0}", { "0": this.page.singular.toLocaleLowerCase() }) : uiText("Edit {0}", { "0": text(value["name"]) || this.page.singular.toLocaleLowerCase() })}</h2>
        </header>
        <fieldset class="record-editor-body" ?disabled=${this.#locked}>
        ${
          character
            ? this.#characterFields(fields, value, record)
            : html`<div class="record-editor-fields">
          ${fields.map((field) => this.#field(field, value, record?.key ?? ""))}
          ${this.page.collection === "locations" ? this.#locationMapControls(record, value) : nothing}
          ${collectionManagesVisibility(this.page.collection) && this.canManageVisibility ? this.#visibility(value) : nothing}
        </div>`
        }
        </fieldset>
        ${saveFailure(this.saveError)}
        <footer class="record-editor-actions">
          ${
            record === undefined
              ? nothing
              : html`<button class="danger-record-action" type="button" @click=${this.#delete} ?disabled=${this.#locked}>${uiText("Delete")}</button>`
          }
          <span class="record-form-status" role="status">${uiText(
            this.saving
              ? "Saving…"
              : this.saveError
                ? "save.failed"
                : this.#dirty
                  ? "save.draft"
                  : "save.explicit",
          )}</span>
          <button type="button" @click=${this.#cancel} ?disabled=${this.#locked}>${uiText("Cancel")}</button>
          <button class="primary-record-action" type="submit" ?disabled=${this.#locked}>
            ${this.saving ? uiText("Saving…") : uiText("Save entry")}
          </button>
        </footer>
      </form>
    `;
  }

  /** What a new record's fields start with, or the edited record's value. */
  #openingValue(record: CampaignRecord | undefined): Readonly<Record<string, unknown>> {
    const route = this.route;
    if (record !== undefined || route.kind !== "create") return recordValue(record);
    if (route.context) return contextualCreationFields(route, this.#snapshot);
    if (route.preset === "party") {
      const status = editorFieldsFor(this.page.collection).find(({ key }) => key === "status");
      return {
        faction: "party",
        knowledge: 4,
        status:
          status !== undefined &&
          editorOptionsFor(this.#snapshot, status, "").some(({ value }) => value === "alive")
            ? "alive"
            : "",
      };
    }
    if (route.preset === "event") return { sitting: route.sitting ?? 1 };
    return {};
  }

  #locationMapControls(
    record: CampaignRecord | undefined,
    value: Readonly<Record<string, unknown>>,
  ) {
    const image = safeMediaURL(value["localMap"]);
    return html`<section class="wide-field location-map-controls" aria-label=${this.#ui.t("map.locationControls")}>
      <h3>${this.#ui.t("map.locationControls")}</h3>
      ${
        record === undefined
          ? html`<p class="field-help">${this.#ui.t("map.saveLocationFirst")}</p>`
          : html`<div class="location-map-actions">${locationPlacementLinks(record, true)}
            <a class="record-action" href=${mapHash(record.key)}>${this.#ui.t("map.local")}</a>
          </div>
          ${image === undefined ? nothing : html`<img class="location-map-preview" src=${previewResourceURL(image)} alt=${this.#ui.t("map.local")} />`}`
      }
    </section>`;
  }

  #visibility(value: Readonly<Record<string, unknown>>) {
    return html`<label>
      <span>${uiText("Visibility")}</span>
      <select name="visibility" .value=${value["visibility"] === "dm" ? "dm" : "public"}>
        <option value="public">${uiText("Public")}</option>
        <option value="dm">${uiText("DM only")}</option>
      </select>
    </label>`;
  }

  #characterFields(
    fields: readonly CampaignEditorField[],
    value: Readonly<Record<string, unknown>>,
    record: CampaignRecord | undefined,
  ) {
    const tabs = ["details", "connections", "knowledge"] as const;
    const labels = {
      details: uiText("Details"),
      connections: uiText("Connections"),
      knowledge: uiText("Knowledge"),
    };
    const connections = new Set([
      "faction",
      "rankAssignment",
      "location",
      "locationRoles",
      "attitudes",
    ]);
    const knowledge = new Set(["knowledge", "known", "unknown"]);
    const group = (key: string): CharacterTab =>
      connections.has(key) ? "connections" : knowledge.has(key) ? "knowledge" : "details";
    return html`<div class="character-editor-layout">
      <div class="character-editor-details">
        <div class="record-tabs" role="tablist" data-ui-tabs aria-label=${uiText("Character details")}>
          ${tabs.map(
            (tab) => html`<button type="button" role="tab" id=${`character-editor-tab-${tab}`}
            aria-controls=${`character-editor-panel-${tab}`} aria-selected=${this.characterTab === tab}
            tabindex=${this.characterTab === tab ? 0 : -1}
            @click=${() => {
              this.characterTab = tab;
            }}>${labels[tab]}</button>`,
          )}
        </div>
        ${tabs.map(
          (tab) => html`<section id=${`character-editor-panel-${tab}`} class="record-editor-fields"
          data-character-editor-panel=${tab} role="tabpanel" aria-labelledby=${`character-editor-tab-${tab}`}
          ?hidden=${this.characterTab !== tab}>
          ${
            tab === "details"
              ? html`<codex-portrait-editor class="wide-field" .portrait=${value["portrait"]}
            .creating=${record === undefined} .disabled=${this.#locked}></codex-portrait-editor>`
              : nothing
          }
          ${fields.filter((field) => field.key !== "description" && group(field.key) === tab).map((field) => this.#field(field, value, record?.key ?? ""))}
          ${
            tab === "connections"
              ? html`<campaign-relationship-editor
            .campaign=${this.#snapshot} .character=${record} .canManageVisibility=${this.canManageVisibility}
            .recordIdentity=${`${record?.key ?? "new"}:${this.#generation}`}></campaign-relationship-editor>`
              : nothing
          }
          ${tab === "details" && this.canManageVisibility ? this.#visibility(value) : nothing}
        </section>`,
        )}
      </div>
      <div class="character-editor-description">
        ${fields.filter((field) => field.key === "description").map((field) => this.#field(field, value, record?.key ?? ""))}
      </div>
    </div>`;
  }

  #field(field: CampaignEditorField, value: Readonly<Record<string, unknown>>, currentKey: string) {
    if (
      field.kind === "questions" ||
      field.kind === "rank-assignment" ||
      field.kind === "rank-chains" ||
      field.kind === "location-roles"
    ) {
      return html`
        <campaign-structured-field
          .campaign=${this.#snapshot}
          .field=${field}
          .record=${value}
          .factionId=${this.#factionDraft ?? editorValue(value["faction"])}
          .recordIdentity=${`${currentKey || "new"}:${field.key}:${this.#generation}`}
        ></campaign-structured-field>
      `;
    }
    const help =
      field.help === undefined ? nothing : html`<small class="field-help">${field.help}</small>`;
    if (field.kind === "markdown") {
      const source = this.#markdownDrafts.get(field.key) ?? editorValue(value[field.key]);
      const context: CampaignMarkdownContext = {
        dataset: this.#snapshot,
        currentCollection: this.page.collection,
        ...(this.wiki === undefined ? {} : { addonWiki: this.wiki }),
        ...(currentKey === "" ? {} : { currentKey }),
      };
      return html`<section class="markdown-editor wide-field"><span class="markdown-editor-label" aria-hidden="true">${field.label}</span><codex-markdown-editor
        .name=${field.key} .label=${field.label} .value=${source} .identity=${currentKey + ":" + field.key + ":" + this.#generation}
        .context=${context} .disabled=${this.#locked} .maximumLength=${field.maximumLength}
        .draftContext=${
          this.actorRole
            ? {
                role: this.actorRole,
                collection: this.page.collection,
                record: currentKey || null,
                field: field.key,
                baseValue: editorValue(value[field.key]),
                revision:
                  campaignCollection(this.#snapshot, this.page.collection).records.find(
                    (record) => record.key === currentKey,
                  )?.revision ?? 0,
              }
            : undefined
        }
        .saveLabel=${uiText("Save entry")}
        .quietIdle=${field.key !== this.#firstMarkdownField}
        @markdown-change=${(event: CustomEvent<{ value: string }>) => {
          this.#markdownDrafts.set(field.key, event.detail.value);
          this.#markDirty();
        }}
        @markdown-save=${(event: Event) => {
          (event.currentTarget as HTMLElement).closest("form")?.requestSubmit();
        }}
      ></codex-markdown-editor>${help}</section>`;
    }
    return recordFieldControl(this.#snapshot, field, value, currentKey, this.#updateFaction);
  }

  readonly #revealInvalidField = (event: Event): void => {
    const input = event.target;
    if (!(
      input instanceof HTMLInputElement ||
      input instanceof HTMLSelectElement ||
      input instanceof HTMLTextAreaElement
    ))
      return;
    const panel = input.closest<HTMLElement>("[data-character-editor-panel]");
    const tab = panel?.dataset["characterEditorPanel"];
    if (!panel?.hidden || (tab !== "details" && tab !== "connections" && tab !== "knowledge"))
      return;
    event.preventDefault();
    this.characterTab = tab;
    void this.updateComplete.then(() => {
      input.focus();
      input.reportValidity();
    });
  };

  readonly #updateFaction = (event: Event): void => {
    const factionID = (event.currentTarget as HTMLSelectElement).value;
    this.#factionDraft = factionID;
    this.querySelectorAll<CampaignStructuredFieldElement>("campaign-structured-field").forEach(
      (editor) => editor.setFaction(factionID),
    );
  };

  readonly #markDirty = (): void => {
    if (this.#locked) return;
    this.saveError = "";
    this.#setDirty(true);
  };

  #setDirty(dirty: boolean): void {
    if (this.#dirty === dirty) return;
    this.#dirty = dirty;
    this.requestUpdate();
    reportEditState(this, { dirty });
  }

  readonly #cancel = (): void => {
    const edits = this.registry?.edits.state();
    if (
      this.#locked ||
      edits?.saving ||
      !confirmDiscardUnsavedEdit(this.#dirty || edits?.dirty === true, (message) =>
        window.confirm(message),
      )
    )
      return;
    this.querySelectorAll<CodexMarkdownEditor>("codex-markdown-editor").forEach((editor) =>
      editor.discardDraft(),
    );
    this.#setDirty(false);
    this.#close("cancel");
  };

  #close(reason: RecordFormClosedDetail["reason"]): void {
    this.dispatchEvent(
      new CustomEvent<RecordFormClosedDetail>("record-form-closed", {
        detail: { reason },
        bubbles: true,
        composed: true,
      }),
    );
  }

  readonly #submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.#locked || this.registry?.edits.state().saving) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const record = this.#record;
    const creating = this.recordKey === undefined;
    if (!creating && record === undefined) return;
    // An edit sends only the fields that differ from what the form opened with,
    // so values a control cannot show exactly (tags containing commas,
    // multi-line list items, older over-long text) are never rewritten.
    const opening = record === undefined ? undefined : recordValue(record);
    const structured = new Map(
      [...form.querySelectorAll<CampaignStructuredFieldElement>("campaign-structured-field")].map(
        (editor) => [editor.fieldKey, editor.editorValue()],
      ),
    );
    const fields: Record<string, unknown> = {};
    for (const field of editorFieldsFor(this.page.collection, this.canManageVisibility)) {
      if (
        field.kind === "questions" ||
        field.kind === "rank-assignment" ||
        field.kind === "rank-chains" ||
        field.kind === "location-roles"
      ) {
        const draft = structured.get(field.key);
        if (opening && sameCampaignValue(draft, initialStructuredDraft(field, opening))) continue;
        fields[field.key] = draft;
        continue;
      }
      const submitted = submittedFieldFormValue(data, field);
      if (
        opening &&
        (submitted === undefined ||
          sameFieldFormValue(
            submitted,
            fieldFormValue(this.#snapshot, field, opening, this.recordKey ?? ""),
          ))
      )
        continue;
      fields[field.key] = formFieldValue(field, submitted ?? "");
    }
    const key = creating
      ? createCampaignRecordKey(
          typeof fields["name"] === "string" ? fields["name"] : this.page.singular,
        )
      : (this.recordKey ?? "");
    if (key === "") return;
    const portrait = form
      .querySelector<CodexPortraitEditor>("codex-portrait-editor")
      ?.editorValue();
    const detail: CampaignRecordSaveDetail = {
      collection: this.page.collection,
      key,
      expectedRevision: record?.revision ?? 0,
      creating,
      fields: Object.freeze(fields),
      ...(portrait !== undefined ? { portrait } : {}),
      ...(this.page.collection === "characters" && !creating
        ? {
            relationships:
              form
                .querySelector<CampaignRelationshipEditorElement>("campaign-relationship-editor")
                ?.editorValue() ?? [],
            relationshipBase: relationshipBaseFor(this.#snapshot, key),
          }
        : {}),
      ...(collectionManagesVisibility(this.page.collection) && this.canManageVisibility
        ? { visibility: data.get("visibility") === "dm" ? ("dm" as const) : ("public" as const) }
        : {}),
    };
    const route = this.route;
    if (route.kind === "create" && route.context && !creationSource(route, this.campaign)?.record) {
      this.saveError = uiText("creation.unavailable");
      return;
    }
    this.#submittedMarkdown = [
      ...form.querySelectorAll<CodexMarkdownEditor>("codex-markdown-editor"),
    ].map((editor) => ({ editor, value: editor.value }));
    void this.#save(detail);
  };

  async #save(detail: CampaignRecordSaveDetail): Promise<void> {
    const route = this.route;
    this.saving = true;
    this.saveError = "";
    const result = await saveCampaign(this, "record", detail);
    this.saving = false;
    if (!this.isConnected) return;
    if (!result.ok) {
      this.saveError = result.message;
      return;
    }
    for (const { editor, value } of this.#submittedMarkdown) editor.acknowledgeSave(value);
    // The form reopens on the saved record, in case add-on sections keep it open.
    this.#opening = result.campaign;
    this.#markdownDrafts.clear();
    this.#factionDraft = undefined;
    this.#submittedMarkdown = [];
    this.#generation++;
    this.#setDirty(false);
    this.dispatchEvent(
      new CustomEvent<RecordFormSavedDetail>("record-form-saved", {
        detail: {
          destination:
            route.kind === "create" && route.context
              ? creationBackHash(route, result.campaign)
              : route.kind === "record" && route.editing && route.returnTo
                ? route.returnTo
                : recordHash(this.page, detail.key),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  readonly #delete = async (): Promise<void> => {
    const record = this.#record;
    if (
      this.#locked ||
      record === undefined ||
      !window.confirm(
        uiText("Delete this {0}? This cannot be undone from this page.", {
          "0": this.page.singular.toLocaleLowerCase(),
        }),
      )
    )
      return;
    this.saving = true;
    this.saveError = "";
    const result = await saveCampaign(this, "record-delete", {
      collection: this.page.collection,
      key: record.key,
      expectedRevision: record.revision,
    });
    this.saving = false;
    if (!this.isConnected) return;
    if (!result.ok) {
      this.saveError = result.message;
      return;
    }
    this.#setDirty(false);
    this.#close("deleted");
  };
}

if (!customElements.get("codex-record-form"))
  customElements.define("codex-record-form", CodexRecordForm);
