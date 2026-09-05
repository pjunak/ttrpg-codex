import { graphEdgeControl, graphEdgeOffsets, validCoordinate, type CampaignGraph, type GraphPoint } from "./campaign-graph.js";

export interface GraphSize { readonly width: number; readonly height: number }
interface Body extends GraphSize { readonly key: string }
interface Velocity { x: number; y: number }
const zero = (): Velocity => ({ x: 0, y: 0 });
const padding = 14, maxSteps = 180, pairBudget = 50_000;
const bounded = (value: number): number => Math.max(-10_000_000, Math.min(10_000_000, value));

/** A disposable visual draft. No storage, timers, DOM, or campaign mutations. */
export class GraphMotion {
  readonly positions: Map<string, GraphPoint>;
  readonly controls = new Map<string, GraphPoint>();
  readonly #rest: ReadonlyMap<string, GraphPoint>;
  readonly #bodies: readonly Body[];
  readonly #velocities = new Map<string, Velocity>();
  readonly #edgeVelocities = new Map<string, Velocity>();
  readonly #affected: Set<string>;
  readonly #offsets: ReadonlyMap<string, number>;
  #steps = 0;
  #quietSteps = 0;
  #settled = false;

  constructor(readonly graph: CampaignGraph, positions: ReadonlyMap<string, GraphPoint>, sizes: ReadonlyMap<string, GraphSize>, readonly held: string) {
    this.positions = new Map(positions); this.#rest = new Map(positions); this.#affected = new Set([held]);
    this.#bodies = graph.nodes.map(node => ({ key: node.key, ...(sizes.get(node.key) ?? { width: node.kind === "faction" ? 210 : 168, height: 126 }) }));
    this.#offsets = graphEdgeOffsets(graph.edges);
    this.#snapEdges();
  }

  move(point: GraphPoint): void {
    if (!validCoordinate(point.x) || !validCoordinate(point.y)) return;
    this.positions.set(this.held, point); this.#steps = 0; this.#quietSteps = 0; this.#settled = false;
  }

  /** One 60 Hz step. Only touched cards move; connected neighbours are not pulled. */
  step(): boolean {
    if (this.#settled) return false;
    for (const key of this.#affected) {
      if (key === this.held) continue;
      const point = this.positions.get(key)!, rest = this.#rest.get(key)!, velocity = this.#velocity(key);
      velocity.x += (rest.x - point.x) * .055; velocity.y += (rest.y - point.y) * .055;
    }
    this.#collisions((a, b, dx, dy, ox, oy) => {
      const horizontal = ox < oy, impulse = (horizontal ? ox : oy) * .55, sign = Math.sign(horizontal ? dx : dy) || 1;
      for (const [key, direction] of [[a.key, -sign], [b.key, sign]] as const) {
        if (key === this.held) continue;
        this.#affected.add(key); const velocity = this.#velocity(key);
        if (horizontal) velocity.x += direction * impulse; else velocity.y += direction * impulse;
      }
    });
    let energy = 0;
    for (const [key, velocity] of this.#velocities) {
      velocity.x *= .78; velocity.y *= .78;
      const cap = Math.min(1, 45 / Math.max(.001, Math.hypot(velocity.x, velocity.y)));
      velocity.x *= cap; velocity.y *= cap;
      const point = this.positions.get(key)!;
      this.positions.set(key, { x: bounded(point.x + velocity.x), y: bounded(point.y + velocity.y) });
      energy = Math.max(energy, velocity.x ** 2 + velocity.y ** 2);
    }
    for (const edge of this.graph.edges) {
      const target = this.#edgeTarget(edge.key, edge.source, edge.target), point = this.controls.get(edge.key)!, velocity = this.#edgeVelocities.get(edge.key) ?? zero();
      velocity.x = (velocity.x + (target.x - point.x) * .04) * .85;
      velocity.y = (velocity.y + (target.y - point.y) * .04) * .85;
      this.#edgeVelocities.set(edge.key, velocity);
      this.controls.set(edge.key, { x: point.x + velocity.x, y: point.y + velocity.y });
      energy = Math.max(energy, velocity.x ** 2 + velocity.y ** 2, ((target.x - point.x) ** 2 + (target.y - point.y) ** 2) * .1);
    }
    this.#quietSteps = energy < .05 ? this.#quietSteps + 1 : 0;
    if (++this.#steps < maxSteps && this.#quietSteps < 3) return true;
    this.snap(); this.#settled = true; return false;
  }

