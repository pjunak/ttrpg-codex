// Style rules shared by the host and integrated add-ons. Add-ons copy this file
// and design-tokens.json unchanged (the first-party add-ons keep them in
// tools/codex/) and run it over their sources:
//   node tools/codex/style-check.mts src
// It reports host tokens that are redefined, given fallbacks or misspelled,
// colour literals outside an add-on's own custom properties, and type sizes,
// stacking layers and transition durations that bypass the host's scales.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface StyleProblem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** Declarations with comments removed; line numbers refer to the source. */
export function declarations(css: string): { property: string; value: string; line: number }[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found = [];
  for (const match of source.matchAll(
    /(^|[;{\s])(-{0,2}[a-z][a-z0-9-]*)\s*:\s*([^;{}]+)(?=;|})/gi,
  )) {
    const offset = match.index + match[1]!.length;
    found.push({
      property: match[2]!.toLowerCase(),
      value: match[3]!.trim(),
      line: source.slice(0, offset).split("\n").length,
    });
  }
  return found;
}

/** Custom properties a TypeScript source sets inline (`--name:` or setProperty). */
export function scriptProperties(source: string): string[] {
  return [...source.matchAll(/(--[a-z][a-z0-9-]*)(?=:|["'`],)/g)].map((match) => match[1]!);
}

/** Every var() in a value, with whether it carries a fallback. */
export function references(value: string): { name: string; fallback: boolean }[] {
  return [...value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)].map((match) => ({
    name: match[1]!,
    fallback: match[2] !== undefined,
  }));
}

// Black and white shades are theme-neutral shadows, scrims and highlights.
const neutral = /^(?:rgba?)\(\s*(?:0[\s,]+0[\s,]+0|255[\s,]+255[\s,]+255)\b/;

/** Colour literals in a value that a theme would have to change. */
export function themedColours(value: string): string[] {
  return (value.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi) ?? []).filter(
    (colour) => !/var\(/.test(colour) && !neutral.test(colour),
  );
}

/** Literal type sizes, unnamed page layers and literal transition durations. */
export function scaleProblems(property: string, value: string): string[] {
  const problems = [];
  // A size may scale a token or a canvas zoom (calc with var), but not stand alone.
  const size = value.replace(/var\(--(?:font-[a-z]+|ui-font)\)|["'][^"']*["']/g, "");
  if (
    /^font(?:-size)?$/.test(property) &&
    /(?:^|[\s/(,])\d*\.?\d+(?:rem|px)\b/.test(` ${size}`) &&
    !size.includes("var(")
  )
    problems.push(`${property} ${value}: use a --text-* token or a relative size`);
  if (property === "z-index" && /^-?\d+$/.test(value) && Math.abs(Number(value)) > 10)
    problems.push(`z-index ${value}: use a --z-* layer above 10`);
  if (/^(?:transition|transition-duration)$/.test(property) && /\d(?:m?s)\b/.test(value))
    problems.push(`${property} ${value}: use a --duration-* token`);
  return problems;
}

/** An add-on's stylesheets use host tokens by name and name their own values once. */
export function addonStyleProblems(
  styles: ReadonlyMap<string, string>,
  scripts: readonly string[],
  tokens: readonly string[],
): StyleProblem[] {
  const host = new Set(tokens);
  const own = new Set(scripts.flatMap(scriptProperties));
  for (const css of styles.values())
    for (const { property } of declarations(css)) if (property.startsWith("--")) own.add(property);
  const problems: StyleProblem[] = [];
  for (const [file, css] of styles)
    for (const { property, value, line } of declarations(css)) {
      const problem = (message: string) => problems.push({ file, line, message });
      if (host.has(property)) problem(`${property} is a host token; do not redefine it`);
      for (const { name, fallback } of references(value))
        if (host.has(name)) {
          if (fallback) problem(`${name} needs no fallback: the host always defines it`);
        } else if (!own.has(name)) problem(`${name} is not a host token or defined here`);
      if (!property.startsWith("--")) {
        for (const colour of themedColours(value))
          problem(`colour ${colour}: use a host token or name it once as your own property`);
        for (const message of scaleProblems(property, value)) problem(message);
      }
    }
  return problems;
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:css|ts)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (directory === undefined) {
    console.error("usage: node style-check.mts <source directory>");
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const tokens = (
    JSON.parse(readFileSync(join(here, "design-tokens.json"), "utf8")) as { tokens: string[] }
  ).tokens;
  const files = sources(directory);
  const styles = new Map(
    files
      .filter((file) => file.endsWith(".css"))
      .map((file) => [relative(process.cwd(), file), readFileSync(file, "utf8")]),
  );
  const scripts = files.filter((file) => file.endsWith(".ts")).map((f) => readFileSync(f, "utf8"));
  const problems = addonStyleProblems(styles, scripts, tokens);
  if (problems.length > 0) {
    for (const { file, line, message } of problems) console.error(`${file}:${line}: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`Style check passed: ${styles.size} stylesheets use the host's design tokens.`);
  }
}
