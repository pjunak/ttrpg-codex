// Keeps the browser app on its design tokens (frontend/src/styles/tokens.css):
// colours are named only there, type sizes, stacking layers and transition
// durations come from its scales, every var() names a defined property, and
// contracts/addons/v3/design-tokens.json lists exactly the published tokens.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const tokenFile = "frontend/src/styles/tokens.css";
export const controlsFile = "frontend/src/ui/controls.css";
export const publishedTokensFile = "contracts/addons/v3/design-tokens.json";
/** Mind Palace keeps its own colours until its design is decided (docs/BACKLOG.md). */
const colourExceptions = new Set(["frontend/src/styles/relationship-graph.css"]);

export interface StyleProblem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

// Black and white shades are theme-neutral shadows, scrims and highlights.
const neutral = /^(?:rgba?)\(\s*(?:0[\s,]+0[\s,]+0|255[\s,]+255[\s,]+255)\b/;
const colourLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;
const lengthLiteral = /(?:^|[\s/(,])\d*\.?\d+(?:rem|px)\b/;

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

export function styleProblems(
  styles: ReadonlyMap<string, string>,
  scripts: readonly string[],
  publishedTokens: readonly string[],
): StyleProblem[] {
  const problems: StyleProblem[] = [];
  const defined = new Set(scripts.flatMap(scriptProperties));
  const used: { file: string; line: number; name: string }[] = [];
  for (const [file, css] of styles) {
    const isTokens = file === tokenFile;
    for (const { property, value, line } of declarations(css)) {
      const problem = (message: string) => problems.push({ file, line, message });
      if (property.startsWith("--")) defined.add(property);
      for (const match of value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi))
        used.push({ file, line, name: match[1]! });
      if (isTokens) continue;
      if (!colourExceptions.has(file))
        for (const colour of value.match(colourLiteral) ?? [])
          if (!/var\(/.test(colour) && !neutral.test(colour))
            problem(`colour ${colour} belongs in ${tokenFile}`);
      if (property.startsWith("--")) continue;
      // A size may scale a token or a canvas zoom (calc with var), but not stand alone.
      const size = value.replace(/var\(--(?:font-[a-z]+|ui-font)\)|["'][^"']*["']/g, "");
      if (
        /^font(?:-size)?$/.test(property) &&
        lengthLiteral.test(` ${size}`) &&
        !size.includes("var(")
      )
        problem(`${property} ${value}: use a --text-* token or a relative size`);
      if (property === "z-index" && /^-?\d+$/.test(value) && Math.abs(Number(value)) > 10)
        problem(`z-index ${value}: use a --z-* layer above 10`);
      if (/^(?:transition|transition-duration)$/.test(property) && /\d(?:m?s)\b/.test(value))
        problem(`${property} ${value}: use a --duration-* token`);
    }
  }
  for (const { file, line, name } of used)
    if (!defined.has(name)) problems.push({ file, line, message: `${name} is not defined` });
  const tokens = new Set(
    [tokenFile, controlsFile].flatMap((file) =>
      declarations(styles.get(file) ?? "")
        .filter(({ property }) => property.startsWith("--"))
        .map(({ property }) => property),
    ),
  );
  const listed = new Set(publishedTokens);
  for (const name of tokens)
    if (!listed.has(name))
      problems.push({ file: publishedTokensFile, line: 1, message: `${name} is not listed` });
  for (const name of listed)
    if (!tokens.has(name))
      problems.push({ file: publishedTokensFile, line: 1, message: `${name} is not a token` });
  return problems;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${root.replaceAll("\\", "/").replace(/\/$/, "")}`,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "frontend/src",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  )
    .split("\0")
    .filter(Boolean);
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");
  const styles = new Map(
    files.filter((path) => path.endsWith(".css")).map((path) => [path, read(path)]),
  );
  const scripts = files.filter((path) => path.endsWith(".ts")).map(read);
  const published = (JSON.parse(read(publishedTokensFile)) as { tokens: string[] }).tokens;
  const problems = styleProblems(styles, scripts, published);
  if (problems.length > 0) {
    for (const { file, line, message } of problems) console.error(`${file}:${line}: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`Style check passed: ${styles.size} stylesheets use the design tokens.`);
  }
}
