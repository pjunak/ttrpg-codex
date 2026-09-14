import { existsSync, readFileSync } from "node:fs";

const acceptancePath = new URL("../docs/rewrite/FEATURE_PARITY_AUDIT.md", import.meta.url);
const incompleteMarkerPath = new URL("../frontend/REWRITE_INCOMPLETE", import.meta.url);
const startMarker = "<!-- product-parity-gates:start -->";
const endMarker = "<!-- product-parity-gates:end -->";
const acceptance = readFileSync(acceptancePath, "utf8");
const start = acceptance.indexOf(startMarker);
const end = acceptance.indexOf(endMarker);

if (start < 0 || end <= start) {
  console.error("Release blocked: docs/rewrite/FEATURE_PARITY_AUDIT.md does not contain the product-parity gate markers.");
  process.exit(1);
}

const gateSection = acceptance.slice(start + startMarker.length, end);
const gates = gateSection.match(/^- \[[ x]\] .+$/gmu) ?? [];
const incomplete = gates.filter((gate) => gate.startsWith("- [ ]"));
const blockers = [];

if (gates.length === 0) {
  blockers.push("the product-parity gate contains no checklist items");
}
if (incomplete.length > 0) {
  blockers.push(`${incomplete.length} product-parity checklist item(s) remain incomplete`);
}
if (existsSync(incompleteMarkerPath)) {
  blockers.push("the rewrite-incomplete release marker is still installed");
}

if (blockers.length > 0) {
  console.error("Release blocked:");
  for (const blocker of blockers) {
    console.error(`- ${blocker}`);
  }
  process.exit(1);
}

console.log(`Release readiness passed (${gates.length} product-parity gates complete).`);
