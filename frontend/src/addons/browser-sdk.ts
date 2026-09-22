import type {
  BrowserContributionDescriptor,
  BrowserContributionSurface,
  BrowserGenerationDescriptor,
  BrowserGenerationSet,
  BrowserPermissionGrant,
  BrowserRole,
} from "./generation-manager.js";
import type { Disposer, GenerationScope } from "./generation-scope.js";
import type { BrowserDataAPI } from "./data-client.js";
import type { BrowserContentAPI } from "./content-client.js";
import type { BrowserServiceAPI } from "./service-client.js";
import { BrowserContributionEdits, type BrowserContributionEditHandle } from "./edit-state.js";
import { showRuleDetails, type RuleDetails } from "./rule-details.js";
import { enhanceControls, type UIControlsHandle } from "../ui/controls.js";

const customElementPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

export interface BrowserElementBinding {
  readonly kind: "element";
  readonly tag: string;
}

export interface BrowserActionBinding {
  readonly kind: "action";
  readonly run: (request: unknown, context: BrowserInvocationContext) => unknown | Promise<unknown>;
}

export interface BrowserModelProviderBinding {
  readonly kind: "model-provider";
  readonly provide: (request: unknown, context: BrowserInvocationContext) => unknown | Promise<unknown>;
}

/** Host-only binding used to mount one sandboxed document into a visual outlet. */
export interface BrowserIsolatedFrameBinding {
  readonly kind: "isolated-frame";
  readonly mount: (host: HTMLElement, hostContext?: unknown, edits?: BrowserContributionEditHandle) => Disposer | BrowserIsolatedMount;
}

export interface BrowserIsolatedMount {
  dispose(): void;
  updateHostContext(value: unknown): void;
}

/** Host-only marker for a manifest contribution that contains no executable binding. */
export interface BrowserDeclarativeBinding {
  readonly kind: "declarative";
}

export type BrowserContributionBinding =
  | BrowserElementBinding
  | BrowserActionBinding
  | BrowserModelProviderBinding;

export type ActiveBrowserContributionBinding =
  | BrowserContributionBinding
  | BrowserIsolatedFrameBinding
  | BrowserDeclarativeBinding;

export interface BrowserInvocationContext {
  readonly signal: AbortSignal;
}

export interface BrowserContributionHandle {
  readonly descriptor: BrowserContributionDescriptor;
  dispose(): void;
}

export interface BrowserUIAPI {
  enhance(root: HTMLElement): UIControlsHandle;
  showRuleDetails(details: RuleDetails): Promise<void>;
  declarations(): readonly BrowserContributionDescriptor[];
  bind(contributionId: string, binding: BrowserContributionBinding): BrowserContributionHandle;
}

export interface BrowserCapabilityAPI {
  has(capability: string): boolean;
  require(capability: string): void;
}

export interface BrowserPermissionAPI {
  has(permission: string, resource?: string): boolean;
  resources(permission: string): readonly string[];
  require(permission: string, resource?: string): void;
}

export interface BrowserAddonContext {
  readonly addon: {
    readonly id: string;
    readonly version: string;
    readonly generation: string;
  };
  readonly signal: AbortSignal;
  readonly capabilities: BrowserCapabilityAPI;
  readonly permissions: BrowserPermissionAPI;
  readonly data: BrowserDataAPI;
  readonly content: BrowserContentAPI;
  readonly services: BrowserServiceAPI;
  readonly ui: BrowserUIAPI;
}

export interface ActiveBrowserContribution {
  readonly permissions?: readonly BrowserPermissionGrant[];
  readonly addonId: string;
  readonly generationId: string;
  readonly descriptor: BrowserContributionDescriptor;
  readonly binding: ActiveBrowserContributionBinding;
  readonly signal: AbortSignal;
}

export interface BrowserAddonSDKSession {
  readonly context: BrowserAddonContext;
  publishDeclarative(contributionId: string): BrowserContributionHandle;
  bindIsolatedCallback(
    contributionId: string,
    binding: BrowserActionBinding | BrowserModelProviderBinding,
  ): BrowserContributionHandle;
  bindIsolated(
    contributionId: string,
    binding: BrowserIsolatedFrameBinding,
  ): BrowserContributionHandle;
  dispose(): void;
}

