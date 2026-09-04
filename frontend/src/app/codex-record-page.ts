import { LitElement, html, nothing } from "lit";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import {
  collectionManagesVisibility,
  createCampaignRecordKey,
  editorFieldsFor,
  type CampaignRecordDeleteDetail,
  type CampaignRecordSaveDetail,
} from "./campaign-record-editor.js";
import {
  projectEntities,
  recordValue,
  stringList,
  text,
  type EntitySummary,
} from "./campaign-projection.js";
import { collectionHash, type AppRoute } from "./routes.js";

type RecordRoute = Extract<AppRoute, { kind: "collection" | "record" }>;

export class CodexRecordPage extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    route: { attribute: false },
    canEdit: { type: Boolean, attribute: "can-edit" },
    canManageVisibility: { type: Boolean, attribute: "can-manage-visibility" },
    saving: { type: Boolean },
    editCompletion: { type: Number, attribute: false },
    query: { state: true },
    editor: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare route: RecordRoute | undefined;
  declare canEdit: boolean;
  declare canManageVisibility: boolean;
  declare saving: boolean;
  declare editCompletion: number;
  declare private query: string;
  declare private editor: "closed" | "create" | "edit";

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
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("route")) {
      this.query = "";
      this.editor = "closed";
    }
    if (changed.has("editCompletion")) this.editor = "closed";
  }

  protected override render() {
    if (this.campaign === undefined || this.route === undefined) return nothing;
    return this.route.kind === "collection"
      ? this.#collection(this.campaign, this.route)
      : this.#record(this.campaign, this.route);
  }

  #collection(dataset: CampaignDataset, route: Extract<RecordRoute, { kind: "collection" }>) {
    const entities = projectEntities(dataset, route.page);
    const needle = this.query.trim().toLocaleLowerCase();
    const visible = needle === "" ? entities : entities.filter((entity) =>
      [entity.name, entity.title, entity.excerpt, ...entity.tags]
        .join(" ").toLocaleLowerCase().includes(needle)
    );
    return html`
      <article class="collection-page" aria-labelledby="collection-title">
        <header class="page-heading collection-heading">
          <span class="page-heading-mark" aria-hidden="true">${route.page.icon}</span>
          <div>
            <h1 id="collection-title">${route.page.plural}</h1>
            <p>${collectionIntroductions[route.page.collection]}</p>
          </div>
          ${this.canEdit ? html`
            <button class="record-action primary-record-action" type="button" @click=${this.#startCreate} ?disabled=${this.saving}>
              Add ${route.page.singular.toLocaleLowerCase()}
            </button>
          ` : nothing}
        </header>
        ${this.editor === "create" ? this.#editorForm(undefined, route) : nothing}
        <label class="collection-search">
          <span>Filter ${route.page.plural.toLocaleLowerCase()}</span>
          <input
            type="search"
            .value=${this.query}
            placeholder=${`Name, title, or tag`}
            @input=${this.#onSearch}
          />
        </label>
        <p class="collection-count" aria-live="polite">
          ${visible.length} ${visible.length === 1 ? route.page.singular.toLocaleLowerCase() : route.page.plural.toLocaleLowerCase()}
        </p>
        ${visible.length === 0
          ? html`<p class="empty-state">No matching entries are recorded in this part of the archive.</p>`
          : html`<div class="record-ledger">${visible.map((entity) => recordRow(entity))}</div>`}
      </article>
    `;
  }

  #record(dataset: CampaignDataset, route: Extract<RecordRoute, { kind: "record" }>) {
    const collection = campaignCollection(dataset, route.page.collection);
    const record = collection.records.find(({ key }) => key === route.key);
    if (record === undefined) {
      return html`
        <article class="record-article missing-record">
          <a href=${collectionHash(route.page)} class="breadcrumb-link">Back to ${route.page.plural}</a>
          <h1>Entry not found</h1>
          <p>This entry is not available in the current campaign view.</p>
        </article>
      `;
    }
    const entity = projectEntities(dataset, route.page).find(({ key }) => key === route.key);
    if (entity === undefined) return nothing;
    const value = recordValue(record);
    if (this.editor === "edit") {
      return html`
        <article class="record-article editor-article" aria-labelledby="record-editor-title">
          <a href=${collectionHash(route.page)} class="breadcrumb-link">${route.page.plural}</a>
          ${this.#editorForm(record, route)}
        </article>
      `;
    }
    const facts = articleFacts(dataset, route.page.collection, value);
    const sections = articleSections(value);
    return html`
      <article class="record-article" aria-labelledby="record-title">
        <a href=${collectionHash(route.page)} class="breadcrumb-link">${route.page.plural}</a>
        <header class="record-masthead">
          ${entity.portrait === undefined ? nothing : html`
            <img class="record-portrait" src=${entity.portrait} alt="" />
          `}
          <div>
            <span class="record-kind">${route.page.singular}</span>
            <h1 id="record-title">${entity.name}</h1>
            ${entity.title === "" ? nothing : html`<p>${entity.title}</p>`}
            <div class="record-badges">
              ${entity.visibility === "dm" ? html`<span class="dm-badge">DM</span>` : nothing}
              ${entity.status === "" ? nothing : html`<span>${entity.status}</span>`}
              ${entity.tags.map((tag) => html`<span>${tag}</span>`)}
            </div>
          </div>
          ${this.canEdit ? html`
            <button class="record-action" type="button" @click=${this.#startEdit} ?disabled=${this.saving}>Edit</button>
          ` : nothing}
        </header>
        ${facts.length === 0 ? nothing : html`
          <dl class="record-facts">
            ${facts.map(([label, fact]) => html`<div><dt>${label}</dt><dd>${fact}</dd></div>`)}
          </dl>
        `}
        ${sections.length === 0
          ? html`<p class="empty-state">This entry does not have article text yet.</p>`
          : html`<div class="record-prose">
              ${sections.map(([heading, body]) => html`
                <section>
                  <h2>${heading}</h2>
                  <p>${body}</p>
                </section>
              `)}
            </div>`}
      </article>
    `;
  }

  readonly #onSearch = (event: Event): void => {
    this.query = (event.currentTarget as HTMLInputElement).value;
  };

  #editorForm(record: CampaignRecord | undefined, route: RecordRoute) {
    const fields = editorFieldsFor(route.page.collection);
    const value = recordValue(record);
    const creating = record === undefined;
    return html`
      <form class="record-editor" @submit=${this.#submitEditor}>
        <header>
          <div>
            <p class="page-kicker">${creating ? "New entry" : `Revision ${record.revision}`}</p>
            <h2 id="record-editor-title">${creating ? `Add ${route.page.singular.toLocaleLowerCase()}` : `Edit ${text(value["name"]) || route.page.singular.toLocaleLowerCase()}`}</h2>
            <p>Only the fields shown here are changed. Other campaign and add-on data remains untouched.</p>
          </div>
        </header>
        <div class="record-editor-fields">
          ${fields.map((field) => html`
            <label class=${field.kind === "text" ? "wide-field" : ""}>
              <span>${field.label}</span>
              ${field.kind === "text"
                ? html`<textarea
                    name=${field.key}
                    maxlength=${field.maximumLength}
                    .value=${editorValue(value[field.key])}
                    ?required=${field.required === true}
                  ></textarea>`
                : html`<input
                    name=${field.key}
                    type=${field.kind === "number" ? "number" : "text"}
                    step=${field.kind === "number" ? "any" : nothing}
                    maxlength=${field.kind === "number" ? nothing : field.maximumLength}
                    .value=${editorValue(value[field.key])}
                    placeholder=${field.placeholder ?? ""}
                    ?required=${field.required === true}
                  />`}
            </label>
          `)}
          ${collectionManagesVisibility(route.page.collection) && this.canManageVisibility ? html`
            <label>
              <span>Visibility</span>
              <select name="visibility" .value=${value["visibility"] === "dm" ? "dm" : "public"}>
                <option value="public">Public</option>
                <option value="dm">DM only</option>
              </select>
            </label>
          ` : nothing}
        </div>
        <footer class="record-editor-actions">
          ${record === undefined ? nothing : html`
            <button class="danger-record-action" type="button" @click=${this.#deleteRecord} ?disabled=${this.saving}>Delete</button>
          `}
          <span></span>
          <button type="button" @click=${this.#closeEditor} ?disabled=${this.saving}>Cancel</button>
          <button class="primary-record-action" type="submit" ?disabled=${this.saving}>
            ${this.saving ? "Saving…" : "Save entry"}
          </button>
        </footer>
      </form>
    `;
  }

  readonly #startCreate = (): void => {
    if (this.canEdit && !this.saving) this.editor = "create";
  };

  readonly #startEdit = (): void => {
    if (this.canEdit && !this.saving) this.editor = "edit";
  };

  readonly #closeEditor = (): void => {
    if (!this.saving) this.editor = "closed";
  };

  readonly #submitEditor = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.canEdit || this.saving || this.campaign === undefined || this.route === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const fields: Record<string, string> = {};
    for (const field of editorFieldsFor(this.route.page.collection)) {
      const raw = String(data.get(field.key) ?? "");
      fields[field.key] = field.kind === "line" ? raw.trim() : raw;
    }
    const creating = this.editor === "create";
    const key = creating
      ? createCampaignRecordKey(fields["name"] ?? this.route.page.singular)
      : this.route.kind === "record" ? this.route.key : "";
    if (key === "") return;
    const record = creating ? undefined : campaignCollection(this.campaign, this.route.page.collection).records
      .find(({ key: recordKey }) => recordKey === key);
    if (!creating && record === undefined) return;
    const detail: CampaignRecordSaveDetail = {
      collection: this.route.page.collection,
      key,
      expectedRevision: record?.revision ?? 0,
      creating,
      fields: Object.freeze(fields),
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
    const target = campaignCollection(this.campaign, this.route.page.collection).records
      .find(({ key }) => key === recordKey);
    if (target === undefined ||
      !window.confirm(`Delete this ${this.route.page.singular.toLocaleLowerCase()}? This cannot be undone from this page.`)) {
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

function recordRow(entity: EntitySummary) {
  return html`
    <a class="record-row" href=${entity.route}>
      ${entity.portrait === undefined
        ? html`<span class="record-row-mark" aria-hidden="true">${entity.icon ?? initial(entity.name)}</span>`
        : html`<img class="record-row-mark" src=${entity.portrait} alt="" loading="lazy" />`}
      <span class="record-row-copy">
        <strong>${entity.name}</strong>
        ${entity.title === "" ? nothing : html`<span>${entity.title}</span>`}
        ${entity.excerpt === "" ? nothing : html`<small>${entity.excerpt}</small>`}
      </span>
      ${entity.visibility === "dm" ? html`<span class="dm-badge">DM</span>` : nothing}
    </a>
  `;
}

function articleSections(value: Readonly<Record<string, unknown>>): readonly (readonly [string, string])[] {
  const definitions: readonly (readonly [string, readonly string[]])[] = [
    ["Overview", ["description", "summary", "short"]],
    ["What is known", ["known"]],
    ["History", ["history"]],
    ["Details", ["body", "notes"]],
    ["Open questions", ["unknown"]],
  ];
  const seen = new Set<string>();
  const result: Array<readonly [string, string]> = [];
  for (const [heading, fields] of definitions) {
    for (const field of fields) {
      const body = text(value[field]);
      if (body !== "" && !seen.has(body)) {
        seen.add(body);
        result.push([heading, body]);
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
    let result = printable(raw);
    if (result !== "" && referenceCollection !== undefined) {
      result = resolveName(dataset, referenceCollection, result) ?? result;
    }
    if (result !== "") facts.push([label, result]);
  }
  return facts;
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
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return stringList(value).join(", ");
  return "";
}

function initial(value: string): string {
  return [...value.trim()][0]?.toLocaleUpperCase() ?? "?";
}

function editorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

const collectionIntroductions: Readonly<Record<string, string>> = {
  characters: "People encountered on the road, from trusted allies to half-known adversaries.",
  locations: "Settlements, wilderness, strongholds, and the smaller places held within them.",
  events: "The recorded sequence of the campaign and the moments that changed its course.",
  mysteries: "Open questions, gathered clues, and truths that have not yet come into view.",
  factions: "Orders, households, cults, and powers pursuing their own designs.",
  pantheon: "Gods, saints, patrons, and the beliefs carried in their names.",
  artifacts: "Objects whose history or power makes them part of the campaign chronicle.",
  historicalEvents: "The older events that shaped the world before the current journey.",
  pets: "Animals, familiars, mounts, and other companions traveling with the cast.",
};

const factDefinitions: Readonly<Record<string, readonly (readonly [string, string, string?])[]>> = {
  characters: [["Species", "species"], ["Gender", "gender"], ["Age", "age"], ["Status", "status"], ["Faction", "faction", "factions"], ["Current location", "location", "locations"]],
  locations: [["Kind", "type"], ["Region", "region"], ["Parent location", "parentId", "locations"]],
  events: [["Date", "date"], ["Session", "sitting"], ["Priority", "priority"]],
  mysteries: [["Priority", "priority"], ["Solved", "solved"]],
  factions: [["Kind", "type"], ["Domain", "domain"], ["Rank", "rank"]],
  pantheon: [["Domain", "domain"], ["Symbol", "symbol"], ["Alignment", "alignment"]],
  artifacts: [["Kind", "type"], ["Holder", "holder", "characters"], ["Origin", "origin"]],
  historicalEvents: [["Date", "date"], ["Period", "period"], ["Location", "location", "locations"]],
  pets: [["Species", "species"], ["Owner", "ownerId", "characters"], ["Status", "status"]],
};

if (!customElements.get("codex-record-page")) {
  customElements.define("codex-record-page", CodexRecordPage);
}
