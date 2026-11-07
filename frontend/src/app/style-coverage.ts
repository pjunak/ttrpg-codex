/** One style rule as plain data, so the analysis does not depend on the DOM. */
export interface StyleRule {
  readonly selector: string;
  readonly declarations: readonly StyleDeclaration[];
}

export interface StyleDeclaration {
  readonly property: string;
  readonly value: string;
}

/** What a rule restyles: native controls the host styles, or a host `ui` primitive. */
export type StyleOverrideKind = "buttons" | "fields" | "selects" | "primitives";

export const styleOverrideKinds: readonly StyleOverrideKind[] = Object.freeze([
  "buttons",
  "fields",
  "selects",
  "primitives",
]);

export interface StyleOverride {
  readonly kind: StyleOverrideKind;
  readonly selector: string;
}

export interface SpacingLiteral {
  readonly selector: string;
  readonly property: string;
  readonly value: string;
}

/** How much one add-on's stylesheet adds on top of the shared controls and tokens. */
export interface StyleCoverage {
  readonly rules: number;
  /** Distinct class names the add-on styles, excluding the host's `ui-*` classes. */
  readonly ownClasses: readonly string[];
  /** Rules that restyle a shared control, each counted once under its first kind. */
  readonly overrides: readonly StyleOverride[];
  /** Spacing declarations with a length literal instead of a `--space-*` token. */
  readonly spacingLiterals: readonly SpacingLiteral[];
}

const kindPatterns: Readonly<Record<StyleOverrideKind, RegExp>> = Object.freeze({
  primitives: /\.ui-[\w-]|\[\s*data-ui[\w-]*/,
  buttons: typeSelector("button"),
  selects: typeSelector("select"),
  fields: typeSelector("input|textarea"),
});
const kindOrder: readonly StyleOverrideKind[] = ["buttons", "selects", "fields", "primitives"];
const spacingProperty =
  /^(?:(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|(?:row-|column-)?gap)$/;
const lengthLiteral =
  /(?<![\w.-])-?(\d*\.?\d+)(?:px|rem|em|ch|ex|vh|vw|vmin|vmax|lh|rlh)(?![\w-])/g;

export function styleCoverage(rules: readonly StyleRule[]): StyleCoverage {
  const ownClasses = new Set<string>();
  const overrides: StyleOverride[] = [];
  const spacingLiterals: SpacingLiteral[] = [];
  for (const rule of rules) {
    const selector = withoutStrings(rule.selector);
    for (const match of withoutAttributes(selector).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      const name = match[1]!;
      if (!name.startsWith("ui-")) ownClasses.add(name);
    }
    const kind = kindOrder.find((candidate) => kindPatterns[candidate].test(selector));
    if (kind !== undefined) overrides.push({ kind, selector: rule.selector });
    for (const { property, value } of rule.declarations) {
      if (spacingProperty.test(property) && hasLengthLiteral(value))
        spacingLiterals.push({ selector: rule.selector, property, value });
    }
  }
  return {
    rules: rules.length,
    ownClasses: [...ownClasses].sort(),
    overrides,
    spacingLiterals,
  };
}

/** Splits a serialized declaration block (`CSSStyleDeclaration.cssText`) into declarations. */
export function parseDeclarations(cssText: string): readonly StyleDeclaration[] {
  const declarations: StyleDeclaration[] = [];
  let depth = 0,
    quote = "",
    start = 0;
  const push = (end: number): void => {
    const text = cssText.slice(start, end);
    const colon = text.indexOf(":");
    if (colon > 0) {
      const property = text.slice(0, colon).trim().toLowerCase();
      const value = text
        .slice(colon + 1)
        .replace(/!important\s*$/i, "")
        .trim();
      if (property !== "" && value !== "") declarations.push({ property, value });
    }
    start = end + 1;
  };
  for (let index = 0; index < cssText.length; index++) {
    const char = cssText[index]!;
    if (quote !== "") {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) push(index);
  }
  push(cssText.length);
  return declarations;
}

function hasLengthLiteral(value: string): boolean {
  const literal = value.replace(/var\(\s*--[\w-]+\s*\)/g, "");
  return [...literal.matchAll(lengthLiteral)].some((match) => Number(match[1]) !== 0);
}

/** A type selector, not part of a class, attribute value or pseudo-element name. */
function typeSelector(names: string): RegExp {
  return new RegExp(`(?:^|[\\s>+~(,&])(?:${names})(?![\\w-])`, "i");
}

function withoutStrings(selector: string): string {
  return selector.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

function withoutAttributes(selector: string): string {
  return selector.replace(/\[[^\]]*\]/g, "");
}