export type BrowserContributionListener = () => void;
export type BrowserDataAPIFactory = (
  descriptor: BrowserGenerationDescriptor,
  signal: AbortSignal,
) => BrowserDataAPI;
export type BrowserContentAPIFactory = (
  descriptor: BrowserGenerationDescriptor,
  signal: AbortSignal,
) => BrowserContentAPI;
export type BrowserServiceAPIFactory = (
  descriptor: BrowserGenerationDescriptor,
  signal: AbortSignal,
) => BrowserServiceAPI;

export class BrowserSDKAuthorityError extends Error {
  override readonly name = "BrowserSDKAuthorityError";
}

export class BrowserContributionBindingError extends Error {
  override readonly name = "BrowserContributionBindingError";
}

interface RegisteredContribution extends ActiveBrowserContribution {
  readonly key: string;
}

/** Host-owned registry of the contribution implementations active right now. */
export class BrowserContributionRegistry {
  readonly edits = new BrowserContributionEdits();
  readonly #active = new Map<string, RegisteredContribution>();
  readonly #listeners = new Set<BrowserContributionListener>();
  readonly #onObserverError: (cause: unknown) => void;
  readonly #createDataAPI: BrowserDataAPIFactory;
  readonly #createContentAPI: BrowserContentAPIFactory;
  readonly #createServiceAPI: BrowserServiceAPIFactory;

  constructor(
    onObserverError: (cause: unknown) => void = () => undefined,
    createDataAPI: BrowserDataAPIFactory = () => unavailableDataAPI(),
    createContentAPI: BrowserContentAPIFactory = () => unavailableContentAPI(),
    createServiceAPI: BrowserServiceAPIFactory = () => unavailableServiceAPI(),
  ) {
    this.#onObserverError = onObserverError;
    this.#createDataAPI = createDataAPI;
    this.#createContentAPI = createContentAPI;
    this.#createServiceAPI = createServiceAPI;
  }

  open(descriptor: BrowserGenerationDescriptor, scope: GenerationScope): BrowserAddonSDKSession {
    const session = new RegistrySession(
      this.#active,
      descriptor,
      scope.signal,
      this.#createDataAPI(descriptor, scope.signal),
      this.#createContentAPI(descriptor, scope.signal),
      this.#createServiceAPI(descriptor, scope.signal),
      () => this.#changed(),
    );
    const releaseFallback = scope.add("browser SDK session", () => session.dispose());
    return {
      context: session.context,
      publishDeclarative: (contributionId) => session.publishDeclarative(contributionId),
      bindIsolatedCallback: (contributionId, binding) =>
        session.bindIsolatedCallback(contributionId, binding),
      bindIsolated: (contributionId, binding) =>
        session.bindIsolated(contributionId, binding),
      dispose: () => {
        releaseFallback();
        session.dispose();
      },
    };
  }

  list(
    surface: BrowserContributionSurface,
    role: BrowserRole,
  ): readonly ActiveBrowserContribution[] {
    return [...this.#active.values()]
      .filter((active) =>
        active.descriptor.surface === surface &&
        (active.descriptor.roles.length === 0 || active.descriptor.roles.includes(role))
      )
      .sort(compareActiveContributions)
      .map(({ key: _key, ...active }) => active);
  }

  settleGraph(graph: BrowserGenerationSet): void {
    this.edits.retain(new Set(graph.addons.filter(addon => addon.mode === "integrated").flatMap(addon =>
      addon.contributions.map(contribution => `${addon.addonId}:${contribution.id}`))));
    this.#changed();
  }

  subscribe(listener: BrowserContributionListener): Disposer {
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (cause: unknown) {
        // A host observer must not make an otherwise valid add-on binding fail.
        this.#onObserverError(cause);
      }
    }
  }
}

class RegistrySession {
  readonly context: BrowserAddonContext;
  readonly #global: Map<string, RegisteredContribution>;
  readonly #descriptor: BrowserGenerationDescriptor;
  readonly #declarations: ReadonlyMap<string, BrowserContributionDescriptor>;
  readonly #changed: BrowserContributionListener;
  readonly #active = new Map<string, RegisteredContribution>();
  #closed = false;
  readonly #uiHandles = new Set<UIControlsHandle>();

