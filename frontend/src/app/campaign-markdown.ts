import { previewResourceURL } from "../core/player-preview.js";
import { html, nothing, type TemplateResult } from "lit";
import { Marked, type Token, type Tokens } from "marked";
import {
  campaignCollection,
  type CampaignCollectionName,
  type CampaignDataset,
} from "../core/campaign-data.js";
import { isRecord } from "../core/boundary.js";
import { campaignPages, recordHash, type CampaignPageDefinition } from "./routes.js";
import type { AddonLinkState } from "./addon-links-controller.js";
import { uiText } from "./ui-localization.js";
import { parseMarkdownFormat, markdownFormatClose } from "./markdown-formats.js";

const wikiTokenType = "campaign-wiki-link";
const markdown = new Marked({
  gfm: true,
  breaks: false,
  extensions: [{
    name: wikiTokenType,
    level: "inline",
    start(source) {
      const index = source.indexOf("[[");
      return index === -1 ? undefined : index;
    },
    tokenizer(source) {
      const match = /^\[\[([^\]|\n]{1,200})(?:\|([^\]\n]{1,300}))?\]\]/u.exec(source);
      const label = match?.[1]?.trim() ?? "";
      if (match === null || label === "") return undefined;
      const hint = match[2]?.trim();
      return {
        type: wikiTokenType,
        raw: match[0],
        label,
        ...(hint === undefined || hint === "" ? {} : { hint }),
      };
    },
  }],
});

type MarkdownRenderable = TemplateResult | typeof nothing | string | readonly MarkdownRenderable[];

export interface CampaignMarkdownOutlineItem {
  readonly id: string;
  readonly text: string;
  readonly depth: number;
}

export interface CampaignMarkdownDocument {
  readonly tokens: readonly Token[];
  readonly outline: readonly CampaignMarkdownOutlineItem[];
  readonly headingIDs: ReadonlyMap<Token, string>;
}

export interface CampaignMarkdownContext {
  readonly dataset: CampaignDataset;
  readonly currentCollection?: CampaignCollectionName;
  readonly currentKey?: string;
  readonly addonWiki?: (label: string, hint: string) => AddonLinkState;
}

export interface CampaignWikiLink {
  readonly href: string;
  readonly page: CampaignPageDefinition;
  readonly key: string;
}

interface CampaignWikiToken extends Tokens.Generic {
  readonly type: typeof wikiTokenType;
  readonly label: string;
  readonly hint?: string;
}

interface SafeMarkdownLink {
  readonly href: string;
  readonly external: boolean;
}

interface SemanticHTML {
  readonly tag: "span" | "mark" | "sup" | "sub";
  readonly className?: string;
}

const legacyScopeAliases: Readonly<Partial<Record<CampaignCollectionName, readonly string[]>>> = Object.freeze({
  characters: Object.freeze(["character", "postava"]),
  locations: Object.freeze(["location", "misto"]),
  events: Object.freeze(["event", "udalost"]),
  mysteries: Object.freeze(["mystery", "zahada"]),
  factions: Object.freeze(["faction", "frakce", "frakce-id"]),
  pantheon: Object.freeze(["deity", "buh"]),
  artifacts: Object.freeze(["artifact", "artefakt"]),
  historicalEvents: Object.freeze(["historical-event", "historicka-udalost"]),
  pets: Object.freeze(["companion", "companions", "pet"]),
});

export function parseCampaignMarkdownDocuments(
  sources: readonly string[],
): readonly CampaignMarkdownDocument[] {
  const slugCounts = new Map<string, number>();
  return Object.freeze(sources.map((source) => parseCampaignMarkdownWithSlugger(source, slugCounts)));
}

export function parseCampaignMarkdown(source: string): CampaignMarkdownDocument {
  return parseCampaignMarkdownDocuments([source])[0] ?? emptyDocument();
}

export function campaignMarkdownOutline(
  documents: readonly CampaignMarkdownDocument[],
): readonly CampaignMarkdownOutlineItem[] {
  return Object.freeze(documents.flatMap(({ outline }) => outline));
}

export function renderCampaignMarkdown(
  document: CampaignMarkdownDocument,
  context: CampaignMarkdownContext,
): TemplateResult {
  return html`<div class="campaign-markdown">${renderBlockTokens(document.tokens, document, context)}</div>`;
}

