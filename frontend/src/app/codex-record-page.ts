import "./codex-investigation-queue.js";
import { investigationStatus } from "./campaign-investigation.js";
import { investigationBadge, investigationAnswers } from "./investigation-view.js";
import { contextualCreationFields, creationSource, creationBackHash } from "./context-creation.js";
import { articleContext, articleOwner, articleReferences } from "./article-context.js";
import { renderArticleContext, renderArticleReferences } from "./article-context-view.js";
import { editorValue, recordFieldControl } from "./record-field-controls.js";
import { uiText, uiSourceLabel } from "./ui-localization.js";
import "./codex-portrait-editor.js";
import "./codex-record-twins.js";
import { CodexCharacterProfile } from "./codex-character-profile.js";
import { CodexMarkdownEditor } from "./codex-markdown-editor.js";
import type { CodexPortraitEditor } from "./codex-portrait-editor.js";
import { previewResourceURL } from "../core/player-preview.js";
import { LitElement, html, nothing, type TemplateResult } from "lit";
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
  relationshipBaseFor,
  type CampaignEditDirtyDetail,
  type CampaignEditorField,
  type CampaignRecordDeleteDetail,
  type CampaignRecordSaveDetail,
} from "./campaign-record-editor.js";
import { campaignEnumDisplayLabel } from "./campaign-settings.js";
import {
  factionRankChains,
  type CampaignRelationshipEditorElement,
  type CampaignStructuredFieldElement,
} from "./campaign-structured-editors.js";
import {
  campaignMarkdownOutline,
  parseCampaignMarkdownDocuments,
  renderCampaignMarkdown,
  type CampaignMarkdownContext,
} from "./campaign-markdown.js";
import {
  projectEntity,
  recordValue,
  safeMediaURL,
  stringList,
  text,
  type EntitySummary,
} from "./campaign-projection.js";
import { contextCreationActions, contextualCreateHash, recordEditHash, recordHash, collectionHash, mapHash, eventMapHash, locationMapHash, type ContextCreationAction, type AppRoute } from "./routes.js";
import { eventMapParent, hasEventPin, mapParent, mapCoordinate } from "./campaign-map.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonLinksController } from "./addon-links-controller.js";
import { bindRuleDetails } from "./codex-addon-rule-details.js";
import "./codex-collection-browser.js";
import "./codex-local-drafts.js";
import "./codex-record-contributions.js";
import { collectionModel } from "./collection-model.js";
import { defaultCollectionView, parseCollectionView, readCollectionView, rememberCollectionView, serializeCollectionView, type CollectionView } from "./collection-view.js";
type RecordRoute = Extract<AppRoute, { kind: "collection" | "record" | "create" }>;

