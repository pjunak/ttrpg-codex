import {
  BrowserGraphClient,
  BrowserGraphRefreshInvalidatedError,
  type BrowserGraphRefresh,
} from "./browser-graph-client.js";
import {
  BrowserGenerationManager,
  type BrowserGenerationDescriptor,
  type BrowserReconcileResult,
  type BrowserDisposalFailure,
} from "./generation-manager.js";
import type { GenerationStopReason } from "./generation-scope.js";

export interface BrowserAddonRefreshResult {
  readonly transport: BrowserGraphRefresh;
  readonly lifecycle: BrowserReconcileResult;
}

/**
 * Serializes the complete fetch-to-activation operation for browser add-ons.
 * A failed refresh leaves the current generation graph running. Reset clears
 * conditional HTTP authority immediately, then disposes lifecycle state after
 * any operation already in progress has settled.
 */
export class BrowserAddonRuntime {
  readonly #client: BrowserGraphClient;
  readonly #manager: BrowserGenerationManager;
  #authorityEpoch = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(client: BrowserGraphClient, manager: BrowserGenerationManager) {
    this.#client = client;
    this.#manager = manager;
  }

  activeGenerations(): readonly BrowserGenerationDescriptor[] {
    return this.#manager.activeGenerations();
  }

  refresh(signal: AbortSignal): Promise<BrowserAddonRefreshResult> {
    const authorityEpoch = this.#authorityEpoch;
    const operation = this.#tail.then(async () => {
      this.#assertCurrentAuthority(authorityEpoch);
      const transport = await this.#client.refresh(signal);
      this.#assertCurrentAuthority(authorityEpoch);
      const lifecycle = await this.#manager.reconcile(transport.graph);
      this.#assertCurrentAuthority(authorityEpoch);
      return { transport, lifecycle };
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  reset(
    reason: GenerationStopReason = "disabled",
  ): Promise<readonly BrowserDisposalFailure[]> {
    this.#authorityEpoch += 1;
    this.#client.reset();
    const operation = this.#tail.then(() => this.#manager.dispose(reason));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #assertCurrentAuthority(authorityEpoch: number): void {
    if (authorityEpoch !== this.#authorityEpoch) {
      throw new BrowserGraphRefreshInvalidatedError();
    }
  }
}
