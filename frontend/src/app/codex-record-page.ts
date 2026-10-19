import "./codex-investigation-queue.js";
import { UIControlsController } from "../ui/controller.js";
import { cardEditLink } from "../ui/card-actions.js";
import { pencilIcon } from "./edit-icon.js";
import { investigationStatus } from "./campaign-investigation.js";
import { investigationBadge, investigationAnswers } from "./investigation-view.js";
import { creationSource, creationBackHash } from "./context-creation.js";
import { articleContext, articleOwner, articleReferences } from "./article-context.js";
import {
  renderArticleContext,
  renderArticleReferences,
  renderRecordBadges,
} from "./article-context-view.js";
import { uiPlural, uiText, uiSourceLabel } from "./ui-localization.js";
import { artwork } from "../ui/artwork.js";
import "./codex-record-twins.js";
import "./codex-record-form.js";
import { CodexCharacterProfile } from "./codex-character-profile.js";
import { previewResourceURL } from "../core/player-preview.js";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import { editorFieldsFor, type CampaignEditorField } from "./campaign-record-editor.js";
import { campaignEnumColor, campaignEnumDisplayLabel } from "./campaign-settings.js";
import { factionRankChains } from "./campaign-structured-editors.js";
import {
  campaignMarkdownOutline,
  parseCampaignMarkdownDocuments,
  renderCampaignMarkdown,
  type CampaignMarkdownContext,
} from "./campaign-markdown.js";
import {
  projectEntity,
  recordValue,
  stringList,
  text,
  type EntitySummary,
  cssHexColor,
} from "./campaign-projection.js";
import {
  campaignPages,
  contextCreationActions,
  contextualCreateHash,
  recordEditHash,
  recordHash,
  collectionHash,
  mapHash,
  eventMapHash,
  type CampaignPageDefinition,
  type ContextCreationAction,
  type AppRoute,
} from "./routes.js";
import { eventMapParent, hasEventPin, locationMarker } from "./campaign-map.js";
import { UiLocalizationController } from "./ui-localization.js";
import { reportEditState, type EditState } from "./unsaved-edit.js";
import { InlineDraftController } from "./inline-draft.js";
import { inlineFieldKinds, recordInlineField } from "./record-inline-field.js";
import { locationPlacementLinks } from "./record-map-links.js";
import type { RecordFormClosedDetail, RecordFormSavedDetail } from "./codex-record-form.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonLinksController } from "./addon-links-controller.js";
import { bindRuleDetails } from "./codex-addon-rule-details.js";
import "./codex-collection-browser.js";
import "./codex-local-drafts.js";
import "./codex-record-contributions.js";
import { collectionModel, factionMemberCounts } from "./collection-model.js";
import {
  defaultCollectionView,
  parseCollectionView,
  quickFacetFor,
  readCollectionView,
  rememberCollectionView,
  serializeCollectionView,
  type CollectionView,
} from "./collection-view.js";
type RecordRoute = Extract<AppRoute, { kind: "collection" | "record" | "create" }>;

/** Sent after a confirmed full-form save, before the page returns to `destination`. */
export interface CampaignRecordSavedDetail {
  readonly destination: string;
}

