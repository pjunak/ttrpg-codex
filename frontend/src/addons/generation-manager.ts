import {
  GenerationScope,
  type Disposer,
  type GenerationStopReason,
} from "./generation-scope.js";

const addonIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface BrowserGenerationDescriptor {
  readonly addonId: string;
  readonly generationId: string;
  readonly entryUrl: string;
  readonly dependencies: readonly string[];
}

export interface BrowserGenerationSet {
  readonly graphRevision: string;
  readonly addons: readonly BrowserGenerationDescriptor[];
}

export interface BrowserGenerationContext {
  readonly addonId: string;
  readonly generationId: string;
  readonly signal: AbortSignal;
  readonly scope: GenerationScope;
}

export type BrowserGenerationActivator = (
  descriptor: BrowserGenerationDescriptor,
  context: BrowserGenerationContext,
) => void | Disposer | Promise<void | Disposer>;

export interface BrowserGenerationModule {
  activate(context: BrowserGenerationContext): void | Disposer | Promise<void | Disposer>;
}

export type BrowserGenerationImporter = (entryUrl: string) => Promise<unknown>;

export interface BrowserActivationFailure {
  readonly addonId: string;
  readonly generationId: string;
  readonly kind: "activation" | "dependency";
  readonly cause: unknown;
}

export interface BrowserDisposalFailure {
  readonly addonId: string;
  readonly generationId: string;
  readonly cause: unknown;
}

export interface BrowserReconcileResult {
  readonly graphRevision: string;
  readonly active: readonly BrowserGenerationDescriptor[];
  readonly activationFailures: readonly BrowserActivationFailure[];
  readonly disposalFailures: readonly BrowserDisposalFailure[];
}

interface ActiveGeneration {
  readonly descriptor: BrowserGenerationDescriptor;
  readonly scope: GenerationScope;
}

interface NormalizedGenerationSet {
  readonly graphRevision: string;
  readonly addons: ReadonlyMap<string, BrowserGenerationDescriptor>;
  readonly activationOrder: readonly string[];
}

export class BrowserGenerationPlanError extends Error {
  override readonly name = "BrowserGenerationPlanError";
}

export class BrowserDependencyActivationError extends Error {
  override readonly name = "BrowserDependencyActivationError";

  constructor(
    readonly addonId: string,
    readonly unavailableDependencies: readonly string[],
  ) {
    super(
      `add-on ${addonId} cannot activate because dependencies failed: ${unavailableDependencies.join(", ")}`,
    );
  }
}

/**
 * Reconciles one server-authoritative browser add-on graph at a time.
 *
 * Any graph revision change deliberately performs a cold graph restart. The
 * suite has few add-ons, so this keeps teardown, rebinding, and recovery
 * deterministic without maintaining two simultaneous contribution graphs.
 */
export class BrowserGenerationManager {
  readonly #activator: BrowserGenerationActivator;
  readonly #active = new Map<string, ActiveGeneration>();
  #graphRevision = "";
  #tail: Promise<void> = Promise.resolve();

  constructor(activator: BrowserGenerationActivator) {
    this.#activator = activator;
  }

  get graphRevision(): string {
    return this.#graphRevision;
  }

  activeGenerations(): readonly BrowserGenerationDescriptor[] {
    return [...this.#active.values()]
      .map((active) => active.descriptor)
      .sort((left, right) => left.addonId.localeCompare(right.addonId));
  }

  reconcile(target: BrowserGenerationSet): Promise<BrowserReconcileResult> {
    const normalized = normalizeGenerationSet(target);
    const operation = this.#tail.then(() => this.#reconcile(normalized));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  dispose(reason: GenerationStopReason = "disabled"): Promise<readonly BrowserDisposalFailure[]> {
    const operation = this.#tail.then(async () => {
      const failures = await this.#disposeActive(new Map(), reason, reason);
      this.#graphRevision = "";
      return failures;
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #reconcile(target: NormalizedGenerationSet): Promise<BrowserReconcileResult> {
    if (this.#matches(target)) {
      return {
        graphRevision: target.graphRevision,
        active: this.activeGenerations(),
        activationFailures: [],
        disposalFailures: [],
      };
    }

    const disposalFailures = await this.#disposeActive(target.addons, "reload", "disabled");
    const activationFailures: BrowserActivationFailure[] = [];

    for (const addonId of target.activationOrder) {
      const descriptor = target.addons.get(addonId);
      if (descriptor === undefined) {
        throw new BrowserGenerationPlanError(`activation order references missing add-on ${addonId}`);
      }
      const unavailableDependencies = descriptor.dependencies.filter(
        (dependencyId) => !this.#active.has(dependencyId),
      );
      if (unavailableDependencies.length > 0) {
        activationFailures.push({
          addonId,
          generationId: descriptor.generationId,
          kind: "dependency",
          cause: new BrowserDependencyActivationError(addonId, unavailableDependencies),
        });
        continue;
      }

      const scope = new GenerationScope(`${addonId}@${descriptor.generationId}`);
      try {
        const disposer = await this.#activator(descriptor, {
          addonId,
          generationId: descriptor.generationId,
          signal: scope.signal,
          scope,
        });
        if (disposer !== undefined) {
          scope.add("module activation", disposer);
        }
        scope.assertActive();
        this.#active.set(addonId, { descriptor, scope });
      } catch (cause: unknown) {
        activationFailures.push({
          addonId,
          generationId: descriptor.generationId,
          kind: "activation",
          cause,
        });
        try {
          await scope.dispose("activation-failed");
        } catch (disposalCause: unknown) {
          disposalFailures.push({
            addonId,
            generationId: descriptor.generationId,
            cause: disposalCause,
          });
        }
      }
    }

