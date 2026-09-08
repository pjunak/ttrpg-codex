import { uiText, UiLocalizationController } from "./ui-localization.js";
import { LitElement, html, nothing } from "lit";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import {
  createCampaignRecordKey,
  relationshipEditorRowsFor,
  relationshipTypeOptionsFor,
  type CampaignEditorField,
  type CampaignRelationshipDirection,
  type CampaignRelationshipEditDetail,
  type CampaignRelationshipTypeOption,
} from "./campaign-record-editor.js";
import { recordValue, text } from "./campaign-projection.js";

export interface CampaignStructuredFieldElement extends HTMLElement {
  readonly fieldKey: string;
  editorValue(): unknown;
  setFaction(factionID: string): void;
}

export interface CampaignRelationshipEditorElement extends HTMLElement {
  editorValue(): readonly CampaignRelationshipEditDetail[];
}

interface QuestionDraft { readonly text: string; readonly answer: string }
interface RankAssignmentDraft { readonly chainId: string; readonly rank: string }
export interface RankChainDraft { readonly id: string; readonly name: string; readonly ranks: readonly string[] }
export interface LocationRoleDraft { readonly locationId: string; readonly role: string }

export class CampaignStructuredFieldEditor extends LitElement implements CampaignStructuredFieldElement {
  static override properties = {
    campaign: { attribute: false },
    field: { attribute: false },
    record: { attribute: false },
    factionId: { attribute: false },
    recordIdentity: { attribute: false },
    revision: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare field: CampaignEditorField | undefined;
  declare record: Readonly<Record<string, unknown>>;
  declare factionId: string;
  declare recordIdentity: string;
  declare private revision: number;
  #draft: unknown = Object.freeze([]);
  #initialized = false;

  constructor() {
    super();
    new UiLocalizationController(this);
    this.campaign = undefined;
    this.field = undefined;
    this.record = {};
    this.factionId = "";
    this.recordIdentity = "";
    this.revision = 0;
  }

  get fieldKey(): string { return this.field?.key ?? ""; }

  protected override createRenderRoot(): HTMLElement | DocumentFragment { return this; }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!this.#initialized || changed.has("recordIdentity") || changed.has("field")) {
      this.#draft = initialDraft(this.field, this.record);
      this.#initialized = true;
    }
  }

  protected override updated(): void {
    if (this.field?.kind === "rank-assignment") {
      const assignment = this.#draft as RankAssignmentDraft;
      setSelectValue(this, "chainId", assignment.chainId);
      setSelectValue(this, "rank", assignment.rank);
    } else if (this.field?.kind === "location-roles") {
      (this.#draft as readonly LocationRoleDraft[]).forEach((row, index) =>
        setSelectValue(this, "locationId", row.locationId, index));
    }
  }

  editorValue(): unknown { return this.#draft; }

  setFaction(factionID: string): void {
    if (this.field?.kind !== "rank-assignment" || factionID === this.factionId) return;
    this.factionId = factionID;
    this.#draft = Object.freeze({ chainId: "", rank: "" });
    this.#changed(true);
  }

  protected override render() {
    const field = this.field;
    if (field === undefined || this.campaign === undefined) return nothing;
    const help = field.help === undefined ? nothing : html`<small class="field-help">${field.help}</small>`;
    if (field.kind === "questions") return this.#questions(field, help);
    if (field.kind === "rank-assignment") return this.#rankAssignment(field, help);
    if (field.kind === "location-roles") return this.#locationRoles(field, help);
    if (field.kind === "rank-chains") return this.#rankChains(field, help);
    return nothing;
  }

  #questions(field: CampaignEditorField, help: unknown) {
    const rows = this.#draft as readonly QuestionDraft[];
    return html`
      <section class="structured-editor wide-field" aria-labelledby=${`structured-${field.key}`}>
        ${sectionHeading(`structured-${field.key}`, field.label, help, uiText("Add question"), this.#addRow)}
        ${rows.length === 0 ? html`<p class="structured-empty">${uiText("No questions recorded.")}</p>` : html`
          <div class="structured-ledger question-ledger">
            ${rows.map((row, index) => html`
              <div class=${`structured-row question-row${row.answer.trim() === "" ? "" : " is-answered"}`}>
                <span class="structured-row-index" aria-hidden="true">Q${String(index + 1).padStart(2, "0")}</span>
                ${textInput(uiText("Question"), row.text, index, "text", field.maximumLength, uiText("What remains unclear?"), this.#updateInput)}
                ${textInput(uiText("Answer"), row.answer, index, "answer", 100_000, uiText("Leave blank while unresolved"), this.#updateInput)}
                ${removeButton(uiText("Remove question {0}", { "0": index + 1 }), index, this.#removeRow)}
              </div>
            `)}
          </div>
        `}
      </section>`;
  }

  #rankAssignment(field: CampaignEditorField, help: unknown) {
    const assignment = this.#draft as RankAssignmentDraft;
    const chains = factionRankChains(this.campaign!, this.factionId);
    const selectedChain = chains.find(({ id }) => id === assignment.chainId);
    const orphaned = assignment.chainId !== "" && selectedChain === undefined;
    return html`
      <section class="structured-editor rank-assignment" aria-labelledby="structured-rank-assignment">
        ${sectionHeading("structured-rank-assignment", field.label, help)}
        <div class="rank-assignment-fields">
          <label><span>${uiText("Chain")}</span><select data-part="chainId" @change=${this.#updateInput}>
            <option value="" ?selected=${assignment.chainId === ""}>${uiText("Not ranked")}</option>
            ${orphaned ? html`<option value=${assignment.chainId} selected>${uiText("Stored chain ({0})", { "0": assignment.chainId })}</option>` : nothing}
            ${chains.filter(({ ranks }) => ranks.length > 0).map((chain) => html`
              <option value=${chain.id} ?selected=${assignment.chainId === chain.id}>${chain.name}</option>`)}
          </select></label>
          <label><span>${uiText("Rank")}</span><select data-part="rank" @change=${this.#updateInput}
            ?disabled=${assignment.chainId === ""}>
            ${orphaned && assignment.rank !== "" ? html`<option value=${assignment.rank} selected>${uiText("Stored rank ({0})", { "0": assignment.rank })}</option>` : nothing}
            ${(selectedChain?.ranks ?? []).map((rank) => html`
              <option value=${rank} ?selected=${assignment.rank === rank}>${rank}</option>`)}
          </select></label>
        </div>
      </section>`;
  }

  #locationRoles(field: CampaignEditorField, help: unknown) {
    const rows = this.#draft as readonly LocationRoleDraft[];
    const locations = campaignOptions(this.campaign!, "locations");
    const selected = new Set(rows.map(({ locationId }) => locationId));
    return html`
      <section class="structured-editor wide-field" aria-labelledby="structured-location-roles">
        ${sectionHeading("structured-location-roles", field.label, help, uiText("Add role"), this.#addRow,
          locations.length === 0 || selected.size >= locations.length)}
        ${rows.length === 0 ? html`<p class="structured-empty">${uiText("No additional location roles.")}</p>` : html`
          <div class="structured-ledger">
            ${rows.map((row, index) => html`
              <div class="structured-row location-role-row">
                <span class="structured-row-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
                <label><span>${uiText("Location")}</span><select data-row=${String(index)} data-part="locationId"
                  @change=${this.#updateInput}>
                  <option value="" ?selected=${row.locationId === ""}>${uiText("Choose a location")}</option>
                  ${locations.map((option) => html`<option value=${option.value}
                    ?selected=${option.value === row.locationId}
                    ?disabled=${option.value !== row.locationId && selected.has(option.value)}>${option.label}</option>`)}
                </select></label>
                ${textInput(uiText("Role or connection"), row.role, index, "role", field.maximumLength,
                  uiText("Warden, visitor, prisoner…"), this.#updateInput)}
                ${removeButton(uiText("Remove role"), index, this.#removeRow)}
              </div>
            `)}
          </div>
        `}
      </section>`;
  }

  #rankChains(field: CampaignEditorField, help: unknown) {
    const chains = this.#draft as readonly RankChainDraft[];
    return html`
      <section class="structured-editor wide-field" aria-labelledby="structured-rank-chains">
        ${sectionHeading("structured-rank-chains", field.label, help, uiText("Add chain"), this.#addRow)}
        ${chains.length === 0 ? html`<p class="structured-empty">${uiText("No rank chains recorded.")}</p>` : html`
          <div class="rank-chain-ledger">
            ${chains.map((chain, chainIndex) => html`
              <section class="rank-chain-card">
                <header>
                  <span class="structured-row-index" aria-hidden="true">${String(chainIndex + 1).padStart(2, "0")}</span>
                  ${textInput(uiText("Chain name"), chain.name, chainIndex, "name", field.maximumLength,
                    uiText("Guard command"), this.#updateInput)}
                  ${removeButton(uiText("Remove chain"), chainIndex, this.#removeRow)}
                </header>
                <div class="rank-list">
                  ${chain.ranks.map((rank, rankIndex) => html`
                    <div class="rank-row">
                      <span aria-hidden="true">${rankIndex + 1}</span>
                      <label><span>${uiText("Rank {0}", { "0": rankIndex + 1 })}</span><input data-row=${String(chainIndex)} data-rank=${String(rankIndex)}
                        data-part="rank" maxlength=${field.maximumLength} .value=${rank} placeholder=${uiText("Highest to lowest")}
                        @input=${this.#updateInput} /></label>
                      <button class="structured-remove" type="button" data-row=${String(chainIndex)} data-rank=${String(rankIndex)}
                        @click=${this.#removeRank}>${uiText("Remove")}</button>
                    </div>
                  `)}
                </div>
                <button class="structured-add-secondary" type="button" data-row=${String(chainIndex)}
                  @click=${this.#addRank}>${uiText("Add rank")}</button>
              </section>
            `)}
          </div>
        `}
      </section>`;
  }

  readonly #updateInput = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement | HTMLSelectElement;
    const part = input.dataset["part"];
    if (part === undefined) return;
    if (this.field?.kind === "rank-assignment") {
      const current = this.#draft as RankAssignmentDraft;
      if (part === "chainId") {
        const chain = factionRankChains(this.campaign!, this.factionId).find(({ id }) => id === input.value);
        this.#draft = Object.freeze({ chainId: input.value, rank: chain?.ranks[0] ?? "" });
        this.revision += 1;
      } else if (part === "rank") this.#draft = Object.freeze({ ...current, rank: input.value });
      return;
    }
    const rowIndex = Number(input.dataset["row"]);
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return;
    if (this.field?.kind === "rank-chains") {
      const rows = [...(this.#draft as readonly RankChainDraft[])];
      const row = rows[rowIndex];
      if (row === undefined) return;
      if (part === "rank") {
        const rankIndex = Number(input.dataset["rank"]);
        if (!Number.isSafeInteger(rankIndex) || rankIndex < 0 || rankIndex >= row.ranks.length) return;
        const ranks = [...row.ranks];
        ranks[rankIndex] = input.value;
        rows[rowIndex] = Object.freeze({ ...row, ranks: Object.freeze(ranks) });
      } else if (part === "name") rows[rowIndex] = Object.freeze({ ...row, name: input.value });
      this.#draft = Object.freeze(rows);
      return;
    }
    if (this.field?.kind === "questions" && (part === "text" || part === "answer")) {
      const rows = [...(this.#draft as readonly QuestionDraft[])];
      const row = rows[rowIndex];
      if (row === undefined) return;
      rows[rowIndex] = Object.freeze({ ...row, [part]: input.value });
      this.#draft = Object.freeze(rows);
      return;
    }
    if (this.field?.kind === "location-roles" && (part === "locationId" || part === "role")) {
      const rows = [...(this.#draft as readonly LocationRoleDraft[])];
      const row = rows[rowIndex];
      if (row === undefined) return;
      rows[rowIndex] = Object.freeze({ ...row, [part]: input.value });
      this.#draft = Object.freeze(rows);
      if (part === "locationId") this.revision += 1;
    }
  };

  readonly #addRow = (): void => {
    const rows = [...(this.#draft as readonly unknown[])];
    if (this.field?.kind === "questions") rows.push(Object.freeze({ text: "", answer: "" }));
    else if (this.field?.kind === "location-roles") rows.push(Object.freeze({ locationId: "", role: "" }));
    else if (this.field?.kind === "rank-chains") rows.push(Object.freeze({
      id: createCampaignRecordKey("rank-chain"), name: "", ranks: Object.freeze([]),
    }));
    else return;
    this.#draft = Object.freeze(rows);
    this.#changed(true);
  };

  readonly #removeRow = (event: Event): void => {
    const index = Number((event.currentTarget as HTMLButtonElement).dataset["row"]);
    const rows = [...(this.#draft as readonly unknown[])];
    if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length) return;
    rows.splice(index, 1);
    this.#draft = Object.freeze(rows);
    this.#changed(true);
  };

  readonly #addRank = (event: Event): void => {
    const index = Number((event.currentTarget as HTMLButtonElement).dataset["row"]);
    const rows = [...(this.#draft as readonly RankChainDraft[])];
    const chain = rows[index];
    if (chain === undefined) return;
    rows[index] = Object.freeze({ ...chain, ranks: Object.freeze([...chain.ranks, ""]) });
    this.#draft = Object.freeze(rows);
    this.#changed(true);
  };

  readonly #removeRank = (event: Event): void => {
    const button = event.currentTarget as HTMLButtonElement;
    const rowIndex = Number(button.dataset["row"]);
    const rankIndex = Number(button.dataset["rank"]);
    const rows = [...(this.#draft as readonly RankChainDraft[])];
    const chain = rows[rowIndex];
    if (chain === undefined || !Number.isSafeInteger(rankIndex) || rankIndex < 0 || rankIndex >= chain.ranks.length) return;
    const ranks = [...chain.ranks];
    ranks.splice(rankIndex, 1);
    rows[rowIndex] = Object.freeze({ ...chain, ranks: Object.freeze(ranks) });
    this.#draft = Object.freeze(rows);
    this.#changed(true);
  };

  #changed(render: boolean): void {
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (render) this.revision += 1;
  }
}

export class CampaignRelationshipEditor extends LitElement implements CampaignRelationshipEditorElement {
  static override properties = {
    campaign: { attribute: false },
    character: { attribute: false },
    canManageVisibility: { type: Boolean, attribute: false },
    recordIdentity: { attribute: false },
    revision: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare character: CampaignRecord | undefined;
  declare canManageVisibility: boolean;
  declare recordIdentity: string;
  declare private revision: number;
  #rows: readonly CampaignRelationshipEditDetail[] = Object.freeze([]);
  #initialized = false;

  constructor() {
    super();
    new UiLocalizationController(this);
    this.campaign = undefined;
    this.character = undefined;
    this.canManageVisibility = false;
    this.recordIdentity = "";
    this.revision = 0;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment { return this; }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!this.#initialized || changed.has("recordIdentity")) {
      this.#rows = this.campaign === undefined || this.character === undefined
        ? Object.freeze([])
        : relationshipEditorRowsFor(this.campaign, this.character.key, this.canManageVisibility);
      this.#initialized = true;
    }
  }

  protected override updated(): void {
    this.#rows.forEach((row, index) => {
      setSelectValue(this, "type", row.type, index);
      setSelectValue(this, "direction", row.direction, index);
      setSelectValue(this, "target", row.target, index);
      if (this.canManageVisibility) setSelectValue(this, "visibility", row.visibility ?? "public", index);
    });
  }

  editorValue(): readonly CampaignRelationshipEditDetail[] { return this.#rows; }

  protected override render() {
    if (this.campaign === undefined) return nothing;
    if (this.character === undefined) return html`
      <section class="structured-editor wide-field relationship-editor">
        ${sectionHeading("structured-relationships", uiText("Relationships"), nothing)}
        <p class="structured-empty">${uiText("Save the character first, then connect them to people and places.")}</p>
      </section>`;
    const configuredTypes = relationshipTypeOptionsFor(this.campaign);
    return html`
      <section class="structured-editor wide-field relationship-editor" aria-labelledby="structured-relationships">
        ${sectionHeading("structured-relationships", uiText("Relationships"), html`
          <small class="field-help">${uiText("Read each row as this character → relationship → target. Both directions create two linked records in one save.")}</small>
        `, uiText("Add relationship"), this.#addRow, configuredTypes.length === 0)}
        ${this.#rows.length === 0 ? html`<p class="structured-empty">${uiText("No relationships recorded.")}</p>` : html`
          <div class="structured-ledger relationship-ledger">${this.#rows.map((row, index) => this.#row(row, index, configuredTypes))}</div>
        `}
      </section>`;
  }

  #row(row: CampaignRelationshipEditDetail, index: number, configured: readonly CampaignRelationshipTypeOption[]) {
    const character = this.character!;
    const types = relationshipTypesIncludingOrphan(configured, row);
    const type = types.find(({ value }) => value === row.type) ?? types[0];
    const directions = type?.directions ?? ["from"];
    const targets = type === undefined ? [] : campaignOptions(this.campaign!, type.targetCollection)
      .filter(({ value }) => type.targetCollection === "locations" || value !== character.key);
    return html`
      <div class="structured-row relationship-row">
        <span class="relationship-source">${recordName(character)}</span>
        <label><span>${uiText("Relationship")}</span><select data-row=${String(index)} data-part="type"
          @change=${this.#updateInput}>${types.map((option) => html`
            <option value=${option.value} ?selected=${option.value === row.type}>${option.label}</option>`)}</select></label>
        <label><span>${uiText("Direction")}</span><select data-row=${String(index)} data-part="direction"
          @change=${this.#updateInput}>${directions.map((direction) => html`
            <option value=${direction} ?selected=${direction === row.direction}>${relationshipDirectionLabel(direction)}</option>`)}</select></label>
        <label><span>${uiText("Target")}</span><select data-row=${String(index)} data-part="target" required
          @change=${this.#updateInput}><option value="" ?selected=${row.target === ""}>${uiText(type?.targetCollection === "locations" ? "Choose a location" : "Choose a character")}</option>
          ${targets.map((option) => html`<option value=${option.value} ?selected=${option.value === row.target}>${option.label}</option>`)}</select></label>
        <label class="relationship-label"><span>${uiText("Custom label")}</span><input data-row=${String(index)} data-part="label" maxlength="500"
          .value=${row.label} placeholder=${type?.label ?? uiText("Relationship")} @input=${this.#updateInput} /></label>
        ${this.canManageVisibility ? html`<label><span>${uiText("Visibility")}</span><select data-row=${String(index)} data-part="visibility"
          @change=${this.#updateInput}><option value="public" ?selected=${row.visibility !== "dm"}>${uiText("Public")}</option>
          <option value="dm" ?selected=${row.visibility === "dm"}>${uiText("DM only")}</option>
        </select></label>` : nothing}
        ${removeButton(uiText("Remove relationship"), index, this.#removeRow)}
      </div>`;
  }

  readonly #addRow = (): void => {
    const type = relationshipTypeOptionsFor(this.campaign!)[0];
    if (type === undefined) return;
    this.#rows = Object.freeze([...this.#rows, Object.freeze({
      originalKey: null,
      expectedRevision: 0,
      direction: type.directions[0] ?? "from",
      target: "",
      type: type.value,
      label: "",
      ...(this.canManageVisibility ? { visibility: "public" as const } : {}),
    })]);
    this.#changed();
  };

  readonly #updateInput = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement | HTMLSelectElement;
    const index = Number(input.dataset["row"]);
    const part = input.dataset["part"];
    const rows = [...this.#rows];
    const row = rows[index];
    if (row === undefined || part === undefined) return;
    if (part === "type") {
      const previous = relationshipTypesIncludingOrphan(relationshipTypeOptionsFor(this.campaign!), row)
        .find(({ value }) => value === row.type);
      const next = relationshipTypeOptionsFor(this.campaign!).find(({ value }) => value === input.value);
      if (next === undefined) return;
      rows[index] = Object.freeze({ ...row, type: next.value,
        direction: next.directions.includes(row.direction) ? row.direction : next.directions[0] ?? "from",
        target: previous?.targetCollection === next.targetCollection ? row.target : "" });
    } else if (part === "direction" && isDirection(input.value)) rows[index] = Object.freeze({ ...row, direction: input.value });
    else if (part === "target" || part === "label") rows[index] = Object.freeze({ ...row, [part]: input.value });
    else if (part === "visibility" && this.canManageVisibility && (input.value === "public" || input.value === "dm")) {
      rows[index] = Object.freeze({ ...row, visibility: input.value });
    } else return;
    this.#rows = Object.freeze(rows);
    if (part === "type") this.revision += 1;
  };

  readonly #removeRow = (event: Event): void => {
    const index = Number((event.currentTarget as HTMLButtonElement).dataset["row"]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#rows.length) return;
    const rows = [...this.#rows];
    rows.splice(index, 1);
    this.#rows = Object.freeze(rows);
    this.#changed();
  };

  #changed(): void {
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this.revision += 1;
  }
}

function initialDraft(field: CampaignEditorField | undefined, value: Readonly<Record<string, unknown>>): unknown {
  if (field?.kind === "questions") return questionDrafts(value[field.key]);
  if (field?.kind === "rank-assignment") return Object.freeze({
    chainId: stringValue(value["rankChain"]), rank: stringValue(value["rank"]),
  });
  if (field?.kind === "rank-chains") return rankChainDrafts(value[field.key]);
  if (field?.kind === "location-roles") return locationRoleDrafts(value[field.key]);
  return Object.freeze([]);
}

function questionDrafts(value: unknown): readonly QuestionDraft[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((candidate) => {
    if (typeof candidate === "string") return [Object.freeze({ text: candidate, answer: "" })];
    if (!plainObject(candidate)) return [];
    return [Object.freeze({ text: stringValue(candidate["text"]), answer: stringValue(candidate["answer"]) })];
  }));
}

export function rankChainDrafts(value: unknown): readonly RankChainDraft[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((candidate) => {
    if (!plainObject(candidate)) return [];
    const id = stringValue(candidate["id"]);
    return id === "" ? [] : [Object.freeze({
      id, name: stringValue(candidate["name"]), ranks: Object.freeze(stringArray(candidate["ranks"])),
    })];
  }));
}

