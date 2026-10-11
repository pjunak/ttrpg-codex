/**
 * Public types for browser add-on modules: the `activate(context)` entry, its
 * SDK handles and the context given to mounted contribution elements.
 *
 * Add-ons copy this file together with contribution-edits.d.ts and
 * ui-controls.d.ts from the host version they build against. The host's own
 * implementation is type-checked against it. See examples/addons/API_V3.md.
 */
import type { BrowserContributionEditHandle } from "./contribution-edits.js";
import type { UIControlsHandle } from "./ui-controls.js";

export type AddonRole = "dm" | "player";

export type ContributionSurface =
  | "route"
  | "sidebar"
  | "settings"
  | "article-action"
  | "article-section"
  | "editor-panel"
  | "slot"
  | "wiki-kind"
  | "graph-view"
  | "graph-contributor";

export interface ContributionDeclaration {
  readonly id: string;
  readonly surface: ContributionSurface;
  readonly label: string;
  readonly roles: readonly AddonRole[];
  readonly order: number;
  readonly requires: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
}

// --- Saved add-on data -----------------------------------------------------

export type DataKind = "collection" | "record-extension";

export interface AddonDocument<T> {
  readonly key: string;
  readonly revision: number;
  readonly value: T;
}

export interface QueryCondition {
  readonly path: string;
  readonly equals: unknown;
}

export interface QueryOptions {
  readonly includeDataRevision?: boolean;
  readonly expectedDataRevision?: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly where?: readonly QueryCondition[];
  readonly signal?: AbortSignal;
}

export interface QueryResult<T> {
  readonly dataRevision?: number;
  readonly documents: readonly AddonDocument<T>[];
  readonly nextCursor?: string;
}

export type DataMutation<T = unknown> =
  | {
      readonly operation: "put";
      readonly kind: DataKind;
      readonly dataId: string;
      readonly key: string;
      readonly expectedRevision: number;
      readonly value: T;
    }
  | {
      readonly operation: "delete";
      readonly kind: DataKind;
      readonly dataId: string;
      readonly key: string;
      readonly expectedRevision: number;
    };

export interface MutationResult {
  readonly kind: DataKind;
  readonly dataId: string;
  readonly key: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly deleted: boolean;
}

export interface DataSetRevision {
  readonly kind: DataKind;
  readonly dataId: string;
  readonly revision: number;
}

export interface CommitReceipt {
  readonly contractVersion: "addon-data-commit.v1";
  readonly commitId: number;
  readonly occurredAt: string;
  readonly results: readonly MutationResult[];
  readonly dataSets: readonly DataSetRevision[];
}

