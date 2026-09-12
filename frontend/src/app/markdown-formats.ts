export const markdownColors = ["gold", "danger", "info", "success", "mystery", "muted"] as const;
export const markdownHighlights = ["gold", "danger", "info", "success", "mystery"] as const;
export const markdownEffects = ["underline", "glow", "small-caps", "spoiler"] as const;
export const markdownSizes = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48] as const;
const markdownFonts = ["serif", "sans", "mono"] as const;
const markdownAlignments = ["left", "center", "right"] as const;

export interface MarkdownFormat {
  readonly tag: "span" | "mark" | "sup" | "sub";
  readonly mark: string;
  readonly value?: string;
  readonly className?: string;
}

const formats: Readonly<Record<string, readonly string[]>> = {
  color: markdownColors, highlight: markdownHighlights, effect: markdownEffects,
  size: markdownSizes.map(String), font: markdownFonts, align: markdownAlignments,
};

export function parseMarkdownFormat(raw: string): MarkdownFormat | undefined {
  if (/^<sup>$/iu.test(raw)) return { tag: "sup", mark: "sup" };
  if (/^<sub>$/iu.test(raw)) return { tag: "sub", mark: "sub" };
  const match = /^<(span|mark)\s+data-md-(color|highlight|effect|size|font|align)=["']([a-z0-9-]+)["']\s*>$/iu.exec(raw);
  if (!match) return undefined;
  const [, tag, kind, value] = match;
  if (!kind || !value || !formats[kind]?.includes(value) || (tag === "mark") !== (kind === "highlight")) return undefined;
  return { tag: tag as "span" | "mark", mark: kind, value, className: `md-${kind}-${value}` };
}

export function markdownFormatClose(tokens: readonly { readonly type: string; readonly raw: string }[], start: number, tag: string): number {
  let depth = 1;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.type !== "html") continue;
    if (new RegExp(`^<${tag}(?:\\s|>)`, "iu").test(token.raw.trim())) depth++;
    if (new RegExp(`^</${tag}\\s*>$`, "iu").test(token.raw.trim())) depth--;
    if (depth === 0) return index;
  }
  return -1;
}
