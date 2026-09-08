import type {
  ActiveBrowserContribution,
  BrowserContributionRegistry,
} from "./browser-sdk.js";
import type {
  BrowserContributionDescriptor,
  BrowserContributionSurface,
  BrowserRole,
} from "./generation-manager.js";
import type { BrowserContributionEditHandle, BrowserContributionEditRegistration } from "./edit-state.js";
import { contributionLabel } from "./contribution-label.js";
import { isRecord } from "../core/boundary.js";

export interface BrowserContributionElementContext {
  readonly edits: BrowserContributionEditHandle;
  readonly addon: {
    readonly id: string;
    readonly generation: string;
  };
  readonly contribution: BrowserContributionDescriptor;
  readonly signal: AbortSignal;
  /** Host-owned, read-only context for the concrete outlet instance. */
  readonly host: unknown;
}

export interface BrowserContributionElement extends HTMLElement {
  codexContribution: BrowserContributionElementContext;
}

export interface BrowserContributionOutletOptions {
  readonly document: Document;
  readonly root: HTMLElement;
  readonly registry: BrowserContributionRegistry;
  readonly surface: BrowserContributionSurface;
  readonly role: BrowserRole;
  readonly include?: (active: ActiveBrowserContribution) => boolean;
  readonly hostContext?: (active: ActiveBrowserContribution) => unknown;
  readonly isolatedHostContext?: boolean;
  readonly compact?: boolean;
  readonly onError?: (cause: unknown) => void;
  readonly onCountChange?: (count: number) => void;
}

interface MountedContribution {
  readonly edits: BrowserContributionEditRegistration;
  readonly updateHostContext?: (value: unknown) => void;
  readonly identity: string;
  readonly wrapper: HTMLElement;
  readonly label: HTMLElement;
  readonly dispose?: () => void;
  readonly element?: BrowserContributionElement;
}