  constructor(
    global: Map<string, RegisteredContribution>,
    descriptor: BrowserGenerationDescriptor,
    signal: AbortSignal,
    data: BrowserDataAPI,
    content: BrowserContentAPI,
    services: BrowserServiceAPI,
    changed: BrowserContributionListener,
  ) {
    this.#global = global;
    this.#descriptor = descriptor;
    this.#changed = changed;
    this.#declarations = new Map(
      descriptor.contributions.map((contribution) => {
        const frozen = freezeContribution(contribution);
        return [frozen.id, frozen] as const;
      }),
    );
    const capabilities = new Set(descriptor.capabilities);
    const permissions = new Map(descriptor.permissions.map((permission) => [
      permission.id,
      Object.freeze({ id: permission.id, resources: Object.freeze([...permission.resources]) }),
    ] as const));
    this.context = Object.freeze({
      addon: Object.freeze({
        id: descriptor.addonId,
        version: descriptor.addonVersion,
        generation: descriptor.generationId,
      }),
      signal,
      capabilities: capabilityAPI(capabilities, () => !this.#closed && !signal.aborted),
      permissions: permissionAPI(permissions, () => !this.#closed && !signal.aborted),
      data,
      content,
      services,
      ui: Object.freeze({
        enhance: (root: HTMLElement): UIControlsHandle => {
          this.#assertOpen(); this.context.capabilities.require("ui.controls.v1");
          if (descriptor.mode !== "integrated") throw new BrowserSDKAuthorityError("DOM controls require an integrated contribution.");
          const handle = enhanceControls(root, { signal }); this.#uiHandles.add(handle);
          return Object.freeze({ refresh: () => { this.#assertOpen(); handle.refresh(); }, dispose: () => { handle.dispose(); this.#uiHandles.delete(handle); } });
        },
        showRuleDetails: (details: RuleDetails) => { this.#assertOpen(); this.context.capabilities.require("ui.rule-details"); return showRuleDetails(details, signal); },
        declarations: () => {
          this.#assertOpen();
          return [...this.#declarations.values()];
        },
        bind: (contributionId: string, binding: BrowserContributionBinding) =>
          this.#bind(contributionId, binding),
      }),
    });
  }

  dispose(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const handle of this.#uiHandles) handle.dispose(); this.#uiHandles.clear();
    let changed = false;
    for (const active of this.#active.values()) {
      if (this.#global.get(active.key) === active) {
        this.#global.delete(active.key);
        changed = true;
      }
    }
    this.#active.clear();
    if (changed) {
      this.#changed();
    }
  }

  publishDeclarative(contributionId: string): BrowserContributionHandle {
    this.#assertOpen();
    const declaration = this.#declaration(contributionId);
    if (expectedBindingKind(declaration.surface) !== undefined) {
      throw new BrowserContributionBindingError(
        `contribution ${contributionId} on ${declaration.surface} requires an executable binding`,
      );
    }
    return this.#register(declaration, Object.freeze({ kind: "declarative" }));
  }

  bindIsolatedCallback(
    contributionId: string,
    binding: BrowserActionBinding | BrowserModelProviderBinding,
  ): BrowserContributionHandle {
    this.#assertOpen();
    if (this.#descriptor.mode !== "isolated") {
      throw new BrowserContributionBindingError(
        `integrated add-on ${this.#descriptor.addonId} cannot bind an isolated callback`,
      );
    }
    const declaration = this.#declaration(contributionId);
    const expected = expectedBindingKind(declaration.surface);
    if (expected !== "action" && expected !== "model-provider") {
      throw new BrowserContributionBindingError(
        `isolated contribution ${contributionId} on ${declaration.surface} is not a callback surface`,
      );
    }
    return this.#register(
      declaration,
      normalizeBinding(declaration, binding, this.context.signal),
    );
  }

  bindIsolated(
    contributionId: string,
    binding: BrowserIsolatedFrameBinding,
  ): BrowserContributionHandle {
    this.#assertOpen();
    if (this.#descriptor.mode !== "isolated") {
      throw new BrowserContributionBindingError(
        `integrated add-on ${this.#descriptor.addonId} cannot bind an isolated frame`,
      );
    }
    const declaration = this.#declaration(contributionId);
    if (expectedBindingKind(declaration.surface) !== "element") {
      throw new BrowserContributionBindingError(
        `isolated contribution ${contributionId} on ${declaration.surface} is not a visual element surface`,
      );
    }
    if (typeof binding.mount !== "function") {
      throw new BrowserContributionBindingError(
        `isolated contribution ${contributionId} requires a frame mount function`,
      );
    }
    return this.#register(declaration, Object.freeze({
      kind: "isolated-frame",
      mount: binding.mount,
    }));
  }

  #bind(
    contributionId: string,
    binding: BrowserContributionBinding,
  ): BrowserContributionHandle {
    this.#assertOpen();
    const declaration = this.#declaration(contributionId);
    const normalizedBinding = normalizeBinding(declaration, binding, this.context.signal);
    return this.#register(declaration, normalizedBinding);
  }

  #register(
    declaration: BrowserContributionDescriptor,
    binding: ActiveBrowserContributionBinding,
  ): BrowserContributionHandle {
    const contributionId = declaration.id;
    if (this.#active.has(contributionId)) {
      throw new BrowserContributionBindingError(
        `contribution ${this.#descriptor.addonId}:${contributionId} is already bound`,
      );
    }
    const key = `${this.#descriptor.addonId}:${contributionId}`;
    if (this.#global.has(key)) {
      throw new BrowserContributionBindingError(`contribution ${key} is owned by another generation`);
    }
    const active: RegisteredContribution = Object.freeze({
      permissions: Object.freeze(this.#descriptor.permissions.map(grant => Object.freeze({ id: grant.id, resources: Object.freeze([...grant.resources]) }))),
      key,
      addonId: this.#descriptor.addonId,
      generationId: this.#descriptor.generationId,
      descriptor: declaration,
      binding,
      signal: this.context.signal,
    });
    this.#active.set(contributionId, active);
    this.#global.set(key, active);
    this.#changed();
    let disposed = false;
    return Object.freeze({
      descriptor: declaration,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.#active.delete(contributionId);
        if (this.#global.get(key) === active) {
          this.#global.delete(key);
          this.#changed();
        }
      },
    });
  }

