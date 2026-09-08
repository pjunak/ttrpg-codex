import { uiText } from "./ui-localization.js";
import { previewResourceURL } from "../core/player-preview.js";
import { LitElement, html, nothing } from "lit";
import { campaignPartyIdentity } from "./campaign-party.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import {
  collectionManagesVisibility,
  createCampaignRecordKey,
  editorFieldsFor,
  editorOptionsFor,
  relationshipEditorRowsFor,
  relationshipBaseFor,
  relationshipTypeOptionsFor,
  type CampaignEditDirtyDetail,
  type CampaignEditorField,
  type CampaignRecordDeleteDetail,
  type CampaignRecordSaveDetail,
} from "./campaign-record-editor.js";
import { campaignEnumDisplayLabel } from "./campaign-settings.js";
import {
  factionRankChains,
  locationRoleDrafts,
  rankChainDrafts,
  type CampaignRelationshipEditorElement,
  type CampaignStructuredFieldElement,
} from "./campaign-structured-editors.js";
import {
  campaignMarkdownOutline,
  parseCampaignMarkdown,
  parseCampaignMarkdownDocuments,
  renderCampaignMarkdown,
  type CampaignMarkdownContext,
} from "./campaign-markdown.js";
import {
  projectEntities,
  recordValue,
  safeMediaURL,
  stringList,
  text,
  type EntitySummary,
} from "./campaign-projection.js";
import { collectionHash, mapHash, eventMapHash, locationMapHash, type AppRoute } from "./routes.js";
import { eventMapParent, hasEventPin, mapParent, mapCoordinate } from "./campaign-map.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonLinksController } from "./addon-links-controller.js";

type RecordRoute = Extract<AppRoute, { kind: "collection" | "record" | "create" }>;

