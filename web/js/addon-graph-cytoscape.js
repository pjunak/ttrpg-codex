import { GRAPH_FACADE_VERSION } from './addon-graph.js';

const FEATURES = Object.freeze([
  'data',
  'selection',
  'viewport',
  'events',
  'lifecycle',
  'node-position',
  'node-drag',
]);
const LAYOUTS = Object.freeze(['grid', 'circle', 'concentric', 'breadthfirst', 'dagre', 'preset']);

function elementData(graph) {
  return [
    ...graph.nodes.map(node => ({
      group: 'nodes',
      data: { id: node.id, label: node.label, kind: node.kind },
      ...(node.position ? { position: node.position } : {}),
    })),
    ...graph.edges.map(edge => ({
      group: 'edges',
      data: { id: edge.id, source: edge.source, target: edge.target, label: edge.label },
    })),
  ];
}

function themeStyles(container) {
  const styles = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
  const token = name => styles?.getPropertyValue(name)?.trim() || '';
  return [
    {
      selector: 'node',
      style: {
        'background-color': token('--bg-card-dark'),
        'border-color': token('--accent-gold-dim'),
        'border-width': 2,
        color: token('--text-ink'),
        label: 'data(label)',
        'font-family': token('--font-ui'),
        'font-size': 14,
        'text-wrap': 'wrap',
        'text-max-width': 136,
        'text-valign': 'center',
        'text-halign': 'center',
        width: 160,
        height: 64,
      },
    },
    {
      selector: 'node[kind = "active"]',
      style: {
        'border-color': token('--color-info'),
        'border-width': 3,
      },
    },
    {
      selector: 'node[kind = "completed"]',
      style: {
        'border-color': token('--color-success'),
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': token('--accent-gold'),
        'border-width': 4,
        'overlay-color': token('--accent-gold'),
        'overlay-opacity': 0.15,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'line-color': token('--text-muted'),
        'target-arrow-color': token('--text-muted'),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        color: token('--text-parchment'),
        label: 'data(label)',
        'font-family': token('--font-ui'),
        'font-size': 12,
        'text-background-color': token('--bg-raised'),
        'text-background-opacity': 1,
        'text-background-padding': 3,
      },
    },
  ];
}

function toLayoutOptions(layout, reducedMotion) {
  const options = { ...layout, animate: !reducedMotion };
  if (layout.name === 'dagre') {
    if (layout.rankDir !== undefined) options.rankDir = layout.rankDir;
    if (layout.rankSep !== undefined) options.rankSep = layout.rankSep;
    if (layout.nodeSep !== undefined) options.nodeSep = layout.nodeSep;
    if (layout.edgeSep !== undefined) options.edgeSep = layout.edgeSep;
  }
  return options;
}

function collectionFor(cy, ids) {
  if (!ids.length) return cy.elements();
  const wanted = new Set(ids);
  return cy.nodes().filter(node => wanted.has(node.id()));
}

function restoreAttribute(container, name, previous) {
  if (previous === null) container.removeAttribute?.(name);
  else container.setAttribute?.(name, previous);
}

