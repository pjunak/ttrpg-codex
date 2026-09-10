import type { APIRequestContext } from 'playwright';
import { createHash } from 'node:crypto';
import { zip, installReviewedPackage } from './installed-graph-fixture.mts';

export function installTimelinePackage(request: APIRequestContext, csrf: string, { id, mode, read = true, version = '1.0.0' }: {
  id: string; mode: string; read?: boolean; version?: string;
}) {
  const slots = ['timeline:toolbar', 'timeline:column:header', 'timeline:column:footer', 'timeline:card:extra'];
  const permissions = read ? [{ id: 'core.data.read', resources: ['events'], reason: 'Identify visible timeline events.' }] : [];
  const manifest = { packageFormat: 1, id, name: 'Timeline fixture', version,
    compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, capabilities: { required: ['ui.contributions'], optional: [] },
    permissions, runtime: { ui: { mode, entry: 'web/index.js' } }, contributions: slots.map((slot, index) => ({
      id: `slot-${index}`, surface: 'slot', label: slot, config: { slot, contractVersion: 1 }, roles: index === 2 ? ['dm'] : ['dm', 'player'], requires: ['ui.contributions'],
    })) };
  const entry = `export function activate(context) {
    const tag = 'fixture-timeline-' + context.addon.id + '-' + context.addon.generation.slice(0, 8);
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
      constructor() {
        super(); this.attachShadow({ mode: 'open' });
        const style = document.createElement('style'); style.textContent = ':host{display:block;color:#c9ab65;font:12px sans-serif}input{width:90%;box-sizing:border-box;background:transparent;color:inherit;border:1px solid #806625;padding:3px}output{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}button{color:inherit;background:transparent;border:1px solid #806625}';
        this.status = document.createElement('output');
        this.input = document.createElement('input'); this.input.setAttribute('aria-label', 'Widget draft');
        this.button = document.createElement('button'); this.button.textContent = 'Widget action';
        this.button.onclick = () => { this.input.value = 'Action ran'; };
        this.shadowRoot.append(style, this.status, this.input, this.button);
        this.connections = 0;
      }
      connectedCallback() { this.connections++; this.renderContext(); }
      set codexContribution(value) { this.context = value; this.renderContext(); }
      renderContext() {
        const value = this.context?.host; if (!value) return;
        this.status.textContent = JSON.stringify({ ...value, connections: this.connections, version: ${JSON.stringify(version)} });
        this.dataset.slot = value.slot;
      }
    });
    for (const declaration of context.ui.declarations()) context.ui.bind(declaration.id, { kind: 'element', tag });
  }`;
  const files: Record<string, string | Buffer> = { 'addon.json': JSON.stringify(manifest), 'web/index.js': entry };
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')])) });
  return installReviewedPackage(request, csrf, id, zip(files), permissions);
}
