import assert from "node:assert/strict";
import { test } from "node:test";
import { addonStyleProblems } from "../contracts/addons/v3/style-check.mts";
import { controlsFile, styleProblems, tokenFile } from "./check-styles.mts";

const tokens = ":root { --bg-base: #141008; --text-sm: 0.85rem; --z-toast: 150; }";
const controls = ":root { --ui-text: var(--bg-base); }";
const published = ["--bg-base", "--text-sm", "--z-toast", "--ui-text"];

function problems(css: string, scripts: string[] = [], list = published): string[] {
  return styleProblems(
    new Map([
      [tokenFile, tokens],
      [controlsFile, controls],
      ["frontend/src/styles/page.css", css],
    ]),
    scripts,
    list,
  ).map(({ file, line, message }) => `${file.split("/").pop()}:${line}: ${message}`);
}

void test("token-based styles pass", () => {
  assert.deepEqual(
    problems(
      `.page {
  color: var(--bg-base);
  font: 600 var(--text-sm)/1.4 var(--font-ui, serif);
  box-shadow: 0 2px 8px rgb(0 0 0 / 40%), 0 0 1px rgba(255, 255, 255, 0.1);
  z-index: 3;
  z-index: var(--z-toast);
  font-size: calc(11px * var(--zoom));
  font-size: 0.6em;
  transition: opacity var(--duration-base);
  background: rgba(var(--accent-rgb), 0.2);
  border-color: var(--entity);
}
a:hover { color: var(--bg-base); }`,
      ['el.style.setProperty("--entity", c)', "html`<i style=${`--zoom:${z}`}>`"],
    ).filter((problem) => !/--(font-ui|duration-base|accent-rgb) is not defined/.test(problem)),
    [],
  );
});

void test("literals outside the tokens are reported with their line", () => {
  assert.deepEqual(
    problems(`.page {
  color: #c8a040;
  background: rgba(28, 20, 8, 0.55);
  font-size: 0.8rem;
  font: 600 2rem/1.2 var(--font-title);
  z-index: 500;
  transition: opacity 0.15s;
  --local: hsl(10 20% 30%);
  color: var(--bg-hover);
}`),
    [
      "page.css:2: colour #c8a040 belongs in frontend/src/styles/tokens.css",
      "page.css:3: colour rgba(28, 20, 8, 0.55) belongs in frontend/src/styles/tokens.css",
      "page.css:4: font-size 0.8rem: use a --text-* token or a relative size",
      "page.css:5: font 600 2rem/1.2 var(--font-title): use a --text-* token or a relative size",
      "page.css:6: z-index 500: use a --z-* layer above 10",
      "page.css:7: transition opacity 0.15s: use a --duration-* token",
      "page.css:8: colour hsl(10 20% 30%) belongs in frontend/src/styles/tokens.css",
      "page.css:5: --font-title is not defined",
      "page.css:9: --bg-hover is not defined",
    ],
  );
});

void test("comments are ignored and keep line numbers", () => {
  assert.deepEqual(problems("/* color: #fff;\n */\n.page { color: #fff; }"), [
    "page.css:3: colour #fff belongs in frontend/src/styles/tokens.css",
  ]);
});

void test("the published list must match the tokens exactly", () => {
  assert.deepEqual(problems("", [], [...published.slice(1), "--retired"]), [
    "design-tokens.json:1: --bg-base is not listed",
    "design-tokens.json:1: --retired is not a token",
  ]);
});

void test("add-ons use host tokens by name and name their own values once", () => {
  const styles = new Map([
    [
      "src/sheet.css",
      `.sheet {
  --sheet-gold: #c8a040;
  --space-5: 1.5rem;
  color: var(--text-light, #d4c49a);
  background: var(--sheet-gold);
  border-color: var(--bg-hover);
  box-shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 0 4px #222;
  font-size: 0.62rem;
  z-index: 40;
  width: var(--sheet-width);
}`,
    ],
  ]);
  assert.deepEqual(
    addonStyleProblems(
      styles,
      ["el.style.setProperty('--sheet-width', w)"],
      ["--text-light", "--space-5"],
    ).map(({ line, message }) => `${line}: ${message}`),
    [
      "3: --space-5 is a host token; do not redefine it",
      "4: --text-light needs no fallback: the host always defines it",
      "4: colour #d4c49a: use a host token or name it once as your own property",
      "6: --bg-hover is not a host token or defined here",
      "7: colour #222: use a host token or name it once as your own property",
      "8: font-size 0.62rem: use a --text-* token or a relative size",
      "9: z-index 40: use a --z-* layer above 10",
    ],
  );
});