    this.#graphRevision = target.graphRevision;
    return {
      graphRevision: target.graphRevision,
      active: this.activeGenerations(),
      activationFailures,
      disposalFailures,
    };
  }

  async #disposeActive(
    target: ReadonlyMap<string, BrowserGenerationDescriptor>,
    fallbackReason: GenerationStopReason,
    absentReason: GenerationStopReason,
  ): Promise<BrowserDisposalFailure[]> {
    const descriptors = new Map(
      [...this.#active.entries()].map(([addonId, active]) => [addonId, active.descriptor]),
    );
    const order = topologicalOrder(descriptors).reverse();
    const failures: BrowserDisposalFailure[] = [];
    for (const addonId of order) {
      const active = this.#active.get(addonId);
      if (active === undefined) {
        continue;
      }
      this.#active.delete(addonId);
      const next = target.get(addonId);
      const reason: GenerationStopReason =
        next === undefined
          ? absentReason
          : next.generationId !== active.descriptor.generationId
            ? "updated"
            : fallbackReason;
      try {
        await active.scope.dispose(reason);
      } catch (cause: unknown) {
        failures.push({
          addonId,
          generationId: active.descriptor.generationId,
          cause,
        });
      }
    }
    return failures;
  }

  #matches(target: NormalizedGenerationSet): boolean {
    if (this.#graphRevision !== target.graphRevision || this.#active.size !== target.addons.size) {
      return false;
    }
    for (const [addonId, descriptor] of target.addons) {
      const active = this.#active.get(addonId);
      if (active === undefined || !sameDescriptor(active.descriptor, descriptor)) {
        return false;
      }
    }
    return true;
  }
}

export function createModuleActivator(
  importModule: BrowserGenerationImporter,
): BrowserGenerationActivator {
  return async (descriptor, context) => {
    const imported = await importModule(descriptor.entryUrl);
    if (!isBrowserGenerationModule(imported)) {
      throw new TypeError(`browser add-on module ${descriptor.entryUrl} must export activate(context)`);
    }
    return imported.activate(context);
  };
}

function normalizeGenerationSet(target: BrowserGenerationSet): NormalizedGenerationSet {
  if (!validToken(target.graphRevision, 200)) {
    throw new BrowserGenerationPlanError("graphRevision must be a non-empty bounded token");
  }
  if (target.addons.length > 100) {
    throw new BrowserGenerationPlanError("browser add-on graph exceeds 100 generations");
  }
  const addons = new Map<string, BrowserGenerationDescriptor>();
  for (const input of target.addons) {
    if (!addonIdPattern.test(input.addonId) || input.addonId.length > 80) {
      throw new BrowserGenerationPlanError(`invalid add-on id ${JSON.stringify(input.addonId)}`);
    }
    if (!validToken(input.generationId, 200)) {
      throw new BrowserGenerationPlanError(`invalid generation id for ${input.addonId}`);
    }
    if (!validSameOriginPath(input.entryUrl)) {
      throw new BrowserGenerationPlanError(`invalid entry URL for ${input.addonId}`);
    }
    if (addons.has(input.addonId)) {
      throw new BrowserGenerationPlanError(`duplicate add-on ${input.addonId}`);
    }
    const dependencies = [...input.dependencies].sort();
    for (let index = 0; index < dependencies.length; index += 1) {
      const dependencyId = dependencies[index];
      if (
        dependencyId === undefined ||
        !addonIdPattern.test(dependencyId) ||
        dependencyId === input.addonId ||
        (index > 0 && dependencies[index - 1] === dependencyId)
      ) {
        throw new BrowserGenerationPlanError(`invalid dependency list for ${input.addonId}`);
      }
    }
    addons.set(input.addonId, {
      addonId: input.addonId,
      generationId: input.generationId,
      entryUrl: input.entryUrl,
      dependencies,
    });
  }
  return {
    graphRevision: target.graphRevision,
    addons,
    activationOrder: topologicalOrder(addons),
  };
}

function topologicalOrder(
  addons: ReadonlyMap<string, BrowserGenerationDescriptor>,
): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (addonId: string): void => {
    if (visited.has(addonId)) {
      return;
    }
    if (visiting.has(addonId)) {
      throw new BrowserGenerationPlanError(`browser add-on dependency cycle includes ${addonId}`);
    }
    const descriptor = addons.get(addonId);
    if (descriptor === undefined) {
      throw new BrowserGenerationPlanError(`missing browser add-on dependency ${addonId}`);
    }
    visiting.add(addonId);
    for (const dependencyId of descriptor.dependencies) {
      if (!addons.has(dependencyId)) {
        throw new BrowserGenerationPlanError(
          `${addonId} requires missing browser add-on ${dependencyId}`,
        );
      }
      visit(dependencyId);
    }
    visiting.delete(addonId);
    visited.add(addonId);
    ordered.push(addonId);
  };
  for (const addonId of [...addons.keys()].sort()) {
    visit(addonId);
  }
  return ordered;
}

function sameDescriptor(
  left: BrowserGenerationDescriptor,
  right: BrowserGenerationDescriptor,
): boolean {
  return (
    left.addonId === right.addonId &&
    left.generationId === right.generationId &&
    left.entryUrl === right.entryUrl &&
    left.dependencies.length === right.dependencies.length &&
    left.dependencies.every((dependencyId, index) => dependencyId === right.dependencies[index])
  );
}

function isBrowserGenerationModule(value: unknown): value is BrowserGenerationModule {
  return typeof value === "object" && value !== null && "activate" in value &&
    typeof value.activate === "function";
}

function validToken(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength && !hasControl(value);
}

function validSameOriginPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 2_000 ||
    hasControl(value) ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://codex.invalid");
    return parsed.origin === "https://codex.invalid" && parsed.hash === "";
  } catch {
    return false;
  }
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
