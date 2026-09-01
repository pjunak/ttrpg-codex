import { existsSync, readFileSync } from "node:fs";

const backlogPath = new URL("../docs/BACKLOG.md", import.meta.url);
const statusPath = new URL("../frontend/src/rewrite-status.ts", import.meta.url);
const startMarker = "<!-- product-parity-gates:start -->";
const endMarker = "<!-- product-parity-gates:end -->";
const backlog = readFileSync(backlogPath, "utf8");
const start = backlog.indexOf(startMarker);
const end = backlog.indexOf(endMarker);

if (start < 0 || end <= start) {
  console.error("Release blocked: docs/BACKLOG.md does not contain the product-parity gate markers.");
  process.exit(1);
}

const gateSection = backlog.slice(start + startMarker.length, end);
const gates = gateSection.match(/^- \[[ x]\] .+$/gmu) ?? [];
const incomplete = gates.filter((gate) => gate.startsWith("- [ ]"));
const blockers = [];

if (gates.length === 0) {
  blockers.push("the product-parity gate contains no checklist items");
}
if (incomplete.length > 0) {
  blockers.push(`${incomplete.length} product-parity checklist item(s) remain incomplete`);
}
if (existsSync(statusPath)) {
  blockers.push("the development-only rewrite status page is still installed");
}

if (blockers.length > 0) {
  console.error("Release blocked:");
  for (const blocker of blockers) {
    console.error(`- ${blocker}`);
  }
  process.exit(1);
}

console.log(`Release readiness passed (${gates.length} product-parity gates complete).`);
