import { describe, expect, it } from "vitest";
import { parseDeclarations, styleCoverage, type StyleRule } from "../src/app/style-coverage.js";

function rule(selector: string, cssText = ""): StyleRule {
  return { selector, declarations: parseDeclarations(cssText) };
}

describe("style coverage", () => {
  it("counts rules that restyle native controls and host primitives once each", () => {
    const coverage = styleCoverage([
      rule(".dm-panel button, .dm-panel .dm-link"),
      rule(".dm-form select"),
      rule(".dm-form :is(input, textarea)"),
      rule('.dm-tabs [data-ui-tabs] > [aria-selected="true"]'),
      rule(".dm-card .ui-action"),
      rule(".dm-toolbar > button.ui-button"),
      rule(".dm-button, .dm-select-label, [type=button]"),
      rule('.dm-note[aria-label="select a button"]'),
      rule(".dm-search::-webkit-search-cancel-button"),
    ]);
    expect(coverage.rules).toBe(9);
    expect(coverage.overrides).toEqual([
      { kind: "buttons", selector: ".dm-panel button, .dm-panel .dm-link" },
      { kind: "selects", selector: ".dm-form select" },
      { kind: "fields", selector: ".dm-form :is(input, textarea)" },
      { kind: "primitives", selector: '.dm-tabs [data-ui-tabs] > [aria-selected="true"]' },
      { kind: "primitives", selector: ".dm-card .ui-action" },
      { kind: "buttons", selector: ".dm-toolbar > button.ui-button" },
    ]);
  });

  it("lists the add-on's own classes without host ui classes or attribute values", () => {
    const coverage = styleCoverage([
      rule(".hb-list > .hb-row:hover .ui-card"),
      rule('.hb-row[data-state="a.b"]'),
      rule(".hb-list"),
    ]);
    expect(coverage.ownClasses).toEqual(["hb-list", "hb-row"]);
  });

  it("finds spacing written as lengths instead of tokens", () => {
    const coverage = styleCoverage([
      rule(".a", "padding: var(--space-2) 0.6rem; margin: 0 auto; gap: var(--space-3);"),
      rule(".b", "margin-inline-start: -4px; row-gap: calc(var(--space-2) * 2); width: 12rem;"),
      rule(".c", "padding: 0px; column-gap: 1.5em !important;"),
    ]);
    expect(coverage.spacingLiterals).toEqual([
      { selector: ".a", property: "padding", value: "var(--space-2) 0.6rem" },
      { selector: ".b", property: "margin-inline-start", value: "-4px" },
      { selector: ".c", property: "column-gap", value: "1.5em" },
    ]);
  });

  it("splits declaration text without breaking strings or functions", () => {
    expect(
      parseDeclarations('content: "a; b"; background: url("x;y.svg"); grid-area: 1 / 2;'),
    ).toEqual([
      { property: "content", value: '"a; b"' },
      { property: "background", value: 'url("x;y.svg")' },
      { property: "grid-area", value: "1 / 2" },
    ]);
  });
});
