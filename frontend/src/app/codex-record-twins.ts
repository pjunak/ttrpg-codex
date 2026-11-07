import { LitElement, html, nothing } from "lit";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import type { CampaignTwinMutation } from "../core/campaign-mutations.js";
import { openContextMenu, type ContextMenuItem } from "../ui/context-menu.js";
import { recordHref, type CampaignPageDefinition } from "./routes.js";
import { recordValue, text } from "./campaign-projection.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { saveCampaign } from "./campaign-writes.js";
import { dmVersionIcon, playerVersionIcon } from "./record-chrome.js";

type Audience = "dm" | "public";
type TwinChange =
  | { readonly action: "create" | "unlink" }
  | {
      readonly action: "link";
      readonly targetKey: string;
      readonly targetExpectedRevision: number;
    };

const audience = (record: CampaignRecord): Audience =>
  recordValue(record)["visibility"] === "dm" ? "dm" : "public";
const linkedTwin = (record: CampaignRecord): string => text(recordValue(record)["linkedTwinId"]);
const recordName = (record: CampaignRecord): string =>
  text(recordValue(record)["name"]) || text(recordValue(record)["title"]) || record.key;

/**
 * A record's DM and player versions as a two-part switch. The version on
 * screen is lit in its audience's colour; the other one opens, or, while it
 * does not exist yet, offers a menu that creates it or links an existing record.
 */
export class CodexRecordTwins extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    record: { attribute: false },
    page: { attribute: false },
    disabled: { type: Boolean },
    pending: { state: true },
    message: { state: true },
  };
  declare campaign: CampaignDataset;
  declare record: CampaignRecord;
  declare page: CampaignPageDefinition;
  declare disabled: boolean;
  declare private pending: boolean;
  declare private message: string;
  #failed = false;
  constructor() {
    super();
    new UiLocalizationController(this);
    this.disabled = false;
    this.pending = false;
    this.message = "";
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const previous = changed.get("record") as CampaignRecord | undefined;
    if ((previous && previous.key !== this.record.key) || changed.has("page")) this.message = "";
  }
  protected override render() {
    if (!this.record || !this.page || this.page.collection === "companions") return nothing;
    const twinKey = linkedTwin(this.record);
    const twin = twinKey ? this.#records().find((record) => record.key === twinKey) : undefined;
    const current = audience(this.record);
    const side = (kind: Audience) => {
      const icon = kind === "dm" ? dmVersionIcon() : playerVersionIcon();
      if (kind === current) {
        const showing = uiText(kind === "dm" ? "twins.showingDM" : "twins.showingPublic");
        return html`<span class="record-version is-current" data-version=${kind} title=${showing}>${icon}<span class="visually-hidden">${showing}</span></span>`;
      }
      if (twin) {
        const open = uiText(kind === "dm" ? "twins.openDM" : "twins.openPublic");
        return html`<a class="record-version" data-version=${kind} href=${recordHref(this.page, twin.key)} aria-label=${open} title=${open}>${icon}</a>`;
      }
      if (twinKey)
        return html`<span class="record-version is-unavailable" data-version=${kind} title=${uiText("twins.unavailable")}>${icon}<span class="visually-hidden">${uiText("twins.unavailable")}</span></span>`;
      const add = uiText(kind === "dm" ? "twins.addDM" : "twins.addPublic");
      return html`<button type="button" class="record-version is-missing" data-version=${kind} aria-label=${add} title=${add}
        aria-haspopup="menu" ?disabled=${this.disabled || this.pending} @click=${(
          event: MouseEvent,
        ) => this.#offer(event.currentTarget as HTMLElement, kind)}>${icon}</button>`;
    };
    return html`<div class="record-version-switch" role="group" aria-label=${uiText("twins.title")}>${side("dm")}${side("public")}</div>
      ${
        this.message
          ? html`<p class="record-versions-note" role=${this.#failed ? "alert" : "status"}><span>${this.message}</span>
        <button type="button" class="ui-action" data-ui-variant="quiet" @click=${this.#close}>${uiText("Close")}</button></p>`
          : nothing
      }`;
  }
  /** Unlinks this record from its other version; both records keep their text. */
  readonly unlink = (): void => {
    if (linkedTwin(this.record)) void this.#submit(this.record, { action: "unlink" });
  };
  readonly #close = (): void => {
    this.message = "";
  };
  #records(): readonly CampaignRecord[] {
    return campaignCollection(this.campaign, this.page.collection).records;
  }
  /** The menu for a version that does not exist yet, built from the records as they are now. */
  #offer(button: HTMLElement, kind: Audience): void {
    const base = this.record;
    const candidates = this.#records().filter(
      (record) => record.key !== base.key && audience(record) === kind && !linkedTwin(record),
    );
    const box = button.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      {
        label: uiText(kind === "dm" ? "twins.createDM" : "twins.createPublic"),
        detail: uiText(kind === "dm" ? "twins.dmOnly" : "twins.playersSee"),
        run: () => void this.#submit(base, { action: "create" }),
      },
      {
        label: uiText(kind === "dm" ? "twins.linkDM" : "twins.linkPublic"),
        disabled: candidates.length ? false : uiText("twins.noCandidates"),
        searchable: candidates.length > 8,
        children: candidates.map((record) => ({
          label: recordName(record),
          run: () =>
            void this.#submit(base, {
              action: "link",
              targetKey: record.key,
              targetExpectedRevision: record.revision,
            }),
        })),
      },
    ];
    openContextMenu(button.ownerDocument, { x: box.left, y: box.bottom + 4 }, items, {
      title: uiText(kind === "dm" ? "twins.noDM" : "twins.noPublic"),
      returnFocus: button,
    });
  }
  async #submit(base: CampaignRecord, change: TwinChange): Promise<void> {
    if (this.pending || this.disabled) return;
    const mutation: CampaignTwinMutation = {
      collection: this.page.collection,
      sourceKey: base.key,
      sourceExpectedRevision: base.revision,
      ...change,
    };
    this.pending = true;
    this.message = "";
    const result = await saveCampaign(this, "twin", mutation);
    this.pending = false;
    this.message = result.message ?? "";
    this.#failed = !result.ok;
  }
}
customElements.define("codex-record-twins", CodexRecordTwins);

/** The ⋯ menu entry that unlinks a record's DM and player versions, while they are linked. */
export function versionMenuItems(host: Element, record: CampaignRecord): ContextMenuItem[] {
  if (!linkedTwin(record)) return [];
  return [
    {
      label: uiText("twins.unlink"),
      detail: uiText("twins.unlinkDetail"),
      run: () => host.querySelector<CodexRecordTwins>("codex-record-twins")?.unlink(),
    },
  ];
}
