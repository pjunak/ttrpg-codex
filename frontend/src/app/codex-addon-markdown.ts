import { LitElement, html } from "lit";
import { parseCampaignMarkdown, renderCampaignMarkdown } from "./campaign-markdown.js";
import { UiLocalizationController } from "./ui-localization.js";

/** Public integrated add-on component: safe prose rendering, with no campaign access. */
export class CodexAddonMarkdown extends LitElement {
  static override properties = { source: { attribute: false } };
  declare source: string;
  readonly #ui = new UiLocalizationController(this);
  readonly #headingPrefix = `addon-prose-${crypto.randomUUID()}-`;
  constructor() { super(); this.source = ""; }
  protected override createRenderRoot() { return this; }
  protected override render() {
    if (typeof this.source !== "string" || this.source.length > 200_000) return html`<p role="alert">${this.#ui.t("recordAddons.markdownInvalid")}</p>`;
    const document = parseCampaignMarkdown(this.source);
    return renderCampaignMarkdown({ ...document, headingIDs: new Map([...document.headingIDs].map(([token, id]) => [token, `${this.#headingPrefix}${id}`])) },
      { dataset: { contractVersion: "campaign-data.v1", collections: [] } });
  }
}
customElements.define("codex-addon-markdown", CodexAddonMarkdown);
