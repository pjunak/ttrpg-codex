import type { APIRequestContext } from 'playwright';
import { createHash } from 'node:crypto';
import { zip, installReviewedPackage } from './installed-graph-fixture.mts';

export const dmToolsPermissions = [{ id: 'core.data.read', resources: ['characters', 'factions', 'locations', 'mysteries', 'artifacts', 'events'], reason: 'Choose visible campaign records for planning references and consequence targets.' }];

export function installDmPackage(request: APIRequestContext, csrf: string, { id, mode = 'integrated', version = '1.0.0', failure = '', slot = true, edits = false, references = false, live = false, ruleDetails = false }: {
  id: string; mode?: string; version?: string; failure?: string; slot?: boolean; edits?: boolean; references?: boolean; live?: boolean; ruleDetails?: boolean;
}) {
  const contributions = [
    { id: 'tool', surface: 'route', label: 'Fixture planner', roles: references ? ['dm', 'player'] : ['dm'], config: { path: 'planner' } },
    { id: 'sidebar', surface: 'sidebar', label: 'Fixture planner', roles: ['dm'], config: { route: 'tool' } },
    // Deliberately broader declaration: the host still owns DM panel authorization.
    ...(slot ? [{ id: 'dashboard', surface: 'slot', label: 'Fixture dashboard', roles: ['dm', 'player'], config: { contractVersion: 1, slot: 'dm:dashboard' } }] : []),
  ];
  const manifest = { packageFormat: 1, id, name: 'DM panel fixture', version,
    compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, capabilities: { required: ['ui.contributions', ...(ruleDetails ? ['ui.rule-details'] : [])], optional: [] },
    permissions: references ? [{ id: 'core.data.read', resources: ['events'], reason: 'Choose event targets.' }] : [], runtime: { ui: { mode, entry: 'web/index.js' } }, contributions };
  Object.assign(manifest, live ? { collections: [{ id: 'notes', keyed: true, visibility: 'dm', schema: 'contracts/notes.json', schemaVersion: '1.0.0' }] } : {});
  const entry = `export function activate(context) {
    if (${JSON.stringify(failure)} === 'activation') throw new Error('Private fixture error must not be shown');
    const tag = 'fixture-dm-' + context.addon.id + '-' + context.addon.generation.slice(0, 8);
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
      set codexContribution(value) {
        this.context = value;
        if (${JSON.stringify(failure)} === 'mount' && value.contribution.id === 'dashboard') throw new Error('Private fixture mount error');
        this.reflectContext();
      }
      connectedCallback() {
        const title = document.createElement('h2'); title.textContent = this.context.contribution.id === 'dashboard' ? 'Fixture DM workspace ${version}' : 'Fixture planner page';
        const input = document.createElement('input'); input.setAttribute('aria-label', 'Fixture notes'); input.style.maxWidth = '100%';
        if (${JSON.stringify(edits)}) input.addEventListener('input', () => this.context.edits.set({ dirty: input.value !== '', saving: false }));
        const output = document.createElement('output'); output.setAttribute('aria-label', 'Fixture context');
        this.replaceChildren(title, input, output); this.reflectContext();
        if (${JSON.stringify(ruleDetails)}) {
          const details = document.createElement('button'); details.textContent = 'Inspect saved rule';
          details.onclick = () => context.ui.showRuleDetails({ label: 'Synthetic source rule', reference: {kind:'rule',id:'synthetic-rule'}, summary: 'Saved definition from the selected revision.', explanation: {label:'Synthetic total',value:12,formula:'10 + 2',terms:[{label:'Base',value:10},{label:'Bonus',value:2}],sources:[]}, savedSources:[{reference:{kind:'rule',id:'synthetic-rule'},name:'Synthetic source rule',summary:'Saved definition',hash:'${'a'.repeat(64)}'}] });
          this.append(details);
        }
        if (${JSON.stringify(live)}) {
          const events = document.createElement('output'); events.setAttribute('aria-label', 'Data changes'); events.textContent = '[]'; this.append(events);
          const controller = new AbortController(), seen = [];
          this.stopChanges = context.data.subscribe(change => { seen.push(change); events.textContent = JSON.stringify(seen); }, { signal: controller.signal });
          const stop = document.createElement('button'); stop.textContent = 'Stop changes'; stop.onclick = () => controller.abort(); this.append(stop);
        }
      }
      disconnectedCallback() { this.stopChanges?.(); }
      reflectContext() { const output = this.querySelector('output'); if (output) output.textContent = JSON.stringify(this.context.host); }
    });
    for (const declaration of context.ui.declarations()) if (declaration.surface !== 'sidebar') context.ui.bind(declaration.id, { kind: 'element', tag });
  }`;
  const files: Record<string, string | Buffer> = { 'addon.json': JSON.stringify(manifest), 'web/index.js': entry };
  if (live) files['contracts/notes.json'] = JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false, required: ['text'] });
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')])) });
  return installReviewedPackage(request, csrf, id, zip(files), manifest.permissions);
}
