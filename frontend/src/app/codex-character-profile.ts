import { LitElement, html, nothing, type TemplateResult } from "lit";
import { isRecord } from "../core/boundary.js";
import { type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import { previewResourceURL } from "../core/player-preview.js";
import { editorFieldsFor, editorOptionsFor, relationshipBaseFor, relationshipEditorRowsFor, relationshipTypeOptionsFor, sameCampaignValue,
  type CampaignEditorField, type CampaignCharacterPatch, type CampaignCharacterSaveResult, type CampaignCharacterSaveRequest } from "./campaign-record-editor.js";
import { recordValue, text, stringList, type EntitySummary } from "./campaign-projection.js";
import { factionRankChains, type CampaignStructuredFieldElement, type CampaignRelationshipEditorElement } from "./campaign-structured-editors.js";
import { parseCampaignMarkdown, renderCampaignMarkdown, type CampaignMarkdownContext } from "./campaign-markdown.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { CodexMarkdownEditor } from "./codex-markdown-editor.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { CodexPortraitEditor } from "./codex-portrait-editor.js";

interface FieldDraft {
  readonly key: string;
  base: CampaignRecord;
  value: unknown;
  original: unknown;
  row?: number;
  part?: string;
  timer?: ReturnType<typeof setTimeout>;
  pending: boolean;
  closeAfter: boolean;
  again: boolean;
  error: string;
  conflict: boolean;
}

export class CodexCharacterProfile extends LitElement {
  static override properties = {
    campaign: { attribute: false }, record: { attribute: false }, entity: { attribute: false }, context: { attribute: false }, extraSections: { attribute: false },
    canEdit: { type: Boolean }, canManageVisibility: { type: Boolean },
    actorRole: { attribute: false },
    status: { state: true }, panel: { state: true }, wikiOpen: { state: true }, wikiSaving: { state: true },
  };
  declare campaign: CampaignDataset;
  declare record: CampaignRecord;
  declare entity: EntitySummary;
  declare context: CampaignMarkdownContext;
  declare extraSections: readonly { heading: string; body: string }[] | undefined;
  declare canEdit: boolean;
  declare canManageVisibility: boolean;
  declare actorRole: BrowserRole | undefined;
  declare private status: string;
  declare private panel: string;
  declare private wikiOpen: boolean;
  declare private wikiSaving: boolean;
  readonly #ui = new UiLocalizationController(this);
  readonly #drafts = new Map<string, FieldDraft>();
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
  #queue: Promise<void> = Promise.resolve();
  #saves = 0;
  #lastKey = "";

  constructor() { super(); this.canEdit = false; this.canManageVisibility = false; this.status = ""; this.panel = ""; this.wikiOpen = false; this.wikiSaving = false; }
  protected override createRenderRoot() { return this; }
  get hasDraft(): boolean { return this.#saves > 0 || this.#drafts.size > 0 || this.wikiOpen || this.panel !== ""; }
  override disconnectedCallback(): void { for (const draft of this.#drafts.values()) clearTimeout(draft.timer); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.record?.key !== this.#lastKey || changed.has("actorRole") || !this.canEdit) {
      for (const draft of this.#drafts.values()) clearTimeout(draft.timer);
      this.#drafts.clear(); this.#wikiBase = undefined; this.#panelBase = undefined; this.#undo = undefined;
      this.wikiOpen = false; this.panel = ""; this.#lastKey = this.record?.key ?? ""; this.status = "";
    }
    if (!this.canEdit) for (const draft of this.#drafts.values()) clearTimeout(draft.timer);
  }
  protected override render() {
    if (!this.record || !this.campaign || !this.entity) return nothing;
    const value = recordValue(this.record); const entity = this.entity;
    const wiki = parseCampaignMarkdown(text(value["description"]));
    return html`<article class="record-article character-profile direct-character" aria-labelledby="record-title">
      <div class="character-page-heading"><a href="#/characters" class="breadcrumb-link">${uiText("Characters")}</a>
        ${this.canEdit ? html`<div class="character-save-status"><span role="status">${this.status}</span>${this.#undo ? html`<button type="button" ?disabled=${this.#saves > 0} @click=${this.#undoSave}>${uiText("Undo")}</button>` : nothing}
        <details class="character-more"><summary aria-label=${uiText("More actions")}>⋯</summary><div>
          <button type="button" @click=${this.#editAll}>${uiText("Edit all fields")}</button>
          <button type="button" @click=${() => this.#openPanel("portrait")}>${uiText("Portrait")}</button>
          ${this.canManageVisibility ? html`<button type="button" @click=${() => this.#openPanel("visibility")}>${uiText("Visibility")}</button>` : nothing}
        </div></details></div>` : nothing}</div>
      <div class="record-reading-layout">
        <aside class="record-side"><header class="record-masthead">
          ${entity.portrait ? html`<img class="record-portrait" src=${previewResourceURL(entity.portrait)} alt="" style=${entity.attitudeRing ? `--attitude-ring: ${entity.attitudeRing}` : nothing} />`
            : html`<span class="record-portrait record-portrait-placeholder" aria-hidden="true" style=${entity.attitudeRing ? `--attitude-ring: ${entity.attitudeRing}` : nothing}><span class="record-visual-glyph">${entity.icon || "♟"}</span></span>`}
          <div><span class="record-kind">${uiText("Character")}</span><h1 id="record-title" aria-label=${text(value["name"])}>${this.#inline("name")}</h1>
            <div class="character-subtitle">${this.#inline("title")}</div>
            <div class="record-badges">${entity.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
              ${entity.partyIdentity ? html`<span class="party-identity-badge" style=${`background:${entity.partyIdentity.color};color:${entity.partyIdentity.textColor}`}>${entity.partyIdentity.badge} ${entity.partyIdentity.name}</span>` : nothing}
              ${entity.attitudes.map(attitude => html`<span class="attitude-badge" style=${`--attitude-color:${attitude.color}`}>${attitude.label}</span>`)}</div>
          </div></header>
          <dl class="record-facts">${["species", "gender", "age", "status", "knowledge", "tags"].map(key => this.#fact(key))}</dl>
          <section class="character-connections"><h2 class="record-section-title">${uiText("Connections")}</h2>
            <dl class="record-facts">${["faction", "location"].map(key => this.#fact(key))}<div><dt>${uiText("Faction rank")}</dt><dd>${this.#panelValue("rankAssignment", this.#rankLabel())}</dd></div>
            <div><dt>${uiText("Attitudes toward the party")}</dt><dd>${this.#panelValue("attitudes", entity.attitudes.map(item => item.label).join(", "))}</dd></div></dl>
          </section>
          <section class="character-circumstances"><h2 class="record-section-title">${uiText("Current circumstances")}</h2>${this.#inline("circumstances")}</section>
          ${wiki.outline.length ? html`<aside class="record-outline" aria-label=${uiText("Article contents")}><p>${uiText("In this entry")}</p><ol>${wiki.outline.map(item => html`<li class=${`outline-depth-${item.depth}`}><button type="button" @click=${() => this.querySelector<HTMLElement>(`#${item.id}`)?.scrollIntoView({ block: "start" })}>${item.text}</button></li>`)}</ol></aside>` : nothing}
        </aside>
        <div class="record-reading"><section class="character-wiki"><div class="character-section-heading"><h2 class="record-section-title">${uiText("Overview")}</h2>
          ${this.canEdit && !this.wikiOpen ? html`<button type="button" class="record-action" @click=${this.#openWiki}>${uiText("Edit wiki")}</button>` : nothing}</div>
          ${this.wikiOpen ? html`<codex-markdown-editor .value=${this.#wikiValue} .label=${uiText("Overview")} .identity=${`${this.record.key}:wiki`}
            .draftContext=${this.actorRole && this.#wikiBase ? { role: this.actorRole, collection: "characters", record: this.#wikiBase.key,
              field: "description", revision: this.#wikiBase.revision, baseValue: text(recordValue(this.#wikiBase)["description"]) } : undefined}
            .context=${this.context} .disabled=${this.wikiSaving} @markdown-change=${this.#wikiChanged} @markdown-save=${this.#saveWiki}></codex-markdown-editor>
            ${this.#wikiError ? html`<p role="alert">${this.#wikiError}</p>${this.#wikiConflict ? html`<details><summary>${uiText("Current saved value")}</summary>${renderCampaignMarkdown(parseCampaignMarkdown(text(recordValue(this.record)["description"])), this.context)}</details>
              <button type="button" @click=${() => { this.#wikiBase = this.record; this.#wikiConflict = false; this.#wikiError = ""; this.requestUpdate(); }}>${uiText("Keep my draft")}</button>` : nothing}` : nothing}
            <div class="character-local-actions"><button type="button" ?disabled=${this.wikiSaving} @click=${this.#cancelWiki}>${uiText("Cancel")}</button>
              <button type="button" class="primary-record-action" ?disabled=${this.wikiSaving} @click=${this.#saveWiki}>${uiText(this.wikiSaving ? "Saving…" : "Save text")}</button></div>`
            : wiki.tokens.length ? renderCampaignMarkdown(wiki, this.context) : html`<p class="empty-state">${uiText("This entry does not have article text yet.")}</p>`}
        </section>
        <div class="character-knowledge-grid"><section><h2 class="record-section-title">${uiText("What is known")}</h2>
          <ul class="character-fact-list">${this.#known().map((_item, index) => html`<li>${this.#inline("known", index)}</li>`)}</ul>
          ${this.canEdit ? html`<button class="character-add" type="button" @click=${() => this.#addItem("known")}>+ ${uiText("Add fact")}</button>` : nothing}</section>
          <section><h2 class="record-section-title">${uiText("Open questions")}</h2>
          <div class="character-questions">${this.#questions().map((_item, index) => html`<div>${this.#inline("unknown", index, "text")}<div class="character-answer">${this.#inline("unknown", index, "answer")}</div></div>`)}</div>
          ${this.canEdit ? html`<button class="character-add" type="button" @click=${() => this.#addItem("unknown")}>+ ${uiText("Add question")}</button>` : nothing}</section></div>
        <section class="record-structured-section"><h2 class="record-section-title">${uiText("Relationships")}</h2>
          ${this.#panelValue("relationships", this.#relationshipLabels())}</section>
        <section class="record-structured-section"><h2 class="record-section-title">${uiText("Other location roles")}</h2>
          ${this.#panelValue("locationRoles", this.#locationRolesLabel())}</section>
        ${this.extraSections?.map(section => html`<section class="record-structured-section"><h2 class="record-section-title">${section.heading}</h2>${renderCampaignMarkdown(parseCampaignMarkdown(section.body), this.context)}</section>`)}
        ${this.panel ? this.#panelContent() : nothing}
        </div>
      </div>
    </article>`;
  }

  #field(key: string): CampaignEditorField { return editorFieldsFor("characters").find(field => field.key === key)!; }
  #initial(key: string, record = this.record): unknown {
    const value = recordValue(record);
    if (key === "known") return stringList(value[key]);
    if (key === "unknown") return Array.isArray(value[key]) ? value[key].map(item => isRecord(item) ? { text: text(item["text"]) || text(item["question"]), answer: text(item["answer"]) } : { text: text(item), answer: "" }) : [];
    if (key === "tags") return stringList(value[key]);
    return value[key] === undefined ? "" : String(value[key]);
  }
  #known(): readonly string[] { return (this.#drafts.get("known")?.value ?? this.#initial("known")) as readonly string[]; }
  #questions(): readonly { text: string; answer: string }[] { return (this.#drafts.get("unknown")?.value ?? this.#initial("unknown")) as readonly { text: string; answer: string }[]; }
  #fact(key: string) { return html`<div><dt>${this.#field(key).label}</dt><dd>${this.#inline(key)}</dd></div>`; }
  #display(key: string, value: unknown): string {
    if (key === "tags") return (value as string[]).join(", ");
    const field = this.#field(key);
    return editorOptionsFor(this.campaign, field, this.record.key).find(option => option.value === String(value))?.label ?? String(value ?? "");
  }
  #inline(key: string, row?: number, part?: string): TemplateResult {
    const draft = this.#drafts.get(key); const field = this.#field(key);
    const whole = draft?.value ?? this.#initial(key);
    const value = row === undefined ? this.#display(key, whole) : key === "known" ? String((whole as string[])[row] ?? "") : text((whole as Record<string, unknown>[])[row]?.[part ?? "text"]);
    const active = draft && draft.row === row && draft.part === part;
    const label = key === "unknown" ? uiText(part === "answer" ? "Answer" : "Question") : field.label;
    if (!this.canEdit) return html`<span>${value || "—"}</span>`;
    if (!active) return html`<button type="button" class="character-edit-value" data-edit-field=${key} aria-label=${uiText("Edit {0}", { "0": label })}
      @click=${() => this.#begin(key, row, part)}>${value || uiText(part === "answer" ? "Add answer" : "Add {0}", { "0": label.toLocaleLowerCase() })}</button>`;
    const options = editorOptionsFor(this.campaign, field, this.record.key);
    const auto = key === "circumstances" || part === "answer";
    return html`<span class="character-inline-editor" data-field=${key}>
      ${field.kind === "enum" || field.kind === "reference" ? html`<select aria-label=${label} .value=${String(whole)} ?disabled=${draft.pending}
        @change=${(e: Event) => { this.#input(key, (e.target as HTMLSelectElement).value); void this.#saveField(key, true); }}
        @blur=${() => { if (!draft.error) void this.#saveField(key, true); }}
        @keydown=${(e: KeyboardEvent) => this.#fieldKey(e, key, auto)}><option value="" ?selected=${whole === ""}>${uiText("None")}</option>
        ${!options.some(option => option.value === whole) && whole ? html`<option value=${String(whole)} selected>${String(whole)}</option>` : nothing}
        ${options.map(option => html`<option value=${option.value} ?selected=${option.value === whole}>${option.label}</option>`)}</select>`
        : auto ? html`<textarea aria-label=${label} .value=${value} maxlength=${part === "answer" ? 100_000 : field.maximumLength}
          @input=${(e: Event) => this.#input(key, (e.target as HTMLTextAreaElement).value, true)} @blur=${() => { if (!draft.error) void this.#saveField(key, true); }}
          @keydown=${(e: KeyboardEvent) => this.#fieldKey(e, key, true)}></textarea>`
          : html`<input aria-label=${label} .value=${value} type=${field.kind === "number" ? "number" : "text"} min=${field.minimum ?? nothing} max=${field.maximum ?? nothing} maxlength=${field.kind === "tags" ? nothing : field.maximumLength} ?required=${field.required === true}
            @input=${(e: Event) => this.#input(key, (e.target as HTMLInputElement).value)} @blur=${() => { if (!draft.error) void this.#saveField(key, true); }}
            @keydown=${(e: KeyboardEvent) => this.#fieldKey(e, key, false)} />`}
      <small class="character-edit-hint">${draft.pending ? uiText("Saving…") : auto ? uiText("Saves after a short pause") : uiText("Enter to confirm · Esc to cancel")}</small>
      ${row !== undefined ? html`<button type="button" ?disabled=${draft.pending} @pointerdown=${(event: PointerEvent) => event.preventDefault()} @click=${() => { (draft.value as unknown[]).splice(row, 1); void this.#saveField(key, true); }}>${uiText("Remove")}</button>` : nothing}
      ${draft.error ? html`<span role="alert">${draft.error}</span>${draft.conflict ? html`<small>${uiText("Current saved value")}: ${this.#display(key, this.#initial(key))}</small>
        <button type="button" @click=${() => { draft.base = this.record; draft.original = this.#initial(key); draft.conflict = false; draft.error = ""; this.requestUpdate(); }}>${uiText("Keep my draft")}</button>` : html`<button type="button" @click=${() => this.#saveField(key, true)}>${uiText("Retry")}</button>`}
        <button type="button" @click=${() => this.#cancelField(key)}>${uiText("Use current value")}</button>` : nothing}
    </span>`;
  }
  async #begin(key: string, row?: number, part?: string): Promise<void> {
    let draft = this.#drafts.get(key);
    if (!draft) { const value = this.#initial(key); draft = { key, base: this.record, value: structuredClone(value), original: value, pending: false, again: false, closeAfter: false, error: "", conflict: false }; this.#drafts.set(key, draft); }
    if (row !== undefined) draft.row = row; else delete draft.row;
    if (part !== undefined) draft.part = part; else delete draft.part;
    this.requestUpdate(); await this.updateComplete;
    const control = this.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${key}"] input,[data-field="${key}"] textarea,[data-field="${key}"] select`);
    control?.focus(); if (control instanceof HTMLInputElement) control.select();
  }
  #input(key: string, value: string, auto = false): void {
    const draft = this.#drafts.get(key); if (!draft) return;
    if (draft.row !== undefined) {
      const rows = structuredClone(draft.value) as (string | Record<string, unknown>)[];
      if (key === "known") rows[draft.row] = value;
      else (rows[draft.row] as Record<string, unknown>)[draft.part ?? "text"] = value;
      draft.value = rows;
    } else draft.value = key === "tags" ? value.split(",").map(item => item.trim()).filter(Boolean) : value;
    draft.error = ""; clearTimeout(draft.timer);
    if (auto && !draft.conflict) draft.timer = setTimeout(() => { void this.#saveField(key, false); }, 700);
    this.#dirty();
  }
  #fieldKey(e: KeyboardEvent, key: string, auto: boolean): void {
    if (e.isComposing) return;
    if (e.key === "Enter" && !auto) { e.preventDefault(); void this.#saveField(key, true); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (auto) void this.#saveField(key, true); else this.#cancelField(key); }
  }
  #cancelField(key: string): void { const draft = this.#drafts.get(key); if (draft?.pending) return; clearTimeout(draft?.timer); this.#drafts.delete(key); this.#dirty(); this.requestUpdate(); }
  async #saveField(key: string, close: boolean): Promise<void> {
    const draft = this.#drafts.get(key); if (!draft || !this.canEdit || draft.conflict) return;
    clearTimeout(draft.timer); draft.closeAfter = close;
    if (draft.pending) { draft.again = true; return; }
    if (sameCampaignValue(draft.value, draft.original)) { if (close) this.#cancelField(key); return; }
    if (this.#field(key).required && !String(draft.value).trim()) { draft.error = uiText("A name is required."); this.requestUpdate(); return; }
    draft.pending = true; const submitted = structuredClone(draft.value); const before = structuredClone(draft.original); const base = draft.base;
    const editedRow = draft.row, editedPart = draft.part;
    this.requestUpdate();
    const result = await this.#send({ base: draft.base, fields: { [key]: submitted } });
    draft.pending = false;
    if (!this.isConnected || this.record.key !== draft.base.key) return;
    if (result.ok) {
      this.#accept(result); draft.base = result.record; draft.original = this.#initial(key, result.record);
      this.#undo = { base: result.record, fields: { [key]: before, ...(key === "faction" ? {
        rankAssignment: { chainId: text(recordValue(base)["rankChain"]), rank: text(recordValue(base)["rank"]) },
        attitudes: Array.isArray(recordValue(base)["attitudes"]) ? (recordValue(base)["attitudes"] as unknown[]).filter(isRecord).map(item => item["id"]) : [],
      } : {}) } };
      if (sameCampaignValue(draft.value, submitted)) {
        const closeCurrent = draft.closeAfter && draft.row === editedRow && draft.part === editedPart;
        if (closeCurrent) draft.value = structuredClone(draft.original);
        else draft.original = structuredClone(submitted);
        if (closeCurrent) this.#drafts.delete(key);
      }
      this.status = uiText("{0} saved", { "0": this.#field(key).label });
    } else { draft.error = result.message; draft.conflict = result.conflict === true; this.status = uiText("Changes not saved"); }
    this.#dirty(); this.requestUpdate();
    if (result.ok && draft.again && this.#drafts.has(key)) { draft.again = false; void this.#saveField(key, draft.closeAfter); }
  }
  #send(patch: CampaignCharacterPatch): Promise<CampaignCharacterSaveResult> {
    this.#saves++; this.#dirty();
    let finish!: (result: CampaignCharacterSaveResult) => void;
    const result = new Promise<CampaignCharacterSaveResult>(resolve => { finish = resolve; });
    this.#queue = this.#queue.then(async () => {
      let settled = false;
      const response = await new Promise<CampaignCharacterSaveResult>(resolve => {
        const respond = (value: CampaignCharacterSaveResult) => { if (!settled) { settled = true; resolve(value); } };
        if (!this.isConnected || !this.canEdit || this.record.key !== patch.base.key) { respond({ ok: false, message: uiText("The entry cannot be saved right now. Your draft is kept.") }); return; }
        const event = new CustomEvent<CampaignCharacterSaveRequest>("campaign-character-save", { detail: { ...patch, respond }, bubbles: true, composed: true, cancelable: true });
        if (this.dispatchEvent(event)) respond({ ok: false, message: uiText("The entry cannot be saved right now. Your draft is kept.") });
      });
      this.#saves--; finish(response); this.#dirty();
    });
    return result;
  }
  #accept(result: Extract<CampaignCharacterSaveResult, { ok: true }>): void { this.record = result.record; this.campaign = result.campaign; }
  #dirty(): void {
    const dirty = [...this.#drafts.values()].some(draft => !sameCampaignValue(draft.value, draft.original)) ||
      this.#wikiBase !== undefined && this.#wikiValue !== text(recordValue(this.#wikiBase)["description"]) || this.#panelDirty;
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty, saving: this.#saves > 0 }, bubbles: true, composed: true }));
  }
  readonly #undoSave = async (): Promise<void> => {
    const undo = this.#undo; if (!undo) return; this.#undo = undefined;
    const result = await this.#send(undo);
    if (result.ok) { this.#accept(result); this.status = uiText("Change undone"); }
    else { this.#undo = undo; this.status = result.message; } this.requestUpdate();
  };
  #addItem(key: "known" | "unknown"): void { void this.#begin(key).then(() => { const draft = this.#drafts.get(key)!; const rows = [...draft.value as unknown[]]; rows.push(key === "known" ? "" : { text: "", answer: "" }); draft.value = rows; void this.#begin(key, rows.length - 1, key === "unknown" ? "text" : undefined); this.#dirty(); }); }

  readonly #openWiki = (): void => { if (!this.#wikiBase) { this.#wikiBase = this.record; this.#wikiValue = text(recordValue(this.record)["description"]); } this.wikiOpen = true; this.#wikiError = ""; };
  readonly #wikiChanged = (e: CustomEvent<{ value: string }>): void => { this.#wikiValue = e.detail.value; this.#dirty(); };
  readonly #cancelWiki = (): void => { if (this.wikiSaving) return; if (this.#wikiBase && this.#wikiValue !== text(recordValue(this.#wikiBase)["description"]) && !window.confirm(uiText("Discard the unsaved wiki changes?"))) return; this.querySelector<CodexMarkdownEditor>("codex-markdown-editor")?.discardDraft(); this.#wikiBase = undefined; this.wikiOpen = false; this.#wikiError = ""; this.#dirty(); };
  readonly #saveWiki = async (): Promise<void> => {
    if (!this.#wikiBase || this.wikiSaving || this.#wikiConflict) return;
    this.wikiSaving = true; const source = this.#wikiValue;
    const result = await this.#send({ base: this.#wikiBase, fields: { description: source } });
    this.wikiSaving = false;
    if (result.ok) { this.querySelector<CodexMarkdownEditor>("codex-markdown-editor")?.acknowledgeSave(source); this.#accept(result); this.#wikiBase = result.record; this.status = uiText("Wiki saved"); this.#wikiError = ""; }
    else { this.#wikiError = result.message; this.#wikiConflict = result.conflict === true; }
    this.#dirty(); this.requestUpdate();
  };

  #panelValue(panel: string, label: string) { return this.canEdit ? html`<button type="button" class="character-edit-value" @click=${() => this.#openPanel(panel)}>${label || uiText("Add {0}", { "0": panel === "relationships" ? uiText("Relationships").toLocaleLowerCase() : this.#field(panel).label.toLocaleLowerCase() })}</button>` : html`<span>${label || "—"}</span>`; }
  #openPanel(panel: string): void { if (this.#panelSaving) return; if (this.#panelDirty && !window.confirm(uiText("Discard the unsaved changes in this entry?"))) return; this.#panelBase = this.record; this.#panelCampaign = this.campaign; this.#panelDirty = false; this.#panelError = ""; this.panel = panel; this.#dirty(); void this.updateComplete.then(() => { const section = this.querySelector<HTMLElement>(".character-section-editor"); section?.scrollIntoView({ block: "nearest" }); section?.querySelector<HTMLElement>("input,select,button")?.focus(); }); }
  #panelContent() {
    const base = this.#panelBase!; const value = recordValue(base);
    return html`<section class="character-section-editor" @input=${this.#panelChanged} @change=${this.#panelChanged}><fieldset ?disabled=${this.#panelSaving || !this.canEdit}>
      ${this.panel === "portrait" ? html`<codex-portrait-editor .portrait=${value["portrait"]} .disabled=${this.#panelSaving}></codex-portrait-editor>`
        : this.panel === "visibility" ? html`<label>${uiText("Visibility")}<select name="visibility"><option value="public" ?selected=${value["visibility"] !== "dm"}>${uiText("Public")}</option><option value="dm" ?selected=${value["visibility"] === "dm"}>${uiText("DM only")}</option></select></label>`
        : this.panel === "relationships" ? html`<campaign-relationship-editor .campaign=${this.#panelCampaign} .character=${base} .canManageVisibility=${this.canManageVisibility} .recordIdentity=${`${base.key}:${base.revision}:relationships`}></campaign-relationship-editor>`
        : this.panel === "attitudes" ? html`<h2>${uiText("Attitudes toward the party")}</h2>${editorOptionsFor(this.campaign, this.#field("attitudes"), this.record.key).map(option => html`<label class="character-checkbox"><input name="attitude" type="checkbox" value=${option.value} ?checked=${Array.isArray(value["attitudes"]) && value["attitudes"].some(item => isRecord(item) && item["id"] === option.value)} />${option.label}</label>`)}`
        : html`<campaign-structured-field .campaign=${this.#panelCampaign} .field=${this.#field(this.panel)} .record=${value} .factionId=${text(value["faction"])} .recordIdentity=${`${base.key}:${base.revision}:${this.panel}`}></campaign-structured-field>`}
      ${this.#panelError ? html`<p role="alert">${this.#panelError}</p>` : nothing}
      <div class="character-local-actions"><button type="button" ?disabled=${this.#panelSaving} @click=${this.#cancelPanel}>${uiText("Cancel")}</button><button type="button" class="primary-record-action" ?disabled=${this.#panelSaving} @click=${this.#savePanel}>${uiText("Save changes")}</button></div>
    </fieldset></section>`;
  }
  readonly #panelChanged = (): void => { this.#panelDirty = true; this.#dirty(); };
  readonly #cancelPanel = (): void => { if (this.#panelSaving) return; this.panel = ""; this.#panelDirty = false; this.#dirty(); };
  readonly #savePanel = async (): Promise<void> => {
    if (!this.#panelBase || this.#panelSaving) return;
    const section = this.querySelector<HTMLElement>(".character-section-editor")!;
    const fields: Record<string, unknown> = {};
    let patch: CampaignCharacterPatch = { base: this.#panelBase, fields };
    if (this.panel === "portrait") { const portrait = section.querySelector<CodexPortraitEditor>("codex-portrait-editor")?.editorValue(); if (portrait === undefined) { this.#cancelPanel(); return; } patch = { ...patch, portrait }; }
    else if (this.panel === "visibility") patch = { ...patch, visibility: section.querySelector<HTMLSelectElement>("select")?.value === "dm" ? "dm" : "public" };
    else if (this.panel === "relationships") patch = { ...patch, relationships: section.querySelector<CampaignRelationshipEditorElement>("campaign-relationship-editor")!.editorValue(), relationshipBase: relationshipBaseFor(this.#panelCampaign!, this.record.key) };
    else if (this.panel === "attitudes") fields["attitudes"] = [...section.querySelectorAll<HTMLInputElement>("input:checked")].map(input => input.value);
    else fields[this.panel] = section.querySelector<CampaignStructuredFieldElement>("campaign-structured-field")!.editorValue();
    this.#panelSaving = true; this.requestUpdate(); const result = await this.#send(patch); this.#panelSaving = false;
    if (result.ok) { this.#accept(result); this.#panelDirty = false; this.panel = ""; this.status = uiText("Changes saved"); }
    else this.#panelError = result.message;
    this.#dirty(); this.requestUpdate();
  };
  #rankLabel(): string { const value = recordValue(this.record); const chain = factionRankChains(this.campaign, text(value["faction"])).find(item => item.id === value["rankChain"]); return chain ? `${chain.name} — ${text(value["rank"])}` : text(value["rank"]); }
  #relationshipLabels(): string {
    const types = relationshipTypeOptionsFor(this.campaign);
    return relationshipEditorRowsFor(this.campaign, this.record.key, this.canManageVisibility).map(row => {
      const type = types.find(type => type.value === row.type);
      const collection = row.direction === "to" ? "characters" : type?.targetCollection ?? "characters";
      const peer = this.campaign.collections.find(item => item.name === collection)?.records.find(item => item.key === row.target);
      const name = peer ? text(recordValue(peer)["name"]) : row.target;
      return row.direction === "to" ? name + " → " + (row.label || type?.label || row.type) : (row.label || type?.label || row.type) + " → " + name;
    }).join(" · ");
  }
  #locationRolesLabel(): string {
    const roles = recordValue(this.record)["locationRoles"];
    return Array.isArray(roles) ? roles.filter(isRecord).map(role => {
      const location = this.campaign.collections.find(item => item.name === "locations")?.records.find(item => item.key === role["locationId"]);
      return text(role["role"]) + ": " + (location ? text(recordValue(location)["name"]) : text(role["locationId"]));
    }).join(" · ") : "";
  }
  readonly #editAll = (): void => { if (this.#saves > 0 || [...this.#drafts.values()].some(draft => !sameCampaignValue(draft.value, draft.original)) || this.#wikiBase && this.#wikiValue !== text(recordValue(this.#wikiBase)["description"]) || this.#panelDirty) { this.status = uiText("Finish or cancel the open edits first."); return; } this.dispatchEvent(new CustomEvent("campaign-character-edit-all", { bubbles: true, composed: true })); };
}
customElements.define("codex-character-profile", CodexCharacterProfile);