export interface DataHandle<T> {
  get(key: string, options?: { readonly signal?: AbortSignal }): Promise<AddonDocument<T>>;
  query(options?: QueryOptions): Promise<QueryResult<T>>;
  put(
    key: string,
    value: T,
    expectedRevision: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CommitReceipt>;
  delete(
    key: string,
    expectedRevision: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CommitReceipt>;
}

/** Invalidations carry no records or revisions; read again to see changes. */
export type DataChange =
  | { readonly reason: "changed"; readonly kind: DataKind; readonly dataId: string }
  | { readonly reason: "reset" };

export interface DataAPI {
  /** Absent where the host has no live event stream. */
  readonly subscribe?: (
    listener: (change: DataChange) => void,
    options?: { readonly signal?: AbortSignal },
  ) => () => void;
  collection<T>(id: string): DataHandle<T>;
  recordExtension<T>(target: string, id: string): DataHandle<T>;
  transact(
    mutations: readonly DataMutation[],
    options?: {
      readonly signal?: AbortSignal;
      readonly expectedDataSets?: readonly DataSetRevision[];
    },
  ): Promise<CommitReceipt>;
}

// --- Immutable package content ----------------------------------------------

export interface ContentSetDescription {
  readonly id: string;
  readonly revision: string;
  readonly groups?: {
    readonly field: string;
    readonly additionalField?: string;
    readonly label: string;
  };
  readonly schemaSha256: string;
  readonly recordCount: number;
  readonly kinds: Readonly<Record<string, number>>;
}

export interface ContentCatalog {
  readonly sets: readonly ContentSetDescription[];
}

export interface ContentRecord<T> {
  readonly kind: string;
  readonly id: string;
  readonly value: T;
}

export interface ContentQueryResult<T> {
  readonly revision: string;
  readonly records: readonly ContentRecord<T>[];
  readonly nextCursor?: string;
}

export interface ContentSet<T> {
  get(
    kind: string,
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ContentRecord<T>>;
  query(options?: {
    readonly kind?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<ContentQueryResult<T>>;
}

export interface ContentAPI {
  catalog(options?: { readonly signal?: AbortSignal }): Promise<ContentCatalog>;
  set<T>(id: string): ContentSet<T>;
}

// --- Services --------------------------------------------------------------

export interface ServiceProvider {
  readonly addonId: string;
  readonly contractVersion: string;
  readonly generation: string;
  readonly bindingRevision: number;
}

export interface ServiceCallOptions {
  /** Required for a "many" connection; one of the handle's providers. */
  readonly providerAddonId?: string;
  readonly deadlineMs?: number;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface ServiceHandle {
  readonly contract: string;
  readonly range: string;
  readonly cardinality: "one" | "many";
  readonly providers: readonly ServiceProvider[];
  readonly available: boolean;
  call<TResponse = unknown>(
    method: string,
    params: unknown,
    options?: ServiceCallOptions,
  ): Promise<TResponse>;
}

export interface ServiceAPI {
  /** Repeats a consumer requirement declared in the manifest. */
  connect(
    contract: string,
    options: {
      readonly range: string;
      readonly cardinality: "one" | "many";
      readonly includeOwn?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<ServiceHandle>;
  /** Requires services.own: this package's own worker provider of `contract`. */
  own(contract: string, options?: { readonly signal?: AbortSignal }): Promise<ServiceHandle>;
}

// --- UI --------------------------------------------------------------------

export interface InvocationContext {
  readonly signal: AbortSignal;
}

export type ContributionBinding =
  | { readonly kind: "element"; readonly tag: string }
  | {
      readonly kind: "action";
      readonly run: (request: unknown, context: InvocationContext) => unknown;
    }
  | {
      readonly kind: "model-provider";
      readonly provide: (request: unknown, context: InvocationContext) => unknown;
    };

export interface ContributionHandle {
  readonly descriptor: ContributionDeclaration;
  dispose(): void;
}

export interface RuleReference {
  readonly kind: string;
  readonly id: string;
}

/** Contextual rule explanation; see docs/reference/RULE_DETAILS.md. */
export interface RuleDetails {
  readonly label: string;
  readonly reference?: RuleReference;
  readonly wiki?: { readonly label: string; readonly hint: string };
  readonly summary?: string;
  readonly savedSources?: readonly {
    readonly reference: RuleReference;
    readonly name: string;
    readonly summary: string;
    readonly hash: string;
  }[];
  readonly explanation?: {
    readonly label: string;
    readonly formula: string;
    readonly value: unknown;
    readonly unit?: string;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly terms: readonly {
      readonly label: string;
      readonly value: unknown;
      readonly source?: RuleReference;
      readonly status?: string;
      readonly grantId?: string;
    }[];
    readonly sources: readonly RuleReference[];
  };
}

export interface UIAPI {
  /** Requires ui.controls.v1. */
  enhance(root: HTMLElement): UIControlsHandle;
  /** Requires ui.rule-details. Settles when the panel closes. */
  showRuleDetails(details: RuleDetails): Promise<void>;
  declarations(): readonly ContributionDeclaration[];
  bind(contributionId: string, binding: ContributionBinding): ContributionHandle;
}

// --- Activation ------------------------------------------------------------

export interface AddonContext {
  readonly addon: {
    readonly id: string;
    readonly version: string;
    readonly generation: string;
  };
  /** Aborts when this generation is replaced, disabled or signed out. */
  readonly signal: AbortSignal;
  readonly capabilities: {
    has(capability: string): boolean;
    require(capability: string): void;
  };
  readonly permissions: {
    has(permission: string, resource?: string): boolean;
    resources(permission: string): readonly string[];
    require(permission: string, resource?: string): void;
  };
  readonly data: DataAPI;
  readonly content: ContentAPI;
  readonly services: ServiceAPI;
  readonly ui: UIAPI;
}

export interface Disposable {
  dispose(): void | Promise<void>;
}

/** The entry module's export. */
export type Activate = (context: AddonContext) => void | Disposable | Promise<void | Disposable>;

/**
 * Set as `codexContribution` on every mounted contribution element. `host` is
 * the surface's own context (route, record, timeline, settings, ...); narrow
 * it with that surface's documented shape.
 */
export interface ContributionElementContext<THost = unknown> {
  readonly edits: BrowserContributionEditHandle;
  readonly addon: {
    readonly id: string;
    readonly generation: string;
  };
  readonly contribution: ContributionDeclaration;
  readonly signal: AbortSignal;
  readonly host: THost;
}
