import "../../src/styles.css";
import type { UIControlsFixture } from "./ui-controls-fixture-api.js";
import { enhanceControls } from "../../src/ui/controls.js";
import { BrowserContributionRegistry } from "../../src/addons/browser-sdk.js";
import { GenerationScope } from "../../src/addons/generation-scope.js";
const root = document.querySelector<HTMLElement>("#fixture")!;
root.style.cssText = "max-width:52rem;margin:auto;padding:1rem";
root.innerHTML = `<h1>Shared UI</h1><form id="controls-form">
<div data-ui-toolbar>
<div data-ui-field data-ui-key="search"><label for="search-query">Search records</label><input id="search-query" type="search" data-ui="search" name="query"><small>Search this collection; filters apply together.</small></div>
<div data-ui-field data-ui-key="origin"><label for="origin">Origin</label><select id="origin" data-ui="combobox" name="origin" required>
<option value="">Choose…</option><option value="a">Álfheim</option><option value="b" disabled>Blocked</option><optgroup label="Disabled group" disabled><option value="c">Blocked group</option></optgroup><optgroup label="Hidden options" hidden><option value="secret">Hidden group</option></optgroup><option value="d" title="Mountain home">Dwarf</option><option value="e">Elf</option></select><small data-ui-help>Choose a saved origin.</small></div>
<label data-ui-field><span>Sort by</span><select name="sort"><option>Name</option><option>Recent</option></select></label></div>
<label data-ui-field><span>Notes</span><textarea name="notes" required minlength="3"></textarea><small data-ui-help>At least three characters.</small></label>
<fieldset><legend>Sources</legend><label data-ui-field><input type="checkbox" name="source" value="one">One</label><label data-ui-field><input type="checkbox" name="source" value="two">Two</label></fieldset>
<div data-ui-actions><button type="submit" data-ui-variant="primary">Apply filters</button><button type="reset">Reset</button><button type="button" id="pending" aria-busy="true">Saving…</button><button type="button" id="open-dialog">Open dialog</button></div>
<p id="result" data-ui-state="empty">Enter a query or select a filter.</p></form>
<dialog data-ui-dialog aria-label="Review choices"><h2>Review choices</h2><div data-ui-field><label for="nested-choice">Nested choice</label><select id="nested-choice" data-ui="combobox"><option>First</option><option>Second</option></select></div><button type="button" id="close-dialog">Close</button></dialog>
<div role="tablist" data-ui-tabs aria-label="Views"><button type="button" role="tab" id="view-one" aria-controls="panel-one" aria-selected="true">First view</button><button type="button" role="tab" id="view-two" aria-controls="panel-two" aria-selected="false" tabindex="-1">Second view</button></div>
<section id="panel-one" role="tabpanel" aria-labelledby="view-one">First content</section><section id="panel-two" role="tabpanel" aria-labelledby="view-two" hidden>Second content</section>`;
const queries: string[] = [], submissions: Record<string, FormDataEntryValue>[] = [];
let changes = 0, pendingClicks = 0;
const form = root.querySelector<HTMLFormElement>("form")!, select = form.querySelector<HTMLSelectElement>('[name="origin"]')!;
const controller = new AbortController();
let handle = enhanceControls(root, { signal: controller.signal });
root.addEventListener("codex-query", event => queries.push((event as CustomEvent<{ value: string }>).detail.value));
select.addEventListener("change", () => changes++);
form.addEventListener("submit", event => { event.preventDefault(); submissions.push(Object.fromEntries(new FormData(form))); });
root.querySelector("#pending")!.addEventListener("click", () => pendingClicks++);
const dialog = root.querySelector("dialog")!;
root.querySelector("#open-dialog")!.addEventListener("click", () => dialog.showModal());
root.querySelector("#close-dialog")!.addEventListener("click", () => dialog.close());
for (const tab of root.querySelectorAll<HTMLButtonElement>('[role="tab"]')) tab.addEventListener("click", () => {
 for (const item of root.querySelectorAll<HTMLButtonElement>('[role="tab"]')) { const active = item === tab; item.tabIndex = active ? 0 : -1; item.setAttribute("aria-selected", String(active)); root.querySelector<HTMLElement>("#" + item.getAttribute("aria-controls"))!.hidden = !active; }
});
const fixture: UIControlsFixture = {
 queries, submissions, get changes() { return changes; }, get pendingClicks() { return pendingClicks; },
 refresh: () => handle.refresh(), dispose: () => handle.dispose(), abort: () => controller.abort(),
 reattach: () => { handle = enhanceControls(root); },
 theme: (value: string) => { document.documentElement.dataset["theme"] = value; },
 locale: (value: string) => { root.lang = value; handle.refresh(); },
 options: (count: number) => { select.replaceChildren(...Array.from({ length: count }, (_, index) => new Option("Option " + index, String(index)))); handle.refresh(); },
 state: (value: string) => { select.dataset["uiOptionsState"] = value; handle.refresh(); },
 disabled: (value: boolean) => { select.disabled = value; handle.refresh(); },
 value: (value: string) => { select.value = value; handle.refresh(); },
 async sdk() {
   handle.dispose();
   const scope = new GenerationScope("ui-fixture");
   const registry = new BrowserContributionRegistry();
   const session = registry.open({ addonId: "ui-fixture", addonVersion: "1.0.0", generationId: "a".repeat(64), mode: "integrated", entryUrl: "/fixture.js", styleUrls: [], sandbox: [], dependencies: [], capabilities: ["ui.controls.v1"], permissions: [], contributions: [] }, scope);
   session.context.ui.enhance(root);
   return () => session.dispose();
 },
};
Object.assign(window, { uiControlsFixture: fixture });
