import type {
  ActiveBrowserContribution,
  BrowserContributionRegistry,
} from "./browser-sdk.js";
import type {
  BrowserContributionDescriptor,
  BrowserContributionSurface,
  BrowserRole,
} from "./generation-manager.js";

export interface BrowserContributionElementContext {
  readonly addon: {
    readonly id: string;
    readonly generation: string;
  };
  readonly contribution: BrowserContributionDescriptor;
  readonly signal: AbortSignal;
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
  readonly onError?: (cause: unknown) => void;
  readonly onCountChange?: (count: number) => void;
}

interface MountedContribution {
  readonly tag: string;
  readonly wrapper: HTMLElement;
}

/** Reconciles one host-owned UI surface without exposing its DOM to add-ons. */
export class BrowserContributionOutlet {
  readonly #document: Document;
  readonly #root: HTMLElement;
  readonly #registry: BrowserContributionRegistry;
  readonly #surface: BrowserContributionSurface;
  readonly #role: BrowserRole;
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
      if (active.binding.kind !== "element") {
        this.#onError(new TypeError(
          `host outlet ${this.#surface} cannot mount ${active.binding.kind} contribution ` +
          `${active.addonId}:${active.descriptor.id}`,
        ));
        continue;
      }
      const key = contributionKey(active);
      let mounted = this.#mounted.get(key);
      if (mounted === undefined || mounted.tag !== active.binding.tag) {
        try {
          mounted = this.#create(active, active.binding.tag);
          this.#mounted.set(key, mounted);
        } catch (cause: unknown) {
          this.#onError(cause);
          continue;
        }
      }
      retained.add(key);
      ordered.push(mounted.wrapper);
    }
    for (const key of this.#mounted.keys()) {
      if (!retained.has(key)) {
        this.#mounted.delete(key);
      }
    }
    try {
      this.#root.replaceChildren(...ordered);
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
    this.#mounted.clear();
    this.#root.replaceChildren();
    this.#root.hidden = true;
    this.#onCountChange(0);
  }

  #create(active: ActiveBrowserContribution, tag: string): MountedContribution {
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

    const element = this.#document.createElement(tag) as BrowserContributionElement;
    element.dataset["codexAddon"] = active.addonId;
    element.dataset["codexContribution"] = active.descriptor.id;
    element.codexContribution = Object.freeze({
      addon: Object.freeze({ id: active.addonId, generation: active.generationId }),
      contribution: active.descriptor,
      signal: active.signal,
    });
    wrapper.append(heading, element);
    return { tag, wrapper };
  }
}

function contributionKey(active: ActiveBrowserContribution): string {
  return `${active.addonId}:${active.generationId}:${active.descriptor.id}`;
}
