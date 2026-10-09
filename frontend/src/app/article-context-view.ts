import { html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import {
  articleReference,
  type ArticleReference,
  type ArticleContextSection,
} from "./article-context.js";
import type { EntitySummary } from "./campaign-projection.js";
import { relationshipEditorRowsFor, relationshipTypeOptionsFor } from "./campaign-record-editor.js";
import { locationRoleDrafts } from "./campaign-structured-editors.js";
import { uiText } from "./ui-localization.js";

/**
 * A record's header badges. A party member's party badge stands in for the
 * "party" attitude, so that attitude is not shown a second time.
 */
export function renderRecordBadges(
  entity: EntitySummary,
  { status = false, tags = false }: { readonly status?: boolean; readonly tags?: boolean } = {},
) {
  const party = entity.partyIdentity;
  return html`<div class="record-badges">
    ${entity.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
    ${status && entity.status !== "" ? html`<span>${entity.statusLabel}</span>` : nothing}
    ${party === undefined ? nothing : html`<span class="party-identity-badge" style=${`background: ${party.color}; color: ${party.textColor}`}>${party.badge} ${party.name}</span>`}
    ${entity.attitudes
      .filter((attitude) => party === undefined || attitude.id !== "party")
      .map(
        (attitude) =>
          html`<span class="attitude-badge" style=${`--attitude-color: ${attitude.color}`}>${attitude.label}</span>`,
      )}
    ${tags ? entity.tags.map((tag) => html`<span>${tag}</span>`) : nothing}
  </div>`;
}

export function renderArticleReference(reference: ArticleReference) {
  return reference.href
    ? html`<a class="article-reference" href=${reference.href}>${reference.label}</a>`
    : html`<span class="article-reference-unavailable">${reference.label}</span>`;
}
export function renderArticleReferences(references: readonly ArticleReference[]) {
  return references.length
    ? html`<span class="article-reference-list">${references.map(renderArticleReference)}</span>`
    : html`<span>—</span>`;
}
export function renderArticleChip(reference: ArticleReference) {
  const content = html`${reference.icon ? html`<span class="article-chip-icon" aria-hidden="true">${reference.icon}</span>` : nothing}${reference.label}`;
  return reference.href
    ? html`<a class="article-chip" href=${reference.href}>${content}</a>`
    : html`<span class="article-chip is-unavailable">${content}</span>`;
}
export function renderArticleContext(sections: readonly ArticleContextSection[]) {
  return sections.map((section) =>
    section.id === "ancestors"
      ? html`<nav class="article-context-section" data-context=${section.id} aria-label=${section.title}><h2 class="record-section-title">${section.title}</h2>
        <ol class="article-ancestor-list">${section.groups.flatMap((group) => group.entries).map((entry) => html`<li>${renderArticleReference(entry)}</li>`)}</ol></nav>`
      : html`<section class="article-context-section" data-context=${section.id} aria-label=${section.title}><h2 class="record-section-title">${section.title}</h2>
      <div class="article-context-groups">${section.groups.map(
        (group) => html`<div>
        ${group.title ? html`<h3>${group.title}</h3>` : nothing}
        ${
          !group.entries.length
            ? html`<p class="field-help">${uiText("None")}</p>`
            : section.id === "events"
              ? html`<ul class="article-event-list">${group.entries.map((entry) => html`<li>${renderArticleReference(entry)}${entry.detail ? html`<span class="article-event-detail"> — ${entry.detail}</span>` : nothing}</li>`)}</ul>`
              : html`<ul class="article-chip-list">${group.entries.map((entry) => html`<li>${renderArticleChip(entry)}</li>`)}</ul>`
        }
      </div>`,
      )}</div></section>`,
  );
}
export function renderCharacterRelationships(campaign: CampaignDataset, key: string, dm: boolean) {
  const types = relationshipTypeOptionsFor(campaign);
  return html`<ul class="article-relationship-list">${relationshipEditorRowsFor(
    campaign,
    key,
    dm,
  ).map((row) => {
    const type = types.find((type) => type.value === row.type);
    const collection =
      row.direction === "to"
        ? "characters"
        : (type?.targetCollection ?? (row.type === "mission" ? "locations" : "characters"));
    const peer = renderArticleReference(articleReference(campaign, collection, row.target));
    return html`<li>${row.direction === "to" ? peer : uiText("This character")} → ${row.label || type?.label || row.type} →
      ${row.direction === "to" ? uiText("This character") : peer}${row.visibility === "dm" ? html` <span class="dm-badge">${uiText("DM")}</span>` : nothing}</li>`;
  })}</ul>`;
}
export function renderCharacterLocationRoles(campaign: CampaignDataset, value: unknown) {
  return html`<ul class="article-relationship-list">${locationRoleDrafts(value).map(
    (role) => html`<li>
    ${renderArticleReference(articleReference(campaign, "locations", role.locationId))} — ${role.role || uiText("Role not specified")}</li>`,
  )}</ul>`;
}
