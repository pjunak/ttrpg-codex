import { LitElement, html, nothing } from "lit";
import type { BrowserCatalogStore } from "../addons/catalog-store.js";
import {
  parseDeclarations,
  styleCoverage,
  styleOverrideKinds,
  type StyleCoverage,
  type StyleOverrideKind,
  type StyleRule,
} from "./style-coverage.js";
import { UiLocalizationController, type MessageKey } from "./ui-localization.js";

interface AddonStyles {
  readonly id: string;
  readonly name: string;
  /** Undefined while a stylesheet loads or when it cannot be read. */
  readonly coverage: StyleCoverage | undefined;
  readonly state: "ready" | "loading" | "unavailable";
}

const kindLabels: Readonly<Record<StyleOverrideKind, MessageKey>> = Object.freeze({
  buttons: "settings.consistencyButtons",
  fields: "settings.consistencyFields",
  selects: "settings.consistencySelects",
  primitives: "settings.consistencyPrimitives",
});

/** Parsed stylesheets; a generation's stylesheet never changes once loaded. */
const parsedSheets = new WeakMap<CSSStyleSheet, readonly StyleRule[]>();

/**
 * DM-only map of how much custom styling each active add-on adds on top of
 * the shared controls, read from the add-on stylesheets the page has loaded.
 */