export class CodexRecordPage extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    registry: { attribute: false }, actorRole: { attribute: false },
    route: { attribute: false },
    canEdit: { type: Boolean, attribute: "can-edit" },
    canManageVisibility: { type: Boolean, attribute: "can-manage-visibility" },
    saving: { type: Boolean },
    saveState: { attribute: false },
    editCompletion: { type: Number, attribute: false },
    collectionView: { state: true }, viewStorageUnavailable: { state: true },
    editor: { state: true }, coreSaved: { state: true },
    characterEditorTab: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  readonly #links = new AddonLinksController(this, () => ({ registry: this.registry, role: this.actorRole }));
  declare route: RecordRoute | undefined;
  declare canEdit: boolean;
  declare canManageVisibility: boolean;
  declare saving: boolean;
  declare saveState: "idle" | "saved" | "failed";
  declare editCompletion: number;
  declare private collectionView: CollectionView;
  declare private viewStorageUnavailable: boolean;
  declare private editor: "closed" | "create" | "edit";
  declare private characterEditorTab: "details" | "connections" | "knowledge";
  #dirty = false;
  declare private coreSaved: boolean;
  readonly #ui = new UiLocalizationController(this);
  // Live projections continue updating, but an open form owns its original base.
  #editCampaign: CampaignDataset | undefined;
  #factionDraft: string | undefined;
  readonly #markdownDrafts = new Map<string, string>();
  #submittedMarkdown: readonly { editor: CodexMarkdownEditor; value: string }[] = [];
  #pendingViewHash: string | undefined;
  #disposeRuleDetails: (() => void) | undefined;

  constructor() {
    super();
    this.campaign = undefined;
    this.route = undefined;
    this.canEdit = false;
    this.canManageVisibility = false;
    this.saving = false;
    this.saveState = "idle";
    this.editCompletion = 0; this.coreSaved = false;
    this.collectionView = defaultCollectionView; this.viewStorageUnavailable = false;
    this.editor = "closed";
    this.characterEditorTab = "details";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#disposeRuleDetails = bindRuleDetails(this, this.#links, { presentSDK: false });
    this.addEventListener("invalid", this.#revealInvalidField, true);
  }

  override disconnectedCallback(): void {
    this.removeEventListener("invalid", this.#revealInvalidField, true);
    this.#disposeRuleDetails?.(); this.#disposeRuleDetails = undefined;
    super.disconnectedCallback();
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("actorRole") || changed.has("canEdit") && !this.canEdit) {
      this.editor = "closed"; this.#resetEditors(); this.#setDirty(false);
    }
    if (changed.has("route")) {
      this.#links.retry();
      const previous = changed.get("route") as RecordRoute | undefined;
      const sameCollection = previous?.kind === "collection" && this.route?.kind === "collection" && previous.page.id === this.route.page.id;
      if (!sameCollection) {
        this.editor = "closed"; this.#resetEditors(); this.#setDirty(false);
      }
    }
    if ((changed.has("route") || changed.has("actorRole")) && this.route?.kind === "collection") {
      const roleChanged = changed.has("actorRole") && changed.get("actorRole") !== undefined;
      this.collectionView = this.route.view !== undefined && !roleChanged ? parseCollectionView(this.route.view)
        : readCollectionView(this.route.page.id, this.actorRole ?? "public");
      this.viewStorageUnavailable = this.route.view !== undefined && !roleChanged && !rememberCollectionView(this.route.page.id, this.actorRole ?? "public", this.collectionView);
      if (roleChanged) this.#pendingViewHash = `${collectionHash(this.route.page)}?${serializeCollectionView(this.collectionView)}`;
    }
    if (changed.has("editCompletion")) {
      for (const { editor, value } of this.#submittedMarkdown) editor.acknowledgeSave(value);
      if (!this.registry?.edits.state().dirty && !this.registry?.edits.state().saving) this.editor = "closed";
      this.#resetEditors();
      this.coreSaved = this.editor !== "closed";
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
      const source = creationSource(this.route, this.#editorCampaign);
      const liveSource = creationSource(this.route, this.campaign);
      return html`<article class="record-article editor-article" aria-labelledby="record-editor-title">
        <a href=${creationBackHash(this.route, this.campaign)} class="breadcrumb-link">${source ? uiText("creation.back", {"0": liveSource?.record ? text(recordValue(liveSource.record)["name"]) || source.page.plural : source.page.plural}) : this.route.preset === "party" ? uiText("Back to party") : this.route.preset === "event" ? this.#ui.t("timeline.back") : this.route.page.plural}</a>
        ${source?.record ? html`<p class="creation-context">${uiText("creation.from")} <a class="article-reference" href=${creationBackHash(this.route, this.campaign)}>${text(recordValue(source.record)["name"]) || source.page.singular}</a></p>` : nothing}
        ${source && !liveSource?.record ? html`<p role="alert">${uiText("creation.unavailable")}</p>` : nothing}
        ${source && !source.record ? html`<h1 id="record-editor-title">${uiText("Add {0}", {"0": this.route.page.singular.toLocaleLowerCase()})}</h1>` : this.canEdit ? this.#editorForm(undefined, this.route) : html`
          <h1 id="record-editor-title">${this.route.preset === "party" ? uiText("Add party member") : uiText("Add {0}", {"0": this.route.page.singular.toLocaleLowerCase()})}</h1>
          <button type="button" @click=${() => this.dispatchEvent(new CustomEvent("campaign-sign-in", { bubbles: true, composed: true }))}>${uiText("Sign in")}</button>
        `}
      </article>`;
    }
    return this.route.kind === "collection"
      ? this.#collection(this.route)
      : this.#record(campaign, this.route);
  }

  protected override updated(): void {
    if (this.#pendingViewHash) {
      const hash = this.#pendingViewHash; this.#pendingViewHash = undefined;
      this.dispatchEvent(new CustomEvent("campaign-collection-view", { detail: { hash }, bubbles: true, composed: true }));
    }
  }

  get #editorCampaign(): CampaignDataset {
    return this.#editCampaign ?? this.campaign!;
  }

  #collection(route: Extract<RecordRoute, { kind: "collection" }>) {
    return html`
      <article class="collection-page" data-collection=${route.page.collection} aria-labelledby="collection-title">
        <header class="page-heading collection-heading">
          <div>
            <h1 id="collection-title">${route.page.plural}</h1>
          </div>
          ${this.canEdit ? html`
            <button class="record-action primary-record-action" type="button" @click=${this.#startCreate} ?disabled=${this.saving || this.editor !== "closed"}>
              ${uiText("Add {0}", { "0": route.page.singular.toLocaleLowerCase() })}
            </button>
          ` : nothing}
        </header>
        ${this.editor === "create" ? this.#editorForm(undefined, route) : nothing}
        ${route.page.collection === "mysteries" ? html`<button type="button" class="record-action investigation-jump" @click=${() => { const queue = this.querySelector<HTMLElement>(".investigation-queue"); queue?.scrollIntoView({block:"start"}); queue?.focus({preventScroll:true}); }}>${uiText("investigation.queue")}</button>` : nothing}
        <codex-collection-browser .model=${collectionModel(this.campaign!, route.page)} .view=${this.collectionView}
          .renderEntry=${(entity: EntitySummary) => recordRow(entity, route.page.icon, this.canEdit ? recordEditHash(route.page, entity.key, route.view === undefined ? collectionHash(route.page) : `${collectionHash(route.page)}?${route.view}`) : undefined)} .storageUnavailable=${this.viewStorageUnavailable}
          @collection-view-change=${this.#changeCollectionView}></codex-collection-browser>
        ${route.page.collection === "mysteries" ? html`<codex-investigation-queue .campaign=${this.campaign} .canEdit=${this.canEdit}></codex-investigation-queue>` : nothing}
        ${this.canEdit ? html`<codex-local-drafts .campaign=${this.campaign} .page=${route.page} .actorRole=${this.actorRole}></codex-local-drafts>` : nothing}
      </article>
    `;
  }

  #record(dataset: CampaignDataset, route: Extract<RecordRoute, { kind: "record" }>) {
    const collection = campaignCollection(dataset, route.page.collection);
    const profile = this.querySelector<CodexCharacterProfile>("codex-character-profile");
    const retained = this.canEdit && route.page.collection === "characters" && profile?.actorRole === this.actorRole && profile?.record.key === route.key && profile.hasDraft ? profile : undefined;
    const record = collection.records.find(({ key }) => key === route.key) ?? retained?.record;
    if (record === undefined) {
      return html`
        <article class="record-article missing-record">
          <a href=${route.page.collection === "events" ? "#/timeline" : collectionHash(route.page)} class="breadcrumb-link">${route.page.collection === "events" ? this.#ui.t("timeline.back") : uiText("Back to {0}", { "0": route.page.plural })}</a>
          <h1>${uiText("Entry not found")}</h1>
          <p>${uiText("This entry is not available in the current campaign view.")}</p>
        </article>
      `;
    }
    const entity = projectEntity(dataset, record, route.page);
    if (entity === undefined) return nothing;
    const value = recordValue(record);
    if (route.editing && !this.canEdit) return html`<article class="record-article editor-article">
      <a class="breadcrumb-link" href=${route.returnTo ?? recordHash(route.page, route.key)}>${route.page.plural}</a>
      <h1>${uiText("Edit {0}", {"0": entity.name})}</h1>
      <button type="button" @click=${() => this.dispatchEvent(new CustomEvent("campaign-sign-in", {bubbles:true, composed:true}))}>${uiText("Sign in")}</button>
    </article>`;
    if (this.editor === "edit") {
      return html`
        <article class="record-article editor-article" aria-labelledby="record-editor-title">
          <a href=${route.returnTo ?? (route.page.collection === "events" ? "#/timeline" : collectionHash(route.page))} class="breadcrumb-link">${route.returnTo ? uiText("creation.backPage") : route.page.collection === "events" ? this.#ui.t("timeline.back") : route.page.plural}</a>
          ${this.#editorForm(record, route)}
          ${this.coreSaved ? html`<p role="status">${this.#ui.t("recordAddons.coreSaved")}</p>` : nothing}
          <codex-record-contributions .registry=${this.registry} .actorRole=${this.actorRole}
            .record=${campaignCollection(this.campaign!, route.page.collection).records.find(item => item.key === route.key)}
            .collection=${route.page.collection} .mode=${"editor"} ?inert=${this.saving}></codex-record-contributions>
        </article>
      `;
    }
    const twins = this.canManageVisibility && this.actorRole === "dm" ? html`<codex-record-twins
      .campaign=${dataset} .record=${record} .page=${route.page} .disabled=${this.saving}></codex-record-twins>` : nothing;
    const facts = articleFacts(dataset, route.page.collection, value);
    const sections = [...articleSections(route.page.collection === "mysteries" ? {...value, questions: undefined} : value)];
    if (route.page.collection === "locations" && this.actorRole === "dm" && text(value["notes"])) {
      sections.push({ heading: uiText("notes.private"), body: text(value["notes"]) });
    }
    const contextSections = articleContext(dataset, route.page.collection, route.key);
    const documents = parseCampaignMarkdownDocuments(sections.map(({ body }) => body));
    const outline = campaignMarkdownOutline(documents);
    const markdownContext: CampaignMarkdownContext = {
      dataset,
      currentCollection: route.page.collection,
      currentKey: route.key,
      addonWiki: this.#links.wiki,
    };
    if (route.page.collection === "characters") return html`${this.#linkFailure()}${twins}<codex-character-profile
      .campaign=${dataset} .record=${record} .entity=${entity} .context=${markdownContext}
      .actorRole=${this.actorRole}
      .extraSections=${articleSections({ ...value, description: undefined, known: undefined, unknown: undefined })}
      .canEdit=${this.canEdit} .canManageVisibility=${this.canManageVisibility}
      @campaign-character-edit-all=${this.#startEdit}></codex-character-profile>`;
    return html`
      <article class=${`record-article${entity.portrait ? "" : " no-artwork"}`} aria-labelledby="record-title">
        ${this.#linkFailure()}
        ${twins}
        <a href=${route.returnTo ?? (route.page.collection === "events" ? "#/timeline" : collectionHash(route.page))} class="breadcrumb-link">${route.returnTo ? uiText("creation.backPage") : route.page.collection === "events" ? this.#ui.t("timeline.back") : route.page.plural}</a>
        ${this.#contextCreationLinks(route)}
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
                  ${entity.status === "" ? nothing : html`<span>${entity.statusLabel}</span>`}
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
            ${route.page.collection === "mysteries" ? investigationAnswers(value) : nothing}
            ${sections.length === 0 && contextSections.length === 0
              ? html`<p class="empty-state">${uiText("This entry does not have article text yet.")}</p>`
              : html`<div class="record-prose">
                  ${renderArticleContext(contextSections)}
                  ${sections.map((section, index) => html`
                    <section class=${section.heading === uiText("What is known") || section.heading === uiText("Open questions") ? "character-knowledge-section" : ""}>
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

  #contextCreationLinks(route: Extract<RecordRoute, {kind: "record"}>) {
    const labels = {"character-here":"creation.character", "event-here":"creation.event", "sub-location":"creation.child", "faction-member":"creation.member"} as const;
    const actions = (Object.keys(contextCreationActions) as ContextCreationAction[]).filter(action => contextCreationActions[action].source === route.page.collection);
    return actions.length ? html`<nav class="context-create-actions" aria-label=${uiText("creation.related")}>${actions.map(action =>
      html`<a class="record-action" href=${contextualCreateHash(action, route.key)}>${uiText(labels[action])}</a>`)}</nav>` : nothing;
  }

  readonly #changeCollectionView = (event: CustomEvent<CollectionView>): void => {
    event.stopPropagation();
    if (this.route?.kind !== "collection") return;
    this.collectionView = event.detail;
    this.viewStorageUnavailable = !rememberCollectionView(this.route.page.id, this.actorRole ?? "public", event.detail);
    this.dispatchEvent(new CustomEvent("campaign-collection-view", { detail: { hash: `${collectionHash(this.route.page)}?${serializeCollectionView(event.detail)}` }, bubbles: true, composed: true }));
  };

  #editorForm(record: CampaignRecord | undefined, route: RecordRoute) {
    const fields = editorFieldsFor(route.page.collection, this.canManageVisibility);
    const statusField = fields.find(({ key }) => key === "status");
    const value: Readonly<Record<string, unknown>> = record === undefined && route.kind === "create" && route.context
      ? contextualCreationFields(route, this.#editorCampaign)
      : record === undefined && route.kind === "create" && route.preset === "party"
      ? { faction: "party", knowledge: 4, status: statusField !== undefined &&
          editorOptionsFor(this.#editorCampaign, statusField, "").some(({ value }) => value === "alive") ? "alive" : "" }
      : record === undefined && route.kind === "create" && route.preset === "event" ? { sitting: route.sitting ?? 1 } : recordValue(record);
    const creating = record === undefined;
    const character = route.page.collection === "characters";
    return html`
      <form class=${`record-editor ${character ? "character-editor" : ""}`} @submit=${this.#submitEditor} @input=${this.#markDirty} @change=${this.#markDirty}>
        <header>
          <div>
            ${character ? nothing : html`<p class="page-kicker">${creating ? uiText("New entry") : uiText("Revision {0}", { "0": record.revision })}</p>`}
            <h2 id="record-editor-title">${creating ? uiText("Add {0}", { "0": route.page.singular.toLocaleLowerCase() }) : uiText("Edit {0}", { "0": text(value["name"]) || route.page.singular.toLocaleLowerCase() })}</h2>
            ${character ? nothing : html`<p>${uiText("Only the fields shown here are changed. Other campaign and add-on data remains untouched.")}</p>`}
          </div>
        </header>
        ${character ? this.#characterEditorFields(fields, value, record) : html`<div class="record-editor-fields">
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
          ${collectionManagesVisibility(route.page.collection) && this.canManageVisibility ? html`
            <label>
              <span>${uiText("Visibility")}</span>
              <select name="visibility" .value=${value["visibility"] === "dm" ? "dm" : "public"}>
                <option value="public">${uiText("Public")}</option>
                <option value="dm">${uiText("DM only")}</option>
              </select>
            </label>
          ` : nothing}
        </div>`}
        <footer class="record-editor-actions">
          ${record === undefined ? nothing : html`
            <button class="danger-record-action" type="button" @click=${this.#deleteRecord} ?disabled=${this.saving}>${uiText("Delete")}</button>
          `}
          <span class="record-form-status" role=${this.saveState === "failed" ? "alert" : "status"}>${uiText(this.saving ? "Saving…" : this.saveState === "failed" ? "save.failed" : this.#dirty ? "save.draft" : "save.explicit")}</span>
          <button type="button" @click=${this.#closeEditor} ?disabled=${this.saving}>${uiText("Cancel")}</button>
          <button class="primary-record-action" type="submit" ?disabled=${this.saving}>
            ${this.saving ? uiText("Saving…") : uiText("Save entry")}
          </button>
        </footer>
      </form>
    `;
  }

  #characterEditorFields(fields: readonly CampaignEditorField[], value: Readonly<Record<string, unknown>>, record: CampaignRecord | undefined) {
    const tabs = ["details", "connections", "knowledge"] as const;
    const labels = { details: uiText("Details"), connections: uiText("Connections"), knowledge: uiText("Knowledge") };
    const connections = new Set(["faction", "rankAssignment", "location", "locationRoles", "attitudes"]);
    const knowledge = new Set(["knowledge", "known", "unknown"]);
    const group = (key: string) => connections.has(key) ? "connections" : knowledge.has(key) ? "knowledge" : "details";
    return html`<div class="character-editor-layout">
      <div class="character-editor-details">
        <div class="record-tabs" role="tablist" aria-label=${uiText("Character details")}>
          ${tabs.map(tab => html`<button type="button" role="tab" id=${`character-editor-tab-${tab}`}
            aria-controls=${`character-editor-panel-${tab}`} aria-selected=${this.characterEditorTab === tab}
            tabindex=${this.characterEditorTab === tab ? 0 : -1}
            @click=${() => { this.characterEditorTab = tab; }} @keydown=${this.#characterEditorTabKey}>${labels[tab]}</button>`)}
        </div>
        ${tabs.map(tab => html`<section id=${`character-editor-panel-${tab}`} class="record-editor-fields"
          data-character-editor-panel=${tab} role="tabpanel" aria-labelledby=${`character-editor-tab-${tab}`}
          ?hidden=${this.characterEditorTab !== tab}>
          ${tab === "details" ? html`<codex-portrait-editor class="wide-field" .portrait=${value["portrait"]}
            .creating=${record === undefined} .disabled=${this.saving}></codex-portrait-editor>` : nothing}
          ${fields.filter(field => field.key !== "description" && group(field.key) === tab).map(field => this.#editorField(field, value, record?.key ?? ""))}
          ${tab === "connections" ? html`<campaign-relationship-editor
            .campaign=${this.#editorCampaign} .character=${record} .canManageVisibility=${this.canManageVisibility}
            .recordIdentity=${`${record?.key ?? "new"}:${this.editCompletion}`}></campaign-relationship-editor>` : nothing}
          ${tab === "details" && this.canManageVisibility ? html`<label>
            <span>${uiText("Visibility")}</span>
            <select name="visibility" .value=${value["visibility"] === "dm" ? "dm" : "public"}>
              <option value="public">${uiText("Public")}</option><option value="dm">${uiText("DM only")}</option>
            </select>
          </label>` : nothing}
        </section>`)}
      </div>
      <div class="character-editor-description">
        ${fields.filter(field => field.key === "description").map(field => this.#editorField(field, value, record?.key ?? ""))}
      </div>
    </div>`;
  }

  readonly #characterEditorTabKey = (event: KeyboardEvent): void => {
    const tabs = ["details", "connections", "knowledge"] as const;
    const index = tabs.indexOf(this.characterEditorTab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : -1;
    if (next < 0) return;
    event.preventDefault(); this.characterEditorTab = tabs[next]!;
    void this.updateComplete.then(() => this.querySelector<HTMLButtonElement>(`#character-editor-tab-${this.characterEditorTab}`)?.focus());
  };

  readonly #revealInvalidField = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
    const panel = input.closest<HTMLElement>("[data-character-editor-panel]");
    const tab = panel?.dataset["characterEditorPanel"];
    if (!panel?.hidden || (tab !== "details" && tab !== "connections" && tab !== "knowledge")) return;
    event.preventDefault(); this.characterEditorTab = tab;
    void this.updateComplete.then(() => { input.focus(); input.reportValidity(); });
  };

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
    const help = field.help === undefined ? nothing : html`<small class="field-help">${field.help}</small>`;
    if (field.kind === "markdown") {
      const source = this.#markdownDrafts.get(field.key) ?? editorValue(value[field.key]);
      const context: CampaignMarkdownContext = {
        dataset: this.#editorCampaign, addonWiki: this.#links.wiki,
        ...(this.route === undefined ? {} : { currentCollection: this.route.page.collection }),
        ...(currentKey === "" ? {} : { currentKey }),
      };
      return html`<section class="markdown-editor wide-field"><codex-markdown-editor
        .name=${field.key} .label=${field.label} .value=${source} .identity=${currentKey + ":" + field.key + ":" + this.editCompletion}
        .context=${context} .disabled=${this.saving} .maximumLength=${field.maximumLength}
        .draftContext=${this.actorRole && this.route ? { role: this.actorRole, collection: this.route.page.collection,
          record: currentKey || null, field: field.key, baseValue: editorValue(value[field.key]),
          revision: campaignCollection(this.#editorCampaign, this.route.page.collection).records.find(record => record.key === currentKey)?.revision ?? 0 } : undefined}
        .saveLabel=${uiText("Save entry")}
        @markdown-change=${(event: CustomEvent<{ value: string }>) => { this.#markdownDrafts.set(field.key, event.detail.value); this.#setDirty(true); }}
        @markdown-save=${(event: Event) => { (event.currentTarget as HTMLElement).closest("form")?.requestSubmit(); }}
      ></codex-markdown-editor>${help}</section>`;
    }
    return recordFieldControl(this.#editorCampaign, field, value, currentKey, this.#updateFactionEditor);
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
    const edits = this.registry?.edits.state();
    if (!this.saving && !edits?.saving && confirmDiscardUnsavedEdit(this.#dirty || edits?.dirty === true, (message) => window.confirm(message))) {
      this.querySelectorAll<CodexMarkdownEditor>("codex-markdown-editor").forEach(editor => editor.discardDraft());
      this.dispatchEvent(new CustomEvent("campaign-record-reset", {bubbles: true, composed: true}));
      this.#setDirty(false);
      this.editor = "closed";
      this.#resetEditors();
      if (this.route?.kind === "create") window.location.hash = creationBackHash(this.route, this.campaign!);
      else if (this.route?.kind === "record" && this.route.editing) window.location.hash = this.route.returnTo ?? (this.route.page.collection === "events" ? "#/timeline" : recordHash(this.route.page, this.route.key));
    }
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
    this.coreSaved = false;
    this.#submittedMarkdown = [];
    this.#editCampaign = undefined;
    this.#markdownDrafts.clear();
    this.#factionDraft = undefined;
    this.characterEditorTab = "details";
  }

  readonly #markDirty = (): void => {
    if (this.editor !== "closed" && !this.saving) { this.coreSaved = false; this.#setDirty(true); }
  };

  #setDirty(dirty: boolean): void {
    if (this.#dirty === dirty) return;
    this.#dirty = dirty;
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent<CampaignEditDirtyDetail>("campaign-edit-dirty", {
      detail: Object.freeze({ dirty }),
      bubbles: true,
      composed: true,
    }));
  }

  readonly #submitEditor = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.canEdit || this.saving || this.registry?.edits.state().saving || this.campaign === undefined || this.route === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const structured = new Map([...form.querySelectorAll<CampaignStructuredFieldElement>("campaign-structured-field")]
      .map((editor) => [editor.fieldKey, editor.editorValue()]));
    const fields: Record<string, unknown> = {};
    for (const field of editorFieldsFor(this.route.page.collection, this.canManageVisibility)) {
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
    const portrait = form.querySelector<CodexPortraitEditor>("codex-portrait-editor")?.editorValue();
    const detail: CampaignRecordSaveDetail = {
      collection: this.route.page.collection,
      key,
      expectedRevision: record?.revision ?? 0,
      creating,
      fields: Object.freeze(fields),
      ...(portrait !== undefined ? { portrait } : {}),
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
    this.#submittedMarkdown = [...form.querySelectorAll<CodexMarkdownEditor>("codex-markdown-editor")]
      .map(editor => ({ editor, value: editor.value }));
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

function recordRow(entity: EntitySummary, fallback: string, editHref?: string) {
  return html`<div class="record-row-shell">
    <a class=${`record-row${entity.portrait ? "" : " no-artwork"}`} href=${entity.route}>
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
        ${entity.route.startsWith("#/mysteries/") ? investigationBadge(entity.raw) : nothing}
        ${entity.route.startsWith("#/characters/") && entity.statusLabel ? html`<span>${entity.statusLabel}</span>` : nothing}
        ${entity.partyIdentity ? html`<span class="party-identity-badge">${entity.partyIdentity.badge} ${entity.partyIdentity.name}</span>` : nothing}
        ${entity.excerpt === "" ? nothing : html`<small>${entity.excerpt}</small>`}
      </span>
      ${entity.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
    </a>${editHref ? html`<a class="record-row-edit record-action" href=${editHref} aria-label=${uiText("Edit {0}", {"0": entity.name})}>${uiText("Edit")}</a>` : nothing}
  </div>`;
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
): readonly (readonly [string, string | TemplateResult])[] {
  const fields = factDefinitions[collection] ?? [];
  const facts: Array<readonly [string, string | TemplateResult]> = [];
  for (const [label, field, referenceCollection] of fields) {
    const raw = collection === "mysteries" && field === "solved" ? investigationStatus(value).solved : value[field];
    const enumCategory = articleEnumCategory(collection, field);
    const result = enumCategory !== undefined
      ? campaignEnumDisplayLabel(dataset, enumCategory, raw)
      : referenceCollection === undefined
        ? printable(raw)
        : articleReferences(dataset, referenceCollection, raw).length ? renderArticleReferences(articleReferences(dataset, referenceCollection, raw)) : "";
    if (result !== "") facts.push([uiSourceLabel(label), result]);
  }
  if (collection === "pets") {
    const owner = articleOwner(dataset, value);
    if (owner.length) facts.push([uiText("Owner"), renderArticleReferences(owner)]);
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

function printable(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? uiText("Yes") : uiText("No");
  if (Array.isArray(value)) return stringList(value).join(", ");
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
