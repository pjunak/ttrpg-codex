export type GenerationStopReason =
  | "activation-failed"
  | "authority-changed"
  | "disabled"
  | "reload"
  | "uninstalled"
  | "updated";

export type Disposer = () => void | Promise<void>;

interface RegisteredDisposer {
  active: boolean;
  label: string;
  run: Disposer;
}

export interface DisposalFailure {
  label: string;
  cause: unknown;
}

export class GenerationClosedError extends Error {
  override readonly name = "GenerationClosedError";

  constructor(readonly generationId: string) {
    super(`add-on generation ${generationId} is no longer active`);
  }
}

export class GenerationDisposalError extends AggregateError {
  override readonly name = "GenerationDisposalError";

  constructor(
    readonly generationId: string,
    readonly reason: GenerationStopReason,
    readonly failures: readonly DisposalFailure[],
  ) {
    super(
      failures.map((failure) => failure.cause),
      `add-on generation ${generationId} failed to dispose ${failures.length} resource(s)`,
    );
  }
}

/** Owns every cancellable handle created by one activated add-on generation. */
export class GenerationScope {
  readonly #abortController = new AbortController();
  readonly #disposers: RegisteredDisposer[] = [];
  #state: "active" | "disposing" | "disposed" = "active";
  #disposal: Promise<void> | undefined;

  constructor(readonly generationId: string) {
    if (generationId.length === 0) {
      throw new TypeError("generationId must not be empty");
    }
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get active(): boolean {
    return this.#state === "active";
  }

  /** Registers cleanup and returns a function that transfers ownership away. */
  add(label: string, disposer: Disposer): () => void {
    if (!this.active) {
      throw new GenerationClosedError(this.generationId);
    }
    if (label.length === 0) {
      throw new TypeError("disposer label must not be empty");
    }
    const registered: RegisteredDisposer = { active: true, label, run: disposer };
    this.#disposers.push(registered);
    return () => {
      registered.active = false;
    };
  }

  assertActive(): void {
    if (!this.active) {
      throw new GenerationClosedError(this.generationId);
    }
  }

  dispose(reason: GenerationStopReason): Promise<void> {
    if (this.#disposal !== undefined) {
      return this.#disposal;
    }
    this.#state = "disposing";
    this.#abortController.abort(reason);
    this.#disposal = this.#drain(reason);
    return this.#disposal;
  }

  async #drain(reason: GenerationStopReason): Promise<void> {
    const failures: DisposalFailure[] = [];
    for (let index = this.#disposers.length - 1; index >= 0; index -= 1) {
      const registered = this.#disposers[index];
      if (registered?.active !== true) {
        continue;
      }
      registered.active = false;
      try {
        await registered.run();
      } catch (cause: unknown) {
        failures.push({ label: registered.label, cause });
      }
    }
    this.#state = "disposed";
    if (failures.length > 0) {
      throw new GenerationDisposalError(this.generationId, reason, failures);
    }
  }
}
