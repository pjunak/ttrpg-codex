import {
  GenerationScope,
  type Disposer,
  type GenerationStopReason,
} from "./generation-scope.js";
import type {
  BrowserAddonContext,
  BrowserAddonSDKSession,
} from "./browser-sdk.js";

const addonIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const localIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const contractIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;

export type BrowserRole = "dm" | "player";

export type BrowserContributionSurface =
  | "route"
  | "sidebar"
  | "settings"
  | "article-action"
  | "article-section"
  | "editor-panel"
  | "slot"
  | "record-renderer"
  | "wiki-kind"
  | "graph-node-kind"
  | "graph-view"
  | "graph-contributor";

export interface BrowserPermissionGrant {
  readonly id: string;
  readonly resources: readonly string[];
}

export interface BrowserContributionDescriptor {
  readonly id: string;
  readonly surface: BrowserContributionSurface;
  readonly label: string;
  readonly roles: readonly BrowserRole[];
  readonly order: number;
  readonly requires: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
}

export interface BrowserGenerationDescriptor {
  readonly addonId: string;
  readonly addonVersion: string;
  readonly generationId: string;
  readonly mode: "integrated" | "isolated";
  readonly entryUrl: string;
  readonly styleUrls: readonly string[];
  readonly sandbox: readonly ("downloads" | "forms" | "modals" | "popups")[];
  readonly dependencies: readonly string[];
  readonly capabilities: readonly string[];
  readonly permissions: readonly BrowserPermissionGrant[];
  readonly contributions: readonly BrowserContributionDescriptor[];
}

export interface BrowserGenerationSet {
  readonly contractVersion: 2;
  readonly graphRevision: string;
  readonly addons: readonly BrowserGenerationDescriptor[];
}

export interface BrowserGenerationContext {
  readonly addonId: string;
  readonly addonVersion: string;
  readonly generationId: string;
  readonly signal: AbortSignal;
  readonly scope: GenerationScope;
}

export type BrowserGenerationActivator = (
  descriptor: BrowserGenerationDescriptor,
  context: BrowserGenerationContext,
) => void | Disposer | Promise<void | Disposer>;

export interface BrowserGenerationModule {
  activate(
    context: BrowserAddonContext,
  ): void | BrowserGenerationDisposable | Promise<void | BrowserGenerationDisposable>;
}

export interface BrowserGenerationDisposable {
  dispose(): void | Promise<void>;
}

export type BrowserGenerationImporter = (entryUrl: string) => Promise<unknown>;

export type BrowserAddonSDKFactory = (
  descriptor: BrowserGenerationDescriptor,
  scope: GenerationScope,
) => BrowserAddonSDKSession;

export type BrowserGenerationResourceFactory = (
  descriptor: BrowserGenerationDescriptor,
  scope: GenerationScope,
) => void | Disposer | Promise<void | Disposer>;

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
          addonVersion: descriptor.addonVersion,
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

/** Validates and returns one detached, canonical browser graph value. */
export function validateBrowserGenerationSet(target: BrowserGenerationSet): BrowserGenerationSet {
  const normalized = normalizeGenerationSet(target);
  return {
    contractVersion: 2,
    graphRevision: normalized.graphRevision,
    addons: [...normalized.addons.values()].sort((left, right) =>
      left.addonId.localeCompare(right.addonId)
    ),
  };
}

export function createModuleActivator(
  importModule: BrowserGenerationImporter,
  createSDK: BrowserAddonSDKFactory,
  prepareResources: BrowserGenerationResourceFactory = () => undefined,
): BrowserGenerationActivator {
  return async (descriptor, context) => {
    if (descriptor.mode !== "integrated") {
      throw new TypeError(`browser add-on ${descriptor.addonId} is not an integrated module`);
    }
    const resourceDisposer = await prepareResources(descriptor, context.scope);
    const releaseResourceFallback = resourceDisposer === undefined
      ? undefined
      : context.scope.add("browser generation resources", resourceDisposer);
    const sdk = createSDK(descriptor, context.scope);
    const imported = await importModule(descriptor.entryUrl);
    if (!isBrowserGenerationModule(imported)) {
      throw new TypeError(`browser add-on module ${descriptor.entryUrl} must export activate(context)`);
    }
    const disposable = await imported.activate(sdk.context);
    if (disposable !== undefined && !isBrowserGenerationDisposable(disposable)) {
      throw new TypeError(
        `browser add-on module ${descriptor.entryUrl} activate(context) must return { dispose() } or undefined`,
      );
    }
    return async () => {
      sdk.dispose();
      try {
        await disposable?.dispose();
      } finally {
        releaseResourceFallback?.();
        await resourceDisposer?.();
      }
    };
  };
}

