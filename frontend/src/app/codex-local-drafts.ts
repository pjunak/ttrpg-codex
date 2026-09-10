import { LitElement, html, nothing } from "lit";
import { IndexedDBMarkdownDraftStore, type MarkdownDraft, type MarkdownDraftContext } from "../core/markdown-drafts.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { editorFieldsFor } from "./campaign-record-editor.js";
import { recordValue, text } from "./campaign-projection.js";
import { recordHash, type CampaignPageDefinition } from "./routes.js";
import { UiLocalizationController, uiText } from "./ui-localization.js";

export class CodexLocalDrafts extends LitElement {
  static override properties = {
    campaign: { attribute: false }, page: { attribute: false }, actorRole: { attribute: false },
    open: { state: true }, drafts: { state: true }, failed: { state: true }, loading: { state: true },
  };
  declare campaign: CampaignDataset;
  declare page: CampaignPageDefinition;
  declare actorRole: MarkdownDraftContext["role"] | undefined;
  declare private open: boolean;
  declare private drafts: readonly MarkdownDraft[];
  declare private failed: boolean;
  declare private loading: boolean;
  readonly #store = new IndexedDBMarkdownDraftStore();
  readonly #ui = new UiLocalizationController(this);
  #epoch = 0;
  constructor() { super(); this.open = false; this.drafts = []; this.failed = false; this.loading = false; }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); globalThis.addEventListener("focus", this.#refresh); }
  override disconnectedCallback(): void { this.#epoch++; globalThis.removeEventListener("focus", this.#refresh); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("actorRole") || changed.has("page")) { this.#epoch++; this.open = false; this.drafts = []; this.failed = false; this.loading = false; }
  }
  readonly #refresh = async (): Promise<void> => {
    if (!this.open || !this.actorRole || !this.page) return;
    const epoch = ++this.#epoch; this.loading = true;
    try { const drafts = await this.#store.listCollection(this.actorRole, this.page.collection); if (epoch === this.#epoch) { this.drafts = drafts; this.failed = false; } }
    catch { if (epoch === this.#epoch) this.failed = true; }
    finally { if (epoch === this.#epoch) this.loading = false; }
  };
  protected override render() {
    if (!this.actorRole || !this.page || !this.campaign) return nothing;
    return html`<details class="collection-local-drafts" ?open=${this.open} @toggle=${(event: Event) => { this.open = (event.target as HTMLDetailsElement).open; if (this.open) void this.#refresh(); }}>
      <summary>${uiText("draft.library")}</summary><p>${uiText("draft.libraryIntro")}</p>
      <button class="record-action" type="button" ?disabled=${this.loading} @click=${this.#refresh}>${uiText("draft.refresh")}</button>
      ${this.failed ? html`<p role="alert">${uiText("draft.loadFailed")}</p>` : this.loading ? html`<p role="status">${uiText("draft.loading")}</p>` :
        !this.drafts.length ? html`<p>${uiText("draft.empty")}</p>` : this.drafts.map(draft => this.#row(draft))}
    </details>`;
  }
  #row(draft: MarkdownDraft) {
    let identity: unknown;
    try { identity = JSON.parse(draft.target); } catch { return nothing; }
    if (!Array.isArray(identity) || identity.length !== 4 || identity[0] !== this.actorRole || identity[1] !== this.page.collection ||
      identity[2] !== null && typeof identity[2] !== "string" || typeof identity[3] !== "string") return nothing;
    const record = campaignCollection(this.campaign, this.page.collection).records.find(record => record.key === identity[2]);
    const label = identity[2] === null ? uiText("New entry") : record ? text(recordValue(record)["name"]) || record.key : `${identity[2]} — ${uiText("draft.missingEntry")}`;
    const field = editorFieldsFor(this.page.collection).find(field => field.key === identity[3])?.label ?? identity[3];
    return html`<details class="collection-local-draft"><summary>${label} · ${field} · ${new Date(draft.savedAt).toLocaleString(this.#ui.locale)}</summary>
      <pre tabindex="0">${draft.value}</pre><div class="writer-recovery-actions">
        ${record ? html`<a class="record-action" href=${recordHash(this.page, record.key)}>${uiText("draft.openEntry")}</a>` : nothing}
        <a class="record-action" download="draft.md" href=${`data:text/markdown;charset=utf-8,${encodeURIComponent(draft.value)}`}>${uiText("draft.download")}</a>
        <button class="record-action" type="button" ?disabled=${this.loading} @click=${async () => {
          if (!window.confirm(uiText("draft.deleteConfirm"))) return;
          this.loading = true;
          try { await this.#store.remove([draft]); await this.#refresh(); } catch { this.failed = true; } finally { this.loading = false; }
        }}>${uiText("draft.delete")}</button>
      </div></details>`;
  }
}
customElements.define("codex-local-drafts", CodexLocalDrafts);