export class CodexRecordPage extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    registry: { attribute: false }, actorRole: { attribute: false },
    route: { attribute: false },
    canEdit: { type: Boolean, attribute: "can-edit" },
    canManageVisibility: { type: Boolean, attribute: "can-manage-visibility" },
    saving: { type: Boolean },
    editCompletion: { type: Number, attribute: false },
    query: { state: true },
    editor: { state: true },
    markdownPreviews: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  readonly #links = new AddonLinksController(this, () => ({ registry: this.registry, role: this.actorRole }));
  declare route: RecordRoute | undefined;
  declare canEdit: boolean;
  declare canManageVisibility: boolean;
  declare saving: boolean;
  declare editCompletion: number;
  declare private query: string;
  declare private editor: "closed" | "create" | "edit";
  declare private markdownPreviews: readonly string[];
  #dirty = false;
  readonly #ui = new UiLocalizationController(this);
  // Live projections continue updating, but an open form owns its original base.
  #editCampaign: CampaignDataset | undefined;
  #factionDraft: string | undefined;
  readonly #markdownDrafts = new Map<string, string>();

  constructor() {
    super();
    this.campaign = undefined;
    this.route = undefined;
    this.canEdit = false;
    this.canManageVisibility = false;
    this.saving = false;
    this.editCompletion = 0;
    this.query = "";
    this.editor = "closed";
    this.markdownPreviews = Object.freeze([]);
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("route")) {
      this.#links.retry();
      this.query = "";
      this.editor = "closed";
      this.#resetEditors();
      this.#setDirty(false);
    }
    if (changed.has("editCompletion")) {
      this.editor = "closed";
      this.#resetEditors();
      this.#setDirty(false);
    }
    if (this.route?.kind === "create" && this.canEdit && this.campaign !== undefined && this.editor === "closed") {
      this.#editCampaign = this.campaign;
      this.editor = "create";
    }
    if ((changed.has("route") || changed.has("canEdit")) && this.route?.kind === "record" && this.route.editing && this.canEdit) {
      this.#editCampaign = this.campaign; this.editor = "edit";
    }
  }

  protected override render() {
    if (this.campaign === undefined || this.route === undefined) return nothing;
    const campaign = this.#editorCampaign;
    if (this.route.kind === "create") {
      return html`<article class="record-article editor-article" aria-labelledby="record-editor-title">
        <a href=${this.route.preset === "party" ? "#/party" : "#/timeline"} class="breadcrumb-link">${this.route.preset === "party" ? uiText("Back to party") : this.#ui.t("timeline.back")}</a>
        ${this.canEdit ? this.#editorForm(undefined, this.route) : html`
          <h1 id="record-editor-title">${this.route.preset === "party" ? uiText("Add party member") : this.#ui.t("timeline.newEvent")}</h1>
          <button type="button" @click=${() => this.dispatchEvent(new CustomEvent("campaign-sign-in", { bubbles: true, composed: true }))}>${uiText("Sign in")}</button>
        `}
      </article>`;
    }
    return this.route.kind === "collection"
      ? this.#collection(campaign, this.route)
      : this.#record(campaign, this.route);
  }

  get #editorCampaign(): CampaignDataset {
    return this.#editCampaign ?? this.campaign!;
  }

  #collection(dataset: CampaignDataset, route: Extract<RecordRoute, { kind: "collection" }>) {
    const entities = projectEntities(dataset, route.page);
    const needle = this.query.trim().toLocaleLowerCase();
    const visible = needle === "" ? entities : entities.filter((entity) =>
      [entity.name, entity.title, entity.excerpt, ...entity.tags]
        .join(" ").toLocaleLowerCase().includes(needle)
    );
    return html`
      <article class="collection-page" data-collection=${route.page.collection} aria-labelledby="collection-title">
        <header class="page-heading collection-heading">
          <div>
            <h1 id="collection-title">${route.page.plural}</h1>
            <p aria-live="polite">${uiText("{0} / {1} records", { "0": visible.length, "1": entities.length })}</p>
          </div>
          ${this.canEdit ? html`
            <button class="record-action primary-record-action" type="button" @click=${this.#startCreate} ?disabled=${this.saving || this.editor !== "closed"}>
              ${uiText("Add {0}", { "0": route.page.singular.toLocaleLowerCase() })}
            </button>
          ` : nothing}
        </header>
        ${this.editor === "create" ? this.#editorForm(undefined, route) : nothing}
        <label class="collection-search">
          <span>${uiText("Filter {0}", { "0": route.page.plural.toLocaleLowerCase() })}</span>
          <input
            type="search"
            .value=${this.query}
            placeholder=${uiText("Name, title, or tag")}
            @input=${this.#onSearch}
          />
        </label>
        ${visible.length === 0
          ? html`<p class="empty-state">${uiText("No matching entries are recorded in this part of the archive.")}</p>`
          : html`<div class="record-ledger">${visible.map((entity) => recordRow(entity, route.page.icon))}</div>`}
      </article>
    `;
  }

  #record(dataset: CampaignDataset, route: Extract<RecordRoute, { kind: "record" }>) {
    const collection = campaignCollection(dataset, route.page.collection);
    const record = collection.records.find(({ key }) => key === route.key);
    if (record === undefined) {
      return html`
        <article class="record-article missing-record">
          <a href=${route.page.collection === "events" ? "#/timeline" : collectionHash(route.page)} class="breadcrumb-link">${route.page.collection === "events" ? this.#ui.t("timeline.back") : uiText("Back to {0}", { "0": route.page.plural })}</a>
          <h1>${uiText("Entry not found")}</h1>
          <p>${uiText("This entry is not available in the current campaign view.")}</p>
        </article>
      `;
    }
    const entity = projectEntities(dataset, route.page).find(({ key }) => key === route.key);
    if (entity === undefined) return nothing;
    const value = recordValue(record);
    if (this.editor === "edit") {
      return html`
        <article class="record-article editor-article" aria-labelledby="record-editor-title">
          <a href=${route.page.collection === "events" ? "#/timeline" : collectionHash(route.page)} class="breadcrumb-link">${route.page.collection === "events" ? this.#ui.t("timeline.back") : route.page.plural}</a>
          ${this.#editorForm(record, route)}
        </article>
      `;
    }
    const facts = articleFacts(dataset, route.page.collection, value);
    const sections = articleSections(value);
    const hasStructuredSections = hasStructuredArticleContent(dataset, route.page.collection, route.key, value);
    const documents = parseCampaignMarkdownDocuments(sections.map(({ body }) => body));
    const outline = campaignMarkdownOutline(documents);
    const markdownContext: CampaignMarkdownContext = {
      dataset,
      currentCollection: route.page.collection,
      currentKey: route.key,
      addonWiki: this.#links.wiki,
    };
    return html`
      <article class="record-article" aria-labelledby="record-title">
        ${this.#linkFailure()}
        <a href=${route.page.collection === "events" ? "#/timeline" : collectionHash(route.page)} class="breadcrumb-link">${route.page.collection === "events" ? this.#ui.t("timeline.back") : route.page.plural}</a>
        <div class="record-reading-layout">
          <aside class="record-side">
            <header class="record-masthead">
              ${entity.portrait === undefined ? recordPlaceholder(entity, route.page.icon, "record-portrait record-portrait-placeholder") : html`
                <img
                  class="record-portrait"
                  src=${previewResourceURL(entity.portrait)}
                  alt=""
                  style=${entity.attitudeRing === undefined ? nothing : `--attitude-ring: ${entity.attitudeRing}`}
                />
              `}
              <div>
                <span class="record-kind">${route.page.singular}</span>
                <h1 id="record-title">${entity.name}</h1>
                ${entity.title === "" ? nothing : html`<p>${entity.title}</p>`}
                <div class="record-badges">
                  ${entity.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
                  ${entity.status === "" ? nothing : html`<span>${entity.status}</span>`}
                  ${entity.partyIdentity === undefined ? nothing : html`<span class="party-identity-badge"
                    style=${`background: ${entity.partyIdentity.color}; color: ${entity.partyIdentity.textColor}`}>${entity.partyIdentity.badge} ${entity.partyIdentity.name}</span>`}
                  ${entity.attitudes.filter(attitude => entity.partyIdentity === undefined || attitude.id !== "party").map((attitude) => html`
                    <span class="attitude-badge" style=${`--attitude-color: ${attitude.color}`}>${attitude.label}</span>
                  `)}
                  ${entity.tags.map((tag) => html`<span>${tag}</span>`)}
                </div>
              </div>
              ${this.canEdit ? html`
                <button class="record-action" type="button" @click=${this.#startEdit} ?disabled=${this.saving}>${uiText("Edit")}</button>
              ` : nothing}
              ${route.page.collection === "locations" ? html`
                ${this.#locationPlacementLinks(record)}
                ${value["localMap"] || this.canEdit ? html`<a class="record-action" href=${mapHash(record.key)}>${this.#ui.t("map.local")}</a>` : nothing}
              ` : nothing}
              ${route.page.collection === "events" ? html`
                ${hasEventPin(value) ? html`<a class="record-action" href=${eventMapHash(eventMapParent(value), record.key, "show")}>${this.#ui.t("map.show")}</a>` : nothing}
                ${this.canEdit ? html`<a class="record-action" href=${eventMapHash(eventMapParent(value), record.key, "place")}>${this.#ui.t(hasEventPin(value) ? "map.moveEvent" : "map.placeEvent")}</a>` : nothing}
              ` : nothing}
            </header>
            ${facts.length === 0 ? nothing : html`
              <dl class="record-facts">
                ${facts.map(([label, fact]) => html`<div><dt>${label}</dt><dd>${fact}</dd></div>`)}
              </dl>
            `}

            ${outline.length === 0 ? nothing : html`
              <aside class="record-outline" aria-label=${uiText("Article contents")}>
                <p>${uiText("In this entry")}</p>
                <ol>
                  ${outline.map((item) => html`
                    <li class=${`outline-depth-${item.depth}`}>
                      <button type="button" data-heading=${item.id} @click=${this.#scrollToHeading}>${item.text}</button>
                    </li>
                  `)}
                </ol>
              </aside>
            `}
          </aside>
          <div class="record-reading">
            ${sections.length === 0 && !hasStructuredSections
              ? html`<p class="empty-state">${uiText("This entry does not have article text yet.")}</p>`
              : html`<div class="record-prose">
                  ${structuredArticleContent(dataset, route.page.collection, route.key, value)}
                  ${sections.map((section, index) => html`
                    <section>
                      <h2 class="record-section-title">${section.heading}</h2>
                      ${documents[index] === undefined
                        ? nothing
                        : renderCampaignMarkdown(documents[index], markdownContext)}
                    </section>
                  `)}
                </div>`}
          </div>
        </div>
      </article>
    `;
  }

  readonly #onSearch = (event: Event): void => {
    this.query = (event.currentTarget as HTMLInputElement).value;
  };

  #editorForm(record: CampaignRecord | undefined, route: RecordRoute) {
    const fields = editorFieldsFor(route.page.collection);
    const statusField = fields.find(({ key }) => key === "status");
    const value: Readonly<Record<string, unknown>> = record === undefined && route.kind === "create" && route.preset === "party"
      ? { faction: "party", knowledge: 4, status: statusField !== undefined &&
          editorOptionsFor(this.#editorCampaign, statusField, "").some(({ value }) => value === "alive") ? "alive" : "" }
      : record === undefined && route.kind === "create" && route.preset === "event" ? { sitting: route.sitting ?? 1 } : recordValue(record);
    const creating = record === undefined;
    return html`
      <form class="record-editor" @submit=${this.#submitEditor} @input=${this.#markDirty} @change=${this.#markDirty}>
        <header>
          <div>
            <p class="page-kicker">${creating ? uiText("New entry") : uiText("Revision {0}", { "0": record.revision })}</p>
            <h2 id="record-editor-title">${creating ? uiText("Add {0}", { "0": route.page.singular.toLocaleLowerCase() }) : uiText("Edit {0}", { "0": text(value["name"]) || route.page.singular.toLocaleLowerCase() })}</h2>
            <p>${uiText("Only the fields shown here are changed. Other campaign and add-on data remains untouched.")}</p>
          </div>
        </header>
        <div class="record-editor-fields">
          ${fields.map((field) => this.#editorField(field, value, record?.key ?? ""))}
          ${route.page.collection === "locations" ? html`<section class="wide-field location-map-controls" aria-label=${this.#ui.t("map.locationControls")}>
            <h3>${this.#ui.t("map.locationControls")}</h3>
            ${record === undefined ? html`<p class="field-help">${this.#ui.t("map.saveLocationFirst")}</p>` : html`
              <div class="location-map-actions">${this.#locationPlacementLinks(record)}
                <a class="record-action" href=${mapHash(record.key)}>${this.#ui.t("map.local")}</a>
              </div>
              ${safeMediaURL(value["localMap"]) === undefined ? nothing : html`
                <img class="location-map-preview" src=${previewResourceURL(safeMediaURL(value["localMap"]))} alt=${this.#ui.t("map.local")} />
              `}
            `}
          </section>` : nothing}
          ${route.page.collection === "characters" ? html`
            <campaign-relationship-editor
              .campaign=${this.#editorCampaign}
              .character=${record}
              .canManageVisibility=${this.canManageVisibility}
              .recordIdentity=${`${record?.key ?? "new"}:${this.editCompletion}`}
            ></campaign-relationship-editor>
          ` : nothing}
          ${collectionManagesVisibility(route.page.collection) && this.canManageVisibility ? html`
            <label>
              <span>${uiText("Visibility")}</span>
              <select name="visibility" .value=${value["visibility"] === "dm" ? "dm" : "public"}>
                <option value="public">${uiText("Public")}</option>
                <option value="dm">${uiText("DM only")}</option>
              </select>
            </label>
          ` : nothing}
        </div>
        <footer class="record-editor-actions">
          ${record === undefined ? nothing : html`
            <button class="danger-record-action" type="button" @click=${this.#deleteRecord} ?disabled=${this.saving}>${uiText("Delete")}</button>
          `}
          <span></span>
          <button type="button" @click=${this.#closeEditor} ?disabled=${this.saving}>${uiText("Cancel")}</button>
          <button class="primary-record-action" type="submit" ?disabled=${this.saving}>
            ${this.saving ? uiText("Saving…") : uiText("Save entry")}
          </button>
        </footer>
      </form>
    `;
  }

  #locationPlacementLinks(record: CampaignRecord) {
    const value = recordValue(record), placed = mapCoordinate(value["x"]) && mapCoordinate(value["y"]);
    return html`
      ${placed ? html`<a class="record-action" href=${locationMapHash(mapParent(value), record.key, "show")}>${this.#ui.t("map.show")}</a>` : nothing}
      ${this.canEdit ? html`<a class="record-action" href=${locationMapHash(mapParent(value), record.key, "place")}>${this.#ui.t(placed ? "map.moveLocation" : "map.placeLocation")}</a>` : nothing}
    `;
  }

  #editorField(
    field: CampaignEditorField,
    value: Readonly<Record<string, unknown>>,
    currentKey: string,
  ) {
    if (field.kind === "questions" || field.kind === "rank-assignment" ||
      field.kind === "rank-chains" || field.kind === "location-roles") {
      return html`
        <campaign-structured-field
          .campaign=${this.#editorCampaign}
          .field=${field}
          .record=${value}
          .factionId=${this.#factionDraft ?? editorValue(value["faction"])}
          .recordIdentity=${`${currentKey || "new"}:${field.key}:${this.editCompletion}`}
        ></campaign-structured-field>
      `;
    }
    const wide = ["text", "markdown", "string-list", "references", "attitudes"].includes(field.kind);
    const help = field.help === undefined ? nothing : html`<small class="field-help">${field.help}</small>`;
    if (field.kind === "markdown") {
      const source = this.#markdownDrafts.get(field.key) ?? editorValue(value[field.key]);
      const previewing = this.markdownPreviews.includes(field.key);
      const id = `markdown-${this.route?.page.collection ?? "record"}-${field.key}`;
      const context: CampaignMarkdownContext = {
        dataset: this.#editorCampaign,
        ...(previewing ? { addonWiki: this.#links.wiki } : {}),
        ...(this.route === undefined ? {} : { currentCollection: this.route.page.collection }),
        ...(currentKey === "" ? {} : { currentKey }),
      };
      return html`
        <section class="markdown-editor wide-field">
          <div class="markdown-editor-heading">
            <label for=${id}>${field.label}</label>
            <div class="markdown-editor-modes" aria-label=${uiText("{0} editor mode", { "0": field.label })}>
              <button
                type="button"
                data-markdown-field=${field.key}
                data-markdown-mode="write"
                aria-pressed=${String(!previewing)}
                @click=${this.#setMarkdownMode}
              >${uiText("Write")}</button>
              <button
                type="button"
                data-markdown-field=${field.key}
                data-markdown-mode="preview"
                aria-pressed=${String(previewing)}
                @click=${this.#setMarkdownMode}
              >${uiText("Preview")}</button>
            </div>
          </div>
          <textarea
            id=${id}
            name=${field.key}
            maxlength=${field.maximumLength}
            .value=${source}
            ?required=${field.required === true}
            ?hidden=${previewing}
            @input=${this.#captureMarkdownDraft}
          ></textarea>
          <div class="markdown-editor-preview" ?hidden=${!previewing}>
            ${previewing ? this.#linkFailure() : nothing}
            ${source.trim() === ""
              ? html`<p class="empty-state">${uiText("Nothing to preview yet.")}</p>`
              : renderCampaignMarkdown(parseCampaignMarkdown(source), context)}
          </div>
          <small class="field-help">
            ${uiText("Markdown supports headings, emphasis, lists, quotes, tables, code, images, and campaign links such as")}
            <code>[[Lantern Watch]]</code>${uiText(". Raw HTML is shown as text unless it uses an existing Codex formatting token.")}
          </small>
          ${help}
        </section>
      `;
    }
    if (field.kind === "text" || field.kind === "string-list") {
      return html`
        <label class=${wide ? "wide-field" : ""}>
          <span>${field.label}</span>
          <textarea
            name=${field.key}
            maxlength=${field.kind === "text" ? field.maximumLength : nothing}
            .value=${field.kind === "string-list"
              ? editorStringList(value[field.key]).join("\n")
              : editorValue(value[field.key])}
            ?required=${field.required === true}
          ></textarea>
          ${help}
        </label>
      `;
    }
    if (field.kind === "reference" || field.kind === "owner" || field.kind === "enum") {
      const options = editorOptionsFor(this.#editorCampaign, field, currentKey);
      const stored = field.kind === "owner" ? ownerValue(value) : editorValue(value[field.key]);
      const selected = currentKey === "" && field.key === "faction" && stored === "" ? "neutral" : stored;
      const orphaned = selected !== "" && !options.some(({ value: option }) => option === selected);
      return html`
        <label>
          <span>${field.label}</span>
          <select name=${field.key} @change=${field.key === "faction" ? this.#updateFactionEditor : nothing}>
            ${field.kind === "reference" || field.kind === "enum"
              ? html`<option value="" ?selected=${selected === ""}>${uiText("Not set")}</option>` : nothing}
            ${orphaned ? html`<option value=${selected} selected>${uiText("{0} (stored)", { "0": selected })}</option>` : nothing}
            ${options.map((option) => html`
              <option value=${option.value} ?selected=${option.value === selected}>${option.label}</option>
            `)}
          </select>
          ${help}
        </label>
      `;
    }
    if (field.kind === "references" || field.kind === "attitudes") {
      const options = editorOptionsFor(this.#editorCampaign, field, currentKey);
      const selected = new Set(field.kind === "attitudes"
        ? editorAttitudes(value[field.key])
        : editorStringList(value[field.key]));
      return html`
        <label class="wide-field structured-picker">
          <span>${field.label}</span>
          <select name=${field.key} multiple size=${Math.min(8, Math.max(3, options.length))}>
            ${options.map((option) => html`
              <option value=${option.value} ?selected=${selected.has(option.value)}>${option.label}</option>
            `)}
          </select>
          ${field.help === undefined
            ? html`<small class="field-help">${uiText("Use Ctrl or Command to select more than one entry.")}</small>`
            : help}
        </label>
      `;
    }
    if (field.kind === "boolean") {
      return html`
        <label class="boolean-field">
          <input name=${field.key} type="checkbox" .checked=${value[field.key] === true} />
          <span>${field.label}</span>
          ${help}
        </label>
      `;
    }
    return html`
      <label>
        <span>${field.label}</span>
        <input
          name=${field.key}
          type=${field.kind === "number" ? "number" : "text"}
          step=${field.kind === "number" ? "any" : nothing}
          min=${field.minimum ?? nothing}
          max=${field.maximum ?? nothing}
          maxlength=${field.kind === "number" ? nothing : field.maximumLength}
          .value=${field.kind === "tags"
            ? editorStringList(value[field.key]).join(", ")
            : editorValue(value[field.key])}
          placeholder=${field.placeholder ?? ""}
          ?required=${field.required === true}
        />
        ${help}
      </label>
    `;
  }

  #linkFailure() {
    return this.#links.failed ? html`<p class="connection-alert" role="status">${this.#ui.t("wiki.failed")}
      <button type="button" @click=${this.#links.retry}>${this.#ui.t("wiki.retry")}</button></p>` : nothing;
  }

  readonly #updateFactionEditor = (event: Event): void => {
    const factionID = (event.currentTarget as HTMLSelectElement).value;
    this.#factionDraft = factionID;
    this.querySelectorAll<CampaignStructuredFieldElement>("campaign-structured-field")
      .forEach((editor) => editor.setFaction(factionID));
  };

  readonly #startCreate = (): void => {
    if (this.canEdit && !this.saving && this.editor === "closed") {
      this.#resetEditors();
      this.#editCampaign = this.campaign;
      this.#setDirty(false);
      this.editor = "create";
    }
  };

  readonly #startEdit = (): void => {
    if (this.canEdit && !this.saving && this.editor === "closed") {
      this.#resetEditors();
      this.#editCampaign = this.campaign;
      this.#setDirty(false);
      this.editor = "edit";
    }
  };

  readonly #closeEditor = (): void => {
    if (!this.saving && confirmDiscardUnsavedEdit(this.#dirty, (message) => window.confirm(message))) {
      this.#setDirty(false);
      this.editor = "closed";
      this.#resetEditors();
      if (this.route?.kind === "create") window.location.hash = this.route.preset === "party" ? "#/party" : "#/timeline";
      else if (this.route?.kind === "record" && this.route.editing) window.location.hash = "#/timeline";
    }
  };

  readonly #captureMarkdownDraft = (event: Event): void => {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    this.#markdownDrafts.set(textarea.name, textarea.value);
  };

  readonly #setMarkdownMode = (event: Event): void => {
    const button = event.currentTarget as HTMLButtonElement;
    const field = button.dataset["markdownField"];
    const mode = button.dataset["markdownMode"];
    if (field === undefined || (mode !== "write" && mode !== "preview")) return;
    const previews = new Set(this.markdownPreviews);
    if (mode === "preview") previews.add(field);
    else previews.delete(field);
    this.markdownPreviews = Object.freeze([...previews]);
  };

  readonly #scrollToHeading = (event: Event): void => {
    const id = (event.currentTarget as HTMLButtonElement).dataset["heading"];
    if (id === undefined) return;
    const heading = document.getElementById(id);
    if (heading === null) return;
    heading.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    heading.focus({ preventScroll: true });
  };

  #resetEditors(): void {
    this.#editCampaign = undefined;
    this.#markdownDrafts.clear();
    this.#factionDraft = undefined;
    this.markdownPreviews = Object.freeze([]);
  }

  readonly #markDirty = (): void => {
    if (this.editor !== "closed" && !this.saving) this.#setDirty(true);
  };

  #setDirty(dirty: boolean): void {
    if (this.#dirty === dirty) return;
    this.#dirty = dirty;
    this.dispatchEvent(new CustomEvent<CampaignEditDirtyDetail>("campaign-edit-dirty", {
      detail: Object.freeze({ dirty }),
      bubbles: true,
      composed: true,
    }));
  }

  readonly #submitEditor = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.canEdit || this.saving || this.campaign === undefined || this.route === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const structured = new Map([...form.querySelectorAll<CampaignStructuredFieldElement>("campaign-structured-field")]
      .map((editor) => [editor.fieldKey, editor.editorValue()]));
    const fields: Record<string, unknown> = {};
    for (const field of editorFieldsFor(this.route.page.collection)) {
      if (field.kind === "questions" || field.kind === "rank-assignment" ||
        field.kind === "rank-chains" || field.kind === "location-roles") {
        fields[field.key] = structured.get(field.key);
      } else if (field.kind === "references" || field.kind === "attitudes") {
        fields[field.key] = data.getAll(field.key).map(String);
      } else if (field.kind === "tags") {
        fields[field.key] = String(data.get(field.key) ?? "").split(",");
      } else if (field.kind === "string-list") {
        fields[field.key] = String(data.get(field.key) ?? "").split(/\r?\n/u);
      } else if (field.kind === "boolean") {
        fields[field.key] = data.has(field.key);
      } else {
        const raw = String(data.get(field.key) ?? "");
        fields[field.key] = field.kind === "line" ? raw.trim() : raw;
      }
    }
    const creating = this.editor === "create";
    const key = creating
      ? createCampaignRecordKey(typeof fields["name"] === "string" ? fields["name"] : this.route.page.singular)
      : this.route.kind === "record" ? this.route.key : "";
    if (key === "") return;
    const record = creating ? undefined : campaignCollection(this.#editorCampaign, this.route.page.collection).records
      .find(({ key: recordKey }) => recordKey === key);
    if (!creating && record === undefined) return;
    const detail: CampaignRecordSaveDetail = {
      collection: this.route.page.collection,
      key,
      expectedRevision: record?.revision ?? 0,
      creating,
      fields: Object.freeze(fields),
      ...(this.route.page.collection === "characters" && !creating
        ? {
            relationships: form.querySelector<CampaignRelationshipEditorElement>("campaign-relationship-editor")?.editorValue() ?? [],
            relationshipBase: relationshipBaseFor(this.#editorCampaign, key),
          }
        : {}),
      ...(collectionManagesVisibility(this.route.page.collection) && this.canManageVisibility
        ? { visibility: data.get("visibility") === "dm" ? "dm" as const : "public" as const }
        : {}),
    };
    this.dispatchEvent(new CustomEvent<CampaignRecordSaveDetail>("campaign-record-save", {
      detail,
      bubbles: true,
      composed: true,
    }));
  };

  readonly #deleteRecord = (): void => {
    if (!this.canEdit || this.saving || this.campaign === undefined || this.route?.kind !== "record") return;
    const recordKey = this.route.key;
    const target = campaignCollection(this.#editorCampaign, this.route.page.collection).records
      .find(({ key }) => key === recordKey);
    if (target === undefined ||
      !window.confirm(uiText("Delete this {0}? This cannot be undone from this page.", { "0": this.route.page.singular.toLocaleLowerCase() }))) {
      return;
    }
    const detail: CampaignRecordDeleteDetail = {
      collection: this.route.page.collection,
      key: target.key,
      expectedRevision: target.revision,
    };
    this.dispatchEvent(new CustomEvent<CampaignRecordDeleteDetail>("campaign-record-delete", {
      detail,
      bubbles: true,
      composed: true,
    }));
  };
}

function recordRow(entity: EntitySummary, fallback: string) {
  return html`
    <a class="record-row" href=${entity.route}>
      ${entity.portrait === undefined
        ? recordPlaceholder(entity, fallback, "record-row-mark")
        : html`<img
            class="record-row-mark"
            style=${entity.attitudeRing === undefined ? nothing : `--attitude-ring: ${entity.attitudeRing}`}
            src=${previewResourceURL(entity.portrait)}
            alt=""
            loading="lazy"
          />`}
      <span class="record-row-copy">
        <strong>${entity.name}</strong>
        ${entity.title === "" ? nothing : html`<span>${entity.title}</span>`}
        ${entity.excerpt === "" || entity.route.startsWith("#/characters/") ? nothing : html`<small>${entity.excerpt}</small>`}
      </span>
      ${entity.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
    </a>
  `;
}

function recordPlaceholder(entity: EntitySummary, fallback: string, className: string) {
  const portrait = entity.route.startsWith("#/characters/");
  return html`<span class=${className} aria-hidden="true"
    style=${portrait && entity.attitudeRing !== undefined ? `--attitude-ring: ${entity.attitudeRing}` : nothing}>
    <span class="record-visual-glyph"
      style=${!portrait && entity.attitudeFilter !== undefined ? `--attitude-filter: ${entity.attitudeFilter}` : nothing}>${entity.icon ?? fallback}</span>
  </span>`;
}

interface ArticleSection {
  readonly heading: string;
  readonly body: string;
}

function articleSections(value: Readonly<Record<string, unknown>>): readonly ArticleSection[] {
  const definitions: readonly (readonly [string, readonly string[]])[] = [
    [uiText("Overview"), ["description", "summary", "short"]],
    [uiText("What is known"), ["known", "clues"]],
    [uiText("History"), ["history"]],
    [uiText("Details"), ["body", "note", "mapNotes"]],
    [uiText("Open questions"), ["questions", "unknown"]],
  ];
  const seen = new Set<string>();
  const result: ArticleSection[] = [];
  for (const [heading, fields] of definitions) {
    for (const field of fields) {
      const body = articleFieldMarkdown(value[field]);
      if (body !== "" && !seen.has(body)) {
        seen.add(body);
        result.push(Object.freeze({ heading, body }));
        break;
      }
    }
  }
  return result;
}

function articleFacts(
  dataset: CampaignDataset,
  collection: string,
  value: Readonly<Record<string, unknown>>,
): readonly (readonly [string, string])[] {
  const fields = factDefinitions[collection] ?? [];
  const facts: Array<readonly [string, string]> = [];
  for (const [label, field, referenceCollection] of fields) {
    const raw = value[field];
    const enumCategory = articleEnumCategory(collection, field);
    const result = enumCategory !== undefined
      ? campaignEnumDisplayLabel(dataset, enumCategory, raw)
      : referenceCollection === undefined
        ? printable(raw)
        : referenceNames(dataset, referenceCollection, raw);
    if (result !== "") facts.push([label, result]);
  }
  if (collection === "pets") {
    const owner = petOwnerName(dataset, value);
    if (owner !== "") facts.push([uiText("Owner"), owner]);
  }
  if (collection === "characters") {
    const rank = characterRankName(dataset, value);
    if (rank !== "") facts.push([uiText("Faction rank"), rank]);
  }
  return facts;
}

function articleEnumCategory(collection: string, field: string) {
  if (collection === "characters" && field === "gender") return "genders" as const;
  if (collection === "characters" && field === "status") return "characterStatuses" as const;
  if (collection === "events" && field === "priority") return "eventPriorities" as const;
  return undefined;
}

function characterRankName(dataset: CampaignDataset, value: Readonly<Record<string, unknown>>): string {
  const factionID = text(value["faction"]);
  const chainID = text(value["rankChain"]);
  const rank = text(value["rank"]);
  if (chainID === "" || rank === "") return "";
  const chain = factionRankChains(dataset, factionID).find(({ id }) => id === chainID);
  return chain === undefined ? rank : `${chain.name} — ${rank}`;
}

function hasStructuredArticleContent(
  dataset: CampaignDataset,
  collection: string,
  key: string,
  value: Readonly<Record<string, unknown>>,
): boolean {
  if (collection === "characters") {
    return locationRoleDrafts(value["locationRoles"]).length > 0 ||
      relationshipEditorRowsFor(dataset, key, true).length > 0;
  }
  return collection === "factions" && rankChainDrafts(value["rankChains"]).length > 0;
}

function structuredArticleContent(
  dataset: CampaignDataset,
  collection: string,
  key: string,
  value: Readonly<Record<string, unknown>>,
) {
  if (collection === "characters") {
    const roles = locationRoleDrafts(value["locationRoles"]);
    const relationships = relationshipEditorRowsFor(dataset, key, true);
    const relationshipTypes = relationshipTypeOptionsFor(dataset);
    return html`
      ${roles.length === 0 ? nothing : html`
        <section class="record-structured-section">
          <h2 class="record-section-title">${uiText("Other location roles")}</h2>
          <div class="article-structured-ledger">
            ${roles.map((role) => html`
              <div><strong>${resolveName(dataset, "locations", role.locationId) ?? role.locationId}</strong><span>${role.role || uiText("Role not specified")}</span></div>
            `)}
          </div>
        </section>
      `}
      ${relationships.length === 0 ? nothing : html`
        <section class="record-structured-section">
          <h2 class="record-section-title">${uiText("Relationships")}</h2>
          <div class="article-structured-ledger relationship-reading">
            ${relationships.map((relationship) => {
              const type = relationshipTypes.find(({ value: typeID }) => typeID === relationship.type);
              const targetCollection = type?.targetCollection ?? (relationship.type === "mission" ? "locations" : "characters");
              const targetName = resolveName(dataset, targetCollection, relationship.target) ?? relationship.target;
              return html`
                <div>
                  <strong>${relationship.direction === "from" ? uiText("This character") : targetName}</strong>
                  <span class="relationship-reading-arrow">→</span>
                  <span>${relationship.label || type?.label || relationship.type}</span>
                  <span class="relationship-reading-arrow">→</span>
                  <strong>${relationship.direction === "from" ? targetName : uiText("This character")}</strong>
                  ${relationship.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
                </div>
              `;
            })}
          </div>
        </section>
      `}
    `;
  }
  if (collection === "factions") {
    const chains = rankChainDrafts(value["rankChains"]);
    if (chains.length === 0) return nothing;
    const members = campaignCollection(dataset, "characters").records.map((record) => ({
      key: record.key,
      value: recordValue(record),
    })).filter((member) => text(member.value["faction"]) === key);
    return html`
      <section class="record-structured-section">
        <h2 class="record-section-title">${uiText("Rank chains")}</h2>
        <div class="rank-chain-reading-grid">
          ${chains.map((chain) => html`
            <section>
              <h3>${chain.name}</h3>
              <ol>
                ${chain.ranks.map((rank) => {
                  const names = members.filter(({ value: member }) =>
                    text(member["rankChain"]) === chain.id && text(member["rank"]) === rank
                  ).map(({ key: memberKey, value: member }) => text(member["name"]) || memberKey);
                  return html`<li><strong>${rank}</strong>${names.length === 0 ? nothing : html`<span>${names.join(", ")}</span>`}</li>`;
                })}
              </ol>
            </section>
          `)}
        </div>
      </section>
    `;
  }
  return nothing;
}

function resolveName(dataset: CampaignDataset, collection: string, key: string): string | undefined {
  const candidate = dataset.collections.find(({ name }) => name === collection);
  const record = candidate?.records.find(({ key: recordKey }) => recordKey === key);
  const value = recordValue(record);
  return text(value["name"]) || undefined;
}

function printable(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? uiText("Yes") : uiText("No");
  if (Array.isArray(value)) return stringList(value).join(", ");
  return "";
}

function referenceNames(dataset: CampaignDataset, collection: string, value: unknown): string {
  const keys = typeof value === "string" ? [value] : stringList(value);
  return keys.map((key) => collection === "factions" && key === "party"
    ? campaignPartyIdentity(dataset).name : resolveName(dataset, collection, key) ?? key).filter(Boolean).join(", ");
}

function petOwnerName(dataset: CampaignDataset, value: Readonly<Record<string, unknown>>): string {
  const ownerType = text(value["ownerType"]);
  const ownerID = text(value["ownerId"]);
  if (ownerType === "party") return campaignPartyIdentity(dataset).name;
  if (ownerType === "character") return resolveName(dataset, "characters", ownerID) ?? ownerID;
  if (ownerType === "faction") return resolveName(dataset, "factions", ownerID) ?? ownerID;
  return "";
}

function articleFieldMarkdown(value: unknown): string {
  const direct = text(value);
  if (direct !== "") return direct;
  if (!Array.isArray(value)) return "";
  const lines = value.flatMap((candidate) => {
    if (typeof candidate === "string") {
      const line = candidate.trim();
      return line === "" ? [] : [`- ${line.replace(/\r?\n/gu, "\n  ")}`];
    }
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
    const item = candidate as Readonly<Record<string, unknown>>;
    const question = text(item["text"] ?? item["question"]);
    const answer = text(item["answer"]);
    if (question === "") return [];
    return [answer === "" ? `- ${question}` : `- **${question}**\n  ${answer.replace(/\r?\n/gu, "\n  ")}`];
  });
  return lines.join("\n");
}

function editorValue(value: unknown): string {
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

const factDefinitions: Readonly<Record<string, readonly (readonly [string, string, string?])[]>> = {
  characters: [["Species", "species"], ["Gender", "gender"], ["Age", "age"], ["Status", "status"], ["Faction", "faction", "factions"], ["Current location", "location", "locations"]],
  locations: [["Kind", "type"], ["Region", "region"], ["Parent location", "parentId", "locations"]],
  events: [["Date", "date"], ["Session", "sitting"], ["Priority", "priority"], ["Characters", "characters", "characters"], ["Locations", "locations", "locations"]],
  mysteries: [["Priority", "priority"], ["Solved", "solved"], ["Characters", "characters", "characters"], ["Locations", "locations", "locations"]],
  factions: [],
  pantheon: [["Domain", "domain"], ["Symbol", "symbol"], ["Alignment", "alignment"]],
  artifacts: [["Holder", "ownerCharacterId", "characters"], ["Location", "locationId", "locations"]],
  historicalEvents: [["Start", "start"], ["End", "end"], ["Characters", "characters", "characters"], ["Locations", "locations", "locations"]],
  pets: [["Species", "species"]],
};

if (!customElements.get("codex-record-page")) {
  customElements.define("codex-record-page", CodexRecordPage);
}
