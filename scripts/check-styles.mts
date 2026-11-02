// Keeps the browser app on its design tokens (frontend/src/styles/tokens.css):
// colours are named only there, type sizes, stacking layers and transition
// durations come from its scales, every var() names a defined property, and
// contracts/addons/v3/design-tokens.json lists exactly the published tokens.
// The rules shared with add-ons live in contracts/addons/v3/style-check.mts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declarations,
  references,
  scaleProblems,
  scriptProperties,
  themedColours,
  type StyleProblem,
} from "../contracts/addons/v3/style-check.mts";

export const tokenFile = "frontend/src/styles/tokens.css";
export const controlsFile = "frontend/src/ui/controls.css";
export const publishedTokensFile = "contracts/addons/v3/design-tokens.json";
/** Mind Palace keeps its own colours until its design is decided (docs/BACKLOG.md). */
const colourExceptions = new Set(["frontend/src/styles/relationship-graph.css"]);

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
      for (const { name } of references(value)) used.push({ file, line, name });
      if (isTokens) continue;
      if (!colourExceptions.has(file))
        for (const colour of themedColours(value))
          problem(`colour ${colour} belongs in ${tokenFile}`);
      if (!property.startsWith("--"))
        for (const message of scaleProblems(property, value)) problem(message);
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
