// Contribution-demo addon. Shows the data-driven contribution model: an addon
// injects its own CONTENT and KINDS into existing core surfaces, with no core
// rewrites — purely via host.register* + the consumer's readback call-sites.
//
// The host dynamically imports this from /addons/demo-contrib/<hash>/entry.js
// and calls the default export with a permission-scoped `host` facade. Build
// HTML only with host.h helpers and design-system tokens (var(--…)) so the app
// stays CSP-clean and re-skins with the theme switcher.

export default function register(host) {
  const { esc } = host.h;

  // ── Timeline session-card slot (perm: ui:slot:timeline) ──────────
  // `Addons.slotContent('timeline:card:extra', {event, sitting, role})` is
  // called by timeline.js per card. Return {html} | html-string | null.
  host.registerSlot('timeline:card:extra', (ctx) => {
    const e = ctx.event || {};
    const cast   = (e.characters || []).length;
    const places = (e.locations  || []).length;
    if (!cast && !places) return null;
    const chip = (txt, accent) =>
      `<span style="padding:.05rem .4rem;border-radius:var(--radius-pill);font-size:var(--text-xs);`
      + (accent
          ? `background:rgba(var(--accent-gold-rgb),.18);color:var(--accent-gold)`
          : `background:var(--bg-raised);color:var(--text-muted)`)
      + `">${esc(txt)}</span>`;
    return { html:
      `<div style="display:flex;gap:.35rem;margin-top:.35rem">`
      + (cast   ? chip('🎭 ' + cast, true)   : '')
      + (places ? chip('📍 ' + places, false) : '')
      + `</div>` };
  });

  // ── Timeline column-footer slot (perm: ui:slot:timeline) ─────────
  // Called per session column with {sitting, events, label, role}.
  host.registerSlot('timeline:column:footer', (ctx) => {
    const n = (ctx.events || []).length;
    if (!n) return null;
    return { html:
      `<div style="text-align:center;font-size:var(--text-xs);color:var(--text-muted);padding:.3rem 0">`
      + `${n} ${n === 1 ? 'event' : 'events'}</div>` };
  });

  // ── A custom mind-map CONNECTION kind (perm: kinds:connections) ───
  // Pure DATA (no functions). The host namespaces the id to
  // `demo-contrib:rivalry`. It merges into Store.getKinds('connections'),
  // so it appears in the relationship editor's type dropdown AND renders as
  // a styled edge in the mind map — no cloudmap/editor code changed.
  host.registerConnectionKind({
    id: 'rivalry', label: 'rivalry',
    color: '#B5651D', style: 'dashed',
    dirs: ['from', 'to', 'both'], target: 'character',
  });

  // ── A custom character STATUS kind via the generic registerKind ───
  // (perm: kinds:statuses). registerKind(domain, def) is the unified seam
  // for every pure-DATA enum domain (connections/statuses/priorities/
  // attitudes/genders/pinTypes). The host namespaces the id to
  // `demo-contrib:petrified`; it merges into Store.getKinds('statuses') →
  // Store.getStatusMap(), so it renders wherever a status label/colour does
  // (cloudmap / wiki / map) — no core code changed.
  host.registerKind('statuses', { id: 'petrified', label: 'Petrified', color: '#78909C', icon: '🗿' });

  // ── A mind-map NODE kind + a contributor that injects it (3b/3c) ──
  // (perms: kinds:graph, graph:contribute). The node kind is a descriptor
  // carrying render fns; the host namespaces its id to `<addonId>:marker`.
  // cardHTML must emit a `.cm-cloud` card (the cloudmap positions/styles it
  // exactly like a built-in node). Use design tokens for colour.
  const MARKER = host.id + ':marker';
  host.registerNodeKind({
    id: 'marker', shape: 'rect', height: () => 96,
    cardHTML: (node) => {
      const label = (node && node.label) || 'Addon node';
      return `<div class="cm-cloud" data-id="${esc(node.id)}" data-type="${esc(node.type)}"`
        + ` style="--cc:var(--color-mystery); --cw:168px">`
        + `<div class="cm-strip">🧩 ${esc(host.id)}</div>`
        + `<div class="cm-name">${esc(label)}</div>`
        + `<div class="cm-divider"></div>`
        + `<div class="cm-fact cm-dim">injected node</div></div>`;
    },
    searchText: () => 'addon marker demo',
  });
  // Inject one marker node into the built-in "vztahy" (relationships) view.
  host.registerGraphContributor('vztahy', () => ({
    nodes: [{ id: MARKER + ':1', type: MARKER, label: 'Hello from ' + host.id }],
    edges: [],
  }));
}
