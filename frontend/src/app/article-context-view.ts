import { html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import { articleReference, type ArticleReference, type ArticleContextSection } from "./article-context.js";
import { relationshipEditorRowsFor, relationshipTypeOptionsFor } from "./campaign-record-editor.js";
import { locationRoleDrafts } from "./campaign-structured-editors.js";
import { uiText } from "./ui-localization.js";

export function renderArticleReference(reference: ArticleReference) {
  return reference.href ? html`<a class="article-reference" href=${reference.href}>${reference.label}</a>`
    : html`<span class="article-reference-unavailable">${reference.label}</span>`;
}
export function renderArticleReferences(references: readonly ArticleReference[]) {
  return references.length ? html`<span class="article-reference-list">${references.map(renderArticleReference)}</span>` : html`<span>—</span>`;
}
export function renderArticleContext(sections: readonly ArticleContextSection[]) {
  return sections.map(section => section.id === "ancestors"
    ? html`<nav class="article-context-section" data-context=${section.id} aria-label=${section.title}><h2 class="record-section-title">${section.title}</h2>
        <ol class="article-ancestor-list">${section.groups.flatMap(group => group.entries).map(entry => html`<li>${renderArticleReference(entry)}</li>`)}</ol></nav>`
    : html`<section class="article-context-section" data-context=${section.id} aria-label=${section.title}><h2 class="record-section-title">${section.title}</h2>
      <div class="article-context-groups">${section.groups.map(group => html`<div>
        ${group.title ? html`<h3>${group.title}</h3>` : nothing}
        ${group.entries.length ? html`<ul>${group.entries.map(entry => html`<li>${renderArticleReference(entry)}</li>`)}</ul>` : html`<p class="field-help">${uiText("None")}</p>`}
      </div>`)}</div></section>`);
}
export function renderCharacterRelationships(campaign: CampaignDataset, key: string, dm: boolean) {
  const types = relationshipTypeOptionsFor(campaign);
  return html`<ul class="article-relationship-list">${relationshipEditorRowsFor(campaign, key, dm).map(row => {
    const type = types.find(type => type.value === row.type);
    const collection = row.direction === "to" ? "characters" : type?.targetCollection ?? (row.type === "mission" ? "locations" : "characters");
    const peer = renderArticleReference(articleReference(campaign, collection, row.target));
    return html`<li>${row.direction === "to" ? peer : uiText("This character")} → ${row.label || type?.label || row.type} →
      ${row.direction === "to" ? uiText("This character") : peer}${row.visibility === "dm" ? html` <span class="dm-badge">${uiText("DM")}</span>` : nothing}</li>`;
  })}</ul>`;
}
export function renderCharacterLocationRoles(campaign: CampaignDataset, value: unknown) {
  return html`<ul class="article-relationship-list">${locationRoleDrafts(value).map(role => html`<li>
    ${renderArticleReference(articleReference(campaign, "locations", role.locationId))} — ${role.role || uiText("Role not specified")}</li>`)}</ul>`;
}
