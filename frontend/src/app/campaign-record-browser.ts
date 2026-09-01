import { LitElement, css, html, type PropertyValues } from "lit";
import type { BrowserContributionRegistry, ActiveBrowserContribution } from "../addons/browser-sdk.js";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { isRecord } from "../core/boundary.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import {
  campaignCollectionHash,
  campaignRecordHash,
  type CampaignPageDescriptor,
} from "./core-navigation.js";

export interface CampaignRecordSummary {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly visibility: "public" | "dm";
  readonly revision: number;
}

export interface CampaignRecordSaveDetail {
  readonly collection: CampaignPageDescriptor["collection"];
  readonly key: string;
  readonly expectedRevision: number;
  readonly creating: boolean;
  readonly fields: Readonly<Record<string, string>>;
  readonly visibility?: "public" | "dm";
}

export interface CampaignRecordDeleteDetail {
  readonly collection: CampaignPageDescriptor["collection"];
  readonly key: string;
  readonly expectedRevision: number;
}

export interface RecordContributionHostContext {
  readonly kind: "campaign-record";
  readonly collection: CampaignPageDescriptor["collection"];
  readonly key: string;
  readonly revision: number;
  readonly value: unknown;
  readonly canEdit: boolean;
}

export function projectCampaignRecords(
  dataset: CampaignDataset,
  page: CampaignPageDescriptor,
  query = "",
): readonly CampaignRecordSummary[] {
  const needle = normalizeSearch(query);
  return campaignCollection(dataset, page.collection).records
    .map((record) => summarizeRecord(page, record))
    .filter((record) => needle === "" || normalizeSearch(
      `${record.title}\n${record.summary}\n${record.key}`,
    ).includes(needle))
    .sort((left, right) => left.title.localeCompare(right.title, "en", { sensitivity: "base" }));
}

export function createCampaignRecordKey(name: string, token = randomToken()): string {
  const slug = name.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "") || "record";
  const safeToken = token.toLocaleLowerCase("en").replace(/[^a-z0-9]/g, "").slice(0, 12);
  return `${slug}-${safeToken === "" ? "new" : safeToken}`;
}

