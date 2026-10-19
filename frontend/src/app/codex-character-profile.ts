import { investigationQuestions } from "./campaign-investigation.js";
import { articleContext } from "./article-context.js";
import {
  renderArticleContext,
  renderCharacterRelationships,
  renderCharacterLocationRoles,
  renderRecordBadges,
} from "./article-context-view.js";
import { characterKnowledge, characterReadingValue } from "./character-reading.js";
import { campaignPages } from "./routes.js";
import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { isRecord } from "../core/boundary.js";
import { type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import { previewResourceURL } from "../core/player-preview.js";
import {
  editorFieldsFor,
  editorOptionsFor,
  relationshipBaseFor,
  relationshipEditorRowsFor,
  type CampaignEditorField,
  type CampaignCharacterPatch,
} from "./campaign-record-editor.js";
import { saveCampaign, type CampaignWriteResult } from "./campaign-writes.js";
import {
  projectEntity,
  recordValue,
  text,
  stringList,
  type EntitySummary,
} from "./campaign-projection.js";
import {
  factionRankChains,
  locationRoleDrafts,
  type CampaignStructuredFieldElement,
  type CampaignRelationshipEditorElement,
} from "./campaign-structured-editors.js";
import {
  parseCampaignMarkdown,
  renderCampaignMarkdown,
  type CampaignMarkdownContext,
} from "./campaign-markdown.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { CodexMarkdownEditor } from "./codex-markdown-editor.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { CodexPortraitEditor } from "./codex-portrait-editor.js";
import { artwork } from "../ui/artwork.js";
import { pencilIcon } from "./edit-icon.js";
import { confirmDiscardUnsavedEdit, reportEditState, type EditState } from "./unsaved-edit.js";
import type { CodexInlineField, InlineControl, InlineProjection } from "./codex-inline-field.js";
import { InlineDraftController, type InlineDraft } from "./inline-draft.js";
import { recordInlineField, type RecordFieldPatch } from "./record-inline-field.js";

interface Question {
  readonly text: string;
  readonly answer: string;
}

export class CodexCharacterProfile extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    record: { attribute: false },
    entity: { attribute: false },
    context: { attribute: false },
    extraSections: { attribute: false },
    headerExtras: { attribute: false },
    canEdit: { type: Boolean },
    canManageVisibility: { type: Boolean },
    actorRole: { attribute: false },
    inspect: { state: true },
    status: { state: true },
    panel: { state: true },
    wikiOpen: { state: true },
    wikiSaving: { state: true },
  };
  declare campaign: CampaignDataset;
  declare record: CampaignRecord;
  declare entity: EntitySummary;
  declare context: CampaignMarkdownContext;
  declare extraSections: readonly { heading: string; body: string }[] | undefined;
  /** Host-owned controls (DM/player versions) shown beside the breadcrumb. */
  declare headerExtras: unknown;
  declare canEdit: boolean;
  declare canManageVisibility: boolean;
  declare actorRole: BrowserRole | undefined;
  declare private status: string;
  declare private inspect: boolean;
  declare private panel: string;
  declare private wikiOpen: boolean;
  declare private wikiSaving: boolean;
  /** Fields edited in place; known facts and open questions each share one draft. */
  readonly #fields = new InlineDraftController(this);
  #reported: EditState = { dirty: false, saving: false };
  #wikiBase: CampaignRecord | undefined;
  #wikiValue = "";
  #wikiError = "";
  #wikiConflict = false;
  #panelBase: CampaignRecord | undefined;
  #panelCampaign: CampaignDataset | undefined;
  #panelDirty = false;
  #panelError = "";
  #panelSaving = false;
  #undo: { base: CampaignRecord; fields: Readonly<Record<string, unknown>> } | undefined;
  #saves = 0;
  #lastKey = "";

  constructor() {
    super();
    this.inspect = false;
    new UiLocalizationController(this);
    this.canEdit = false;
    this.canManageVisibility = false;
    this.status = "";
    this.panel = "";
    this.wikiOpen = false;
    this.wikiSaving = false;
  }
  protected override createRenderRoot() {
    return this;
  }
  get hasDraft(): boolean {
    return this.#saves > 0 || this.#fields.drafts.length > 0 || this.wikiOpen || this.panel !== "";
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.record?.key !== this.#lastKey || changed.has("actorRole") || !this.canEdit) {
      this.#fields.discardAll();
      this.#wikiBase = undefined;
      this.#panelBase = undefined;
      this.#undo = undefined;
      this.inspect = false;
      this.wikiOpen = false;
      this.panel = "";
      this.#lastKey = this.record?.key ?? "";
      this.status = "";
    }
  }
  protected override updated(): void {
    const dirty = this.#unsaved(),
      saving = this.#saves > 0;
    if (dirty === this.#reported.dirty && saving === this.#reported.saving) return;
    this.#reported = { dirty, saving };
    reportEditState(this, this.#reported);
  }
  protected override render() {
    if (!this.record || !this.campaign || !this.entity) return nothing;
    const inspecting = this.inspect && this.actorRole === "dm";
    const original = recordValue(this.record),
      value = characterReadingValue(original, inspecting);
    const revealed = inspecting || characterKnowledge(original) >= 2;
    const entity = inspecting
      ? projectEntity(
          this.campaign,
          this.record,
          campaignPages.find((page) => page.collection === "characters")!,
          true,
        )
      : this.entity;
    const wiki = parseCampaignMarkdown(text(value["description"]));
    const hasRelationships =
      relationshipEditorRowsFor(this.campaign, this.record.key, this.canManageVisibility).length >
      0;
    const hasLocationRoles = locationRoleDrafts(value["locationRoles"]).length > 0;
    return html`<article class=${`record-article character-profile direct-character${entity.portrait ? "" : " no-artwork"}${revealed ? "" : " knowledge-limited"}`} aria-labelledby="record-title">
      <div class="character-page-heading"><a href="#/characters" class="breadcrumb-link">${uiText("Characters")}</a>
        <div class="character-heading-tools">
        ${
          this.actorRole === "dm"
            ? html`<button type="button" class="knowledge-toggle" aria-pressed=${inspecting} ?disabled=${this.hasDraft}
          @click=${() => {
            this.inspect = !this.inspect;
          }}>${uiText(inspecting ? "knowledge.read" : "knowledge.inspect")}</button>`
            : nothing
        }
        ${this.headerExtras ?? nothing}
        ${
          this.canEdit
            ? html`<div class="character-save-status"><span role="status">${this.#feedback()}</span>${this.#undo ? html`<button type="button" ?disabled=${this.#saves > 0} @click=${this.#undoSave}>${uiText("Undo")}</button>` : nothing}
        <details class="character-more"><summary aria-label=${uiText("More actions")}>⋯</summary><div>
          <button type="button" @click=${this.#editAll}>${uiText("Edit all fields")}</button>
          <button type="button" @click=${() => this.#openPanel("portrait")}>${uiText("Portrait")}</button>
          ${this.canManageVisibility ? html`<button type="button" @click=${() => this.#openPanel("visibility")}>${uiText("Visibility")}</button>` : nothing}
        </div></details></div>`
            : nothing
        }</div></div>
      ${inspecting ? html`<p class="knowledge-inspection">${uiText("knowledge.inspectHint")}</p>` : nothing}
      <div class="record-reading-layout">
        <aside class="record-side"><header class="record-masthead">
          ${artwork({
            source: previewResourceURL(entity.portrait),
            className: `record-portrait${entity.portrait ? "" : " record-portrait-placeholder"}`,
            style: entity.attitudeRing ? `--attitude-ring: ${entity.attitudeRing}` : undefined,
            fallback: html`<span class="record-visual-glyph">${entity.icon || "♟"}</span>`,
          })}
          <div><span class="record-kind">${uiText("Character")}</span><h1 id="record-title" aria-label=${text(value["name"])}>${this.#inline("name")}</h1>
            ${revealed && this.#hasValue("title") ? html`<div class="character-subtitle">${this.#inline("title")}</div>` : nothing}
            ${renderRecordBadges(entity)}
          </div></header>
          <dl class="record-facts">${this.#facts((revealed ? ["species", "gender", "age", "status", "knowledge", "tags"] : ["knowledge"]).filter((key) => this.#hasValue(key)))}</dl>
          ${
            revealed
              ? html`${
                  ["faction", "location", "rank"].some((key) => this.#hasValue(key)) ||
                  entity.attitudes.length
                    ? html`<section class="character-connections"><h2 class="record-section-title">${uiText("Connections")}</h2>
            <dl class="record-facts">${this.#facts(["faction", "location"].filter((key) => this.#hasValue(key)))}${this.#rankLabel() ? html`<div><dt>${uiText("Faction rank")}</dt><dd>${this.#panelValue("rankAssignment", this.#rankLabel())}</dd></div>` : nothing}
            ${entity.attitudes.length ? html`<div><dt>${uiText("Attitudes toward the party")}</dt><dd>${this.#panelValue("attitudes", entity.attitudes.map((item) => item.label).join(", "))}</dd></div>` : nothing}</dl>
          </section>`
                    : nothing
                }
          ${this.#hasValue("circumstances") ? html`<section class="character-circumstances"><h2 class="record-section-title">${uiText("Current circumstances")}</h2>${this.#inline("circumstances")}</section>` : nothing}
          ${this.canEdit ? this.#emptyDetails() : nothing}`
              : nothing
          }
          ${wiki.outline.length ? html`<aside class="record-outline" aria-label=${uiText("Article contents")}><p>${uiText("In this entry")}</p><ol>${wiki.outline.map((item) => html`<li class=${`outline-depth-${item.depth}`}><button type="button" @click=${() => this.querySelector<HTMLElement>(`#${item.id}`)?.scrollIntoView({ block: "start" })}>${item.text}</button></li>`)}</ol></aside>` : nothing}
        </aside>
        <div class="record-reading">${
          revealed
            ? html`<section class="character-wiki"><div class="character-section-heading"><h2 class="record-section-title">${uiText("Overview")}</h2>
          ${this.canEdit && !this.wikiOpen ? html`<button type="button" class="record-action" @click=${this.#openWiki}>${uiText("Edit wiki")}</button>` : nothing}</div>
          ${
            this.wikiOpen
              ? html`<codex-markdown-editor .value=${this.#wikiValue} .label=${uiText("Overview")} .identity=${`${this.record.key}:wiki`}
            .draftContext=${
              this.actorRole && this.#wikiBase
                ? {
                    role: this.actorRole,
                    collection: "characters",
                    record: this.#wikiBase.key,
                    field: "description",
                    revision: this.#wikiBase.revision,
                    baseValue: text(recordValue(this.#wikiBase)["description"]),
                  }
                : undefined
            }
            .context=${this.context} .disabled=${this.wikiSaving} @markdown-change=${this.#wikiChanged} @markdown-save=${this.#saveWiki}></codex-markdown-editor>
            ${
              this.#wikiError
                ? html`<p role="alert">${this.#wikiError}</p>${
                    this.#wikiConflict
                      ? html`<details><summary>${uiText("Current saved value")}</summary>${renderCampaignMarkdown(parseCampaignMarkdown(text(recordValue(this.record)["description"])), this.context)}</details>
              <button type="button" @click=${() => {
                this.#wikiBase = this.record;
                this.#wikiConflict = false;
                this.#wikiError = "";
                this.requestUpdate();
              }}>${uiText("Keep my draft")}</button>`
                      : nothing
                  }`
                : nothing
            }
            <div class="character-local-actions"><button type="button" ?disabled=${this.wikiSaving} @click=${this.#cancelWiki}>${uiText("Cancel")}</button>
              <button type="button" class="primary-record-action" ?disabled=${this.wikiSaving} @click=${this.#saveWiki}>${uiText(this.wikiSaving ? "Saving…" : "Save text")}</button></div>`
              : wiki.tokens.length
                ? renderCampaignMarkdown(wiki, this.context)
                : html`<p class="empty-state">${uiText("This entry does not have article text yet.")}</p>`
          }
        </section>
        <div class="character-knowledge-grid"><section><h2 class="record-section-title">${uiText("What is known")}</h2>
          <ul class="character-fact-list">${this.#known().map((_item, index) => html`<li>${this.#row("known", index)}</li>`)}</ul>
          ${this.canEdit ? html`<button class="character-add" type="button" @click=${() => this.#addItem("known")}>+ ${uiText("Add fact")}</button>` : nothing}</section>
          <section><h2 class="record-section-title">${uiText("Open questions")}</h2>
          <p class="investigation-count">${uiText("investigation.count", { open: investigationQuestions(value["unknown"]).filter((question) => !question.answer).length, total: investigationQuestions(value["unknown"]).length })}</p>
          <div class="character-questions">${this.#questions().map((_item, index) => html`<div>${this.#row("unknown", index, "text")}<div class="character-answer">${this.#row("unknown", index, "answer")}</div></div>`)}</div>
          ${this.canEdit ? html`<button class="character-add" type="button" @click=${() => this.#addItem("unknown")}>+ ${uiText("Add question")}</button>` : nothing}</section></div>
        ${
          hasRelationships
            ? html`<section class="record-structured-section">${this.#sectionHeading("relationships", uiText("Relationships"))}
          ${renderCharacterRelationships(this.campaign, this.record.key, this.canManageVisibility)}</section>`
            : nothing
        }
        ${
          hasLocationRoles
            ? html`<section class="record-structured-section">${this.#sectionHeading("locationRoles", uiText("Other location roles"))}
          ${renderCharacterLocationRoles(this.campaign, value["locationRoles"])}</section>`
            : nothing
        }
        ${
          this.canEdit && (!hasRelationships || !hasLocationRoles)
            ? html`<div class="character-structured-add">
          ${hasRelationships ? nothing : html`<button class="character-add" type="button" @click=${() => this.#openPanel("relationships")}>+ ${uiText("Relationships")}</button>`}
          ${hasLocationRoles ? nothing : html`<button class="character-add" type="button" @click=${() => this.#openPanel("locationRoles")}>+ ${uiText("Other location roles")}</button>`}
        </div>`
            : nothing
        }
        ${renderArticleContext(articleContext(this.campaign, "characters", this.record.key))}
        ${this.extraSections?.map((section) => html`<section class="record-structured-section"><h2 class="record-section-title">${section.heading}</h2>${renderCampaignMarkdown(parseCampaignMarkdown(section.body), this.context)}</section>`)}
        `
            : html`<p class="empty-state">${uiText(characterKnowledge(original) === 0 ? "knowledge.hidden" : "knowledge.nameOnly")}</p>`
        }
        ${this.panel ? this.#panelContent() : nothing}
        </div>
      </div>
    </article>`;
  }

  #hasValue(key: string): boolean {
    // An open field stays where it is until its draft closes.
    const base = this.#fields.get(key)?.base as CampaignRecord | undefined;
    const value = recordValue(base ?? this.record)[key];
    // New characters store the reserved "No faction" choice; it is not a connection.
    if (key === "faction" && value === "neutral") return false;
    return typeof value === "string"
      ? value.trim() !== ""
      : Array.isArray(value)
        ? value.length > 0
        : value !== undefined && value !== null;
  }
  #emptyDetails() {
    const keys = [
      "title",
      "species",
      "gender",
      "age",
      "status",
      "knowledge",
      "tags",
      "faction",
      "location",
      "circumstances",
    ].filter((key) => !this.#hasValue(key));
    return html`<details class="character-empty-details"><summary>${uiText("details.add")}</summary>
      <dl class="record-facts">${this.#facts(keys)}
        ${!this.#rankLabel() ? html`<div><dt>${uiText("Faction rank")}</dt><dd>${this.#panelValue("rankAssignment", "")}</dd></div>` : nothing}
        ${!this.entity.attitudes.length ? html`<div><dt>${uiText("Attitudes toward the party")}</dt><dd>${this.#panelValue("attitudes", "")}</dd></div>` : nothing}
      </dl>
    </details>`;
  }
  #field(key: string): CampaignEditorField {
    return editorFieldsFor("characters").find((field) => field.key === key)!;
  }
  #initial(key: string, record = this.record): unknown {
    const value = recordValue(record);
    if (key === "known") return stringList(value[key]);
    if (key === "unknown")
      return Array.isArray(value[key])
        ? value[key].map((item) =>
            isRecord(item)
              ? { text: text(item["text"]), answer: text(item["answer"]) }
              : { text: text(item), answer: "" },
          )
        : [];
    if (key === "tags") return stringList(value[key]);
    return fieldText(value[key]);
  }
  #known(): readonly string[] {
    return (this.#fields.get("known")?.value ?? this.#initial("known")) as readonly string[];
  }
  #questions(): readonly Question[] {
    return (this.#fields.get("unknown")?.value ?? this.#initial("unknown")) as readonly Question[];
  }
  #facts(keys: readonly string[]) {
    return repeat(
      keys,
      (key) => key,
      (key) => html`<div><dt>${this.#field(key).label}</dt><dd>${this.#inline(key)}</dd></div>`,
    );
  }
  #sectionHeading(panel: string, label: string) {
    return html`<div class="character-section-heading"><h2 class="record-section-title">${label}</h2>
      ${
        this.canEdit
          ? html`<button type="button" class="inline-edit-button" aria-label=${uiText("Edit {0}", { "0": label })}
        title=${uiText("Edit {0}", { "0": label })} @click=${() => this.#openPanel(panel)}>${pencilIcon()}</button>`
          : nothing
      }</div>`;
  }
  /** A field edited in place; its draft lives here, so it survives the field moving. */
  #inline(key: string) {
    if (
      key === "name" &&
      !this.inspect &&
      this.#fields.get("name") === undefined &&
      characterKnowledge(recordValue(this.record)) < 1
    )
      return html`<span>${uiText("knowledge.unknown")}</span>`;
    return recordInlineField({
      owner: this,
      drafts: this.#fields,
      campaign: this.campaign,
      collection: "characters",
      record: this.record,
      field: this.#field(key),
      canEdit: this.canEdit,
      // The reserved "No faction" choice reads as its label, not as a link.
      links: this.#hasValue(key),
      paragraph: key === "circumstances",
      latest: () => this.record,
      send: (patch) => this.#sendField(key, patch),
    });
  }
  /** One known fact, or a question or its answer; the whole list saves together. */
  #row(key: "known" | "unknown", row: number, part?: keyof Question) {
    const field = this.#field(key);
    const id = part === undefined ? `${row}` : `${row}:${part}`;
    const project: InlineProjection =
      part === undefined
        ? {
            read: (value) => (value as readonly string[])[row] ?? "",
            write: (value, input) =>
              (value as readonly string[]).map((item, index) =>
                index === row ? String(input) : item,
              ),
          }
        : {
            read: (value) => (value as readonly Question[])[row]?.[part] ?? "",
            write: (value, input) =>
              (value as readonly Question[]).map((item, index) =>
                index === row ? { ...item, [part]: String(input) } : item,
              ),
          };
    const answer = part === "answer";
    const control: InlineControl = answer
      ? { kind: "text", multiline: true, maxLength: 100_000 }
      : { kind: "text", maxLength: field.maximumLength };
    const draft = this.#fields.get(key);
    return html`<codex-inline-field .name=${`${key}:${id}`}
      .label=${key === "unknown" ? uiText(answer ? "Answer" : "Question") : field.label}
      .placeholder=${answer ? uiText("Add answer") : undefined}
      .value=${project.read(draft?.value ?? this.#initial(key))}
      .current=${project.read(this.#initial(key))}
      .control=${control} .commit=${answer ? "pause" : "blur"} .canEdit=${this.canEdit}
      .draft=${draft} .draftPart=${id} .project=${project}
      .begin=${() => this.#openRow(key, id)}
      .onRemove=${() => this.#removeRow(key, row)}></codex-inline-field>`;
  }
  #openRow(key: "known" | "unknown", part: string): InlineDraft {
    return this.#fields.open(
      key,
      () => ({
        value: this.#initial(key),
        base: this.record,
        current: () => ({ base: this.record, value: this.#initial(key) }),
        save: (value, base) =>
          this.#sendField(key, { base: base as CampaignRecord, fields: { [key]: value } }),
      }),
      part,
    );
  }
  #removeRow(key: "known" | "unknown", row: number): void {
    const draft = this.#fields.get(key);
    if (draft === undefined) return;
    draft.input((draft.value as readonly unknown[]).filter((_item, index) => index !== row));
    void draft.commit(true);
  }
  /** Saves one field edited in place and offers to undo it. */
  async #sendField(key: string, patch: RecordFieldPatch): Promise<CampaignWriteResult> {
    const result = await this.#send(patch);
    if (!result.ok || !this.isConnected || this.record.key !== patch.base.key) return result;
    this.#accept(result);
    const base = recordValue(patch.base);
    this.#undo = {
      base: this.record,
      fields: {
        [key]: this.#initial(key, patch.base),
        ...(key === "faction"
          ? {
              rankAssignment: { chainId: text(base["rankChain"]), rank: text(base["rank"]) },
              attitudes: Array.isArray(base["attitudes"])
                ? base["attitudes"].filter(isRecord).map((item) => item["id"])
                : [],
            }
          : {}),
      },
    };
    this.status = uiText("{0} saved", { "0": this.#field(key).label });
    return result;
  }
  async #send(patch: CampaignCharacterPatch): Promise<CampaignWriteResult> {
    this.#saves++;
    this.requestUpdate();
    try {
      return await saveCampaign(
        this,
        "record-patch",
        patch,
        () => this.isConnected && this.canEdit && this.record.key === patch.base.key,
      );
    } finally {
      this.#saves--;
      this.requestUpdate();
    }
  }
  #accept(result: Extract<CampaignWriteResult, { ok: true }>): void {
    this.record = result.record ?? this.record;
    this.campaign = result.campaign;
  }
  #unsaved(): boolean {
    return (
      this.#fields.dirty ||
      (this.#wikiBase !== undefined &&
        this.#wikiValue !== text(recordValue(this.#wikiBase)["description"])) ||
      this.#panelDirty
    );
  }
  #feedback(): string {
    if (this.#saves > 0) return uiText("Saving…");
    if (this.#fields.failed || this.#wikiError || this.#panelError) return uiText("save.failed");
    if (this.#unsaved()) return uiText("save.draft");
    return this.status || uiText("save.saved");
  }
  readonly #undoSave = async (): Promise<void> => {
    const undo = this.#undo;
    if (!undo) return;
    this.#undo = undefined;
    const result = await this.#send(undo);
    if (result.ok) {
      this.#accept(result);
      this.status = uiText("Change undone");
      // A field still open since the undone save would show the value that is gone.
      for (const key of Object.keys(undo.fields)) {
        const draft = this.#fields.get(key);
        if (draft !== undefined && !draft.dirty && !draft.pending) draft.discard();
      }
    } else {
      this.#undo = undo;
      this.status = result.message;
    }
    this.requestUpdate();
  };
  #addItem(key: "known" | "unknown"): void {
    const rows = (this.#fields.get(key)?.value ?? this.#initial(key)) as readonly unknown[];
    const part = key === "unknown" ? `${rows.length}:text` : `${rows.length}`;
    const draft = this.#openRow(key, part);
    draft.input([...rows, key === "known" ? "" : { text: "", answer: "" }]);
    void this.updateComplete.then(() =>
      [...this.querySelectorAll<CodexInlineField>("codex-inline-field")]
        .find((field) => field.name === `${key}:${part}`)
        ?.open(),
    );
  }

  readonly #openWiki = (): void => {
    if (!this.#wikiBase) {
      this.#wikiBase = this.record;
      this.#wikiValue = text(recordValue(this.record)["description"]);
    }
    this.wikiOpen = true;
    this.#wikiError = "";
  };
  readonly #wikiChanged = (e: CustomEvent<{ value: string }>): void => {
    this.#wikiValue = e.detail.value;
    this.requestUpdate();
  };
  readonly #cancelWiki = (): void => {
    if (this.wikiSaving) return;
    if (
      this.#wikiBase &&
      this.#wikiValue !== text(recordValue(this.#wikiBase)["description"]) &&
      !window.confirm(uiText("Discard the unsaved wiki changes?"))
    )
      return;
    this.querySelector<CodexMarkdownEditor>("codex-markdown-editor")?.discardDraft();
    this.#wikiBase = undefined;
    this.wikiOpen = false;
    this.#wikiError = "";
    this.#wikiConflict = false;
    this.status = "";
    this.requestUpdate();
  };
  readonly #saveWiki = async (): Promise<void> => {
    if (!this.#wikiBase || this.wikiSaving || this.#wikiConflict) return;
    this.wikiSaving = true;
    const source = this.#wikiValue;
    const result = await this.#send({ base: this.#wikiBase, fields: { description: source } });
    this.wikiSaving = false;
    if (result.ok) {
      this.querySelector<CodexMarkdownEditor>("codex-markdown-editor")?.acknowledgeSave(source);
      this.#accept(result);
      this.#wikiBase = this.record;
      this.status = uiText("Wiki saved");
      this.#wikiError = "";
    } else {
      this.#wikiError = result.message;
      this.#wikiConflict = result.conflict === true;
    }
    this.requestUpdate();
    this.requestUpdate();
  };

  #panelValue(panel: string, label: string) {
    return this.canEdit
      ? html`<button type="button" class=${`inline-field-value${label ? "" : " is-empty"}`} @click=${() => this.#openPanel(panel)}>${label || uiText("Add {0}", { "0": panel === "relationships" ? uiText("Relationships").toLocaleLowerCase() : this.#field(panel).label.toLocaleLowerCase() })}</button>`
      : html`<span>${label || "—"}</span>`;
  }
  #openPanel(panel: string): void {
    if (this.#panelSaving) return;
    if (!confirmDiscardUnsavedEdit(this.#panelDirty, (message) => window.confirm(message))) return;
    this.#panelBase = this.record;
    this.#panelCampaign = this.campaign;
    this.#panelDirty = false;
    this.#panelError = "";
    this.panel = panel;
    this.requestUpdate();
    void this.updateComplete.then(async () => {
      const section = this.querySelector<HTMLElement>(".character-section-editor");
      section?.scrollIntoView({ block: "nearest" });
      // Chip pickers are enhanced by the page's shared controls after this render.
      if (section?.querySelector('select[data-ui="chips"]'))
        await new Promise((resolve) => requestAnimationFrame(resolve));
      section
        ?.querySelector<HTMLElement>(
          ".ui-chip-input, input:not([hidden]), select:not([hidden]), button",
        )
        ?.focus();
    });
  }
  #panelContent() {
    const base = this.#panelBase!;
    const value = recordValue(base);
    return html`<section class="character-section-editor" @input=${this.#panelChanged} @change=${this.#panelChanged}><fieldset ?disabled=${this.#panelSaving || !this.canEdit}>
      ${
        this.panel === "portrait"
          ? html`<codex-portrait-editor .portrait=${value["portrait"]} .disabled=${this.#panelSaving}></codex-portrait-editor>`
          : this.panel === "visibility"
            ? html`<label>${uiText("Visibility")}<select name="visibility"><option value="public" ?selected=${value["visibility"] !== "dm"}>${uiText("Public")}</option><option value="dm" ?selected=${value["visibility"] === "dm"}>${uiText("DM only")}</option></select></label>`
            : this.panel === "relationships"
              ? html`<campaign-relationship-editor .campaign=${this.#panelCampaign} .character=${base} .canManageVisibility=${this.canManageVisibility} .recordIdentity=${`${base.key}:${base.revision}:relationships`}></campaign-relationship-editor>`
              : this.panel === "attitudes"
                ? html`<label class="character-panel-field"><span>${uiText("Attitudes toward the party")}</span>
                <select name="attitude" multiple data-ui="chips">${editorOptionsFor(this.campaign, this.#field("attitudes"), this.record.key).map((option) => html`<option value=${option.value} ?selected=${Array.isArray(value["attitudes"]) && value["attitudes"].some((item) => isRecord(item) && item["id"] === option.value)}>${option.label}</option>`)}</select></label>`
                : html`<campaign-structured-field .campaign=${this.#panelCampaign} .field=${this.#field(this.panel)} .record=${value} .factionId=${text(value["faction"])} .recordIdentity=${`${base.key}:${base.revision}:${this.panel}`}></campaign-structured-field>`
      }
      ${this.#panelError ? html`<p role="alert">${this.#panelError}</p>` : nothing}
      <div class="character-local-actions"><button type="button" ?disabled=${this.#panelSaving} @click=${this.#cancelPanel}>${uiText("Cancel")}</button><button type="button" class="primary-record-action" ?disabled=${this.#panelSaving} @click=${this.#savePanel}>${uiText("Save changes")}</button></div>
    </fieldset></section>`;
  }
  readonly #panelChanged = (): void => {
    this.#panelDirty = true;
    this.requestUpdate();
  };
  readonly #cancelPanel = (): void => {
    if (this.#panelSaving) return;
    this.panel = "";
    this.#panelDirty = false;
    this.#panelError = "";
    this.status = "";
    this.requestUpdate();
  };
  readonly #savePanel = async (): Promise<void> => {
    if (!this.#panelBase || this.#panelSaving) return;
    const section = this.querySelector<HTMLElement>(".character-section-editor")!;
    const fields: Record<string, unknown> = {};
    let patch: CampaignCharacterPatch = { base: this.#panelBase, fields };
    if (this.panel === "portrait") {
      const portrait = section
        .querySelector<CodexPortraitEditor>("codex-portrait-editor")
        ?.editorValue();
      if (portrait === undefined) {
        this.#cancelPanel();
        return;
      }
      patch = { ...patch, portrait };
    } else if (this.panel === "visibility")
      patch = {
        ...patch,
        visibility:
          section.querySelector<HTMLSelectElement>("select")?.value === "dm" ? "dm" : "public",
      };
    else if (this.panel === "relationships")
      patch = {
        ...patch,
        relationships: section
          .querySelector<CampaignRelationshipEditorElement>("campaign-relationship-editor")!
          .editorValue(),
        relationshipBase: relationshipBaseFor(this.#panelCampaign!, this.record.key),
      };
    else if (this.panel === "attitudes")
      fields["attitudes"] = [
        ...(section.querySelector<HTMLSelectElement>('select[name="attitude"]')?.selectedOptions ??
          []),
      ].map((option) => option.value);
    else
      fields[this.panel] = section
        .querySelector<CampaignStructuredFieldElement>("campaign-structured-field")!
        .editorValue();
    this.#panelSaving = true;
    this.requestUpdate();
    const result = await this.#send(patch);
    this.#panelSaving = false;
    if (result.ok) {
      this.#accept(result);
      this.#panelDirty = false;
      this.panel = "";
      this.status = uiText("Changes saved");
    } else this.#panelError = result.message;
    this.requestUpdate();
    this.requestUpdate();
  };
  #rankLabel(): string {
    const value = recordValue(this.record);
    const chain = factionRankChains(this.campaign, text(value["faction"])).find(
      (item) => item.id === value["rankChain"],
    );
    return chain ? `${chain.name} — ${text(value["rank"])}` : text(value["rank"]);
  }
  readonly #editAll = (): void => {
    if (
      this.#saves > 0 ||
      this.#fields.dirty ||
      (this.#wikiBase && this.#wikiValue !== text(recordValue(this.#wikiBase)["description"])) ||
      this.#panelDirty
    ) {
      this.status = uiText("Finish or cancel the open edits first.");
      return;
    }
    this.dispatchEvent(
      new CustomEvent("campaign-character-edit-all", { bubbles: true, composed: true }),
    );
  };
}
customElements.define("codex-character-profile", CodexCharacterProfile);

function fieldText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}
