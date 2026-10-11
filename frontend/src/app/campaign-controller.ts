import type { ReactiveController, ReactiveControllerHost } from "lit";
import { uiRequestError } from "./ui-errors.js";
import {
  CampaignDataClient,
  CampaignDataRefreshInvalidatedError,
  type CampaignDataset,
} from "../core/campaign-data.js";
import { CampaignMutationClient } from "../core/campaign-mutations.js";

export type CampaignState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly campaign: CampaignDataset }
  | { readonly state: "unavailable"; readonly message: string };

export interface CampaignControllerOptions {
  /** False while the current session must be recovered before reading again. */
  mayRefresh(retainCurrent: boolean): boolean | Promise<boolean>;
  /** A new snapshot is shown; runs after the host has rendered it. */
  accepted(campaign: CampaignDataset): void;
  /** A refresh failed while the previous snapshot stays shown. */
  refreshFailed(cause: unknown): void;
  /** Applies the snapshot's appearance before it renders. */
  apply(campaign: CampaignDataset): void;
}

/**
 * Owns the shell's campaign snapshot: loading, reloading after authority
 * changes, and live-refresh ordering. Writers use `mutations` and then call
 * `load(signal, true)` to read their own result back.
 */
export class CampaignController implements ReactiveController {
  readonly mutations = new CampaignMutationClient();
  readonly #data = new CampaignDataClient();
  readonly #host: ReactiveControllerHost;
  readonly #options: CampaignControllerOptions;
  #state: CampaignState = { state: "loading" };
  #restore = 0;

  constructor(host: ReactiveControllerHost, options: CampaignControllerOptions) {
    this.#host = host;
    this.#options = options;
    host.addController(this);
  }

  hostConnected(): void {
    this.#set({ state: "loading" });
  }

  hostDisconnected(): void {
    this.#data.reset();
  }

  get state(): CampaignState {
    return this.#state;
  }

  /** The shown snapshot, if any. */
  get campaign(): CampaignDataset | undefined {
    return this.#state.state === "ready" ? this.#state.campaign : undefined;
  }

  /** Drops the cached snapshot and any read in flight. */
  reset(): void {
    this.#data.reset();
  }

  /** A fresh read for a new authority or an explicit retry. */
  reload(signal: AbortSignal): Promise<void> {
    this.#data.reset();
    return this.load(signal);
  }

  /**
   * Reads the current snapshot. `retainCurrent` keeps the shown snapshot while
   * reading and on failure, for live refresh and write readback.
   */
  async load(signal: AbortSignal, retainCurrent = false): Promise<void> {
    if (signal.aborted) return;
    const allowed = this.#options.mayRefresh(retainCurrent);
    if (!(typeof allowed === "boolean" ? allowed : await allowed) || signal.aborted) return;
    if (!retainCurrent || this.#state.state !== "ready") this.#set({ state: "loading" });
    try {
      const campaign = await this.#data.refresh(signal);
      if (signal.aborted || this.#data.current() !== campaign) return;
      this.#options.apply(campaign);
      this.#set({ state: "ready", campaign });
      await this.#host.updateComplete;
      if (signal.aborted || this.#data.current() !== campaign) return;
      this.#options.accepted(campaign);
    } catch (cause: unknown) {
      if (signal.aborted || cause instanceof CampaignDataRefreshInvalidatedError) return;
      const current = this.#data.current();
      if (retainCurrent && current !== undefined) {
        this.#options.apply(current);
        this.#set({ state: "ready", campaign: current });
        this.#options.refreshFailed(cause);
      } else {
        this.#set({ state: "unavailable", message: uiRequestError(cause) });
      }
    }
  }

  /**
   * Reads a restored campaign. Returns false when a newer restore started
   * meanwhile; that one owns the follow-up decision.
   */
  async restored(signal: AbortSignal): Promise<boolean> {
    const restore = ++this.#restore;
    this.#data.reset();
    await this.load(signal, true);
    return restore === this.#restore;
  }

  #set(state: CampaignState): void {
    this.#state = state;
    this.#host.requestUpdate();
  }
}