  #assertOpen(): void {
    if (this.#closed || this.context.signal.aborted) {
      throw new BrowserContributionBindingError(
        `browser SDK session for ${this.#descriptor.addonId} is closed`,
      );
    }
  }

  #declaration(contributionId: string): BrowserContributionDescriptor {
    const declaration = this.#declarations.get(contributionId);
    if (declaration === undefined) {
      throw new BrowserContributionBindingError(
        `add-on ${this.#descriptor.addonId} did not declare contribution ${contributionId}`,
      );
    }
    return declaration;
  }
}

function unavailableDataAPI(): BrowserDataAPI {
  const unavailable = (): never => {
    throw new BrowserSDKAuthorityError("browser add-on data API is unavailable");
  };
  const handle = Object.freeze({
    get: unavailable,
    query: unavailable,
    put: unavailable,
    delete: unavailable,
  });
  return Object.freeze({
    collection: () => handle,
    recordExtension: () => handle,
    transact: unavailable,
  });
}

function unavailableContentAPI(): BrowserContentAPI {
  const unavailable = (): never => {
    throw new BrowserSDKAuthorityError("browser add-on content API is unavailable");
  };
  const set = Object.freeze({ get: unavailable, query: unavailable });
  return Object.freeze({ catalog: unavailable, set: () => set });
}

function unavailableServiceAPI(): BrowserServiceAPI {
  return Object.freeze({
    connect: (): never => {
      throw new BrowserSDKAuthorityError("browser add-on service API is unavailable");
    },
  });
}

function capabilityAPI(
  capabilities: ReadonlySet<string>,
  active: () => boolean,
): BrowserCapabilityAPI {
  const has = (capability: string): boolean => active() && capabilities.has(capability);
  return Object.freeze({
    has,
    require: (capability: string): void => {
      if (!has(capability)) {
        throw new BrowserSDKAuthorityError(`browser capability ${capability} is unavailable`);
      }
    },
  });
}

