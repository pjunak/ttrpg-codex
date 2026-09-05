import { LitElement, html, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import { emptyGraphFilter, graphEdgeGeometry, graphEdgeOffsets, graphNodeStates, graphZoomLevels, initialGraphPositions,
  parseGraphFilter, parseGraphPositions, stepGraphZoom, validCoordinate, wrapGraphLabel,
  type CampaignGraph, type GraphBox, type GraphFilter, type GraphNode, type GraphPoint } from "./campaign-graph.js";
import { UiLocalizationController } from "./ui-localization.js";
import { graphModes, graphPreferenceKeys, migrateGraphPositions, projectCampaignGraph, type GraphMode } from "./campaign-graph-modes.js";
import { GraphMotion } from "./campaign-graph-motion.js";

interface Gesture {
  readonly pointer: number; readonly key: string | undefined; readonly origin: GraphPoint;
  readonly before: GraphPoint; readonly capture: HTMLElement; moved: boolean;
}
export class CodexCampaignGraph extends LitElement {
  static override properties = {
    campaign: { attribute: false }, mode: { attribute: false }, positions: { state: true }, pan: { state: true }, zoom: { state: true },
    filters: { state: true }, hiddenFactions: { state: true }, query: { state: true }, focusId: { state: true },
    contextMenu: { state: true }, storageError: { state: true }, storageChanged: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  declare mode: GraphMode;
  declare private positions: ReadonlyMap<string, GraphPoint>;
  declare private pan: GraphPoint;
  declare private zoom: number;
  declare private filters: GraphFilter;
  declare private hiddenFactions: ReadonlySet<string>;
  declare private query: string;
  declare private focusId: string | undefined;
  declare private contextMenu: { readonly key: string; readonly x: number; readonly y: number } | undefined;
  declare private storageError: boolean;
  declare private storageChanged: boolean;
  #graph: CampaignGraph = { nodes: [], edges: [] };
  #nodeByKey = new Map<string, GraphNode>();
  #sizes = new Map<string, { width: number; height: number }>();
  #observer: ResizeObserver | undefined;
  #gesture: Gesture | undefined;
  #motion: GraphMotion | undefined;
  #motionMode: GraphMode = "relationships";
  #motionFrame: number | undefined;
  #motionTime: number | undefined;
  #motionAccumulator = 0;
  #reducedMotion: MediaQueryList | undefined;
  #suppressClickUntil = 0;
  #wheelDelta = 0;
  #fitPasses = 3;
  #fitCap = .8;
  #viewportSize: GraphPoint | undefined;
  #windowSize = "";
  #textMeasure: CanvasRenderingContext2D | null = null;
  #labelLayouts = new Map<string, { lines: readonly string[]; width: number }>();
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super(); this.campaign = undefined; this.mode = "relationships"; this.positions = new Map(); this.pan = { x: 0, y: 0 }; this.zoom = 1;
    this.filters = emptyGraphFilter(); this.hiddenFactions = new Set(); this.query = ""; this.focusId = undefined;
    this.contextMenu = undefined; this.storageError = false; this.storageChanged = false;
  }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("storage", this.#onStorage); window.addEventListener("blur", this.#onBlur);
    window.addEventListener("pagehide", this.#onBlur); document.addEventListener("visibilitychange", this.#onVisibility);
    this.#reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    this.#reducedMotion.addEventListener("change", this.#onMotionPreference);
    document.addEventListener("pointerdown", this.#dismissMenu);
    this.#textMeasure = document.createElement("canvas").getContext("2d");
    void document.fonts.ready.then(() => { if (this.isConnected) { this.#labelLayouts.clear(); this.requestUpdate(); } });
  }
  override disconnectedCallback(): void {
    this.#interruptMotion(); this.#observer?.disconnect(); this.#observer = undefined;
    window.removeEventListener("storage", this.#onStorage); window.removeEventListener("blur", this.#onBlur);
    window.removeEventListener("pagehide", this.#onBlur); document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#reducedMotion?.removeEventListener("change", this.#onMotionPreference);
    document.removeEventListener("pointerdown", this.#dismissMenu); super.disconnectedCallback();
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("campaign") || changed.has("mode")) {
      this.#interruptMotion();
      this.#graph = this.campaign === undefined ? { nodes: [], edges: [] } : projectCampaignGraph(this.campaign, this.mode);
      this.#nodeByKey = new Map(this.#graph.nodes.map(node => [node.key, node]));
      if (changed.has("mode")) {
        this.#sizes.clear(); this.#wheelDelta = 0; this.#suppressClickUntil = 0;
        this.focusId = undefined; this.contextMenu = undefined; this.query = ""; this.storageError = false; this.storageChanged = false;
        this.#readPreferences(); this.#scheduleFit(.8);
      }
      this.positions = initialGraphPositions(this.#graph, this.positions);
      if (!this.#graph.nodes.some(node => node.key === this.focusId)) this.focusId = undefined;
      if (!this.#graph.nodes.some(node => node.key === this.contextMenu?.key)) this.contextMenu = undefined;
    }
    if (changed.has("hiddenFactions")) this.#interruptMotion();
  }
  protected override updated(): void {
    if (!this.isConnected) return;
    const viewport = this.querySelector<HTMLElement>(".cm-viewport"); if (!viewport) return;
    if (!this.#observer) {
      this.#observer = new ResizeObserver(() => {
        const size = { x: viewport.clientWidth, y: viewport.clientHeight }, windowSize = `${innerWidth}:${innerHeight}`;
        if (this.#windowSize && this.#windowSize !== windowSize) this.#scheduleFit(this.#fitCap);
        else if (this.#viewportSize && (size.x !== this.#viewportSize.x || size.y !== this.#viewportSize.y)) {
          // Toolbar wrapping must not override an explicit zoom selection.
          this.pan = { x: this.pan.x + (size.x - this.#viewportSize.x) / 2, y: this.pan.y + (size.y - this.#viewportSize.y) / 2 };
        }
        this.#viewportSize = size; this.#windowSize = windowSize;
      });
      this.#observer.observe(viewport);
    }
    let resized = false;
    for (const element of this.querySelectorAll<HTMLElement>(".cm-node")) {
      const key = element.dataset["key"]!, width = element.offsetWidth, height = element.offsetHeight, before = this.#sizes.get(key);
      if (before?.width !== width || before?.height !== height) { this.#sizes.set(key, { width, height }); resized = true; }
    }
    if (this.#fitPasses > 0) { this.#fitPasses--; this.#fit(); }
    else if (resized) this.requestUpdate();
  }
  protected override render() {
    const filter = this.query.trim() ? { ...this.filters, values: [...this.filters.values, this.query.trim()] } : this.filters;
    const states = graphNodeStates(this.#graph, filter, this.hiddenFactions, this.focusId);
    const visible = this.#graph.nodes.filter(node => !states.get(node.key)?.hidden);
    const types = new Map(this.#graph.edges.map(edge => [edge.type, { label: edge.type, color: edge.color }]));
    // Custom labels belong to individual edges; the shared definition names the toggle.
    const definitions = this.campaign?.collections.find(collection => collection.name === "settings")?.records.find(record => record.key === "relationshipTypes")?.value;
    if (Array.isArray(definitions)) for (const definition of definitions) if (definition && typeof definition === "object" && "id" in definition && "label" in definition && typeof definition.id === "string" && typeof definition.label === "string") {
      const type = types.get(definition.id); if (type) types.set(definition.id, { ...type, label: definition.label });
    }
    const intrinsicLabels = { member: this.#ui.t("graph.member"), located_at: this.#ui.t("graph.locatedAt"), mysteryLink: this.#ui.t("graph.involved") };
    if (this.mode !== "relationships") for (const [key, label] of Object.entries(intrinsicLabels)) {
      const type = types.get(key); if (type) types.set(key, { ...type, label, color: key === "member" ? "#888888" : type.color });
    }
    const factions = new Map(this.#graph.nodes.filter(node => node.kind === "character" || node.kind === "faction")
      .map(node => [node.faction, { name: node.factionName, color: node.color, badge: node.badge }]));
    const detail = this.zoom < .45 ? "overview" : this.zoom < .6 ? "compact" : this.zoom < 1 ? "condensed" : "full";
    const typeScale = this.zoom <= 1 ? 1 : Math.floor((this.zoom + Number.EPSILON) / .25) * .25;
    return html`<section class="cm-shell" aria-label=${this.#ui.t("graph.title")}>
      <header class="map-toolbar">
        <h1 class="map-title">☁ ${this.#ui.t("graph.title")}</h1>
        ${graphModes.map(mode => html`<a class=${`map-mode-btn${this.mode === mode ? " active" : ""}`} href=${`#/graph/${mode}`}
          aria-current=${this.mode === mode ? "page" : nothing}>${this.#ui.t(`graph.${mode}`)}</a>`)}
        <span class="map-hint">${this.#ui.t("graph.hint")}</span>
        <span class="cm-view-actions">
          <span class="cm-canvas-purpose">◉ ${this.#ui.t("graph.readOnly")}</span>
          ${detail === "full" ? nothing : html`<span class="cm-visibility-indicator" role="status">◐ ${this.#ui.t("graph.hiddenDetails")}</span>`}
          <span class="cm-zoom-controls" role="group" aria-label=${this.#ui.t("graph.zoomControls")}>
            <button ?disabled=${this.zoom <= .25} aria-label=${this.#ui.t("graph.zoomOut")} @click=${() => this.#setZoom(stepGraphZoom(this.zoom, -1))}>−</button>
            <button class="cm-zoom-level" aria-label=${this.#ui.t("graph.zoomReset")} @click=${() => this.#setZoom(1)}>${Math.round(this.zoom * 100)}%</button>
            <button ?disabled=${this.zoom >= 2} aria-label=${this.#ui.t("graph.zoomIn")} @click=${() => this.#setZoom(stepGraphZoom(this.zoom, 1))}>+</button>
            <button class="cm-zoom-fit" @click=${() => this.#scheduleFit(1)}>${this.#ui.t("graph.fit")}</button>
          </span>
        </span>
      </header>
      <div class="map-filterbar">
        <div class="cm-filter-mount">
          ${this.filters.values.map((value, index) => html`<button class="cm-chip" aria-label=${this.#ui.t("graph.removeFilter", { value })}
            @click=${() => this.#setFilters({ ...this.filters, values: this.filters.values.filter((_, i) => i !== index) })}>${value} ×</button>`)}
          <input class="cm-query" aria-label=${this.#ui.t("graph.filter")} placeholder=${this.#ui.t("graph.filterPlaceholder")} .value=${this.query}
            @input=${(event: Event) => { this.query = (event.target as HTMLInputElement).value.slice(0, 200); }}
            @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); this.#addQuery(); } }} @change=${this.#addQuery} />
        </div>
        <div class="cm-chip-group" role="group" aria-label=${this.#ui.t("graph.edgeTypes")}>
          ${this.mode === "mysteries" ? nothing : [...types].map(([type, value]) => html`<button class=${`cm-chip cm-chip-edge${this.filters.hiddenEdgeTypes.includes(type) ? " is-off" : ""}`}
            style=${`--chip-color:${value.color}`} aria-pressed=${!this.filters.hiddenEdgeTypes.includes(type)}
            @click=${() => this.#setFilters({ ...this.filters, hiddenEdgeTypes: this.filters.hiddenEdgeTypes.includes(type)
              ? this.filters.hiddenEdgeTypes.filter(id => id !== type) : [...this.filters.hiddenEdgeTypes, type] })}>${value.label}</button>`)}
        </div>
        <button class=${`cm-focus-toggle${this.filters.focusMode ? " is-on" : ""}`} aria-pressed=${this.filters.focusMode}
          @click=${() => { this.focusId = undefined; this.#setFilters({ ...this.filters, focusMode: !this.filters.focusMode }); }}>🎯 ${this.#ui.t("graph.focus")}</button>
        <span class="cm-focus-hops" ?hidden=${!this.filters.focusMode}><input type="range" min="1" max="4" step="1" .value=${String(this.filters.focusHops)} aria-label=${this.#ui.t("graph.focusHops")}
          @input=${(event: Event) => this.#setFilters({ ...this.filters, focusHops: Number((event.target as HTMLInputElement).value) })} />${this.filters.focusHops}</span>
        <button class="cm-clear-filters" aria-label=${this.#ui.t("graph.clearFilters")} @click=${this.#clearFilters}>×</button>
      </div>
      ${this.storageError ? html`<p class="cm-message" role="alert">${this.#ui.t("graph.storageFailed")} <button @click=${this.#savePreferences}>${this.#ui.t("graph.retry")}</button></p>` : nothing}
      ${this.storageChanged ? html`<p class="cm-message" role="status">${this.#ui.t("graph.storageChanged")}</p>` : nothing}
      <p id="cm-keyboard-help" class="visually-hidden">${this.#ui.t("graph.keyboardHelp")}</p>
      <div class="cm-viewport" tabindex="0" role="region" aria-label=${this.#ui.t(this.mode === "relationships" ? "graph.canvas" : this.mode === "factions" ? "graph.factionCanvas" : "graph.mysteryCanvas")} aria-describedby="cm-keyboard-help"
        style=${`--cm-z:${this.zoom};--cm-type-z:${typeScale}`} data-cm-detail=${detail}
        data-motion=${this.#motion ? this.#gesture ? "dragging" : "settling" : "idle"}
        @pointerdown=${this.#pointerDown} @pointermove=${this.#pointerMove} @pointerup=${this.#pointerUp}
        @pointercancel=${this.#cancelGesture} @lostpointercapture=${this.#cancelGesture}
        @wheel=${{ handleEvent: this.#wheel, passive: false }} @keydown=${this.#keyDown}
        @click=${(event: MouseEvent) => { if (!(event.target as Element).closest(".cm-node")) this.focusId = undefined; }}>
        ${this.mode === "factions" ? visible.filter(node => node.glow).map(node => {
          const box = this.#box(node.key), size = (node.kind === "faction" ? 550 : 320) * this.zoom;
          return html`<div class=${`cm-glow${node.kind === "faction" ? "" : " cm-glow-sm"}`} aria-hidden="true"
            style=${`left:${box.x - size / 2}px;top:${box.y - size / 2}px;--gc:${node.glow};${states.get(node.key)?.dim ? "opacity:.02" : ""}`}></div>`;
        }) : nothing}
        ${this.#renderEdges(states, typeScale)}
        ${repeat(visible, node => node.key, node => {
          const box = this.#box(node.key), state = states.get(node.key)!;
          return html`<a class="cm-node" data-key=${node.key} data-kind=${node.kind} href=${node.route} draggable="false" aria-label=${node.name} aria-describedby="cm-keyboard-help"
            style=${`left:${Math.round(box.x - box.width / 2)}px;top:${Math.round(box.y - box.height / 2)}px;--cc:${node.color};--cw:${node.kind === "faction" ? 210 : 168}px`}
            @click=${(event: MouseEvent) => this.#nodeClick(event, node)} @contextmenu=${(event: MouseEvent) => this.#openMenu(event, node.key)}>
            <div class=${`cm-cloud${node.kind === "faction" ? " cm-faction-hub" : ` cm-${node.kind}`}${node.status === "dead" ? " cm-dead" : ""}${state.dim ? " cm-vfilter-dim" : ""}${this.focusId === node.key ? " cm-highlighted" : ""}`}>
              <div class="cm-strip">${node.kind === "character" ? `${node.badge} ${node.factionName}` : node.kind === "faction" ? `${node.badge} ${this.#ui.t("graph.factionStrip")}` : node.kind === "location" ? `📍 ${this.#ui.t("graph.placeStrip")}` : `❓ ${this.#ui.t("graph.mysteryStrip")}`}</div>
              <div class="cm-name">${node.status === "dead" ? "💀 " : ""}${node.name}</div>
              <div class="cm-divider"></div>${this.#renderFacts(node)}
            </div>
          </a>`;
        })}
        ${visible.length ? nothing : html`<div class="cm-empty-state"><div class="cm-empty-icon">☁</div><strong>${this.#ui.t(this.mode === "relationships" ? "graph.empty" : "graph.emptyCards")}</strong><span>${this.#ui.t(this.mode === "relationships" ? "graph.emptyHint" : "graph.emptyCardsHint")}</span></div>`}
      </div>
      <details class="map-legend-shell"><summary>${this.#ui.t("graph.legend")}</summary><div class="map-legend">
        <strong class="legend-title">${this.#ui.t("graph.edgeTypes")}</strong>
        ${[...types].map(([type, value]) => html`<div class="legend-item"><span class="legend-line" style=${`border-color:${value.color};border-top-style:${this.#graph.edges.find(edge => edge.type === type)?.style ?? "solid"}`}></span>${value.label}</div>`)}
        <strong class="legend-title">${this.#ui.t("graph.factions")}</strong>
        ${[...factions].map(([key, faction]) => html`<label class="legend-item legend-filter"><input type="checkbox" .checked=${!this.hiddenFactions.has(key)}
          @change=${() => { const hidden = new Set(this.hiddenFactions); if (!hidden.delete(key)) hidden.add(key); this.hiddenFactions = hidden; this.#savePreferences(); }} />
          <span style=${`color:${faction.color}`}>${faction.badge}</span> ${faction.name || this.#ui.t("graph.noFaction")}</label>`)}
      </div></details>
      ${this.contextMenu === undefined ? nothing : html`<div class="cm-ctx-menu" role="menu" style=${`left:${this.contextMenu.x}px;top:${this.contextMenu.y}px`}
        @keydown=${this.#menuKeyDown}>
        <a class="cm-ctx-item" role="menuitem" href=${this.#graph.nodes.find(node => node.key === this.contextMenu?.key)?.route ?? "#"}>↗ ${this.#ui.t("graph.openDetail")}</a>
        <button class="cm-ctx-item" role="menuitem" @click=${() => { this.focusId = this.contextMenu?.key; this.#setFilters({ ...this.filters, focusMode: true }); this.#closeMenu(true); }}>🎯 ${this.#ui.t("graph.focusNeighborhood")}</button>
      </div>`}
    </section>`;
  }
  #renderFacts(node: GraphNode) {
    if (node.kind === "location") return nothing;
    if (node.kind === "faction") return html`<div class="cm-fact">${this.#ui.plural("graph.memberCount", node.count)}</div>`;
    if (node.kind === "mystery") return html`<div class="cm-fact cm-fact-priority" style=${`color:${node.priorityColor}`}>⚑ ${node.priority || this.#ui.t("graph.priorityMedium")}</div>
      ${node.hint ? html`<div class="cm-fact cm-hint">${node.hint}</div>` : nothing}`;
    if (this.mode === "factions") return html`${node.title ? html`<div class="cm-fact">${node.title}</div>` : nothing}
      ${node.commandCount ? html`<div class="cm-fact cm-dim">${this.#ui.plural("graph.commandCount", node.commandCount)}</div>` : nothing}
      ${node.commander ? html`<div class="cm-fact cm-dim">${this.#ui.t("graph.underCommand", { name: node.commander })}</div>` : nothing}
      ${!node.title && !node.commandCount && !node.commander ? html`<div class="cm-fact cm-dim">${this.#ui.t("graph.noCommands")}</div>` : nothing}`;
    if (this.mode === "mysteries") return html`<div class="cm-fact cm-dim">${this.#ui.plural("graph.mysteryCount", node.count)}</div>
      ${node.hint ? html`<div class="cm-fact cm-hint">${node.hint}</div>` : nothing}`;
    return html`<div class="cm-status-row"><span style=${`color:${node.statusColor}`}>${node.statusIcon}</span> ${node.statusLabel}</div>
      <div class="cm-fact cm-dim">${this.#ui.plural("graph.connectionCount", node.count)}</div>
      ${node.commonTypes ? html`<div class="cm-fact cm-dim">${node.commonTypes}</div>` : nothing}`;
  }
  #renderEdges(states: ReturnType<typeof graphNodeStates>, typeScale: number) {
    const edges = this.#graph.edges.filter(edge => !states.get(edge.source)?.hidden && !states.get(edge.target)?.hidden);
    const offsets = graphEdgeOffsets(edges);
    return svg`<svg class="cm-edge-svg" aria-hidden="true">${edges.map((edge, index) => {
      const offset = (offsets.get(edge.key) ?? 0) * this.zoom, control = this.#motion?.controls.get(edge.key);
      const source = this.#box(edge.source), target = this.#box(edge.target), geometry = graphEdgeGeometry(source, target, offset,
        control ? { x: this.pan.x + control.x * this.zoom, y: this.pan.y + control.y * this.zoom } : undefined);
      const dim = states.get(edge.source)?.dim || states.get(edge.target)?.dim || this.filters.hiddenEdgeTypes.includes(edge.type);
      const showLabel = Boolean(edge.label) && this.zoom >= 1 && geometry.length > 50;
      const label = this.#labelLayout(edge.label, Math.max(36, geometry.length - 20), typeScale), lineHeight = 16.2 * typeScale;
      let angle = Math.atan2(target.y - source.y, target.x - source.x) * 180 / Math.PI;
      if (Math.abs(angle) > 90) angle += angle > 0 ? -180 : 180;
      const rotation = `rotate(${angle} ${geometry.label.x} ${geometry.label.y})`;
      return svg`<g data-edge-key=${edge.key} data-edge-type=${edge.type} opacity=${dim ? .1 : .8}>
        <defs><marker id=${`cm-arrow-${index}`} viewBox="0 0 14 10" markerWidth="14" markerHeight="10" refX="13" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L14,5 L0,10 Z" fill=${edge.color}/></marker>
          <marker id=${`cm-circle-${index}`} viewBox="0 0 10 10" markerWidth="9" markerHeight="9" refX="5" refY="5" markerUnits="userSpaceOnUse"><circle cx="5" cy="5" r="4" fill=${edge.color}/></marker>
          <mask id=${`cm-gap-${index}`} maskUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="white"/>
            ${!showLabel ? nothing : svg`<rect x=${geometry.label.x - label.width / 2 - 5} y=${geometry.label.y - label.lines.length * lineHeight / 2} width=${label.width + 10}
              height=${label.lines.length * lineHeight} transform=${rotation} fill="black"/>`}</mask>
        </defs>
        <path d=${geometry.path} fill="none" stroke=${edge.color} stroke-width=${edge.width} stroke-dasharray=${edge.style === "dashed" ? "8 5" : edge.style === "dotted" ? "2 5" : "none"}
          marker-start=${`url(#cm-circle-${index})`} marker-end=${`url(#cm-arrow-${index})`} mask=${`url(#cm-gap-${index})`}/>
        ${!showLabel ? nothing : svg`<text class="cm-edge-text" fill=${edge.color} style=${`font-size:${12 * typeScale}px`} transform=${rotation}
          text-anchor="middle" dominant-baseline="central">${label.lines.map((line, i) => svg`<tspan x=${geometry.label.x} y=${geometry.label.y + (i - (label.lines.length - 1) / 2) * lineHeight}>${line}</tspan>`)}</text>`}
      </g>`;
    })}</svg>`;
  }
  #labelLayout(value: string, width: number, scale: number) {
    const font = `${12 * scale}px Inter Variable, sans-serif`, key = JSON.stringify([value, Math.round(width), scale]);
    let layout = this.#labelLayouts.get(key); if (layout) return layout;
    if (this.#textMeasure) this.#textMeasure.font = font;
    const measure = (text: string) => (this.#textMeasure?.measureText(text).width ?? text.length * 7 * scale) + Math.max(0, text.length - 1) * .24 * scale;
    const lines = wrapGraphLabel(value, width, measure);
    layout = { lines, width: Math.max(0, ...lines.map(measure)) };
    if (this.#labelLayouts.size > 1000) this.#labelLayouts.clear();
    this.#labelLayouts.set(key, layout); return layout;
  }
  #box(key: string): GraphBox {
    const pill = this.#nodeByKey.get(key)?.kind === "faction";
    const p = this.#motion?.positions.get(key) ?? this.positions.get(key) ?? { x: 0, y: 0 }, size = this.#sizes.get(key) ?? { width: (pill ? 210 : 168) * this.zoom, height: 126 };
    return { x: this.pan.x + p.x * this.zoom, y: this.pan.y + p.y * this.zoom, ...size, pill };
  }
  #scheduleFit(cap: number): void { this.#interruptMotion(); this.#fitCap = cap; this.#fitPasses = 3; this.requestUpdate(); }
  #fit(): void {
    const states = graphNodeStates(this.#graph, this.filters, this.hiddenFactions);
    const viewport = this.querySelector<HTMLElement>(".cm-viewport"), nodes = this.#graph.nodes.filter(node => !states.get(node.key)?.hidden);
    if (!viewport || !nodes.length) return;
    const bounds = nodes.map(node => { const p = this.positions.get(node.key)!, size = this.#box(node.key); return { x: p.x, y: p.y, w: size.width / this.zoom, h: size.height / this.zoom }; });
    const left = Math.min(...bounds.map(b => b.x - b.w / 2)), right = Math.max(...bounds.map(b => b.x + b.w / 2));
    const top = Math.min(...bounds.map(b => b.y - b.h / 2)), bottom = Math.max(...bounds.map(b => b.y + b.h / 2));
    const fit = Math.min(this.#fitCap, Math.max(1, viewport.clientWidth - 80) / Math.max(1, right - left), Math.max(1, viewport.clientHeight - 80) / Math.max(1, bottom - top));
    this.zoom = [...graphZoomLevels].reverse().find(level => level <= fit) ?? .25;
    this.pan = { x: viewport.clientWidth / 2 - (left + right) / 2 * this.zoom, y: viewport.clientHeight / 2 - (top + bottom) / 2 * this.zoom };
  }
  #setZoom(next: number, anchor?: GraphPoint): void {
    this.#interruptMotion(); this.#fitPasses = 0;
    const viewport = this.querySelector<HTMLElement>(".cm-viewport"); if (!viewport) return;
    const center = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    this.pan = { x: center.x - (center.x - this.pan.x) * next / this.zoom, y: center.y - (center.y - this.pan.y) * next / this.zoom }; this.zoom = next;
  }
  readonly #wheel = (event: WheelEvent): void => {
    event.preventDefault(); if (!event.deltaY) return;
    const delta = Math.sign(event.deltaY) * (event.deltaMode === 0 ? Math.min(100, Math.abs(event.deltaY)) : 100);
    if (Math.sign(delta) !== Math.sign(this.#wheelDelta)) this.#wheelDelta = 0;
    this.#wheelDelta += delta; if (Math.abs(this.#wheelDelta) < 100) return;
    this.#wheelDelta -= Math.sign(delta) * 100;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.#setZoom(stepGraphZoom(this.zoom, -Math.sign(delta)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  readonly #pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#gesture) return;
    this.#finishMotion();
    const node = (event.target as Element).closest<HTMLElement>(".cm-node"), capture = node ?? event.currentTarget as HTMLElement;
    const key = node?.dataset["key"], before = key === undefined ? this.pan : this.positions.get(key);
    if (!before) return;
    this.#fitPasses = 0; this.storageChanged = false;
    this.#gesture = { pointer: event.pointerId, key, before, origin: { x: event.clientX, y: event.clientY }, capture, moved: false };
    capture.setPointerCapture(event.pointerId);
  };
  readonly #pointerMove = (event: PointerEvent): void => {
    const gesture = this.#gesture; if (!gesture || gesture.pointer !== event.pointerId) return;
    const dx = event.clientX - gesture.origin.x, dy = event.clientY - gesture.origin.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    if (!gesture.moved && gesture.key !== undefined) this.#startMotion(gesture.key);
    gesture.moved = true; event.preventDefault();
    if (gesture.key === undefined) this.pan = { x: gesture.before.x + dx, y: gesture.before.y + dy };
    else {
      this.#motion?.move({ x: gesture.before.x + dx / this.zoom, y: gesture.before.y + dy / this.zoom });
      if (this.#reducedMotion?.matches) this.#motion?.snap(); else this.#wakeMotion();
      this.requestUpdate();
    }
  };
  readonly #pointerUp = (event: PointerEvent): void => {
    const gesture = this.#gesture; if (!gesture || gesture.pointer !== event.pointerId) return;
    this.#gesture = undefined;
    if (gesture.capture.hasPointerCapture(event.pointerId)) gesture.capture.releasePointerCapture(event.pointerId);
    if (gesture.moved) {
      this.#suppressClickUntil = Date.now() + 400;
      if (gesture.key !== undefined) { if (this.#reducedMotion?.matches) this.#finishMotion(); else this.#wakeMotion(); }
      this.requestUpdate();
    }
  };
  readonly #cancelGesture = (): void => {
    const gesture = this.#gesture; if (!gesture) return;
    this.#gesture = undefined;
    if (gesture.key === undefined) this.pan = gesture.before; else this.#cancelMotion();
    this.#suppressClickUntil = Date.now() + 400;
    if (gesture.capture.hasPointerCapture(gesture.pointer)) gesture.capture.releasePointerCapture(gesture.pointer);
  };
  #moveNode(key: string, point: GraphPoint): void {
    if (validCoordinate(point.x) && validCoordinate(point.y)) { const positions = new Map(this.positions); positions.set(key, point); this.positions = positions; }
  }
  #nodeClick(event: MouseEvent, node: GraphNode): void {
    if (Date.now() < this.#suppressClickUntil) { event.preventDefault(); return; }
    if (this.filters.focusMode && !event.ctrlKey && !event.metaKey) { event.preventDefault(); this.focusId = node.key; }
  }
  readonly #keyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { this.#cancelGesture(); this.#cancelMotion(); this.focusId = undefined; this.#closeMenu(true); return; }
    const node = (event.target as Element).closest<HTMLElement>(".cm-node"), key = node?.dataset["key"];
    if ((event.key === "ContextMenu" || event.shiftKey && event.key === "F10") && key && node) { event.preventDefault(); const rect = node.getBoundingClientRect(); this.#showMenu(key, rect.left, rect.bottom); return; }
    const direction: Readonly<Record<string, GraphPoint>> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const delta = direction[event.key]; if (!delta || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); this.#interruptMotion(); this.#fitPasses = 0; const step = event.shiftKey ? 20 : 5;
    if (key) { const point = this.positions.get(key)!; this.#moveNode(key, { x: point.x + delta.x * step, y: point.y + delta.y * step }); this.#savePreferences(); }
    else this.pan = { x: this.pan.x - delta.x * 30, y: this.pan.y - delta.y * 30 };
  };
  #openMenu(event: MouseEvent, key: string): void { event.preventDefault(); this.#showMenu(key, event.clientX, event.clientY); }
  #showMenu(key: string, x: number, y: number): void {
    this.contextMenu = { key, x: Math.max(4, Math.min(innerWidth - 240, x)), y: Math.max(4, Math.min(innerHeight - 130, y)) };
    void this.updateComplete.then(() => this.querySelector<HTMLElement>('.cm-ctx-menu [role="menuitem"]')?.focus());
  }
  #closeMenu(restoreFocus = false): void {
    const key = this.contextMenu?.key; this.contextMenu = undefined;
    if (restoreFocus && key) [...this.querySelectorAll<HTMLElement>(".cm-node")].find(node => node.dataset["key"] === key)?.focus();
  }
  readonly #menuKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); this.#closeMenu(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const items = [...this.querySelectorAll<HTMLElement>('.cm-ctx-menu [role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  readonly #dismissMenu = (event: PointerEvent): void => { if (this.contextMenu && !(event.target instanceof Element && event.target.closest(".cm-ctx-menu"))) this.#closeMenu(); };
  readonly #onBlur = (): void => { this.#interruptMotion(); this.#closeMenu(); };
  readonly #onVisibility = (): void => { if (document.hidden) this.#onBlur(); };
  readonly #onMotionPreference = (): void => {
    if (!this.#reducedMotion?.matches || !this.#motion) return;
    this.#stopMotionFrame();
    if (this.#gesture) { this.#motion.snap(); this.requestUpdate(); } else this.#finishMotion();
  };
  readonly #addQuery = (): void => {
    const values = [...this.filters.values, ...this.query.split(",").map(value => value.trim()).filter(Boolean)].slice(0, 32);
    this.query = ""; this.#setFilters({ ...this.filters, values: [...new Set(values)] });
  };
  #setFilters(filters: GraphFilter): void { this.filters = filters; this.#savePreferences(); }
  readonly #clearFilters = (): void => { this.query = ""; this.focusId = undefined; this.filters = emptyGraphFilter(); this.hiddenFactions = new Set(); this.#savePreferences(); };
  readonly #savePreferences = (): void => {
    this.#persistPreferences(this.mode);
  };
  #persistPreferences(mode: GraphMode): void {
    const keys = graphPreferenceKeys(mode);
    try {
      localStorage.setItem(keys.positions, JSON.stringify(Object.fromEntries(this.positions)));
      localStorage.setItem(keys.filters, JSON.stringify(this.filters)); localStorage.setItem(keys.factions, JSON.stringify([...this.hiddenFactions])); this.storageError = false;
    } catch { this.storageError = true; }
  }
  #readPreferences(): void {
    const keys = graphPreferenceKeys(this.mode);
    const read = (key: string): unknown => { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return undefined; } };
    const positions = read(keys.positions);
    this.positions = initialGraphPositions(this.#graph, positions === null && this.mode !== "relationships"
      ? migrateGraphPositions(this.#graph, read(keys.legacyPositions)) : parseGraphPositions(positions));
    this.filters = parseGraphFilter(read(keys.filters));
    const factions = read(keys.factions); this.hiddenFactions = new Set(Array.isArray(factions) ? factions.filter((key): key is string => typeof key === "string").slice(0, 128) : []);
  }
  readonly #onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== localStorage || event.key !== null && !Object.values(graphPreferenceKeys(this.mode)).includes(event.key)) return;
    const interrupted = this.#gesture !== undefined || this.#motion !== undefined;
    this.#cancelGesture(); this.#cancelMotion(); this.#readPreferences();
    if (interrupted) this.storageChanged = true;
  };

  #startMotion(key: string): void {
    const states = graphNodeStates(this.#graph, this.filters, this.hiddenFactions);
    const nodes = this.#graph.nodes.filter(node => !states.get(node.key)?.hidden);
    const edges = this.#graph.edges.filter(edge => !states.get(edge.source)?.hidden && !states.get(edge.target)?.hidden);
    const sizes = new Map(nodes.map(node => { const box = this.#box(node.key); return [node.key, { width: box.width / this.zoom, height: box.height / this.zoom }]; }));
    this.#motion = new GraphMotion({ nodes, edges }, this.positions, sizes, key); this.#motionMode = this.mode;
  }
  #stopMotionFrame(): void {
    if (this.#motionFrame !== undefined) cancelAnimationFrame(this.#motionFrame);
    this.#motionFrame = undefined; this.#motionTime = undefined; this.#motionAccumulator = 0;
  }
  #cancelMotion(): void {
    this.#stopMotionFrame(); this.#motion = undefined; this.requestUpdate();
  }
  #finishMotion(): void {
    if (!this.#motion) return;
    this.#stopMotionFrame(); this.#motion.settle(); this.positions = new Map(this.#motion.positions);
    const mode = this.#motionMode; this.#motion = undefined; this.#persistPreferences(mode); this.requestUpdate();
  }
  #interruptMotion(): void {
    // Held movement is a cancellable draft; a completed drop survives navigation.
    if (this.#gesture) this.#cancelGesture(); else this.#finishMotion();
  }
  #wakeMotion(): void {
    if (!this.#motion || this.#motionFrame !== undefined) return;
    this.#motionFrame = requestAnimationFrame(this.#motionTick);
  }
  readonly #motionTick = (now: number): void => {
    this.#motionFrame = undefined;
    if (!this.#motion) return;
    const frame = 1000 / 60;
    this.#motionAccumulator += this.#motionTime === undefined ? frame : Math.min(frame * 4, Math.max(0, now - this.#motionTime));
    this.#motionTime = now;
    let moving = true;
    while (this.#motionAccumulator >= frame && moving) { this.#motionAccumulator -= frame; moving = this.#motion.step(); }
    this.requestUpdate();
    if (moving) this.#wakeMotion();
    else {
      this.#stopMotionFrame();
      if (!this.#gesture) this.#finishMotion();
    }
  };
}
customElements.define("codex-campaign-graph", CodexCampaignGraph);
