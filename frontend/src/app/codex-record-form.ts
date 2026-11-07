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
import { renderFactionChip } from "./article-context-view.js";
import { campaignFactionIdentity, hexColor } from "./campaign-party.js";
import { factionRankChains } from "./campaign-structured-editors.js";
import { recordFormLayout, type RecordFormSection } from "./record-form-layout.js";
import { recordPictureKinds } from "./record-picture.js";
import { saveCampaign } from "./campaign-writes.js";
import type { CodexMarkdownEditor } from "./codex-markdown-editor.js";
import type { CodexPortraitEditor } from "./codex-portrait-editor.js";
import { contextualCreationFields, creationBackHref, creationSource } from "./context-creation.js";
import {
  editorValue,
  fieldFormValue,
  formFieldValue,
  recordFieldControl,
  sameFieldFormValue,
  submittedFieldFormValue,
} from "./record-field-controls.js";
import { locationPlacementLinks } from "./record-map-links.js";
import { mapHref, recordHref, type AppRoute, type CampaignPageDefinition } from "./routes.js";
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

/**
 * The full record form. It opens on a snapshot of the campaign and keeps that
 * snapshot, its own drafts and its dirty state while live updates arrive; a
 * save sends only the fields that differ from the snapshot, against the
 * snapshot's revision, so another author's change fails as a conflict. The
 * form takes no input while any write runs, its own included.
 *
 * Every collection shares one page: a head with the title, status chips and
 * a section bar; the fields in sections (record-form-layout.ts); and a side
 * column with the picture and Settings (visibility, tags). Fields a choice
 * reveals sit in an indented "↳ Because …" group. Ctrl+S saves.
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
  #opening: CampaignDataset | undefined;
  #dirty = false;
  /** Changes when the fields must reload from the saved record. */
  #generation = 0;
  #factionDraft: string | undefined;
  /** Current values of the fields other parts of the form follow while editing. */
  readonly #watched = new Map<string, string>();
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
  }
  protected override createRenderRoot() {
    return this;
  }
  override disconnectedCallback(): void {
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
    const collection = this.page.collection;
    const fields = editorFieldsFor(collection, this.canManageVisibility);
    this.#firstMarkdownField = fields.find((field) => field.kind === "markdown")?.key;
    const byKey = new Map(fields.map((field) => [field.key, field]));
    const layout = recordFormLayout(collection);
    const value = this.#openingValue(record);
    const creating = record === undefined;
    const sections = layout.sections.filter(
      (section) =>
        section.fields.some((key) => byKey.has(key)) ||
        this.#extras(section, value, record) !== nothing,
    );
    return html`
      <form class="record-editor record-form" data-ui-form data-collection=${collection} @submit=${this.#submit}
        @input=${this.#edited} @change=${this.#edited} @keydown=${this.#shortcut}>
        <header class="record-form-head">
          <div class="record-form-title">
            <h2 id="record-editor-title">${creating ? uiText("Add {0}", { "0": this.page.singular.toLocaleLowerCase() }) : uiText("Edit {0}", { "0": text(value["name"]) || this.page.singular.toLocaleLowerCase() })}</h2>
            <span class="record-form-chips">${this.#chips(value)}</span>
          </div>
          ${
            sections.length > 1
              ? html`<nav class="record-form-nav" aria-label=${uiText("form.sections")}>${sections.map(
                  (section) =>
                    html`<button type="button" class="ui-action" data-ui-variant="quiet"
                      @click=${() => this.#showSection(section.id)}>${uiText(section.label)}</button>`,
                )}</nav>`
              : nothing
          }
          <p class="record-form-legend">
            <span>${uiText("form.legendPick")}</span><span>${uiText("form.legendType")}</span><span>${uiText("form.legendDepends")}</span>
          </p>
        </header>
        <fieldset class="record-editor-body record-form-body" ?disabled=${this.#locked}>
          <div class="record-form-main">
            ${sections.map(
              (section) => html`<section class="record-form-section" data-form-section=${section.id}
                aria-labelledby=${`record-form-${section.id}`}>
                <h3 id=${`record-form-${section.id}`}>${uiText(section.label)}</h3>
                <div class="record-editor-fields">
                  ${section.fields.map((key) => {
                    const field = byKey.get(key);
                    if (field === undefined) return nothing;
                    const alone = section.fields.filter((other) => byKey.has(other)).length === 1;
                    return this.#sectionField(
                      field,
                      value,
                      record,
                      alone && field.label === uiText(section.label),
                    );
                  })}
                  ${this.#extras(section, value, record)}
                </div>
              </section>`,
            )}
          </div>
          ${this.#side(
            value,
            record,
            layout.settings.flatMap((key) => byKey.get(key) ?? []),
          )}
        </fieldset>
        ${saveFailure(this.saveError)}
        <footer class="record-editor-actions">
          ${
            record === undefined
              ? nothing
              : html`<button class="ui-action" data-ui-variant="danger" type="button" @click=${this.#delete} ?disabled=${this.#locked}>${uiText("Delete")}</button>`
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
          <button class="ui-action" type="button" @click=${this.#cancel} ?disabled=${this.#locked}>${uiText("Cancel")}</button>
          <button class="ui-action" data-ui-variant="primary" type="submit" ?disabled=${this.#locked}
            title=${uiText("form.saveHint")}>
            ${this.saving ? uiText("Saving…") : uiText("Save entry")}
          </button>
        </footer>
      </form>
    `;
  }

  /** The status chips beside the title: unsaved changes and who sees the record. */
  #chips(value: Readonly<Record<string, unknown>>) {
    const visibility =
      collectionManagesVisibility(this.page.collection) && this.canManageVisibility
        ? (this.#watched.get("visibility") ?? (value["visibility"] === "dm" ? "dm" : "public"))
        : undefined;
    return html`${this.#dirty ? html`<span class="record-form-chip" data-tone="accent">${uiText("save.draft")}</span>` : nothing}
      ${
        visibility === undefined
          ? nothing
          : html`<span class="record-form-chip" data-tone=${visibility === "dm" ? "muted" : "public"}>${uiText(visibility === "dm" ? "DM only" : "Public")}</span>`
      }`;
  }

  /** One field in its section; a few follow another field's current choice. */
  #sectionField(
    field: CampaignEditorField,
    value: Readonly<Record<string, unknown>>,
    record: CampaignRecord | undefined,
    unlabelled = false,
  ) {
    const key = record?.key ?? "";
    const collection = this.page.collection;
    const faction = this.#factionDraft ?? editorValue(value["faction"]);
    if (collection === "characters" && field.key === "rankAssignment") {
      const ranked = factionRankChains(this.#snapshot, faction).some(({ ranks }) => ranks.length);
      // A stored rank stays visible, so it can be seen and cleared.
      const stored = faction === editorValue(value["faction"]) && text(value["rankChain"]) !== "";
      return html`<div class="record-form-depends wide-field" ?hidden=${!ranked && !stored}>
        <p class="record-form-depends-why">↳ ${uiText("form.rankBecause", { faction: campaignFactionIdentity(this.#snapshot, faction)?.name ?? "" })}</p>
        ${this.#field(field, value, key)}
      </div>`;
    }
    if (collection === "characters" && field.key === "attitudes") {
      // A party member's attitudes are cleared on save.
      const party = faction === "party";
      return html`${party ? html`<p class="record-form-depends-why wide-field">↳ ${uiText("form.partyAttitudes")}</p>` : nothing}
        <div class="record-form-slot wide-field" ?hidden=${party}>${this.#field(field, value, key)}</div>`;
    }
    if (collection === "locations" && field.key === "parentId" && record !== undefined) {
      const stored = editorValue(value["parentId"]);
      const changed = (this.#watched.get("parentId") ?? stored) !== stored;
      // Its help applies only once the parent changes, so it moves into the group.
      const { help, ...quiet } = field;
      return html`${this.#field(quiet, value, key)}
        <div class="record-form-depends" ?hidden=${!changed}>
          <p class="record-form-depends-why">↳ ${uiText("form.parentBecause")}</p>
          <small class="field-help">${help}</small>
        </div>`;
    }
    return this.#field(field, value, key, unlabelled);
  }

  /** What a section shows besides its fields. */
  #extras(
    section: RecordFormSection,
    value: Readonly<Record<string, unknown>>,
    record: CampaignRecord | undefined,
  ) {
    const collection = this.page.collection;
    if (collection === "characters" && section.id === "connections")
      return html`<campaign-relationship-editor
        .campaign=${this.#snapshot} .character=${record} .canManageVisibility=${this.canManageVisibility}
        .recordIdentity=${`${record?.key ?? "new"}:${this.#generation}`}></campaign-relationship-editor>`;
    if (collection === "locations" && section.id === "map")
      return this.#locationMapControls(record, value);
    if (collection === "factions" && section.id === "look") return this.#factionPreview(value);
    return nothing;
  }

  /** The side column: the record's picture, then its Settings. */
  #side(
    value: Readonly<Record<string, unknown>>,
    record: CampaignRecord | undefined,
    settings: readonly CampaignEditorField[],
  ) {
    const collection = this.page.collection;
    const visibility = collectionManagesVisibility(collection) && this.canManageVisibility;
    return html`<aside class="record-form-side">
      ${
        recordPictureKinds[collection] === undefined
          ? nothing
          : html`<section class="record-form-panel record-form-picture">
          <codex-portrait-editor .noun=${collection === "factions" ? "picture" : "portrait"}
            .fallback=${collection === "factions" ? text(value["badge"]) : ""}
            .portrait=${value["portrait"]} .creating=${record === undefined} .disabled=${this.#locked}></codex-portrait-editor>
        </section>`
      }
      ${
        visibility || settings.length
          ? html`<section class="record-form-panel record-form-settings" aria-labelledby="record-form-settings">
          <h3 id="record-form-settings">${uiText("form.settings")}</h3>
          ${visibility ? this.#visibility(value) : nothing}
          ${settings.map((field) => this.#field(field, value, record?.key ?? ""))}
        </section>`
          : nothing
      }
    </aside>`;
  }

  /** The faction's chip as characters show it, following the form as it changes. */
  #factionPreview(value: Readonly<Record<string, unknown>>) {
    const current = (key: string): string => this.#watched.get(key) ?? text(value[key]);
    return html`<div class="record-form-preview wide-field">
      <span class="record-form-preview-label">${uiText("form.preview")}</span>
      ${renderFactionChip(
        {
          name: current("name").trim() || this.page.singular,
          icon: current("badge").trim() || "⚑",
          color: hexColor(current("color").trim()),
          picture: safeMediaURL(value["portrait"]),
          href: undefined,
        },
        false,
      )}
    </div>`;
  }

  #showSection(id: string): void {
    const section = this.querySelector<HTMLElement>(`[data-form-section="${id}"]`);
    if (section === null) return;
    section.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    section
      .querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, [contenteditable]")
      ?.focus({ preventScroll: true });
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
      <span class="record-form-preview-label">${this.#ui.t("map.locationControls")}</span>
      ${
        record === undefined
          ? html`<p class="field-help">${this.#ui.t("map.saveLocationFirst")}</p>`
          : html`<div class="location-map-actions">${locationPlacementLinks(record, true)}
            <a class="ui-action" href=${mapHref(record.key)}>${this.#ui.t("map.local")}</a>
          </div>
          ${image === undefined ? nothing : html`<img class="location-map-preview" src=${previewResourceURL(image)} alt=${this.#ui.t("map.local")} />`}`
      }
    </section>`;
  }

  #visibility(value: Readonly<Record<string, unknown>>) {
    const dm = value["visibility"] === "dm";
    return html`<fieldset data-ui="choices" class="record-choices">
      <legend>${uiText("Visibility")}</legend>
      <label><input type="radio" name="visibility" value="public" .checked=${!dm} />${uiText("Public")}</label>
      <label><input type="radio" name="visibility" value="dm" .checked=${dm} />${uiText("DM only")}</label>
    </fieldset>`;
  }

  /** A field's control; `unlabelled` leaves out a writer's visible name where its section shows it. */
  #field(
    field: CampaignEditorField,
    value: Readonly<Record<string, unknown>>,
    currentKey: string,
    unlabelled = false,
  ) {
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
      return html`<section class="markdown-editor wide-field">${unlabelled ? nothing : html`<span class="markdown-editor-label" aria-hidden="true">${field.label}</span>`}<codex-markdown-editor
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
    return recordFieldControl(this.#snapshot, field, value, currentKey, {
      collection: this.page.collection,
      onFactionChange: this.#updateFaction,
    });
  }

  readonly #updateFaction = (event: Event): void => {
    const factionID = (event.currentTarget as HTMLSelectElement).value;
    this.#factionDraft = factionID;
    this.requestUpdate();
    this.querySelectorAll<CampaignStructuredFieldElement>("campaign-structured-field").forEach(
      (editor) => editor.setFaction(factionID),
    );
  };

  readonly #markDirty = (): void => {
    if (this.#locked) return;
    this.saveError = "";
    this.#setDirty(true);
  };

  /** Marks the form changed and follows the fields other parts of the form depend on. */
  readonly #edited = (event: Event): void => {
    this.#markDirty();
    const target = event.target;
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) &&
      ["name", "badge", "color", "parentId", "visibility"].includes(target.name) &&
      this.#watched.get(target.name) !== target.value
    ) {
      this.#watched.set(target.name, target.value);
      this.requestUpdate();
    }
  };

  /** Ctrl+S (Cmd+S) saves; leaving the field first reports its change. */
  readonly #shortcut = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() !== "s" || !(event.ctrlKey || event.metaKey) || event.altKey)
      return;
    event.preventDefault();
    if (event.target instanceof HTMLElement) event.target.blur();
    (event.currentTarget as HTMLFormElement).requestSubmit();
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
    this.#watched.clear();
    this.#submittedMarkdown = [];
    this.#generation++;
    this.#setDirty(false);
    this.dispatchEvent(
      new CustomEvent<RecordFormSavedDetail>("record-form-saved", {
        detail: {
          destination:
            route.kind === "create" && route.context
              ? creationBackHref(route, result.campaign)
              : route.kind === "record" && route.editing && route.returnTo
                ? route.returnTo
                : recordHref(this.page, detail.key),
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