function permissionAPI(
  permissions: ReadonlyMap<string, BrowserPermissionGrant>,
  active: () => boolean,
): BrowserPermissionAPI {
  const has = (permission: string, resource?: string): boolean => {
    if (!active()) {
      return false;
    }
    const grant = permissions.get(permission);
    return grant !== undefined && (resource === undefined || grant.resources.includes(resource));
  };
  return Object.freeze({
    has,
    resources: (permission: string): readonly string[] =>
      active() ? permissions.get(permission)?.resources ?? [] : [],
    require: (permission: string, resource?: string): void => {
      if (!has(permission, resource)) {
        const suffix = resource === undefined ? "" : ` for resource ${resource}`;
        throw new BrowserSDKAuthorityError(`browser permission ${permission}${suffix} is unavailable`);
      }
    },
  });
}

function normalizeBinding(
  declaration: BrowserContributionDescriptor,
  binding: BrowserContributionBinding,
  signal: AbortSignal,
): BrowserContributionBinding {
  const expected = expectedBindingKind(declaration.surface);
  if (expected === undefined) {
    throw new BrowserContributionBindingError(
      `contribution ${declaration.id} on ${declaration.surface} is declarative and cannot be bound`,
    );
  }
  if (binding.kind !== expected) {
    const article = expected === "element" || expected === "action" ? "an" : "a";
    throw new BrowserContributionBindingError(
      `contribution ${declaration.id} on ${declaration.surface} requires ${article} ${expected} binding`,
    );
  }
  switch (binding.kind) {
    case "element":
      if (!customElementPattern.test(binding.tag) || binding.tag.length > 100) {
        throw new BrowserContributionBindingError(
          `contribution ${declaration.id} has an invalid custom element tag`,
        );
      }
      return Object.freeze({ kind: "element", tag: binding.tag });
    case "action":
      if (typeof binding.run !== "function") {
        throw new BrowserContributionBindingError(
          `contribution ${declaration.id} requires an action function`,
        );
      }
      return Object.freeze({
        kind: "action",
        run: (request: unknown, context: BrowserInvocationContext) => {
          signal.throwIfAborted();
          return binding.run(request, { signal: combinedSignal(signal, context.signal) });
        },
      });
    case "model-provider":
      if (typeof binding.provide !== "function") {
        throw new BrowserContributionBindingError(
          `contribution ${declaration.id} requires a model provider function`,
        );
      }
      return Object.freeze({
        kind: "model-provider",
        provide: (request: unknown, context: BrowserInvocationContext) => {
          signal.throwIfAborted();
          return binding.provide(request, { signal: combinedSignal(signal, context.signal) });
        },
      });
  }
}

function combinedSignal(generation: AbortSignal, invocation: AbortSignal): AbortSignal {
  return generation === invocation ? generation : AbortSignal.any([generation, invocation]);
}

function expectedBindingKind(
  surface: BrowserContributionSurface,
): BrowserContributionBinding["kind"] | undefined {
  switch (surface) {
    case "sidebar":
      return undefined;
    case "article-action":
      return "action";
    case "graph-view":
    case "graph-contributor":
    case "wiki-kind":
      return "model-provider";
    default:
      return "element";
  }
}

function compareActiveContributions(
  left: RegisteredContribution,
  right: RegisteredContribution,
): number {
  return left.descriptor.order - right.descriptor.order ||
    left.addonId.localeCompare(right.addonId) ||
    left.descriptor.id.localeCompare(right.descriptor.id);
}

function freezeContribution(
  contribution: BrowserContributionDescriptor,
): BrowserContributionDescriptor {
  return Object.freeze({
    id: contribution.id,
    surface: contribution.surface,
    label: contribution.label,
    roles: Object.freeze([...contribution.roles]),
    order: contribution.order,
    requires: Object.freeze([...contribution.requires]),
    config: freezeJSONRecord(contribution.config),
  });
}

function freezeJSONRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    result[key] = freezeJSONValue(value[key]);
  }
  return Object.freeze(result);
}

function freezeJSONValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJSONValue(item)));
  }
  if (typeof value === "object" && value !== null) {
    return freezeJSONRecord(value as Readonly<Record<string, unknown>>);
  }
  return value;
}