function normalizeGenerationSet(target: BrowserGenerationSet): NormalizedGenerationSet {
  if (target.contractVersion !== 2) {
    throw new BrowserGenerationPlanError("unsupported browser graph contract version");
  }
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
    if (!validToken(input.addonVersion, 100)) {
      throw new BrowserGenerationPlanError(`invalid add-on version for ${input.addonId}`);
    }
    if (!validSameOriginPath(input.entryUrl)) {
      throw new BrowserGenerationPlanError(`invalid entry URL for ${input.addonId}`);
    }
    if (input.mode !== "integrated" && input.mode !== "isolated") {
      throw new BrowserGenerationPlanError(`invalid UI mode for ${input.addonId}`);
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
    const styleUrls = sortedUnique(input.styleUrls, (value) => validSameOriginPath(value));
    if (styleUrls === undefined) {
      throw new BrowserGenerationPlanError(`invalid style URL list for ${input.addonId}`);
    }
    const sandbox = sortedUnique(
      input.sandbox,
      (value) => value === "downloads" || value === "forms" || value === "modals" || value === "popups",
    );
    if (sandbox === undefined || input.mode === "integrated" && sandbox.length > 0) {
      throw new BrowserGenerationPlanError(`invalid sandbox list for ${input.addonId}`);
    }
    const capabilities = sortedUnique(
      input.capabilities,
      (value) => contractIdPattern.test(value) && value.length <= 120,
    );
    if (capabilities === undefined || capabilities.length > 200) {
      throw new BrowserGenerationPlanError(`invalid capability list for ${input.addonId}`);
    }
    const permissions = normalizePermissions(input.addonId, input.permissions);
    const contributions = normalizeContributions(
      input.addonId,
      input.contributions,
      new Set(capabilities),
    );
    addons.set(input.addonId, {
      addonId: input.addonId,
      addonVersion: input.addonVersion,
      generationId: input.generationId,
      mode: input.mode,
      entryUrl: input.entryUrl,
      styleUrls,
      sandbox,
      dependencies,
      capabilities,
      permissions,
      contributions,
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
    left.addonVersion === right.addonVersion &&
    left.generationId === right.generationId &&
    left.mode === right.mode &&
    left.entryUrl === right.entryUrl &&
    sameStrings(left.styleUrls, right.styleUrls) &&
    sameStrings(left.sandbox, right.sandbox) &&
    sameStrings(left.dependencies, right.dependencies) &&
    sameStrings(left.capabilities, right.capabilities) &&
    JSON.stringify(left.permissions) === JSON.stringify(right.permissions) &&
    JSON.stringify(left.contributions) === JSON.stringify(right.contributions)
  );
}

function normalizePermissions(
  addonId: string,
  input: readonly BrowserPermissionGrant[],
): BrowserPermissionGrant[] {
  if (input.length > 100) {
    throw new BrowserGenerationPlanError(`permission list exceeds 100 grants for ${addonId}`);
  }
  const result = input.map((permission) => {
    if (!contractIdPattern.test(permission.id) || permission.id.length > 120) {
      throw new BrowserGenerationPlanError(`invalid permission id for ${addonId}`);
    }
    const resources = sortedUnique(
      permission.resources,
      (value) => validToken(value, 300),
    );
    if (resources === undefined || resources.length > 200) {
      throw new BrowserGenerationPlanError(`invalid resources for ${addonId}:${permission.id}`);
    }
    return { id: permission.id, resources };
  }).sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]?.id === result[index]?.id) {
      throw new BrowserGenerationPlanError(`duplicate permission for ${addonId}`);
    }
  }
  return result;
}

