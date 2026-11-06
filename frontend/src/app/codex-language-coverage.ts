import { LitElement, html, nothing } from "lit";
import type { BrowserCatalogStore } from "../addons/catalog-store.js";
import type { MessageCatalog } from "../core/message-catalog.js";
import { hostCatalogs, languageEndonym } from "../locales/index.js";
import {
  catalogCoverage,
  coveragePercent,
  coverageRows,
  missingCatalog,
} from "./language-coverage.js";
import { UiLocalizationController } from "./ui-localization.js";

interface CatalogSet {
  readonly id: string;
  readonly name: string;
  /** Where each language's catalog comes from, by language. */
  readonly origins: Readonly<Record<string, "built-in" | "package" | "pack">>;
  readonly issues: readonly string[];
  readonly english: MessageCatalog | undefined;
  readonly translations: ReadonlyMap<string, MessageCatalog | undefined>;
  readonly state: "ready" | "loading" | "unavailable";
}

interface Comparison {
  readonly source: string;
  readonly section: string;
}

/**
 * DM-only map of what the host and every active add-on translate into the
 * site's enabled languages, with a side-by-side comparison and an export of
 * the missing texts. It reads catalogs only; nothing here edits them.
 */
export class CodexLanguageCoverage extends LitElement {
  static override properties = {
    catalogs: { attribute: false },
    locales: { attribute: false },
    selectedLocale: { state: true },
    comparison: { state: true },
    missingOnly: { state: true },
    addons: { state: true },
  };
  /** The add-on session's catalog store; undefined while add-ons are not running. */
  declare catalogs: BrowserCatalogStore | undefined;
  /** Enabled languages other than English. */
  declare locales: readonly string[];
  declare private selectedLocale: string | undefined;
  declare private comparison: Comparison | undefined;
  declare private missingOnly: boolean;
  declare private addons: readonly CatalogSet[];
  readonly #ui = new UiLocalizationController(this);
  #loadKey = "";
  #load: AbortController | undefined;
  #unsubscribe: (() => void) | undefined;
  #subscribed: BrowserCatalogStore | undefined;

  constructor() {
    super();
    this.locales = [];
    this.missingOnly = false;
    this.addons = [];
  }

  protected override createRenderRoot() {
    return this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#load?.abort();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#subscribed = undefined;
    this.#loadKey = "";
  }

  protected override willUpdate(): void {
    if (this.#subscribed !== this.catalogs) {
      this.#unsubscribe?.();
      this.#subscribed = this.catalogs;
      this.#unsubscribe = this.catalogs?.subscribe(() => this.requestUpdate());
    }
    if (this.selectedLocale === undefined || !this.locales.includes(this.selectedLocale))
      this.selectedLocale = this.locales[0];
    const key = JSON.stringify([this.locales, this.catalogs?.entries() ?? []]);
    if (key !== this.#loadKey) {
      this.#loadKey = key;
      void this.#loadAddons();
    }
  }