export function locationRoleDrafts(value: unknown): readonly LocationRoleDraft[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((candidate) => {
    if (!plainObject(candidate)) return [];
    const locationId = stringValue(candidate["locationId"]);
    return locationId === "" ? [] : [Object.freeze({ locationId, role: stringValue(candidate["role"]) })];
  }));
}

export function factionRankChains(campaign: CampaignDataset, factionID: string): readonly RankChainDraft[] {
  const faction = campaignCollection(campaign, "factions").records.find(({ key }) => key === factionID);
  return rankChainDrafts(recordValue(faction)["rankChains"]);
}

export function campaignOptions(campaign: CampaignDataset, collection: "characters" | "locations") {
  return Object.freeze(campaignCollection(campaign, collection).records.map((record) => Object.freeze({
    value: record.key, label: text(recordValue(record)["name"]) || record.key,
  })));
}

function relationshipTypesIncludingOrphan(
  configured: readonly CampaignRelationshipTypeOption[], row: CampaignRelationshipEditDetail,
): readonly CampaignRelationshipTypeOption[] {
  if (configured.some(({ value }) => value === row.type) || row.type === "") return configured;
  return Object.freeze([Object.freeze({
    value: row.type,
    label: uiText("{0} (stored)", { "0": row.type }),
    targetCollection: row.type === "mission" ? "locations" as const : "characters" as const,
    directions: Object.freeze(["from", "to"] as CampaignRelationshipDirection[]),
  }), ...configured]);
}