export class CodexRecordPage extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    registry: { attribute: false },
    actorRole: { attribute: false },
    route: { attribute: false },
    canEdit: { type: Boolean, attribute: "can-edit" },
    canManageVisibility: { type: Boolean, attribute: "can-manage-visibility" },
    busy: { type: Boolean },
    collectionView: { state: true },
    viewStorageUnavailable: { state: true },
    editor: { state: true },
    coreSaved: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  readonly #links = new AddonLinksController(this, () => ({
    registry: this.registry,
    role: this.actorRole,
  }));
  declare route: RecordRoute | undefined;
  declare canEdit: boolean;
  declare canManageVisibility: boolean;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  declare private collectionView: CollectionView;
  declare private viewStorageUnavailable: boolean;
  declare private editor: "closed" | "create" | "edit";
  /** The core entry saved while add-on sections of the open form still have edits. */
  declare private coreSaved: boolean;
  /** One per opened form, so each form starts from its own snapshot. */
  #session = 0;
  /** The creation's source entry was already gone when the form would have opened. */
  #sourceMissing = false;
  readonly #inline = new InlineDraftController(this);
  #inlineDirty = false;
  readonly #ui = new UiLocalizationController(this);
  #pendingViewHash: string | undefined;
  #disposeRuleDetails: (() => void) | undefined;

  constructor() {
    super();
    new UIControlsController(this);
    this.campaign = undefined;
    this.route = undefined;
    this.canEdit = false;
    this.canManageVisibility = false;
    this.busy = false;
    this.coreSaved = false;
    this.collectionView = defaultCollectionView;
    this.viewStorageUnavailable = false;
    this.editor = "closed";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#disposeRuleDetails = bindRuleDetails(this, this.#links, { presentSDK: false });
  }

  override disconnectedCallback(): void {
    this.#disposeRuleDetails?.();
    this.#disposeRuleDetails = undefined;
    super.disconnectedCallback();
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("actorRole") || (changed.has("canEdit") && !this.canEdit)) {
      this.#closeEditor();
      this.#inline.discardAll();
    }
    if (changed.has("route")) {
      this.#links.retry();
      const previous = changed.get("route") as RecordRoute | undefined;
      const sameCollection =
        previous?.kind === "collection" &&
        this.route?.kind === "collection" &&
        previous.page.id === this.route.page.id;
      if (!sameCollection) this.#closeEditor();
      const sameRecord =
        previous?.kind === "record" &&
        this.route?.kind === "record" &&
        previous.page.id === this.route.page.id &&
        previous.key === this.route.key;
      if (!sameRecord) this.#inline.discardAll();
    }
    if ((changed.has("route") || changed.has("actorRole")) && this.route?.kind === "collection") {
      const roleChanged = changed.has("actorRole") && changed.get("actorRole") !== undefined;
      this.collectionView =
        this.route.view !== undefined && !roleChanged
          ? parseCollectionView(this.route.view)
          : readCollectionView(this.route.page.id, this.actorRole ?? "public");
      this.viewStorageUnavailable =
        this.route.view !== undefined &&
        !roleChanged &&
        !rememberCollectionView(
          this.route.page.id,
          this.actorRole ?? "public",
          this.collectionView,
        );
      if (roleChanged)
        this.#pendingViewHash = `${collectionHash(this.route.page)}?${serializeCollectionView(this.collectionView)}`;
    }
    if (
      this.route?.kind === "create" &&
      this.canEdit &&
      this.campaign !== undefined &&
      this.editor === "closed"
    )
      this.#openEditor("create");
    if (
      (changed.has("route") || changed.has("canEdit")) &&
      this.route?.kind === "record" &&
      this.route.editing &&
      this.canEdit
    )
      this.#openEditor("edit");
  }

  protected override render() {
    if (this.campaign === undefined || this.route === undefined) return nothing;
    if (this.route.kind === "create") {
      const source = creationSource(this.route, this.campaign);
      return html`<article class="record-article editor-article" aria-labelledby="record-editor-title">
        <a href=${creationBackHash(this.route, this.campaign)} class="breadcrumb-link">${source ? uiText("creation.back", { "0": source.record ? text(recordValue(source.record)["name"]) || source.page.plural : source.page.plural }) : this.route.preset === "party" ? uiText("Back to party") : this.route.preset === "event" ? this.#ui.t("timeline.back") : this.route.page.plural}</a>
        ${source?.record ? html`<p class="creation-context">${uiText("creation.from")} <a class="article-reference" href=${creationBackHash(this.route, this.campaign)}>${text(recordValue(source.record)["name"]) || source.page.singular}</a></p>` : nothing}
        ${source && !source.record ? html`<p role="alert">${uiText("creation.unavailable")}</p>` : nothing}
        ${
          this.#sourceMissing
            ? html`<h1 id="record-editor-title">${uiText("Add {0}", { "0": this.route.page.singular.toLocaleLowerCase() })}</h1>`
            : this.canEdit && this.editor === "create"
              ? this.#form(this.route, undefined)
              : html`
          <h1 id="record-editor-title">${this.route.preset === "party" ? uiText("Add party member") : uiText("Add {0}", { "0": this.route.page.singular.toLocaleLowerCase() })}</h1>
          <button type="button" @click=${() => this.dispatchEvent(new CustomEvent("campaign-sign-in", { bubbles: true, composed: true }))}>${uiText("Sign in")}</button>
        `
        }
      </article>`;
    }
    return this.route.kind === "collection"
      ? this.#collection(this.route)
      : this.#record(this.campaign, this.route);
  }

  protected override updated(): void {
    if (this.#inline.dirty !== this.#inlineDirty) {
      this.#inlineDirty = this.#inline.dirty;
      reportEditState(this, { dirty: this.#inlineDirty });
    }
    if (this.#pendingViewHash) {
      const hash = this.#pendingViewHash;
      this.#pendingViewHash = undefined;
      this.dispatchEvent(
        new CustomEvent("campaign-collection-view", {
          detail: { hash },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  #openEditor(editor: "create" | "edit"): void {
    this.#session++;
    this.coreSaved = false;
    this.editor = editor;
    this.#sourceMissing =
      editor === "create" &&
      this.route?.kind === "create" &&
      this.campaign !== undefined &&
      creationSource(this.route, this.campaign)?.record === undefined &&
      this.route.context !== undefined;
  }

  #closeEditor(): void {
    this.editor = "closed";
    this.coreSaved = false;
  }

  /** The full form for a new entry (`recordKey` undefined) or an existing one. */
  #form(route: RecordRoute, recordKey: string | undefined) {
    return keyed(
      this.#session,
      html`<codex-record-form .campaign=${this.campaign} .page=${route.page} .recordKey=${recordKey}
        .route=${route} .canManageVisibility=${this.canManageVisibility} .actorRole=${this.actorRole}
        .registry=${this.registry} .wiki=${this.#links.wiki} .busy=${this.busy}
        @campaign-edit-dirty=${(event: CustomEvent<EditState>) => {
          if (event.detail.dirty) this.coreSaved = false;
        }}
        @record-form-saved=${this.#formSaved} @record-form-closed=${this.#formClosed}></codex-record-form>`,
    );
  }

  readonly #formSaved = (event: CustomEvent<RecordFormSavedDetail>): void => {
    event.stopPropagation();
    const { destination } = event.detail;
    const edits = this.registry?.edits.state();
    this.dispatchEvent(
      new CustomEvent<CampaignRecordSavedDetail>("campaign-record-saved", {
        detail: { destination },
        bubbles: true,
        composed: true,
      }),
    );
    // Add-on sections save separately; the form stays open on the saved entry for them.
    if (edits?.dirty || edits?.saving) {
      this.coreSaved = true;
      return;
    }
    this.#closeEditor();
    window.location.hash = destination;
  };

  readonly #formClosed = (event: CustomEvent<RecordFormClosedDetail>): void => {
    event.stopPropagation();
    const route = this.route;
    this.#closeEditor();
    if (route === undefined || this.campaign === undefined) return;
    if (event.detail.reason === "deleted")
      window.location.hash =
        route.page.collection === "events" ? "#/timeline" : collectionHash(route.page);
    else if (route.kind === "create") window.location.hash = creationBackHash(route, this.campaign);
    else if (route.kind === "record" && route.editing)
      window.location.hash =
        route.returnTo ??
        (route.page.collection === "events" ? "#/timeline" : recordHash(route.page, route.key));
  };

  #collection(route: Extract<RecordRoute, { kind: "collection" }>) {
    const members =
      route.page.collection === "factions" ? factionMemberCounts(this.campaign!) : undefined;
    return html`
      <article class="collection-page" data-collection=${route.page.collection} aria-labelledby="collection-title">
        <header class="page-heading collection-heading">
          <div>
            <h1 id="collection-title">${route.page.plural}</h1>
          </div>
          ${
            this.canEdit
              ? html`
            <button class="record-action primary-record-action" type="button" @click=${this.#startCreate} ?disabled=${this.busy || this.editor !== "closed"}>
              <span aria-hidden="true">+</span>${uiText("Add {0}", { "0": route.page.singular.toLocaleLowerCase() })}
            </button>
          `
              : nothing
          }
        </header>
        ${this.editor === "create" ? this.#form(route, undefined) : nothing}
        ${
          // The queue sits right under an empty list, so it needs no shortcut then.
          route.page.collection === "mysteries" &&
          campaignCollection(this.campaign!, "mysteries").records.length > 0
            ? html`<button type="button" class="record-action investigation-jump" @click=${() => {
                const queue = this.querySelector<HTMLElement>(".investigation-queue");
                queue?.scrollIntoView({ block: "start" });
                queue?.focus({ preventScroll: true });
              }}>${uiText("investigation.queue")}</button>`
            : nothing
        }
        <codex-collection-browser .model=${collectionModel(this.campaign!, route.page)} .view=${this.collectionView} .quickFacet=${quickFacetFor(route.page.id)}
          .renderEntry=${(entity: EntitySummary) => recordRow(this.campaign!, entity, route.page, this.canEdit ? recordEditHash(route.page, entity.key, route.view === undefined ? collectionHash(route.page) : `${collectionHash(route.page)}?${route.view}`) : undefined, members?.get(entity.key))} .storageUnavailable=${this.viewStorageUnavailable}
          @collection-view-change=${this.#changeCollectionView}></codex-collection-browser>
        ${route.page.collection === "mysteries" ? html`<codex-investigation-queue .campaign=${this.campaign} .canEdit=${this.canEdit}></codex-investigation-queue>` : nothing}
        ${this.canEdit ? html`<codex-local-drafts .campaign=${this.campaign} .page=${route.page} .actorRole=${this.actorRole}></codex-local-drafts>` : nothing}
      </article>
    `;
  }

  #record(dataset: CampaignDataset, route: Extract<RecordRoute, { kind: "record" }>) {
    // The open form keeps its own snapshot, so it stays when the entry is removed elsewhere.
    if (this.editor === "edit")
      return html`
        <article class="record-article editor-article" aria-labelledby="record-editor-title">
          <a href=${route.returnTo ?? (route.page.collection === "events" ? "#/timeline" : collectionHash(route.page))} class="breadcrumb-link">${route.returnTo ? uiText("creation.backPage") : route.page.collection === "events" ? this.#ui.t("timeline.back") : route.page.plural}</a>
          ${this.#form(route, route.key)}
          ${this.coreSaved ? html`<p role="status">${this.#ui.t("recordAddons.coreSaved")}</p>` : nothing}
          <codex-record-contributions .registry=${this.registry} .actorRole=${this.actorRole}
            .record=${campaignCollection(dataset, route.page.collection).records.find((item) => item.key === route.key)}
            .collection=${route.page.collection} .mode=${"editor"} ?inert=${this.busy}></codex-record-contributions>
        </article>
      `;
    const collection = campaignCollection(dataset, route.page.collection);
    const profile = this.querySelector<CodexCharacterProfile>("codex-character-profile");
    const retained =
      this.canEdit &&
      route.page.collection === "characters" &&
      profile?.actorRole === this.actorRole &&
      profile?.record.key === route.key &&
      profile.hasDraft
        ? profile
        : undefined;
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
    if (route.editing && !this.canEdit)
      return html`<article class="record-article editor-article">
      <a class="breadcrumb-link" href=${route.returnTo ?? recordHash(route.page, route.key)}>${route.page.plural}</a>
      <h1>${uiText("Edit {0}", { "0": entity.name })}</h1>
      <button type="button" @click=${() => this.dispatchEvent(new CustomEvent("campaign-sign-in", { bubbles: true, composed: true }))}>${uiText("Sign in")}</button>
    </article>`;
    const twins =
      this.canManageVisibility && this.actorRole === "dm"
        ? html`<codex-record-twins
      .campaign=${dataset} .record=${record} .page=${route.page} .disabled=${this.busy}></codex-record-twins>`
        : nothing;
    const facts = articleFacts(dataset, route.page.collection, value);
    const editable = this.canEdit
      ? editorFieldsFor(route.page.collection, this.canManageVisibility).filter(
          (field) => inlineFieldKinds.has(field.kind) && field.key !== "name",
        )
      : [];
    const extraFields = editable.filter((field) => !facts.some((fact) => fact[2] === field.key));
    const sections = [
      ...articleSections(
        route.page.collection === "mysteries"
          ? { ...value, questions: undefined, clues: clueLinks(dataset, value["clues"]) }
          : value,
      ),
    ];
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
    if (route.page.collection === "characters")
      return html`${this.#linkFailure()}<codex-character-profile
      .campaign=${dataset} .record=${record} .entity=${entity} .context=${markdownContext} .headerExtras=${twins}
      .actorRole=${this.actorRole}
      .extraSections=${articleSections({ ...value, description: undefined, known: undefined, unknown: undefined })}
      .canEdit=${this.canEdit} .canManageVisibility=${this.canManageVisibility}
      @campaign-character-edit-all=${this.#startEdit}></codex-character-profile>`;
    return html`
      <article class=${`record-article${entity.portrait ? "" : " no-artwork"}`} aria-labelledby="record-title">
        ${this.#linkFailure()}
        <div class="record-topbar">
          <a href=${route.returnTo ?? (route.page.collection === "events" ? "#/timeline" : collectionHash(route.page))} class="breadcrumb-link">${route.returnTo ? uiText("creation.backPage") : route.page.collection === "events" ? this.#ui.t("timeline.back") : route.page.plural}</a>
          ${twins}
        </div>
        <div class="record-reading-layout">
          <aside class="record-side">
            <header class="record-masthead">
              ${recordArtwork(entity, route.page.icon, `record-portrait${entity.portrait ? "" : " record-portrait-placeholder"}`, "eager", route.page.collection === "locations" ? dataset : undefined)}
              <div>
                <span class="record-kind">${route.page.singular}</span>
                <h1 id="record-title" aria-label=${entity.name}>${
                  this.canEdit
                    ? this.#inlineField(
                        record,
                        route,
                        editorFieldsFor(route.page.collection).find(
                          (field) => field.key === "name",
                        )!,
                      )
                    : entity.name
                }</h1>
                ${entity.title === "" ? nothing : html`<p>${entity.title}</p>`}
                ${renderRecordBadges(entity, { status: true, tags: true })}
              </div>
              ${this.#mastheadActions(route, record, value)}
            </header>
            ${
              facts.length === 0
                ? nothing
                : html`
              <dl class="record-facts">
                ${repeat(
                  facts,
                  ([label, , key]) => key ?? label,
                  ([label, fact, key]) => {
                    const field = editable.find((field) => field.key === key);
                    return html`<div><dt>${label}</dt><dd>${field ? this.#inlineField(record, route, field, label) : fact}</dd></div>`;
                  },
                )}
              </dl>
            `
            }
            ${
              extraFields.length
                ? html`<details class="character-empty-details record-more-details"><summary>${uiText("details.add")}</summary>
              <dl class="record-facts">${repeat(
                extraFields,
                (field) => field.key,
                (field) =>
                  html`<div><dt>${field.label}</dt><dd>${this.#inlineField(record, route, field)}</dd></div>`,
              )}</dl>
            </details>`
                : nothing
            }
            ${
              outline.length === 0
                ? nothing
                : html`
              <aside class="record-outline" aria-label=${uiText("Article contents")}>
                <p>${uiText("In this entry")}</p>
                <ol>
                  ${outline.map(
                    (item) => html`
                    <li class=${`outline-depth-${item.depth}`}>
                      <button type="button" data-heading=${item.id} @click=${this.#scrollToHeading}>${item.text}</button>
                    </li>
                  `,
                  )}
                </ol>
              </aside>
            `
            }
          </aside>
          <div class="record-reading">
            ${route.page.collection === "mysteries" ? investigationAnswers(value) : nothing}
            ${
              sections.length === 0 && contextSections.length === 0
                ? html`<p class="empty-state">${uiText("This entry does not have article text yet.")}</p>${this.#contextCreationLinks(route)}`
                : html`<div class="record-prose">
                  ${renderArticleContext(contextSections)}
                  ${this.#contextCreationLinks(route)}
                  ${sections.map(
                    (section, index) => html`
                    <section class=${section.heading === uiText("What is known") || section.heading === uiText("Open questions") ? "character-knowledge-section" : ""}>
                      <h2 class="record-section-title">${section.heading}</h2>
                      ${
                        documents[index] === undefined
                          ? nothing
                          : renderCampaignMarkdown(documents[index], markdownContext)
                      }
                    </section>
                  `,
                  )}

                </div>`
            }
          </div>
        </div>
      </article>
    `;
  }

  /** A fact edited in place; its draft lives here, so it survives the fact moving. */
  #inlineField(
    record: CampaignRecord,
    route: Extract<RecordRoute, { kind: "record" }>,
    field: CampaignEditorField,
    label?: string,
  ) {
    return recordInlineField({
      owner: this,
      drafts: this.#inline,
      campaign: this.campaign!,
      collection: route.page.collection,
      record,
      field,
      canEdit: this.canEdit,
      ...(label === undefined ? {} : { label }),
      latest: () =>
        this.campaign === undefined
          ? undefined
          : campaignCollection(this.campaign, route.page.collection).records.find(
              ({ key }) => key === record.key,
            ),
    });
  }

  #mastheadActions(
    route: Extract<RecordRoute, { kind: "record" }>,
    record: CampaignRecord,
    value: Readonly<Record<string, unknown>>,
  ) {
    const location = route.page.collection === "locations",
      event = route.page.collection === "events";
    const actions = [
      this.canEdit
        ? html`<button class="record-action" type="button" @click=${this.#startEdit} ?disabled=${this.busy}>${pencilIcon()} ${uiText("Edit")}</button>`
        : nothing,
      location ? locationPlacementLinks(record, this.canEdit) : nothing,
      location && (value["localMap"] || this.canEdit)
        ? html`<a class="record-action" href=${mapHash(record.key)}>${this.#ui.t("map.local")}</a>`
        : nothing,
      event && hasEventPin(value)
        ? html`<a class="record-action" href=${eventMapHash(eventMapParent(value), record.key, "show")}>${this.#ui.t("map.show")}</a>`
        : nothing,
      event && this.canEdit
        ? html`<a class="record-action" href=${eventMapHash(eventMapParent(value), record.key, "place")}>${this.#ui.t(hasEventPin(value) ? "map.moveEvent" : "map.placeEvent")}</a>`
        : nothing,
    ];
    return this.canEdit || location || (event && hasEventPin(value))
      ? html`<div class="record-masthead-actions">${actions}</div>`
      : nothing;
  }

  #contextCreationLinks(route: Extract<RecordRoute, { kind: "record" }>) {
    const labels = {
      "character-here": "creation.character",
      "event-here": "creation.event",
      "sub-location": "creation.child",
      "faction-member": "creation.member",
    } as const;
    const actions = (Object.keys(contextCreationActions) as ContextCreationAction[]).filter(
      (action) => contextCreationActions[action].source === route.page.collection,
    );
    return actions.length
      ? html`<nav class="context-create-actions" aria-label=${uiText("creation.related")}>${actions.map(
          (action) =>
            html`<a class="record-action" href=${contextualCreateHash(action, route.key)}><span aria-hidden="true">+</span> ${uiText(labels[action])}</a>`,
        )}</nav>`
      : nothing;
  }

  readonly #changeCollectionView = (event: CustomEvent<CollectionView>): void => {
    event.stopPropagation();
    if (this.route?.kind !== "collection") return;
    this.collectionView = event.detail;
    this.viewStorageUnavailable = !rememberCollectionView(
      this.route.page.id,
      this.actorRole ?? "public",
      event.detail,
    );
    this.dispatchEvent(
      new CustomEvent("campaign-collection-view", {
        detail: {
          hash: `${collectionHash(this.route.page)}?${serializeCollectionView(event.detail)}`,
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #linkFailure() {
    return this.#links.failed
      ? html`<p class="connection-alert" role="status">${this.#ui.t("wiki.failed")}
      <button type="button" @click=${this.#links.retry}>${this.#ui.t("wiki.retry")}</button></p>`
      : nothing;
  }

  readonly #startCreate = (): void => {
    if (this.canEdit && !this.busy && this.editor === "closed") this.#openEditor("create");
  };

  readonly #startEdit = (): void => {
    if (this.canEdit && !this.busy && this.editor === "closed") this.#openEditor("edit");
  };

  readonly #scrollToHeading = (event: Event): void => {
    const id = (event.currentTarget as HTMLButtonElement).dataset["heading"];
    if (id === undefined) return;
    const heading = document.getElementById(id);
    if (heading === null) return;
    heading.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    heading.focus({ preventScroll: true });
  };
}

function recordRow(
  campaign: CampaignDataset,
  entity: EntitySummary,
  page: CampaignPageDefinition,
  editHref?: string,
  memberCount?: number,
) {
  const character = page.collection === "characters";
  const compact = !character && entity.portrait === undefined;
  const statusColor = character
    ? campaignEnumColor(campaign, "characterStatuses", entity.status)
    : undefined;
  const factionColor =
    page.collection === "factions" ? cssHexColor(entity.raw["color"]) : undefined;
  return html`<div class="record-row-shell ui-card">
    <a class=${`record-row${entity.portrait ? "" : " no-artwork"}${compact ? " is-compact" : ""}`} href=${entity.route}
      style=${factionColor ? `--entity-color: ${factionColor}` : nothing}>
      ${recordArtwork(entity, page.icon, "record-row-mark", "lazy", page.collection === "locations" ? campaign : undefined)}
      <span class="record-row-copy">
        <strong>${entity.name}</strong>
        ${entity.title === "" ? nothing : html`<span>${entity.title}</span>`}
        ${page.collection === "mysteries" ? html`<span class="record-row-meta">${investigationBadge(entity.raw)}</span>` : nothing}
        ${character && entity.statusLabel ? html`<span class="record-status" style=${statusColor ? `--status-color: ${statusColor}` : nothing}>${entity.statusLabel}</span>` : nothing}
        ${entity.partyIdentity ? html`<span class="party-identity-badge">${entity.partyIdentity.badge} ${entity.partyIdentity.name}</span>` : nothing}
        ${memberCount === undefined ? nothing : html`<span class="record-row-meta">${uiPlural("browse.memberCount", memberCount)}</span>`}
        ${entity.excerpt === "" || character ? nothing : html`<small>${entity.excerpt}</small>`}
      </span>
      ${entity.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
    </a>${editHref ? cardEditLink(editHref, uiText("Edit {0}", { "0": entity.name })) : nothing}
  </div>`;
}

function recordArtwork(
  entity: EntitySummary,
  fallback: string,
  className: string,
  loading: "lazy" | "eager" = "eager",
  locationCampaign?: CampaignDataset,
) {
  const portrait = entity.route.startsWith("#/characters/");
  const marker =
    locationCampaign && entity.portrait === undefined && entity.icon === undefined
      ? locationMarker(locationCampaign, entity.key, entity.raw)
      : undefined;
  return artwork({
    source: previewResourceURL(entity.portrait),
    className,
    loading,
    style:
      (portrait || entity.portrait !== undefined) && entity.attitudeRing !== undefined
        ? `--attitude-ring: ${entity.attitudeRing}`
        : undefined,
    fallback: marker?.markerIcon
      ? html`<img class="record-marker-icon" src=${marker.markerIcon} alt="" loading=${loading}
        style=${entity.attitudeFilter !== undefined ? `--attitude-filter: ${entity.attitudeFilter}` : nothing} />`
      : html`<span class="record-visual-glyph"
      style=${!portrait && entity.attitudeFilter !== undefined ? `--attitude-filter: ${entity.attitudeFilter}` : nothing}>${entity.icon ?? marker?.markerGlyph ?? fallback}</span>
    `,
  });
}

/** Older mysteries store clues as event keys; show those as links to the events. */
function clueLinks(dataset: CampaignDataset, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const events = campaignCollection(dataset, "events").records;
  return value.map((clue) => {
    const event =
      typeof clue === "string" ? events.find((record) => record.key === clue) : undefined;
    if (!event) return clue;
    const name = (text(recordValue(event)["name"]) || event.key).replace(/[[\]\\]/gu, "");
    return `[${name}](${recordHash(
      campaignPages.find((page) => page.collection === "events")!,
      event.key,
    )})`;
  });
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
): readonly (readonly [string, string | TemplateResult, string?])[] {
  const fields = factDefinitions[collection] ?? [];
  const facts: Array<readonly [string, string | TemplateResult, string?]> = [];
  for (const [label, field, referenceCollection] of fields) {
    const raw =
      collection === "mysteries" && field === "solved"
        ? investigationStatus(value).solved
        : value[field];
    const enumCategory = articleEnumCategory(collection, field);
    const result =
      enumCategory !== undefined
        ? campaignEnumDisplayLabel(dataset, enumCategory, raw)
        : referenceCollection === undefined
          ? printable(raw)
          : articleReferences(dataset, referenceCollection, raw).length
            ? renderArticleReferences(articleReferences(dataset, referenceCollection, raw))
            : "";
    if (result !== "") facts.push([uiSourceLabel(label), result, field]);
  }
  if (collection === "companions") {
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

function characterRankName(
  dataset: CampaignDataset,
  value: Readonly<Record<string, unknown>>,
): string {
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
    const question = text(item["text"]);
    const answer = text(item["answer"]);
    if (question === "") return [];
    return [
      answer === "" ? `- ${question}` : `- **${question}**\n  ${answer.replace(/\r?\n/gu, "\n  ")}`,
    ];
  });
  return lines.join("\n");
}

const factDefinitions: Readonly<Record<string, readonly (readonly [string, string, string?])[]>> = {
  characters: [
    ["Species", "species"],
    ["Gender", "gender"],
    ["Age", "age"],
    ["Status", "status"],
    ["Faction", "faction", "factions"],
    ["Current location", "location", "locations"],
  ],
  locations: [
    ["Kind", "type"],
    ["Region", "region"],
    ["Parent location", "parentId", "locations"],
  ],
  events: [
    ["Date", "date"],
    ["Session", "sitting"],
    ["Priority", "priority"],
    ["Characters", "characters", "characters"],
    ["Locations", "locations", "locations"],
    ["Leads to", "consequence", "events"],
  ],
  mysteries: [
    ["Priority", "priority"],
    ["Solved", "solved"],
    ["Characters", "characters", "characters"],
    ["Locations", "locations", "locations"],
  ],
  factions: [],
  pantheon: [
    ["Domain", "domain"],
    ["Symbol", "symbol"],
    ["Alignment", "alignment"],
  ],
  artifacts: [
    ["Holder", "ownerCharacterId", "characters"],
    ["Location", "locationId", "locations"],
  ],
  historicalEvents: [
    ["Start", "start"],
    ["End", "end"],
    ["Characters", "characters", "characters"],
    ["Locations", "locations", "locations"],
  ],
  companions: [["Species", "species"]],
};

if (!customElements.get("codex-record-page")) {
  customElements.define("codex-record-page", CodexRecordPage);
}
