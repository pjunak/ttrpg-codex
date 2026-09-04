import { describe, expect, it } from "vitest";
import {
  campaignMarkdownOutline,
  parseCampaignMarkdown,
  parseCampaignMarkdownDocuments,
  renderCampaignMarkdown,
  resolveCampaignWikiLink,
  safeCampaignMarkdownLink,
} from "../src/app/campaign-markdown.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

describe("campaign markdown", () => {
  it("builds a stable, duplicate-safe outline across article sections", () => {
    const documents = parseCampaignMarkdownDocuments([
      "# First steps\n\n## Clues\n\n#### Not in the outline",
      "# First steps\n\n### Consequences",
    ]);

    expect(campaignMarkdownOutline(documents)).toEqual([
      { id: "article-first-steps", text: "First steps", depth: 1 },
      { id: "article-clues", text: "Clues", depth: 2 },
      { id: "article-first-steps-2", text: "First steps", depth: 1 },
      { id: "article-consequences", text: "Consequences", depth: 3 },
    ]);
  });

  it("parses wiki syntax without turning raw HTML into a rendering boundary", () => {
    const document = parseCampaignMarkdown("Meet **[[Lantern Watch|frakce:watch]]**.\n\n<script>alert(1)</script>");

    expect(document.tokens.map(({ type }) => type)).toEqual(["paragraph", "space", "html"]);
    expect(JSON.stringify(document.tokens)).toContain('"type":"campaign-wiki-link"');
    expect(document.outline).toEqual([]);
  });

  it("renders resolved and missing wiki links as typed Lit templates", () => {
    const campaign = dataset({
      factions: [{ key: "watch", revision: 1, value: { id: "watch", name: "Lantern Watch" } }],
    });
    const rendered = renderCampaignMarkdown(
      parseCampaignMarkdown("**[[Lantern Watch|frakce:watch]]** and [[Missing witness]]"),
      { dataset: campaign },
    );
    const markup = templateStructure(rendered);

    expect(markup).toContain('<a class="wiki-link"');
    expect(markup).toContain('class="wiki-link-missing"');
    expect(markup).not.toContain("unsafeHTML");
  });

  it("resolves only records present in the role-projected campaign", () => {
    const campaign = dataset({
      characters: [
        { key: "ryn-public", revision: 1, value: { id: "ryn-public", name: "Rýn", visibility: "public" } },
        { key: "ryn-dm", revision: 1, value: { id: "ryn-dm", name: "Rýn", visibility: "dm" } },
      ],
      factions: [{ key: "watch", revision: 1, value: { id: "watch", name: "Lantern Watch" } }],
    });

    expect(resolveCampaignWikiLink({
      dataset: campaign,
      currentCollection: "characters",
      currentKey: "ryn-public",
    }, "Ryn")).toMatchObject({ href: "#/characters/ryn-public", key: "ryn-public" });
    expect(resolveCampaignWikiLink({ dataset: campaign }, "Watch", "frakce:watch"))
      .toMatchObject({ href: "#/factions/watch", key: "watch" });
    expect(resolveCampaignWikiLink({ dataset: campaign }, "Hidden", "postava:hidden-character")).toBeUndefined();
    expect(resolveCampaignWikiLink({ dataset: campaign }, "Lantern Watch", "misto")).toBeUndefined();
  });

  it("allows campaign and ordinary web links but rejects active-content schemes", () => {
    expect(safeCampaignMarkdownLink("#/characters/ryn")).toEqual({
      href: "#/characters/ryn", external: false,
    });
    expect(safeCampaignMarkdownLink("/api/media/portrait.webp")).toEqual({
      href: "/api/media/portrait.webp", external: false,
    });
    expect(safeCampaignMarkdownLink("https://example.com/lore")).toEqual({
      href: "https://example.com/lore", external: true,
    });
    expect(safeCampaignMarkdownLink("javascript:alert(1)")).toBeUndefined();
    expect(safeCampaignMarkdownLink("data:text/html,boom")).toBeUndefined();
    expect(safeCampaignMarkdownLink("//example.com/implicit")).toBeUndefined();
  });
});

function dataset(
  records: Partial<Record<CampaignCollectionName, CampaignCollection["records"]>>,
): CampaignDataset {
  const shapes: Readonly<Record<CampaignCollectionName, CampaignCollection["shape"]>> = {
    characters: "list", relationships: "list", locations: "list", events: "list",
    mysteries: "list", factions: "keyed", deletedDefaults: "keyed", pantheon: "list",
    artifacts: "list", settings: "keyed", historicalEvents: "list", campaign: "keyed", pets: "list",
  };
  return {
    contractVersion: "campaign-data.v1",
    collections: (Object.entries(shapes) as [CampaignCollectionName, CampaignCollection["shape"]][])
      .map(([name, shape]) => ({
        name,
        shape,
        materialized: records[name] !== undefined,
        revision: records[name] === undefined ? 0 : 1,
        records: records[name] ?? [],
      })),
  };
}

function templateStructure(value: unknown): string {
  if (Array.isArray(value)) return value.map(templateStructure).join("");
  if (typeof value !== "object" || value === null) return String(value ?? "");
  if (!("strings" in value) || !("values" in value)) return "";
  const stringsValue: unknown = value.strings;
  const valuesValue: unknown = value.values;
  if (!Array.isArray(stringsValue) || !Array.isArray(valuesValue)) return "";
  const strings = stringsValue.filter((candidate): candidate is string => typeof candidate === "string");
  return strings.map((part, index) => `${part}${templateStructure(valuesValue[index])}`).join("");
}