function relationshipDirectionLabel(direction: CampaignRelationshipDirection): string {
  if (direction === "from") return uiText("This character → target");
  if (direction === "to") return uiText("Target → this character");
  return uiText("Both directions");
}

function sectionHeading(id: string, label: string, help: unknown, action?: string,
  handler?: (event: Event) => void, disabled = false) {
  return html`<header class="structured-editor-heading"><div><h3 id=${id}>${label}</h3>${help}</div>
    ${action === undefined ? nothing : html`<button type="button" @click=${handler} ?disabled=${disabled}>${action}</button>`}</header>`;
}

function textInput(label: string, value: string, row: number, part: string, maximumLength: number,
  placeholder: string, handler: (event: Event) => void) {
  return html`<label><span>${label}</span><input data-row=${String(row)} data-part=${part} maxlength=${maximumLength}
    .value=${value} placeholder=${placeholder} @input=${handler} /></label>`;
}

function removeButton(label: string, row: number, handler: (event: Event) => void) {
  return html`<button class="structured-remove" type="button" data-row=${String(row)} @click=${handler}>${label}</button>`;
}

function setSelectValue(root: ParentNode, part: string, value: string, row?: number): void {
  const selector = row === undefined
    ? `select[data-part="${part}"]`
    : `select[data-row="${row}"][data-part="${part}"]`;
  const select = root.querySelector<HTMLSelectElement>(selector);
  if (select !== null) select.value = value;
}

function recordName(record: CampaignRecord): string { return text(recordValue(record)["name"]) || record.key; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function plainObject(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isDirection(value: string): value is CampaignRelationshipDirection { return value === "from" || value === "to" || value === "both"; }

if (!customElements.get("campaign-structured-field")) customElements.define("campaign-structured-field", CampaignStructuredFieldEditor);
if (!customElements.get("campaign-relationship-editor")) customElements.define("campaign-relationship-editor", CampaignRelationshipEditor);