export class CampaignRecordBrowser extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    page: { attribute: false },
    recordKey: { attribute: false },
    canEdit: { type: Boolean, attribute: "can-edit" },
    canManageVisibility: { type: Boolean, attribute: "can-manage-visibility" },
    saving: { type: Boolean },
    addonRegistry: { attribute: false },
    addonRole: { attribute: false },
    query: { state: true },
    editor: { state: true },
  };

  static override styles = css`
    :host {
      display: block;
      margin-top: 2rem;
      padding-top: 1.75rem;
      border-top: 1px solid #55534a;
    }

    h2,
    h3,
    p {
      margin: 0;
    }

    h2,
    h3 {
      color: #e2d7bd;
      font-family: Palatino, "Palatino Linotype", Georgia, serif;
      font-weight: 500;
    }

    h2 {
      font-size: clamp(1.7rem, 4vw, 2.7rem);
      letter-spacing: -0.025em;
    }

    h3 {
      font-size: 1.25rem;
    }

    a {
      color: #d8c99f;
      text-decoration: none;
    }

    a:hover {
      color: #f1dfb2;
      text-decoration: underline;
    }

    a:focus-visible,
    button:focus-visible,
    input:focus-visible,
    textarea:focus-visible,
    select:focus-visible {
      outline: 2px solid #ded4bc;
      outline-offset: 3px;
    }

    .page-heading,
    .record-heading,
    .editor-heading {
      display: flex;
      gap: 1rem;
      align-items: start;
      justify-content: space-between;
    }

    .page-heading p,
    .record-meta,
    .empty,
    .summary {
      color: #aaa79e;
      line-height: 1.5;
    }

    .toolbar {
      display: flex;
      gap: 0.65rem;
      align-items: center;
      margin: 1.25rem 0;
    }

    .search {
      width: min(28rem, 100%);
    }

    input,
    textarea,
    select,
    button {
      min-height: 2.6rem;
      border: 1px solid #55584f;
      border-radius: 0.3rem;
      color: #eee8da;
      background: #171b21;
      font: inherit;
    }

    input,
    textarea,
    select {
      width: 100%;
      min-width: 0;
      padding: 0.6rem 0.7rem;
    }

    textarea {
      min-height: 13rem;
      resize: vertical;
      line-height: 1.5;
    }

    button {
      padding: 0.55rem 0.85rem;
      cursor: pointer;
    }

    button.primary {
      border-color: #c3a464;
      color: #211d15;
      background: #c3a464;
    }

    button.danger {
      border-color: #7c4e4a;
      color: #e8aaa1;
      background: #2b1d1f;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    .records {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
      gap: 0.75rem;
    }

    .record-card {
      min-width: 0;
      padding: 1rem;
      border: 1px solid #454841;
      border-radius: 0.3rem;
      background: #1b1f26;
    }

    .record-card a {
      display: block;
      overflow-wrap: anywhere;
      font-size: 1.03rem;
      font-weight: 650;
    }

    .summary {
      display: -webkit-box;
      margin-top: 0.35rem;
      overflow: hidden;
      font-size: 0.84rem;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-top: 0.75rem;
    }

    .badge {
      padding: 0.17rem 0.38rem;
      border: 1px solid #4b4d48;
      border-radius: 999px;
      color: #a7a59d;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.68rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .badge.dm {
      border-color: #715852;
      color: #df9f93;
    }

    .breadcrumb {
      display: inline-block;
      margin-bottom: 1rem;
      color: #aaa79e;
      font-size: 0.86rem;
    }

    .record-body {
      display: grid;
      grid-template-columns: minmax(12rem, 0.35fr) minmax(0, 1fr);
      gap: 1.25rem;
      margin-top: 1.5rem;
    }

    .facts,
    .prose,
    form {
      padding: 1rem;
      border: 1px solid #454841;
      border-radius: 0.3rem;
      background: #1b1f26;
    }

    .addon-sections {
      display: grid;
      gap: 1rem;
      margin-top: 1.25rem;
    }

    .addon-sections[hidden] {
      display: none;
    }

    .addon-contribution {
      min-width: 0;
      overflow: hidden;
      border: 1px solid #454841;
      border-radius: 0.3rem;
      background: #1b1f26;
    }

    .addon-contribution-heading {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      justify-content: space-between;
      padding: 0.65rem 0.85rem;
      border-bottom: 1px solid #454841;
      color: #d8c99f;
    }

    .addon-contribution-heading span {
      color: #88877f;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.68rem;
    }

    .addon-contribution > :not(.addon-contribution-heading) {
      display: block;
      min-width: 0;
    }

    dl {
      display: grid;
      gap: 0.75rem;
      margin: 0;
    }

    dt {
      color: #99978f;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.7rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    dd {
      margin: 0.15rem 0 0;
      overflow-wrap: anywhere;
      color: #e3ded2;
    }

    .prose {
      min-height: 10rem;
      white-space: pre-wrap;
      color: #d2cec2;
      line-height: 1.65;
    }

    form {
      display: grid;
      gap: 0.9rem;
      margin-top: 1rem;
    }

    label {
      display: grid;
      gap: 0.35rem;
      color: #bdb9ad;
      font-size: 0.82rem;
    }

    .form-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      justify-content: end;
    }

    @media (max-width: 46rem) {
      .page-heading,
      .record-heading {
        display: grid;
      }

      .record-body {
        grid-template-columns: 1fr;
      }
    }
  `;

  declare campaign: CampaignDataset | undefined;
  declare page: CampaignPageDescriptor | undefined;
  declare recordKey: string | undefined;
  declare canEdit: boolean;
  declare canManageVisibility: boolean;
  declare saving: boolean;
  declare addonRegistry: BrowserContributionRegistry | undefined;
  declare addonRole: BrowserRole;
  declare private query: string;
  declare private editor: "closed" | "create" | "edit";
  #addonOutlet: BrowserContributionOutlet | undefined;
  #addonOutletRoot: HTMLElement | undefined;
  #addonOutletRegistry: BrowserContributionRegistry | undefined;
  #addonOutletRole: BrowserRole | undefined;

  constructor() {
    super();
    this.campaign = undefined;
    this.page = undefined;
    this.recordKey = undefined;
    this.canEdit = false;
    this.canManageVisibility = false;
    this.saving = false;
    this.addonRegistry = undefined;
    this.addonRole = "player";
    this.query = "";
    this.editor = "closed";
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("page") || changed.has("recordKey")) {
      this.editor = "closed";
      this.query = "";
    }
  }

  protected override updated(): void {
    this.#syncAddonSections();
  }

  override disconnectedCallback(): void {
    this.#disposeAddonSections();
    super.disconnectedCallback();
  }

  protected override render() {
    if (this.campaign === undefined || this.page === undefined) {
      return null;
    }
    return this.recordKey === undefined ? this.#collectionTemplate() : this.#recordTemplate();
  }

  #collectionTemplate() {
    if (this.campaign === undefined || this.page === undefined) {
      return null;
    }
    const records = projectCampaignRecords(this.campaign, this.page, this.query);
    return html`
      <section aria-labelledby="record-browser-title">
        <div class="page-heading">
          <div>
            <h2 id="record-browser-title">${this.page.pluralLabel}</h2>
            <p>${records.length} ${records.length === 1 ? "record" : "records"} visible</p>
          </div>
          ${this.canEdit ? html`<button class="primary" type="button" @click=${this.#startCreate}>
            Add ${this.page.singularLabel.toLocaleLowerCase("en")}
          </button>` : null}
        </div>
        ${this.editor === "create" ? this.#editorTemplate(undefined) : null}
        <div class="toolbar">
          <input
            class="search"
            type="search"
            placeholder=${`Search ${this.page.pluralLabel.toLocaleLowerCase("en")}…`}
            aria-label=${`Search ${this.page.pluralLabel}`}
            .value=${this.query}
            @input=${this.#updateQuery}
          />
        </div>
        ${records.length === 0
          ? html`<p class="empty">${this.query === ""
            ? `No ${this.page.pluralLabel.toLocaleLowerCase("en")} are visible yet.`
            : "No records match this search."}</p>`
          : html`<div class="records">${records.map((record) => this.#recordCard(record))}</div>`}
      </section>
    `;
  }

  #recordCard(record: CampaignRecordSummary) {
    if (this.page === undefined) {
      return null;
    }
    return html`
      <article class="record-card">
        <a href=${campaignRecordHash(this.page, record.key)}>${record.title}</a>
        ${record.summary === "" ? null : html`<p class="summary">${record.summary}</p>`}
        <div class="badges">
          ${record.visibility === "dm" ? html`<span class="badge dm">DM only</span>` : null}
          <span class="badge">revision ${record.revision}</span>
        </div>
      </article>
    `;
  }

  #recordTemplate() {
    if (this.campaign === undefined || this.page === undefined || this.recordKey === undefined) {
      return null;
    }
    const record = campaignCollection(this.campaign, this.page.collection).records
      .find((candidate) => candidate.key === this.recordKey);
    if (record === undefined) {
      return html`
        <a class="breadcrumb" href=${campaignCollectionHash(this.page)}>← ${this.page.pluralLabel}</a>
        <h2>Record not found</h2>
        <p class="empty">It may have been removed or may not be visible to this role.</p>
      `;
    }
    const summary = summarizeRecord(this.page, record);
    const value = isRecord(record.value) ? record.value : {};
    return html`
      <article>
        <a class="breadcrumb" href=${campaignCollectionHash(this.page)}>← ${this.page.pluralLabel}</a>
        <div class="record-heading">
          <div>
            <h2>${summary.title}</h2>
            <p class="record-meta">${this.page.singularLabel} · revision ${record.revision}</p>
          </div>
          ${this.canEdit ? html`<button type="button" @click=${this.#startEdit}>Edit</button>` : null}
        </div>
        ${this.editor === "edit" ? this.#editorTemplate(record) : html`
          <div class="record-body">
            <div class="facts">
              <dl>
                ${this.page.fields.filter((field) => field.kind === "line").map((field) => html`
                  <div><dt>${field.label}</dt><dd>${displayString(value[field.key], "—")}</dd></div>
                `)}
                ${this.page.visibilityBearing ? html`
                  <div><dt>Visibility</dt><dd>${summary.visibility === "dm" ? "DM only" : "Public"}</dd></div>
                ` : null}
              </dl>
            </div>
            <div class="prose">${recordText(this.page, value) || "No description has been written yet."}</div>
          </div>
          <div class="addon-sections" data-addon-article-sections hidden></div>
        `}
      </article>
    `;
  }

  #editorTemplate(record: CampaignRecord | undefined) {
    if (this.page === undefined) {
      return null;
    }
    const value = isRecord(record?.value) ? record.value : {};
    return html`
      <form @submit=${this.#submitEditor}>
        <div class="editor-heading">
          <h3>${record === undefined ? "New" : "Edit"} ${this.page.singularLabel.toLocaleLowerCase("en")}</h3>
          ${record === undefined ? null : html`<span class="record-meta">revision ${record.revision}</span>`}
        </div>
        ${this.page.fields.map((field) => html`
          <label>
            ${field.label}
            ${field.kind === "text"
              ? html`<textarea
                  name=${field.key}
                  maxlength=${field.maximumLength}
                  .value=${displayString(value[field.key], "")}
                  ?required=${field.required === true}
                ></textarea>`
              : html`<input
                  name=${field.key}
                  maxlength=${field.maximumLength}
                  .value=${displayString(value[field.key], "")}
                  ?required=${field.required === true}
                />`}
          </label>
        `)}
        ${this.page.visibilityBearing && this.canManageVisibility ? html`
          <label>
            Visibility
            <select name="visibility" .value=${value["visibility"] === "dm" ? "dm" : "public"}>
              <option value="public">Public</option>
              <option value="dm">DM only</option>
            </select>
          </label>
        ` : null}
        <div class="form-actions">
          ${record === undefined ? null : html`
            <button class="danger" type="button" @click=${this.#deleteRecord} ?disabled=${this.saving}>
              Delete
            </button>
          `}
          <button type="button" @click=${this.#closeEditor} ?disabled=${this.saving}>Cancel</button>
          <button class="primary" type="submit" ?disabled=${this.saving}>
            ${this.saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    `;
  }

  readonly #updateQuery = (event: InputEvent): void => {
    this.query = (event.currentTarget as HTMLInputElement).value;
  };

  readonly #startCreate = (): void => {
    if (this.canEdit && !this.saving) {
      this.editor = "create";
    }
  };

  readonly #startEdit = (): void => {
    if (this.canEdit && !this.saving) {
      this.editor = "edit";
    }
  };

  readonly #closeEditor = (): void => {
    if (!this.saving) {
      this.editor = "closed";
    }
  };

  readonly #submitEditor = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.canEdit || this.saving || this.campaign === undefined || this.page === undefined) {
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const fields: Record<string, string> = {};
    for (const field of this.page.fields) {
      const raw = String(data.get(field.key) ?? "");
      const value = field.kind === "line" ? raw.trim() : raw;
      if (value.length > field.maximumLength || field.required === true && value.trim() === "") {
        return;
      }
      fields[field.key] = value;
    }
    const creating = this.editor === "create";
    const key = creating
      ? createCampaignRecordKey(fields["name"] ?? this.page.singularLabel)
      : this.recordKey ?? "";
    if (key === "") {
      return;
    }
    const record = creating ? undefined : campaignCollection(this.campaign, this.page.collection).records
      .find((candidate) => candidate.key === key);
    if (!creating && record === undefined) {
      return;
    }
    const detail: CampaignRecordSaveDetail = {
      collection: this.page.collection,
      key,
      expectedRevision: record?.revision ?? 0,
      creating,
      fields: Object.freeze(fields),
      ...(this.page.visibilityBearing && this.canManageVisibility
        ? { visibility: data.get("visibility") === "dm" ? "dm" as const : "public" as const }
        : {}),
    };
    this.dispatchEvent(new CustomEvent<CampaignRecordSaveDetail>("campaign-record-save", {
      detail, bubbles: true, composed: true,
    }));
  };

  readonly #deleteRecord = (): void => {
    if (!this.canEdit || this.saving || this.campaign === undefined || this.page === undefined ||
      this.recordKey === undefined) {
      return;
    }
    const record = campaignCollection(this.campaign, this.page.collection).records
      .find((candidate) => candidate.key === this.recordKey);
    if (record === undefined || !window.confirm(`Delete this ${this.page.singularLabel.toLocaleLowerCase("en")}?`)) {
      return;
    }
    this.dispatchEvent(new CustomEvent<CampaignRecordDeleteDetail>("campaign-record-delete", {
      detail: {
        collection: this.page.collection, key: record.key, expectedRevision: record.revision,
      },
      bubbles: true,
      composed: true,
    }));
  };

  #syncAddonSections(): void {
    const root = this.renderRoot.querySelector<HTMLElement>("[data-addon-article-sections]") ?? undefined;
    if (root === undefined || this.addonRegistry === undefined || this.page === undefined ||
      this.recordKey === undefined || this.editor !== "closed") {
      this.#disposeAddonSections();
      return;
    }
    if (this.#addonOutlet !== undefined && this.#addonOutletRoot === root &&
      this.#addonOutletRegistry === this.addonRegistry && this.#addonOutletRole === this.addonRole) {
      this.#addonOutlet.refresh();
      return;
    }
    this.#disposeAddonSections();
    const page = this.page;
    this.#addonOutletRoot = root;
    this.#addonOutletRegistry = this.addonRegistry;
    this.#addonOutletRole = this.addonRole;
    this.#addonOutlet = new BrowserContributionOutlet({
      document: this.ownerDocument,
      root,
      registry: this.addonRegistry,
      surface: "article-section",
      role: this.addonRole,
      include: (active) => contributionTargetsCollection(active, page.collection),
      hostContext: () => this.#recordContributionContext(),
      onError: (cause) => this.dispatchEvent(new CustomEvent("browser-addon-diagnostic", {
        detail: cause, bubbles: true, composed: true,
      })),
    });
  }

  #recordContributionContext(): RecordContributionHostContext | null {
    if (this.campaign === undefined || this.page === undefined || this.recordKey === undefined) {
      return null;
    }
    const record = campaignCollection(this.campaign, this.page.collection).records
      .find((candidate) => candidate.key === this.recordKey);
    return record === undefined ? null : {
      kind: "campaign-record",
      collection: this.page.collection,
      key: record.key,
      revision: record.revision,
      value: record.value,
      canEdit: this.canEdit,
    };
  }

  #disposeAddonSections(): void {
    this.#addonOutlet?.dispose();
    this.#addonOutlet = undefined;
    this.#addonOutletRoot = undefined;
    this.#addonOutletRegistry = undefined;
    this.#addonOutletRole = undefined;
  }
}

export function contributionTargetsCollection(
  active: ActiveBrowserContribution,
  collection: CampaignPageDescriptor["collection"],
): boolean {
  return active.descriptor.config["collection"] === collection;
}

function summarizeRecord(
  page: CampaignPageDescriptor,
  record: CampaignRecord,
): CampaignRecordSummary {
  const value = isRecord(record.value) ? record.value : {};
  const title = displayString(value["name"], record.key);
  const summaryField = page.fields.find((field) => field.key !== "name" &&
    displayString(value[field.key], "") !== "");
  return {
    key: record.key,
    title,
    summary: summaryField === undefined ? "" : displayString(value[summaryField.key], ""),
    visibility: value["visibility"] === "dm" ? "dm" : "public",
    revision: record.revision,
  };
}

function recordText(page: CampaignPageDescriptor, value: Readonly<Record<string, unknown>>): string {
  const field = page.fields.find((candidate) => candidate.kind === "text");
  return field === undefined ? "" : displayString(value[field.key], "");
}

function displayString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").trim();
}

function randomToken(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

if (typeof customElements !== "undefined" && !customElements.get("campaign-record-browser")) {
  customElements.define("campaign-record-browser", CampaignRecordBrowser);
}