  settle(): void { while (this.step()) { /* Bounded by maxSteps, independent of frame rate. */ } }

  /** Remove tiny spring error and residual overlap before adopting a saved arrangement. */
  snap(): void {
    for (const key of this.#affected) {
      if (key === this.held) continue;
      const point = this.positions.get(key)!, rest = this.#rest.get(key)!;
      if (Math.hypot(point.x - rest.x, point.y - rest.y) < .5) this.positions.set(key, rest);
    }
    // A static spring/collision equilibrium can still overlap. Project the
    // touched cards apart while keeping the user's dropped point exact.
    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      this.#collisions((a, b, dx, dy, ox, oy) => {
        changed = true;
        const horizontal = ox < oy, sign = Math.sign(horizontal ? dx : dy) || 1;
        const distance = (horizontal ? ox : oy) + .01, share = a.key === this.held || b.key === this.held ? 1 : .5;
        for (const [key, direction] of [[a.key, -sign], [b.key, sign]] as const) {
          if (key === this.held) continue;
          this.#affected.add(key); const point = this.positions.get(key)!;
          this.positions.set(key, { x: bounded(point.x + (horizontal ? direction * distance * share : 0)),
            y: bounded(point.y + (horizontal ? 0 : direction * distance * share)) });
        }
      });
      if (!changed) break;
    }
    this.#velocities.clear(); this.#snapEdges();
  }

  #velocity(key: string): Velocity {
    let velocity = this.#velocities.get(key);
    if (!velocity) { velocity = zero(); this.#velocities.set(key, velocity); }
    return velocity;
  }
  #edgeTarget(key: string, source: string, target: string): GraphPoint {
    return graphEdgeControl(this.positions.get(source)!, this.positions.get(target)!, this.#offsets.get(key) ?? 0);
  }
  #snapEdges(): void {
    this.#edgeVelocities.clear();
    for (const edge of this.graph.edges) this.controls.set(edge.key, this.#edgeTarget(edge.key, edge.source, edge.target));
  }
  #collisions(resolve: (a: Body, b: Body, dx: number, dy: number, ox: number, oy: number) => void): void {
    const boxes = this.#bodies.map(body => ({ ...body, left: this.positions.get(body.key)!.x - body.width / 2 - padding }))
      .sort((a, b) => a.left - b.left || a.key.localeCompare(b.key));
    const maxWidth = boxes.reduce((width, box) => Math.max(width, box.width + 2 * padding), 0);
    const byKey = new Map(boxes.map(box => [box.key, box]));
    let comparisons = 0;
    const visited = new Set<string>();
    // Query only the touched region. Bound dense clusters without an O(N²)
    // scan through every untouched pair in a large campaign.
    for (const key of this.#affected) {
      const a = byKey.get(key); if (!a) continue;
      let low = 0, high = boxes.length;
      while (low < high) { const mid = (low + high) >>> 1; if (boxes[mid]!.left < a.left - maxWidth) low = mid + 1; else high = mid; }
      for (let index = low; index < boxes.length; index++) {
        const b = boxes[index]!; if (b.left > a.left + a.width + 2 * padding) break;
        if (++comparisons > pairBudget) return;
        if (b.key === key) continue;
        const pair = JSON.stringify([a.key, b.key].sort());
        if (visited.has(pair)) continue;
        visited.add(pair);
        const p = this.positions.get(a.key)!, q = this.positions.get(b.key)!, dx = q.x - p.x, dy = q.y - p.y;
        const ox = (a.width + b.width) / 2 + 2 * padding - Math.abs(dx), oy = (a.height + b.height) / 2 + 2 * padding - Math.abs(dy);
        if (ox > 0 && oy > 0) resolve(a, b, dx, dy, ox, oy);
      }
    }
  }
}
