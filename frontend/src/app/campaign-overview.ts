import { LitElement, css, html } from "lit";
import { isRecord } from "../core/boundary.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";

export interface CampaignCharacterSummary {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly status: "alive" | "dead" | "unknown";
  readonly partyMember: boolean;
  readonly dmOnly: boolean;
}

export interface CampaignOverviewModel {
  readonly name: string;
  readonly tagline: string;
  readonly characters: readonly CampaignCharacterSummary[];
  readonly locations: number;
  readonly events: number;
  readonly mysteries: number;
}

export function projectCampaignOverview(dataset: CampaignDataset): CampaignOverviewModel {
  const campaign = campaignCollection(dataset, "campaign").records.find((record) => record.key === "main");
  const identity = isRecord(campaign?.value) ? campaign.value : {};
  const characters = campaignCollection(dataset, "characters").records.map(characterSummary);
  return {
    name: displayString(identity["name"], "Untitled Campaign"),
    tagline: displayString(identity["tagline"], ""),
    characters,
    locations: campaignCollection(dataset, "locations").records.length,
    events: campaignCollection(dataset, "events").records.length,
    mysteries: campaignCollection(dataset, "mysteries").records.length,
  };
}

export class CampaignOverview extends LitElement {
  static override properties = {
    campaign: { attribute: false },
  };

  static override styles = css`
    :host {
      display: block;
      margin-top: 2rem;
      padding-top: 1.75rem;
      border-top: 1px solid #55534a;
    }

    .hero {
      display: grid;
      gap: 0.4rem;
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

    .tagline,
    .empty {
      color: #bdb9ad;
      line-height: 1.55;
    }

    .facts {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.65rem;
      margin: 1.4rem 0 2rem;
    }

    .fact {
      padding: 0.8rem;
      border: 1px solid #454841;
      border-radius: 0.3rem;
      background: #1c2027;
    }

    .fact strong,
    .fact span {
      display: block;
    }

    .fact strong {
      color: #d8c99f;
      font-family: Palatino, "Palatino Linotype", Georgia, serif;
      font-size: 1.45rem;
      font-weight: 500;
    }

    .fact span,
    .badge {
      color: #a7a59d;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .section-heading {
      display: flex;
      gap: 1rem;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 0.8rem;
    }

    .section-heading span {
      color: #99978f;
      font-size: 0.8rem;
    }

    .characters {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
      gap: 0.75rem;
    }

    article {
      min-width: 0;
      padding: 0.9rem;
      border: 1px solid #454841;
      border-radius: 0.3rem;
      background: #1b1f26;
    }

    .portrait {
      display: grid;
      width: 2.6rem;
      height: 2.6rem;
      margin-bottom: 0.7rem;
      place-items: center;
      border: 1px solid #625b48;
      border-radius: 50%;
      color: #d9c695;
      background: #262a31;
      font-family: Palatino, "Palatino Linotype", Georgia, serif;
      font-size: 1.05rem;
    }

    .character-name {
      overflow-wrap: anywhere;
      color: #e5dfd1;
      font-weight: 650;
    }

    .character-title {
      min-height: 1.3em;
      margin-top: 0.2rem;
      color: #aaa79e;
      font-size: 0.82rem;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-top: 0.65rem;
    }

    .badge {
      padding: 0.17rem 0.35rem;
      border: 1px solid #4b4d48;
      border-radius: 999px;
    }

    .badge.dm {
      border-color: #715852;
      color: #df9f93;
    }

    @media (max-width: 40rem) {
      .facts {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `;

  declare campaign: CampaignDataset | undefined;

  constructor() {
    super();
    this.campaign = undefined;
  }

  protected override render() {
    if (this.campaign === undefined) {
      return null;
    }
    const overview = projectCampaignOverview(this.campaign);
    return html`
      <section aria-labelledby="campaign-name">
        <div class="hero">
          <h2 id="campaign-name">${overview.name}</h2>
          ${overview.tagline === "" ? null : html`<p class="tagline">${overview.tagline}</p>`}
        </div>
        <div class="facts" aria-label="Campaign contents">
          ${fact(overview.characters.length, "Characters")}
          ${fact(overview.locations, "Locations")}
          ${fact(overview.events, "Events")}
          ${fact(overview.mysteries, "Mysteries")}
        </div>
        <div class="section-heading">
          <h3>Known characters</h3>
          <span>${overview.characters.length} visible</span>
        </div>
        ${overview.characters.length === 0
          ? html`<p class="empty">No characters are visible in this campaign yet.</p>`
          : html`<div class="characters">
            ${overview.characters.map((character) => html`
              <article>
                <div class="portrait" aria-hidden="true">${initials(character.name)}</div>
                <div class="character-name">${character.name}</div>
                <div class="character-title">${character.title}</div>
                <div class="badges">
                  ${character.partyMember ? html`<span class="badge">Party</span>` : null}
                  <span class="badge">${character.status}</span>
                  ${character.dmOnly ? html`<span class="badge dm">DM only</span>` : null}
                </div>
              </article>
            `)}
          </div>`}
      </section>
    `;
  }
}

function characterSummary(record: CampaignRecord): CampaignCharacterSummary {
  const value = isRecord(record.value) ? record.value : {};
  const knowledge = typeof value["knowledge"] === "number" && Number.isFinite(value["knowledge"])
    ? value["knowledge"]
    : 4;
  const disclosedName = displayString(value["name"], "Unnamed character");
  const status = value["status"] === "alive" || value["status"] === "dead"
    ? value["status"]
    : "unknown";
  return {
    id: record.key,
    name: knowledge >= 1 ? disclosedName : "Unknown figure",
    title: knowledge >= 2 ? displayString(value["title"], "") : "Details unknown",
    status,
    partyMember: value["faction"] === "party",
    dmOnly: value["visibility"] === "dm",
  };
}

function displayString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toLocaleUpperCase() ?? "").join("") || "?";
}

function fact(value: number, label: string) {
  return html`<div class="fact"><strong>${value}</strong><span>${label}</span></div>`;
}

if (typeof customElements !== "undefined" && !customElements.get("campaign-overview")) {
  customElements.define("campaign-overview", CampaignOverview);
}