export function createCytoscapeGraphAdapter(cytoscapeRuntime) {
  if (typeof cytoscapeRuntime !== 'function') {
    throw new Error('Cytoscape runtime is unavailable');
  }
  return {
    id: 'host-cytoscape',
    minFacadeVersion: GRAPH_FACADE_VERSION,
    maxFacadeVersion: GRAPH_FACADE_VERSION,
    features: FEATURES,
    layouts: LAYOUTS,
    create({ container, graph, layout, accessibleLabel, fitPadding }) {
      let destroyed = false;
      let layoutGeneration = 0;
      let activeLayout = null;
      let frame = null;
      const removers = [];
      const prior = new Map([
        ['tabindex', container.getAttribute?.('tabindex') ?? null],
        ['role', container.getAttribute?.('role') ?? null],
        ['aria-label', container.getAttribute?.('aria-label') ?? null],
        ['aria-busy', container.getAttribute?.('aria-busy') ?? null],
      ]);
      container.textContent = '';
      container.setAttribute?.('tabindex', '0');
      container.setAttribute?.('role', 'region');
      container.setAttribute?.('aria-busy', 'false');
      if (accessibleLabel) container.setAttribute?.('aria-label', accessibleLabel);
      const reducedMotion = typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches;
      const cy = cytoscapeRuntime({
        container,
        elements: elementData(graph),
        style: themeStyles(container),
        layout: { name: 'preset' },
        minZoom: 0.2,
        maxZoom: 4,
      });

      function schedule(fn) {
        if (destroyed || frame !== null) return;
        if (typeof requestAnimationFrame === 'function') {
          frame = requestAnimationFrame(() => {
            frame = null;
            if (!destroyed) fn();
          });
        } else {
          fn();
        }
      }

      function applyTheme() {
        if (destroyed) return;
        const target = cy.style?.();
        if (target?.fromJson) target.fromJson(themeStyles(container)).update?.();
      }

      function runLayout(next) {
        const generation = ++layoutGeneration;
        try { activeLayout?.stop?.(); } catch {}
        activeLayout = cy.layout(toLayoutOptions(next, reducedMotion));
        const current = activeLayout;
        const settle = () => {
          if (destroyed || generation !== layoutGeneration || current !== activeLayout) return;
          cy.fit(undefined, fitPadding);
        };
        if (typeof current.one === 'function') current.one('layoutstop', settle);
        current.run();
        if (typeof current.one !== 'function') settle();
      }

      const Resize = globalThis.ResizeObserver;
      const resizeObserver = typeof Resize === 'function'
        ? new Resize(() => schedule(() => cy.resize()))
        : null;
      resizeObserver?.observe(container);

      const Mutation = globalThis.MutationObserver;
      const themeRoot = globalThis.document?.documentElement;
      const themeObserver = typeof Mutation === 'function' && themeRoot
        ? new Mutation(() => schedule(applyTheme))
        : null;
      themeObserver?.observe(themeRoot, { attributes: true, attributeFilter: ['data-theme'] });

      const keydown = event => {
        if (destroyed || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
        const nodes = cy.nodes();
        if (!nodes.length) return;
        const selected = cy.$('node:selected').first();
        let index = selected?.length ? nodes.indexOf(selected[0]) : 0;
        if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = nodes.length - 1;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = (index + 1) % nodes.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = (index - 1 + nodes.length) % nodes.length;
        const node = nodes.eq(index);
        if (event.key === 'Enter') {
          if (!selected?.length) {
            cy.nodes().unselect();
            node.select();
          }
          node.emit('tap');
        } else {
          cy.nodes().unselect();
          node.select();
          cy.center(node);
        }
        event.preventDefault();
      };
      container.addEventListener?.('keydown', keydown);
      removers.push(() => container.removeEventListener?.('keydown', keydown));

      runLayout(layout);

      function update(nextGraph, nextLayout) {
        if (destroyed) return;
        cy.batch(() => {
          cy.elements().remove();
          cy.add(elementData(nextGraph));
        });
        runLayout(nextLayout);
      }

      function select(ids) {
        if (destroyed) return;
        const wanted = new Set(ids);
        cy.batch(() => {
          cy.nodes().unselect();
          cy.nodes().filter(node => wanted.has(node.id())).select();
        });
      }

      function focus(ids, padding) {
        if (destroyed) return;
        const elements = collectionFor(cy, ids);
        select(ids);
        cy.fit(elements, padding);
        cy.center(elements);
        container.focus?.({ preventScroll: true });
      }

      function fit(ids, padding) {
        if (destroyed) return;
        cy.fit(collectionFor(cy, ids), padding);
      }

      function on(event, handler) {
        if (destroyed) return () => {};
        if (event === 'focus') {
          const listener = () => handler({ selectedIds: cy.$('node:selected').map(node => node.id()) });
          container.addEventListener?.('focus', listener);
          return () => container.removeEventListener?.('focus', listener);
        }
        const eventName = event === 'activate' ? 'tap' : event === 'move' ? 'dragfree' : event;
        const selector = event === 'viewport' ? undefined : 'node';
        const listener = cyEvent => {
          if (destroyed) return;
          if (event === 'viewport') {
            handler({ zoom: cy.zoom() });
            return;
          }
          const nodeId = cyEvent.target?.id?.() || '';
          const position = event === 'move' ? cyEvent.target?.position?.() : undefined;
          handler({
            nodeId,
            ...(position ? { position: { x: position.x, y: position.y } } : {}),
            selectedIds: cy.$('node:selected').map(node => node.id()),
          });
        };
        if (selector) cy.on(eventName, selector, listener);
        else cy.on(eventName, listener);
        return () => {
          if (selector) cy.off(eventName, selector, listener);
          else cy.off(eventName, listener);
        };
      }

      function destroy() {
        if (destroyed) return;
        destroyed = true;
        layoutGeneration++;
        try { activeLayout?.stop?.(); } catch {}
        resizeObserver?.disconnect();
        themeObserver?.disconnect();
        if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        for (const remove of removers.reverse()) {
          try { remove(); } catch {}
        }
        try { cy.destroy(); } catch {}
        container.textContent = '';
        for (const [name, value] of prior) restoreAttribute(container, name, value);
      }

      return Object.freeze({ update, select, focus, fit, on, destroy });
    },
  };
}