export function resolveCampaignWikiLink(
  context: CampaignMarkdownContext,
  label: string,
  hint = "",
): CampaignWikiLink | undefined {
  const normalizedLabel = normalizeIdentity(label);
  if (normalizedLabel === "") return undefined;
  const separator = hint.indexOf(":");
  if (separator !== -1) {
    const page = pageForScope(hint.slice(0, separator));
    const key = hint.slice(separator + 1).trim();
    if (page === undefined || key === "") return undefined;
    const record = campaignCollection(context.dataset, page.collection).records.find(({ key: candidate }) => candidate === key);
    return record === undefined ? undefined : Object.freeze({ href: recordHash(page, record.key), page, key: record.key });
  }

  const scopedPage = hint === "" ? undefined : pageForScope(hint);
  if (hint !== "" && scopedPage === undefined) return undefined;
  const pages = scopedPage === undefined ? campaignPages : [scopedPage];
  for (const page of pages) {
    const matches = campaignCollection(context.dataset, page.collection).records.filter((record) => {
      if (!isRecord(record.value)) return false;
      return normalizeIdentity(record.value["name"] ?? record.value["title"]) === normalizedLabel;
    });
    if (matches.length === 0) continue;
    const record = preferredWikiMatch(context, matches) ?? matches[0];
    if (record !== undefined) {
      return Object.freeze({ href: recordHash(page, record.key), page, key: record.key });
    }
  }
  return undefined;
}

export function safeCampaignMarkdownLink(href: string): SafeMarkdownLink | undefined {
  const normalized = href.trim();
  if (normalized.startsWith("#/")) return { href: normalized, external: false };
  if (normalized.startsWith("/") && !normalized.startsWith("//")) {
    return { href: normalized, external: false };
  }
  try {
    const url = new URL(normalized);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") {
      return { href: url.href, external: url.protocol !== "mailto:" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseCampaignMarkdownWithSlugger(
  source: string,
  slugCounts: Map<string, number>,
): CampaignMarkdownDocument {
  const tokens: readonly Token[] = lexCampaignMarkdown(source);
  const outline: CampaignMarkdownOutlineItem[] = [];
  const headingIDs = new Map<Token, string>();
  walkTokens(tokens, (token) => {
    if (token.type !== "heading") return;
    const heading = token as Tokens.Heading;
    const headingText = inlineText(heading.tokens).trim() || heading.text.trim() || "Section";
    const base = `article-${slugify(headingText)}`;
    const occurrence = (slugCounts.get(base) ?? 0) + 1;
    slugCounts.set(base, occurrence);
    const id = occurrence === 1 ? base : `${base}-${occurrence}`;
    headingIDs.set(token, id);
    if (heading.depth <= 3) outline.push(Object.freeze({ id,
      text: inlineText(heading.tokens).trim() || heading.text.trim() || uiText("Section"), depth: heading.depth }));
  });
  return Object.freeze({
    tokens: Object.freeze([...tokens]),
    outline: Object.freeze(outline),
    headingIDs,
  });
}

function lexCampaignMarkdown(source: string): readonly Token[] {
  try {
    return markdown.lexer(source);
  } catch {
    // A damaged article must remain readable and editable even if the parser
    // rejects it. Lit still owns the output boundary, so this is safe text.
    const textToken: Tokens.Text = { type: "text", raw: source, text: source };
    const paragraph: Tokens.Paragraph = { type: "paragraph", raw: source, text: source, tokens: [textToken] };
    return [paragraph];
  }
}

function emptyDocument(): CampaignMarkdownDocument {
  return Object.freeze({ tokens: Object.freeze([]), outline: Object.freeze([]), headingIDs: new Map() });
}

function walkTokens(tokens: readonly Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    const children = "tokens" in token && Array.isArray(token.tokens) ? token.tokens : undefined;
    if (children !== undefined) walkTokens(children, visit);
    if (token.type === "list") {
      for (const item of (token as Tokens.List).items) walkTokens(item.tokens, visit);
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()]) walkTokens(cell.tokens, visit);
    }
  }
}

function renderBlockTokens(
  tokens: readonly Token[],
  document: CampaignMarkdownDocument,
  context: CampaignMarkdownContext,
): readonly MarkdownRenderable[] {
  return tokens.map((token) => renderBlockToken(token, document, context));
}