function normalizeContributions(
  addonId: string,
  input: readonly BrowserContributionDescriptor[],
  capabilities: ReadonlySet<string>,
): BrowserContributionDescriptor[] {
  if (input.length > 500) {
    throw new BrowserGenerationPlanError(`contribution list exceeds 500 entries for ${addonId}`);
  }
  const result = input.map((contribution) => {
    if (!localIdPattern.test(contribution.id) || contribution.id.length > 100) {
      throw new BrowserGenerationPlanError(`invalid contribution id for ${addonId}`);
    }
    if (!validContributionSurface(contribution.surface)) {
      throw new BrowserGenerationPlanError(`invalid contribution surface for ${addonId}:${contribution.id}`);
    }
    if (!validToken(contribution.label, 120)) {
      throw new BrowserGenerationPlanError(`invalid contribution label for ${addonId}:${contribution.id}`);
    }
    if (!Number.isInteger(contribution.order) || contribution.order < -10_000 || contribution.order > 10_000) {
      throw new BrowserGenerationPlanError(`invalid contribution order for ${addonId}:${contribution.id}`);
    }
    const roles = sortedUnique(
      contribution.roles,
      (value) => value === "dm" || value === "player",
    );
    const requires = sortedUnique(
      contribution.requires,
      (value) => contractIdPattern.test(value) && value.length <= 120 && capabilities.has(value),
    );
    if (roles === undefined || requires === undefined) {
      throw new BrowserGenerationPlanError(`invalid contribution authority for ${addonId}:${contribution.id}`);
    }
    return {
      id: contribution.id,
      surface: contribution.surface,
      label: contribution.label,
      roles,
      order: contribution.order,
      requires,
      config: normalizeJSONRecord(contribution.config, `${addonId}:${contribution.id}`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]?.id === result[index]?.id) {
      throw new BrowserGenerationPlanError(`duplicate contribution for ${addonId}`);
    }
  }
  return result;
}

function validContributionSurface(value: string): value is BrowserContributionSurface {
  return value === "route" || value === "sidebar" || value === "settings" ||
    value === "article-action" || value === "article-section" || value === "editor-panel" ||
    value === "slot" || value === "record-renderer" || value === "wiki-kind" ||
    value === "graph-node-kind" || value === "graph-view" || value === "graph-contributor";
}

function normalizeJSONRecord(
  input: Readonly<Record<string, unknown>>,
  owner: string,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeJSONValue(input, owner, 0);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
    throw new BrowserGenerationPlanError(`invalid contribution config for ${owner}`);
  }
  return normalized as Readonly<Record<string, unknown>>;
}

function normalizeJSONValue(value: unknown, owner: string, depth: number): unknown {
  if (depth > 20) {
    throw new BrowserGenerationPlanError(`contribution config is too deep for ${owner}`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BrowserGenerationPlanError(`contribution config contains a non-finite number for ${owner}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw new BrowserGenerationPlanError(`contribution config array is too large for ${owner}`);
    }
    return value.map((item) => normalizeJSONValue(item, owner, depth + 1));
  }
  if (typeof value !== "object" || value === null) {
    throw new BrowserGenerationPlanError(`contribution config contains a non-JSON value for ${owner}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BrowserGenerationPlanError(`contribution config contains a non-plain object for ${owner}`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length > 1_000) {
    throw new BrowserGenerationPlanError(`contribution config object is too large for ${owner}`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new BrowserGenerationPlanError(`contribution config contains a forbidden key for ${owner}`);
    }
    result[key] = normalizeJSONValue((value as Record<string, unknown>)[key], owner, depth + 1);
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique<T extends string>(
  values: readonly T[],
  validate: (value: T) => boolean,
): T[] | undefined {
  const result = [...values].sort();
  for (let index = 0; index < result.length; index += 1) {
    const value = result[index];
    if (value === undefined || !validate(value) || index > 0 && result[index - 1] === value) {
      return undefined;
    }
  }
  return result;
}

function isBrowserGenerationModule(value: unknown): value is BrowserGenerationModule {
  return typeof value === "object" && value !== null && "activate" in value &&
    typeof value.activate === "function";
}

function isBrowserGenerationDisposable(value: unknown): value is BrowserGenerationDisposable {
  return typeof value === "object" && value !== null && "dispose" in value &&
    typeof value.dispose === "function";
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