/** Reconciles one host-owned UI surface without exposing its DOM to add-ons. */
export class BrowserContributionOutlet {
  readonly #document: Document;
  readonly #root: HTMLElement;
  readonly #registry: BrowserContributionRegistry;
  readonly #surface: BrowserContributionSurface;
  readonly #role: BrowserRole;
  readonly #include: (active: ActiveBrowserContribution) => boolean;
  readonly #hostContext: (active: ActiveBrowserContribution) => unknown;
  readonly #isolatedHostContext: boolean;
  readonly #compact: boolean;
  readonly #onError: (cause: unknown) => void;
  readonly #onCountChange: (count: number) => void;
  readonly #mounted = new Map<string, MountedContribution>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(options: BrowserContributionOutletOptions) {
    this.#document = options.document;
    this.#root = options.root;
    this.#registry = options.registry;
    this.#surface = options.surface;
    this.#role = options.role;
    this.#include = options.include ?? (() => true);
    this.#hostContext = options.hostContext ?? (() => null);
    this.#isolatedHostContext = options.isolatedHostContext ?? false;
    this.#compact = options.compact ?? false;
    this.#onError = options.onError ?? (() => undefined);
    this.#onCountChange = options.onCountChange ?? (() => undefined);
    this.#unsubscribe = this.#registry.subscribe(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (this.#disposed) {
      return;
    }
    const ordered: HTMLElement[] = [];
    const retained = new Set<string>();
    for (const active of this.#registry.list(this.#surface, this.#role)) {
      if (!this.#include(active)) {
        continue;
      }
      if (active.binding.kind !== "element" && active.binding.kind !== "isolated-frame") {
        this.#onError(new TypeError(
          `host outlet ${this.#surface} cannot mount ${active.binding.kind} contribution ` +
          `${active.addonId}:${active.descriptor.id}`,
        ));
        continue;
      }
      const key = contributionKey(active);
      const identity = active.binding.kind === "element"
        ? `element:${active.binding.tag}`
        : "isolated-frame";
      let mounted = this.#mounted.get(key);
      if (mounted === undefined || mounted.identity !== identity) {
        if (mounted !== undefined) {
          this.#mounted.delete(key);
          this.#release(mounted);
          mounted = undefined;
        }
        try {
          mounted = this.#create(active);
          this.#mounted.set(key, mounted);
        } catch (cause: unknown) {
          this.#onError(cause);
          continue;
        }
      }
      try {
        const context = this.#hostContext(active);
        const label = contributionLabel(active.descriptor, isRecord(context) ? context["locale"] : undefined);
        mounted.wrapper.setAttribute("aria-label", label);
        mounted.label.textContent = label;
        if (mounted.element !== undefined) mounted.element.codexContribution = contributionContext(active, context, mounted.edits.handle);
        else if (this.#isolatedHostContext) mounted.updateHostContext?.(freezeJSON(context));
      } catch (cause: unknown) { this.#onError(cause); continue; }
      retained.add(key);
      ordered.push(mounted.wrapper);
    }
    for (const key of this.#mounted.keys()) {
      if (!retained.has(key)) {
        this.#release(this.#mounted.get(key));
        this.#mounted.delete(key);
      }
    }
    try {
      // Keep unchanged frames and custom elements connected during refresh.
      for (const child of [...this.#root.children]) if (!ordered.includes(child as HTMLElement)) child.remove();
      ordered.forEach((child, index) => {
        const before = this.#root.children[index] ?? null;
        if (before !== child) {
          if (child.parentNode === this.#root && this.#root.isConnected && this.#root.moveBefore) this.#root.moveBefore(child, before);
          else this.#root.insertBefore(child, before);
        }
      });
      this.#root.hidden = ordered.length === 0;
      this.#onCountChange(ordered.length);
    } catch (cause: unknown) {
      this.#onError(cause);
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribe();
    for (const mounted of this.#mounted.values()) {
      this.#release(mounted);
    }
    this.#mounted.clear();
    this.#root.replaceChildren();
    this.#root.hidden = true;
    this.#onCountChange(0);
  }

  #create(active: ActiveBrowserContribution): MountedContribution {
    const edits = this.#registry.edits.open(active);
    try {
      return this.#mount(active, edits);
    } catch (cause: unknown) {
      edits.dispose();
      throw cause;
    }
  }

  #mount(active: ActiveBrowserContribution, edits: BrowserContributionEditRegistration): MountedContribution {
    const wrapper = this.#document.createElement("section");
    wrapper.className = "addon-contribution";
    wrapper.dataset["addonId"] = active.addonId;
    wrapper.dataset["contributionId"] = active.descriptor.id;
    wrapper.setAttribute("aria-label", active.descriptor.label);

    const heading = this.#document.createElement("header");
    heading.className = "addon-contribution-heading";
    const label = this.#document.createElement("strong");
    label.textContent = active.descriptor.label;
    const owner = this.#document.createElement("span");
    owner.textContent = active.addonId;
    heading.append(label, owner);

    if (active.binding.kind === "element") {
      const element = this.#document.createElement(active.binding.tag) as BrowserContributionElement;
      element.dataset["codexAddon"] = active.addonId;
      element.dataset["codexContribution"] = active.descriptor.id;
      element.codexContribution = contributionContext(active, this.#hostContext(active), edits.handle);
      if (!this.#compact) wrapper.append(heading);
      wrapper.append(element);
      return { identity: `element:${active.binding.tag}`, wrapper, label, element, edits };
    }
    if (active.binding.kind === "isolated-frame") {
      const frameHost = this.#document.createElement("div");
      frameHost.className = "addon-isolated-frame";
      const mount = active.binding.mount(frameHost, this.#isolatedHostContext ? freezeJSON(this.#hostContext(active)) : null, edits.handle);
      if (!this.#compact) wrapper.append(heading);
      wrapper.append(frameHost);
      return { identity: "isolated-frame", wrapper, label, edits,
        dispose: typeof mount === "function" ? mount : () => mount.dispose(),
        ...(typeof mount === "function" ? {} : { updateHostContext: (value: unknown) => mount.updateHostContext(value) }) };
    }
    throw new TypeError(
      `host outlet ${this.#surface} cannot mount ${active.binding.kind} contribution`,
    );
  }

  #release(mounted: MountedContribution | undefined): void {
    mounted?.edits.dispose();
    if (mounted?.dispose === undefined) {
      return;
    }
    try {
      mounted.dispose();
    } catch (cause: unknown) {
      this.#onError(cause);
    }
  }
}

function contributionKey(active: ActiveBrowserContribution): string {
  return `${active.addonId}:${active.generationId}:${active.descriptor.id}`;
}

function contributionContext(
  active: ActiveBrowserContribution,
  host: unknown,
  edits: BrowserContributionEditHandle,
): BrowserContributionElementContext {
  return Object.freeze({
    addon: Object.freeze({ id: active.addonId, generation: active.generationId }),
    contribution: active.descriptor,
    signal: active.signal,
    edits,
    host: freezeJSON(host),
  });
}

function freezeJSON(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJSON(item)));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = freezeJSON(item);
    }
    return Object.freeze(result);
  }
  return value;
}