function renderBlockToken(
  token: Token,
  document: CampaignMarkdownDocument,
  context: CampaignMarkdownContext,
): MarkdownRenderable {
  switch (token.type) {
    case "space":
    case "def":
      return nothing;
    case "heading": {
      const heading = token as Tokens.Heading;
      const id = document.headingIDs.get(token);
      const content = renderInlineTokens(heading.tokens, context);
      if (heading.depth <= 1) return html`<h2 id=${id ?? nothing} tabindex="-1">${content}</h2>`;
      if (heading.depth === 2) return html`<h3 id=${id ?? nothing} tabindex="-1">${content}</h3>`;
      return html`<h4 id=${id ?? nothing} tabindex="-1">${content}</h4>`;
    }
    case "paragraph":
      return html`<p>${renderInlineTokens((token as Tokens.Paragraph).tokens, context)}</p>`;
    case "text": {
      const textToken = token as Tokens.Text;
      return textToken.tokens === undefined
        ? textToken.text
        : renderInlineTokens(textToken.tokens, context);
    }
    case "blockquote":
      return html`<blockquote>${renderBlockTokens((token as Tokens.Blockquote).tokens, document, context)}</blockquote>`;
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item) => html`<li>${renderBlockTokens(item.tokens, document, context)}</li>`);
      return list.ordered
        ? html`<ol start=${typeof list.start === "number" ? list.start : nothing}>${items}</ol>`
        : html`<ul>${items}</ul>`;
    }
    case "code": {
      const code = token as Tokens.Code;
      const language = code.lang?.trim().match(/^[a-z0-9_+-]+/iu)?.[0];
      return html`<pre><code class=${language === undefined ? nothing : `language-${language.toLocaleLowerCase()}`}>${code.text}</code></pre>`;
    }
    case "hr":
      return html`<hr />`;
    case "table":
      return renderTable(token as Tokens.Table, context);
    case "html":
      return html`<p class="markdown-raw-html"><code>${(token as Tokens.HTML).text}</code></p>`;
    default:
      return renderUnknownToken(token, document, context);
  }
}

function renderInlineTokens(tokens: readonly Token[], context: CampaignMarkdownContext): readonly MarkdownRenderable[] {
  const rendered: MarkdownRenderable[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const semantic = semanticOpening(token);
    if (semantic !== undefined) {
      const closing = semanticClosingIndex(tokens, index + 1, semantic.tag);
      if (closing !== -1) {
        const children = renderInlineTokens(tokens.slice(index + 1, closing), context);
        rendered.push(renderSemanticHTML(semantic, children));
        index = closing;
        continue;
      }
    }
    rendered.push(renderInlineToken(token, context));
  }
  return rendered;
}