  protected override render() {
    const locale = this.selectedLocale;
    return html`
      <section class="language-coverage" aria-labelledby="language-coverage-title">
        <h3 id="language-coverage-title">${this.#ui.t("settings.translations")}</h3>
        <p class="settings-hint">${this.#ui.t("settings.translationsIntro")}</p>
        ${
          locale === undefined
            ? html`<p class="settings-hint">${this.#ui.t("settings.translationsEnable")}</p>`
            : this.#map(locale)
        }
      </section>`;
  }

  #map(locale: string) {
    const sets = [this.#hostSet(), ...this.addons];
    return html`
      ${
        this.locales.length > 1
          ? html`<label class="language-coverage-locale"><span>${this.#ui.t("settings.translationsLanguage")}</span>
          <select @change=${(event: Event) => {
            this.selectedLocale = (event.currentTarget as HTMLSelectElement).value;
          }}>${this.locales.map(
            (item) =>
              html`<option value=${item} ?selected=${item === locale}>${languageEndonym(item)}</option>`,
          )}</select></label>`
          : nothing
      }
      <ul class="language-coverage-sources">${sets.map((set) => this.#source(set, locale))}</ul>
      ${this.#comparisonPanel(sets, locale)}`;
  }

  #source(set: CatalogSet, locale: string) {
    if (set.english === undefined)
      return html`<li class="language-coverage-source" data-source=${set.id}>
        <div class="language-coverage-summary"><strong>${set.name}</strong>
        <span class="settings-hint" role=${set.state === "unavailable" ? "alert" : "status"}>${this.#ui.t(
          set.state === "unavailable"
            ? "settings.translationsUnavailable"
            : "settings.translationsLoading",
        )}</span></div></li>`;
    const coverage = catalogCoverage(set.id, set.name, set.english, set.translations);
    const translated = coverage.translated[locale] ?? 0;
    const missing = missingCatalog(set.english, set.translations.get(locale), locale);
    const complete = translated === coverage.total;
    return html`<li class="language-coverage-source" data-source=${set.id}>
      <details ?open=${this.comparison?.source === set.id}>
        <summary class="language-coverage-summary">
          <strong>${set.name}</strong>
          <span class="language-coverage-figure">${this.#percent(translated, coverage.total)}</span>
          <span class="settings-hint">${this.#ui.t("settings.translationsCount", { translated, total: coverage.total })} · ${this.#origin(set, locale)}</span>
        </summary>
        ${
          set.issues.length === 0
            ? nothing
            : html`<details class="language-coverage-issues"><summary>${this.#ui.t("settings.translationsIssues")} (${set.issues.length})</summary>
              <ul>${set.issues.map((issue) => html`<li>${issue}</li>`)}</ul></details>`
        }
        <table class="language-coverage-sections">
          <thead><tr><th scope="col">${this.#ui.t("settings.translationsSection")}</th>
            <th scope="col" lang=${locale}>${languageEndonym(locale)}</th><th scope="col"><span class="visually-hidden">${this.#ui.t("settings.translationsCompare")}</span></th></tr></thead>
          <tbody>${coverage.sections.map((section) => {
            const count = section.translated[locale] ?? 0;
            return html`<tr data-section=${section.id} ?data-complete=${count === section.total}>
              <th scope="row"><code>${section.id}</code></th>
              <td>${this.#ui.t("settings.translationsCount", { translated: count, total: section.total })}</td>
              <td><button type="button" aria-label=${this.#ui.t("settings.translationsCompareSection", { section: section.id, source: set.name })}
                @click=${() => {
                  this.comparison = { source: set.id, section: section.id };
                  void this.updateComplete.then(() =>
                    this.querySelector<HTMLElement>(".language-comparison h4")?.focus(),
                  );
                }}>${this.#ui.t("settings.translationsCompare")}</button></td>
            </tr>`;
          })}</tbody>
        </table>
        ${
          complete
            ? html`<p class="settings-hint">${this.#ui.t("settings.translationsComplete")}</p>`
            : html`<a class="ui-action language-coverage-export" download=${`${set.id}-${locale}-missing.json`}
              href=${`data:application/json;charset=utf-8,${encodeURIComponent(`${JSON.stringify(missing, null, 2)}\n`)}`}>${this.#ui.t("settings.translationsExport")}</a>`
        }
      </details>
    </li>`;
  }

  #comparisonPanel(sets: readonly CatalogSet[], locale: string) {
    const comparison = this.comparison;
    const set = sets.find(({ id }) => id === comparison?.source);
    if (comparison === undefined || set?.english === undefined) return nothing;
    const rows = coverageRows(set.english, set.translations.get(locale), comparison.section).filter(
      (row) => !this.missingOnly || row.translation === undefined,
    );
    return html`<section class="language-comparison" aria-labelledby="language-comparison-title">
      <header>
        <h4 id="language-comparison-title" tabindex="-1">${set.name} · <code>${comparison.section}</code></h4>
        <label><input type="checkbox" .checked=${this.missingOnly} @change=${(event: Event) => {
          this.missingOnly = (event.currentTarget as HTMLInputElement).checked;
        }} />${this.#ui.t("settings.translationsMissingOnly")}</label>
        <button type="button" @click=${() => {
          this.comparison = undefined;
        }}>${this.#ui.t("settings.translationsClose")}</button>
      </header>
      <table class="language-comparison-table">
        <thead><tr><th scope="col">${this.#ui.t("settings.translationsKey")}</th><th scope="col" lang="en">English</th>
          <th scope="col" lang=${locale}>${languageEndonym(locale)}</th></tr></thead>
        <tbody>${rows.map(
          (row) => html`<tr ?data-missing=${row.translation === undefined}>
            <th scope="row"><code>${row.key}</code></th>
            <td lang="en">${row.english}</td>
            <td lang=${locale}>${
              row.translation ??
              html`<span class="language-comparison-missing">${this.#ui.t("settings.translationsMissing")}</span>`
            }</td>
          </tr>`,
        )}</tbody>
      </table>
    </section>`;
  }

  #hostSet(): CatalogSet {
    const english = hostCatalogs.find(({ locale }) => locale === "en");
    return {
      id: "codex",
      name: this.#ui.t("settings.translationsHost"),
      origins: Object.fromEntries(hostCatalogs.map(({ locale }) => [locale, "built-in" as const])),
      issues: [],
      english,
      translations: new Map(
        this.locales.map((locale) => [
          locale,
          hostCatalogs.find((catalog) => catalog.locale === locale),
        ]),
      ),
      state: "ready",
    };
  }

  #origin(set: CatalogSet, locale: string): string {
    const origin = set.origins[locale];
    return this.#ui.t(
      origin === "built-in"
        ? "settings.translationsBuiltIn"
        : origin === "package"
          ? "settings.translationsPackage"
          : origin === "pack"
            ? "settings.translationsPack"
            : "settings.translationsNotShipped",
    );
  }

  #percent(translated: number, total: number): string {
    const share = coveragePercent(translated, total) / 100;
    try {
      return new Intl.NumberFormat(this.#ui.locale, { style: "percent" }).format(share);
    } catch {
      return `${Math.round(share * 100)}%`;
    }
  }

  async #loadAddons(): Promise<void> {
    this.#load?.abort();
    const store = this.catalogs;
    if (store === undefined || this.locales.length === 0) {
      this.addons = [];
      return;
    }
    const controller = new AbortController();
    this.#load = controller;
    const entries = store.entries();
    const sets = entries.map((entry): CatalogSet => ({
      id: entry.addonId,
      name: entry.addonName || entry.addonId,
      origins: Object.fromEntries(entry.locales.map(({ locale, source }) => [locale, source])),
      issues: entry.locales.flatMap(({ locale, issues }) =>
        issues.map((issue) => `${locale}: ${issue}`),
      ),
      english: undefined,
      translations: new Map(),
      state: "loading",
    }));
    this.addons = sets;
    const loaded = await Promise.all(
      sets.map(async (set): Promise<CatalogSet> => {
        try {
          const english = await store.catalog(set.id, "en", controller.signal);
          const translations = new Map(
            await Promise.all(
              this.locales.map(
                async (locale) =>
                  [locale, await store.catalog(set.id, locale, controller.signal)] as const,
              ),
            ),
          );
          return english === undefined
            ? { ...set, state: "unavailable" }
            : { ...set, english, translations, state: "ready" };
        } catch {
          return { ...set, state: "unavailable" };
        }
      }),
    );
    if (!controller.signal.aborted) this.addons = loaded;
  }
}

customElements.define("codex-language-coverage", CodexLanguageCoverage);