export class CodexInterfaceConsistency extends LitElement {
  static override properties = {
    catalogs: { attribute: false },
  };
  /** The add-on session's catalog store; it names the add-ons and notifies when they change. */
  declare catalogs: BrowserCatalogStore | undefined;
  readonly #ui = new UiLocalizationController(this);
  #unsubscribe: (() => void) | undefined;
  #subscribed: BrowserCatalogStore | undefined;
  /** Add-on stylesheet links come and go with add-on generations. */
  readonly #links = new MutationObserver(() => this.requestUpdate());
  readonly #onLoad = (): void => this.requestUpdate();

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#links.observe(document.head, { childList: true });
  }

  protected override willUpdate(): void {
    if (this.#subscribed !== this.catalogs) {
      this.#unsubscribe?.();
      this.#subscribed = this.catalogs;
      this.#unsubscribe = this.catalogs?.subscribe(() => this.requestUpdate());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#links.disconnect();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#subscribed = undefined;
  }

  protected override render() {
    const addons = this.#addons();
    return html`
      <section class="language-coverage interface-consistency" aria-labelledby="interface-consistency-title">
        <h3 id="interface-consistency-title">${this.#ui.t("settings.consistency")}</h3>
        <p class="settings-hint">${this.#ui.t("settings.consistencyIntro")}</p>
        ${
          addons.length === 0
            ? html`<p class="settings-hint">${this.#ui.t("settings.consistencyNone")}</p>`
            : html`<ul class="language-coverage-sources">${addons.map((addon) => this.#addon(addon))}</ul>`
        }
      </section>`;
  }

  #addon({ id, name, coverage, state }: AddonStyles) {
    if (coverage === undefined)
      return html`<li class="language-coverage-source" data-addon=${id}>
        <div class="language-coverage-summary"><strong>${name}</strong>
        <span class="settings-hint" role=${state === "unavailable" ? "alert" : "status"}>${this.#ui.t(
          state === "unavailable"
            ? "settings.consistencyUnavailable"
            : "settings.consistencyLoading",
        )}</span></div></li>`;
    const t = (key: MessageKey, count: number) => `${this.#ui.t(key)}: ${count}`;
    return html`<li class="language-coverage-source" data-addon=${id}>
      <details>
        <summary class="language-coverage-summary">
          <strong>${name}</strong>
          <span class="language-coverage-figure" data-figure="overrides">${t("settings.consistencyOverrides", coverage.overrides.length)}</span>
          <span class="settings-hint">${[
            t("settings.consistencyRules", coverage.rules),
            t("settings.consistencyOwnParts", coverage.ownClasses.length),
            t("settings.consistencySpacing", coverage.spacingLiterals.length),
          ].join(" · ")}</span>
        </summary>
        ${
          coverage.overrides.length === 0 && coverage.spacingLiterals.length === 0
            ? html`<p class="settings-hint">${this.#ui.t("settings.consistencyClean")}</p>`
            : nothing
        }
        ${styleOverrideKinds.map((kind) => {
          const selectors = coverage.overrides.filter((override) => override.kind === kind);
          return selectors.length === 0
            ? nothing
            : html`<h4>${this.#ui.t(kindLabels[kind])} (${selectors.length})</h4>
              <ul class="interface-consistency-list" data-kind=${kind}>${selectors.map(
                ({ selector }) => html`<li><code>${selector}</code></li>`,
              )}</ul>`;
        })}
        ${
          coverage.spacingLiterals.length === 0
            ? nothing
            : html`<h4>${this.#ui.t("settings.consistencySpacing")} (${coverage.spacingLiterals.length})</h4>
              <ul class="interface-consistency-list" data-kind="spacing">${coverage.spacingLiterals.map(
                ({ selector, property, value }) =>
                  html`<li><code>${selector}</code> <code>${property}: ${value}</code></li>`,
              )}</ul>`
        }
      </details>
    </li>`;
  }

  /** Every add-on with loaded styles, the one restyling most shared controls first. */
  #addons(): readonly AddonStyles[] {
    const names = new Map(
      (this.catalogs?.entries() ?? []).map((entry) => [entry.addonId, entry.addonName]),
    );
    const links = new Map<string, HTMLLinkElement[]>();
    for (const link of document.querySelectorAll<HTMLLinkElement>("link[data-codex-addon]")) {
      const id = link.dataset["codexAddon"] ?? "",
        generation = link.dataset["codexGeneration"] ?? "";
      // While a replacement loads, keep only the newest generation's links.
      const kept = (links.get(id) ?? []).filter(
        (other) => other.dataset["codexGeneration"] === generation,
      );
      links.set(id, [...kept, link]);
    }
    return [...links]
      .map(([id, sheets]): AddonStyles => {
        const name = names.get(id) || id,
          rules: StyleRule[] = [];
        for (const link of sheets) {
          const read = readRules(link);
          if (read === "loading") {
            link.addEventListener("load", this.#onLoad, { once: true });
            return { id, name, coverage: undefined, state: "loading" };
          }
          if (read === "unavailable")
            return { id, name, coverage: undefined, state: "unavailable" };
          rules.push(...read);
        }
        return { id, name, coverage: styleCoverage(rules), state: "ready" };
      })
      .sort(
        (a, b) =>
          (b.coverage?.overrides.length ?? -1) - (a.coverage?.overrides.length ?? -1) ||
          a.name.localeCompare(b.name),
      );
  }
}

function readRules(link: HTMLLinkElement): readonly StyleRule[] | "loading" | "unavailable" {
  const sheet = link.sheet;
  if (sheet === null) return "loading";
  const cached = parsedSheets.get(sheet);
  if (cached !== undefined) return cached;
  try {
    const rules: StyleRule[] = [];
    collectRules(sheet.cssRules, rules);
    parsedSheets.set(sheet, rules);
    return rules;
  } catch {
    return "unavailable";
  }
}

/** Style rules inside grouping rules (`@media`, `@layer`, `@supports`, nesting) count too. */
function collectRules(list: CSSRuleList, rules: StyleRule[]): void {
  for (const rule of Array.from(list)) {
    if (rule instanceof CSSStyleRule) {
      rules.push({
        selector: rule.selectorText,
        declarations: parseDeclarations(rule.style.cssText),
      });
      collectRules(rule.cssRules, rules);
    } else if (rule instanceof CSSGroupingRule) collectRules(rule.cssRules, rules);
  }
}

customElements.define("codex-interface-consistency", CodexInterfaceConsistency);