function renderInlineToken(token: Token, context: CampaignMarkdownContext): MarkdownRenderable {
  if (isWikiToken(token)) {
    const target = resolveCampaignWikiLink(context, token.label, token.hint);
    const addon = target ? undefined : context.addonWiki?.(token.label, token.hint ?? "");
    const href = target?.href ?? (addon?.status === "resolved" ? addon.href : undefined);
    if (!target && (addon !== undefined || token.hint?.includes(":"))) return html`<codex-addon-rule-details .details=${{ label: token.label, wiki: { label: token.label, hint: token.hint ?? "" } }}></codex-addon-rule-details>`;
    return href === undefined
      ? html`<span class="wiki-link-missing" title=${uiText(addon?.status === "loading" ? "wiki.loading" : addon?.status === "failed" ? "wiki.failed" : "wiki.missing")}>[[${token.label}]]</span>`
      : html`<a class="wiki-link" href=${href}>${token.label}</a>`;
  }
  switch (token.type) {
    case "text": {
      const textToken = token as Tokens.Text;
      return textToken.tokens === undefined ? textToken.text : renderInlineTokens(textToken.tokens, context);
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "strong":
      return html`<strong>${renderInlineTokens((token as Tokens.Strong).tokens, context)}</strong>`;
    case "em":
      return html`<em>${renderInlineTokens((token as Tokens.Em).tokens, context)}</em>`;
    case "del":
      return html`<del>${renderInlineTokens((token as Tokens.Del).tokens, context)}</del>`;
    case "codespan":
      return html`<code>${(token as Tokens.Codespan).text}</code>`;
    case "br":
      return html`<br />`;
    case "link": {
      const link = token as Tokens.Link;
      const safe = safeCampaignMarkdownLink(link.href);
      const content = renderInlineTokens(link.tokens, context);
      if (safe === undefined) return html`<span class="markdown-link-rejected">${content}</span>`;
      return html`<a
        href=${previewResourceURL(safe.href)}
        title=${link.title ?? nothing}
        target=${safe.external ? "_blank" : nothing}
        rel=${safe.external ? "noopener noreferrer" : nothing}
      >${content}</a>`;
    }
    case "image": {
      const image = token as Tokens.Image;
      const safe = safeCampaignMarkdownLink(image.href);
      return safe === undefined || safe.href.startsWith("mailto:") || safe.href.startsWith("#/")
        ? html`<span class="markdown-image-rejected">${image.text}</span>`
        : html`<img src=${previewResourceURL(safe.href)} alt=${image.text} title=${image.title ?? nothing} loading="lazy" />`;
    }
    case "checkbox":
      return html`<input type="checkbox" disabled .checked=${(token as Tokens.Checkbox).checked} />`;
    case "html": {
      const raw = (token as Tokens.HTML).text;
      if (/^<br\s*\/?>$/iu.test(raw.trim())) return html`<br />`;
      return raw;
    }
    default:
      if ("tokens" in token && Array.isArray(token.tokens)) return renderInlineTokens(token.tokens, context);
      return "text" in token && typeof token.text === "string" ? token.text : token.raw;
  }
}

function renderTable(table: Tokens.Table, context: CampaignMarkdownContext): TemplateResult {
  return html`
    <div class="markdown-table-scroll" tabindex="0">
      <table>
        <thead><tr>${table.header.map((cell) => html`
          <th class=${alignmentClass(cell.align)}>${renderInlineTokens(cell.tokens, context)}</th>
        `)}</tr></thead>
        <tbody>${table.rows.map((row) => html`<tr>${row.map((cell) => html`
          <td class=${alignmentClass(cell.align)}>${renderInlineTokens(cell.tokens, context)}</td>
        `)}</tr>`)}</tbody>
      </table>
    </div>
  `;
}

function renderUnknownToken(
  token: Token,
  document: CampaignMarkdownDocument,
  context: CampaignMarkdownContext,
): MarkdownRenderable {
  if ("tokens" in token && Array.isArray(token.tokens)) return renderBlockTokens(token.tokens, document, context);
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}

function semanticOpening(token: Token): SemanticHTML | undefined {
  if (token.type !== "html") return undefined;
  return parseMarkdownFormat(token.raw.trim());
}

function semanticClosingIndex(tokens: readonly Token[], start: number, tag: SemanticHTML["tag"]): number {
  return markdownFormatClose(tokens, start, tag);
}

function renderSemanticHTML(
  semantic: SemanticHTML,
  children: readonly MarkdownRenderable[],
): TemplateResult {
  switch (semantic.tag) {
    case "span": return html`<span
      class=${semantic.className ?? nothing}
      tabindex=${semantic.className === "md-effect-spoiler" ? "0" : nothing}
    >${children}</span>`;
    case "mark": return html`<mark class=${semantic.className ?? nothing}>${children}</mark>`;
    case "sup": return html`<sup>${children}</sup>`;
    case "sub": return html`<sub>${children}</sub>`;
  }
}

function inlineText(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    if (isWikiToken(token)) return token.label;
    if (token.type === "image") return (token as Tokens.Image).text;
    if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : "";
  }).join("");
}

function isWikiToken(token: Token): token is CampaignWikiToken {
  return token.type === wikiTokenType && "label" in token && typeof token["label"] === "string";
}

function pageForScope(scope: string): CampaignPageDefinition | undefined {
  const normalized = normalizeIdentity(scope);
  return campaignPages.find((page) => [
    page.id,
    page.collection,
    page.singular,
    ...(legacyScopeAliases[page.collection] ?? []),
  ].some((candidate) => normalizeIdentity(candidate) === normalized));
}

function preferredWikiMatch(
  context: CampaignMarkdownContext,
  matches: ReturnType<typeof campaignCollection>["records"],
) {
  if (context.currentCollection === undefined || context.currentKey === undefined) return matches[0];
  const current = campaignCollection(context.dataset, context.currentCollection).records
    .find(({ key }) => key === context.currentKey);
  const currentVisibility = isRecord(current?.value) && current.value["visibility"] === "dm" ? "dm" : "public";
  return matches.find((candidate) => {
    const visibility = isRecord(candidate.value) && candidate.value["visibility"] === "dm" ? "dm" : "public";
    return visibility === currentVisibility;
  }) ?? matches[0];
}

function normalizeIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ");
}

function slugify(value: string): string {
  return normalizeIdentity(value)
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "section";
}

function alignmentClass(alignment: Tokens.TableCell["align"]): string {
  return alignment === null ? "" : `align-${alignment}`;
}
