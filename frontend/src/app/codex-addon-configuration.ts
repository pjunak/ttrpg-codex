import { LitElement, html, nothing } from "lit";
import { AddonAdminClient } from "../core/addon-admin.js";
import { HostRequestError } from "../core/api.js";
import { sourceKey, serviceKey, type ConfigurationResult, type ConfigurationSnapshot, type RulesPolicy, type ServiceSelection, type ServiceSelections, type SourceTarget } from "../core/addon-configuration.js";
import { UiLocalizationController } from "./ui-localization.js";
import { uiRequestError } from "./ui-errors.js";

interface ProviderDraft { automatic: boolean; ids: string[] }
type Review = { snapshot: ConfigurationSnapshot } & ({ kind: "sources"; enabled: SourceTarget[] } | { kind: "service"; service: ServiceSelection; choice: ProviderDraft });

export class CodexAddonConfiguration extends LitElement {
  static override properties = { csrfToken: { attribute: false }, inventoryRevision: { attribute: false }, disabled: { type: Boolean }, policy: { state: true }, services: { state: true }, pending: { state: true }, error: { state: true }, message: { state: true }, search: { state: true }, review: { state: true } };
  declare csrfToken: string;
  declare inventoryRevision: string;
  declare disabled: boolean;
  declare private policy: RulesPolicy | undefined;
  declare private services: ServiceSelections | undefined;
  declare private pending: boolean;
  declare private error: string;
  declare private message: string;
  declare private search: string;
  declare private review: Review | undefined;
  #selected: Set<string> | undefined;
  #providers = new Map<string, ProviderDraft>();
  #request = new AbortController();
  readonly #ui = new UiLocalizationController(this);
  constructor() { super(); this.disabled = false; this.pending = false; this.error = ""; this.message = ""; this.search = ""; }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#request = new AbortController(); void this.#load(); }
  override disconnectedCallback(): void { this.#request.abort(); this.#dirty(false); super.disconnectedCallback(); }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if ((changed.has("inventoryRevision") || changed.has("disabled")) && !this.#hasDraft && !this.#blocked) void this.#load();
    if (changed.has("review") && this.review) this.querySelector<HTMLElement>(".configuration-review h4")?.focus();
  }
  get #blocked(): boolean { return this.disabled || this.pending; }
  get #hasDraft(): boolean { return this.#selected !== undefined || this.#providers.size > 0 || this.review !== undefined; }
  #dirty(value = this.#hasDraft): void { this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty: value }, bubbles: true, composed: true })); }
  #providerChoice(row: ServiceSelection): ProviderDraft { return this.#providers.get(serviceKey(row)) ?? { automatic: row.resolution.binding === null, ids: row.resolution.binding?.providerAddonIds ?? [] }; }
  #choose(row: ServiceSelection, choice: ProviderDraft): void { this.#providers.set(serviceKey(row), choice); this.requestUpdate(); this.#dirty(); }
  #sourceEnabled(source: SourceTarget & { enabled: boolean }): boolean { return this.#selected?.has(sourceKey(source)) ?? source.enabled; }
  #toggleSource(source: SourceTarget, enabled: boolean): void {
    this.#selected ??= new Set(this.policy?.sources.filter(source => source.enabled).map(sourceKey));
    if (enabled) this.#selected.add(sourceKey(source)); else this.#selected.delete(sourceKey(source));
    this.requestUpdate(); this.#dirty();
  }
  protected override render() {
    const t = this.#ui.t.bind(this.#ui), policy = this.policy;
    return html`<section class="addon-configuration" aria-busy=${this.pending}>
      <header><h3>${t("configuration.title")}</h3><p>${t("configuration.intro")}</p></header>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}${this.message ? html`<p role="status">${this.message}</p>` : nothing}
      <div class="addon-actions"><button ?disabled=${this.#blocked} @click=${() => { this.review = undefined; void this.#load(); }}>${t("configuration.refresh")}</button>
      ${this.#hasDraft ? html`<button ?disabled=${this.#blocked} @click=${this.#reset}>${t("configuration.reset")}</button><span role="status">${t("configuration.draft")}</span>` : nothing}</div>
      ${!policy ? html`<p role="status">${this.pending ? t("addons.loading") : t("configuration.noRules")}</p>` : html`
      <p class="configuration-ruleset">${policy.ruleset ? html`<strong>${policy.ruleset.name}</strong><br>${t("configuration.definedBy", { addon: policy.ruleset.addonId })}` : t("configuration.noRules")}</p>
      <fieldset ?disabled=${this.#blocked || !!this.review}><legend>${t("configuration.books")}</legend><p>${t("configuration.booksHelp")}</p>
        ${policy.sources.length > 8 ? html`<label>${t("configuration.search")}<input type="search" .value=${this.search} @input=${(event: Event) => { this.search = (event.target as HTMLInputElement).value; }}></label>` : nothing}
        ${this.#sourceGroups()}
        <button ?disabled=${!policy.sources.length || !this.#selected && !policy.sources.some(source => source.pending)} @click=${() => {
          this.review = { kind: "sources", snapshot: policy, enabled: policy.sources.filter(source => this.#sourceEnabled(source)).map(({ addonId, setId, id }) => ({ addonId, setId, id })) }; this.#dirty();
        }}>${t("configuration.reviewBooks")}</button>
      </fieldset>`}
      <section><h4>${t("configuration.services")}</h4><p>${t("configuration.servicesHelp")}</p>
        ${this.services?.services.length ? this.services.services.map(row => this.#service(row)) : html`<p>${t("configuration.noServices")}</p>`}
      </section>
      ${this.review ? this.#review(this.review) : nothing}
    </section>`;
  }
  #sourceGroups() {
    const t = this.#ui.t.bind(this.#ui), sources = this.policy?.sources ?? [];
    if (!sources.length) return html`<p>${t("configuration.noBooks")}</p>`;
    const visible = sources.filter(source => `${source.name} ${source.addonName} ${source.id}`.toLocaleLowerCase().includes(this.search.toLocaleLowerCase().trim()));
    if (!visible.length) return html`<p role="status">${t("configuration.noMatches")}</p>`;
    return [...new Set(visible.map(source => source.addonId))].map(id => html`<fieldset class="configuration-books"><legend>${visible.find(source => source.addonId === id)?.addonName}</legend>
      ${visible.filter(source => source.addonId === id).map(source => html`<label class="addon-permission"><input type="checkbox" data-source=${sourceKey(source)} .checked=${this.#sourceEnabled(source)} ?disabled=${source.required}
        @change=${(event: Event) => this.#toggleSource(source, (event.target as HTMLInputElement).checked)}><span>${source.name}
        ${source.required ? html`<small>${t("configuration.required")}</small>` : source.pending ? html`<small>${t("configuration.new")}</small>` : nothing}</span></label>`)}
    </fieldset>`);
  }
  #service(row: ServiceSelection) {
    const t = this.#ui.t.bind(this.#ui), choice = this.#providerChoice(row), operator = row.requirement.selection === "operator";
    const inputId = `configuration-provider-${row.requirement.consumerAddonId}-${row.generationId}-${row.requirement.contract}`;
    return html`<fieldset class="configuration-service" data-service=${serviceKey(row)} ?disabled=${this.#blocked || !!this.review}>
      <legend>${row.consumerName} · ${row.version}${row.active ? "" : ` · ${t("configuration.staged")}`}</legend>
      <p><strong>${row.requirement.contract}</strong> ${row.requirement.range}${row.requirement.required ? "" : ` · ${t("configuration.optional")}`}</p>
      <p>${row.resolution.status === "resolved" ? t("configuration.ready") : row.resolution.status === "ambiguous" ? t("configuration.ambiguous") : row.resolution.status === "unavailable" ? t("configuration.missing") : t("configuration.unresolved")}</p>
      <p>${t("configuration.current", { providers: row.resolution.providers.join(", ") || t("configuration.none") })}</p>
      ${row.resolution.staleTargets.length ? html`<p role="status">${t("configuration.stale", { providers: row.resolution.staleTargets.join(", ") })}</p>` : nothing}
      ${!operator ? html`<p>${t("configuration.all")}</p>` : row.requirement.cardinality === "one" ? html`
        <label for=${inputId}>${t("configuration.provider")}</label><select id=${inputId} .value=${choice.automatic ? "" : choice.ids[0] ?? ""} @change=${(event: Event) => { const id = (event.target as HTMLSelectElement).value; this.#choose(row, { automatic: !id, ids: id ? [id] : [] }); }}>
          <option value="">${t("configuration.automatic")}</option>
          ${choice.ids.filter(id => !row.candidates.some(candidate => candidate.addonId === id)).map(id => html`<option value=${id} disabled>${id} · ${t("configuration.unavailable")}</option>`)}
          ${row.candidates.map(candidate => html`<option value=${candidate.addonId} ?disabled=${!candidate.compatible || !candidate.activeGeneration}>${candidate.addonId} · ${candidate.addonVersion}${candidate.compatible && candidate.activeGeneration ? "" : ` · ${t("configuration.unavailable")}`}</option>`)}
        </select>` : html`
        <label class="addon-permission"><input type="checkbox" .checked=${choice.automatic} @change=${(event: Event) => this.#choose(row, { automatic: (event.target as HTMLInputElement).checked, ids: [] })}>${t("configuration.automatic")}</label>
        ${row.candidates.map(candidate => html`<label class="addon-permission"><input type="checkbox" .checked=${!choice.automatic && choice.ids.includes(candidate.addonId)} ?disabled=${choice.automatic || !candidate.compatible || !candidate.activeGeneration} @change=${(event: Event) => this.#choose(row, { automatic: false, ids: (event.target as HTMLInputElement).checked ? [...choice.ids, candidate.addonId] : choice.ids.filter(id => id !== candidate.addonId) })}>${candidate.addonId} · ${candidate.addonVersion}</label>`)}`}
      ${operator ? html`<button ?disabled=${!this.#providers.has(serviceKey(row))} @click=${() => { if (this.services) { this.review = { kind: "service", snapshot: this.services, service: row, choice: structuredClone(choice) }; this.#dirty(); } }}>${t("configuration.reviewService")}</button>` : nothing}
    </fieldset>`;
  }
  #review(review: Review) {
    const t = this.#ui.t.bind(this.#ui);
    return html`<section class="configuration-review" aria-label=${t("configuration.review")}>
      <h4 tabindex="-1">${t("configuration.review")}</h4>
      ${review.kind === "sources" ? html`<ul>${this.policy?.sources.filter(source => this.#sourceEnabled(source) !== source.enabled).map(source => html`<li>${this.#sourceEnabled(source) ? t("configuration.enabling") : t("configuration.disabling")}: ${source.name} · ${source.addonName}</li>`)}</ul><p>${t("configuration.acknowledge")}</p>` : html`<p>${review.service.consumerName} · ${review.service.requirement.contract}: <strong>${review.choice.automatic ? t("configuration.automatic") : review.choice.ids.join(", ")}</strong></p>`}
      <p>${t("configuration.retained")}</p><p>${review.snapshot.restartedAddonIds.length ? t("configuration.restart", { addons: review.snapshot.restartedAddonIds.join(", ") }) : t("configuration.noRestart")}</p>
      <div class="addon-actions"><button ?disabled=${this.#blocked} @click=${() => this.#apply(review)}>${t("configuration.apply")}</button><button ?disabled=${this.#blocked} @click=${() => { this.review = undefined; this.#dirty(); }}>${t("configuration.cancel")}</button></div>
    </section>`;
  }
  readonly #reset = (): void => { this.#selected = undefined; this.#providers.clear(); this.review = undefined; this.requestUpdate(); this.#dirty(); };
  async #load(): Promise<void> {
    await this.#run(async client => {
      const [policy, services] = await Promise.all([client.rulesPolicy(), client.serviceSelections()]);
      if (policy.revision !== services.revision || policy.graphRevision !== services.graphRevision) throw new HostRequestError(409, "Add-on configuration");
      if (this.#selected && this.policy) {
        const previous = new Set(this.policy.sources.map(sourceKey));
        this.#selected = new Set(policy.sources.filter(source => previous.has(sourceKey(source)) ? this.#selected?.has(sourceKey(source)) : source.enabled).map(sourceKey));
      }
      const keys = new Set(services.services.map(serviceKey));
      for (const key of this.#providers.keys()) if (!keys.has(key)) this.#providers.delete(key);
      this.policy = policy; this.services = services; this.#dirty();
    });
  }
  async #apply(review: Review): Promise<void> {
    let applied = false;
    await this.#run(async client => {
      const result: ConfigurationResult = review.kind === "sources" ? await client.selectSources(review.snapshot, review.enabled) : await client.selectService(review.snapshot, review.service, review.choice.automatic, review.choice.ids);
      if (!result.applied) throw new Error(this.#ui.t("addons.failed"));
      applied = true;
      if (review.kind === "sources") this.#selected = undefined; else this.#providers.delete(serviceKey(review.service));
      this.review = undefined; this.#dirty();
      this.message = this.#ui.t(result.failures.length || result.recoveryError ? "configuration.recovery" : "configuration.saved");
      if (result.failures.length || result.recoveryError) this.error = [result.recoveryError, ...result.failures.map(failure => `${failure.addonId}: ${failure.error}`)].filter(Boolean).join(" ");
      this.dispatchEvent(new CustomEvent("addon-configuration-applied", { bubbles: true, composed: true }));
    }, true);
    if (applied) {
      const recoveryFailure = this.error;
      await this.#load();
      if (recoveryFailure) this.error = [recoveryFailure, this.error].filter(Boolean).join(" ");
    }
  }
  async #run(operation: (client: AddonAdminClient) => Promise<void>, mutating = false): Promise<void> {
    if (this.#blocked) return;
    this.pending = true; this.error = ""; if (mutating) this.message = "";
    if (mutating) this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: true, bubbles: true, composed: true }));
    try { await operation(new AddonAdminClient(this.csrfToken, this.#request.signal)); }
    catch (error) { if (!this.#request.signal.aborted) { this.review = undefined; this.error = error instanceof HostRequestError && error.status === 409 ? this.#ui.t("configuration.conflict") : uiRequestError(error); this.#dirty(); } }
    finally { if (!this.#request.signal.aborted) { this.pending = false; if (mutating) this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: false, bubbles: true, composed: true })); } }
  }
}
customElements.define("codex-addon-configuration", CodexAddonConfiguration);
