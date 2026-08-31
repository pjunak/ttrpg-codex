import type {
  BrowserContributionDescriptor,
  BrowserContributionSurface,
  BrowserGenerationDescriptor,
  BrowserPermissionGrant,
  BrowserRole,
} from "./generation-manager.js";
import type { GenerationScope } from "./generation-scope.js";

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

export type BrowserContributionBinding =
  | BrowserElementBinding
  | BrowserActionBinding
  | BrowserModelProviderBinding;

export interface BrowserInvocationContext {
  readonly signal: AbortSignal;
}

export interface BrowserContributionHandle {
  readonly descriptor: BrowserContributionDescriptor;
  dispose(): void;
}

export interface BrowserUIAPI {
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
  readonly ui: BrowserUIAPI;
}

export interface ActiveBrowserContribution {
  readonly addonId: string;
  readonly generationId: string;
  readonly descriptor: BrowserContributionDescriptor;
  readonly binding: BrowserContributionBinding;
  readonly signal: AbortSignal;
}

export interface BrowserAddonSDKSession {
  readonly context: BrowserAddonContext;
  dispose(): void;
}

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
  readonly #active = new Map<string, RegisteredContribution>();

  open(descriptor: BrowserGenerationDescriptor, scope: GenerationScope): BrowserAddonSDKSession {
    const session = new RegistrySession(this.#active, descriptor, scope.signal);
    const releaseFallback = scope.add("browser SDK session", () => session.dispose());
    return {
      context: session.context,
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
}

class RegistrySession {
  readonly context: BrowserAddonContext;
  readonly #global: Map<string, RegisteredContribution>;
  readonly #descriptor: BrowserGenerationDescriptor;
  readonly #declarations: ReadonlyMap<string, BrowserContributionDescriptor>;
  readonly #active = new Map<string, RegisteredContribution>();
  #closed = false;

  constructor(
    global: Map<string, RegisteredContribution>,
    descriptor: BrowserGenerationDescriptor,
    signal: AbortSignal,
  ) {
    this.#global = global;
    this.#descriptor = descriptor;
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
      ui: Object.freeze({
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
    for (const active of this.#active.values()) {
      if (this.#global.get(active.key) === active) {
        this.#global.delete(active.key);
      }
    }
    this.#active.clear();
  }

  #bind(
    contributionId: string,
    binding: BrowserContributionBinding,
  ): BrowserContributionHandle {
    this.#assertOpen();
    const declaration = this.#declarations.get(contributionId);
    if (declaration === undefined) {
      throw new BrowserContributionBindingError(
        `add-on ${this.#descriptor.addonId} did not declare contribution ${contributionId}`,
      );
    }
    if (this.#active.has(contributionId)) {
      throw new BrowserContributionBindingError(
        `contribution ${this.#descriptor.addonId}:${contributionId} is already bound`,
      );
    }
    const normalizedBinding = normalizeBinding(declaration, binding, this.context.signal);
    const key = `${this.#descriptor.addonId}:${contributionId}`;
    if (this.#global.has(key)) {
      throw new BrowserContributionBindingError(`contribution ${key} is owned by another generation`);
    }
    const active: RegisteredContribution = Object.freeze({
      key,
      addonId: this.#descriptor.addonId,
      generationId: this.#descriptor.generationId,
      descriptor: declaration,
      binding: normalizedBinding,
      signal: this.context.signal,
    });
    this.#active.set(contributionId, active);
    this.#global.set(key, active);
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
        run: (request: unknown) => {
          signal.throwIfAborted();
          return binding.run(request, { signal });
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
        provide: (request: unknown) => {
          signal.throwIfAborted();
          return binding.provide(request, { signal });
        },
      });
  }
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
