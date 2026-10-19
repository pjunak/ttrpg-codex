import type { ReactiveController, ReactiveControllerHost } from "lit";
import { waitForSignal } from "../core/abort-signal.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import type { CampaignMutationResult } from "../core/campaign-mutations.js";
import { MediaClient } from "../core/media.js";
import type { BusyLeases } from "./busy-lease.js";
import type { CampaignController } from "./campaign-controller.js";
import {
  campaignWriteHandlers,
  type CampaignWriteContext,
  type CampaignWriteReceipt,
} from "./campaign-write-handlers.js";
import {
  campaignWriteEvent,
  writeUnavailable,
  type CampaignWriteKind,
  type CampaignWriteRequest,
  type CampaignWriteResult,
  type CampaignWrites,
} from "./campaign-writes.js";
import { uiText } from "./ui-localization.js";

/** The signed-in writer, as the app knows it when a write's turn comes. */
export interface CampaignWriter {
  readonly csrfToken: string;
  readonly canManage: boolean;
}

export interface CampaignWriteControllerOptions {
  readonly campaign: CampaignController;
  readonly busy: BusyLeases;
  /** The signed-in writer, or undefined while no write may start. */
  writer(): CampaignWriter | undefined;
  /** Whether an editor has unsaved or saving changes, which twin changes must wait for. */
  editing(): boolean;
  /** Media uploads; tests may replace them. */
  readonly media?: MediaClient;
}

/**
 * The one write path for host editors. An editor asks with `saveCampaign`
 * and hears back about its own request only. Writes run one at a time in
 * request order while holding the app's busy lease; each is read back and
 * checked before it counts as saved. Leaving the page cancels the waits; it
 * does not roll back a write the server already received.
 */
export class CampaignWriteController implements ReactiveController {
  readonly #host: ReactiveControllerHost & EventTarget;
  readonly #options: CampaignWriteControllerOptions;
  readonly #media: MediaClient;
  #scope = new AbortController();
  #queue: Promise<void> = Promise.resolve();

  constructor(host: ReactiveControllerHost & EventTarget, options: CampaignWriteControllerOptions) {
    this.#host = host;
    this.#options = options;
    this.#media = options.media ?? new MediaClient();
    host.addController(this);
  }

  hostConnected(): void {
    this.#scope = new AbortController();
    this.#queue = Promise.resolve();
    this.#host.addEventListener(campaignWriteEvent, this.#onRequest);
  }

  hostDisconnected(): void {
    this.#host.removeEventListener(campaignWriteEvent, this.#onRequest);
    this.#scope.abort("component-disconnected");
  }

  /** A write the app asks for itself, such as a context-menu edit. */
  save<K extends CampaignWriteKind>(
    kind: K,
    detail: CampaignWrites[K],
  ): Promise<CampaignWriteResult> {
    return new Promise((respond) => this.#enqueue({ kind, detail, ready: () => true, respond }));
  }

  readonly #onRequest = (event: Event): void => {
    const request = (event as CustomEvent<CampaignWriteRequest>).detail;
    if (!Object.hasOwn(campaignWriteHandlers, request.kind)) return;
    event.preventDefault();
    event.stopPropagation();
    this.#enqueue(request);
  };

  #enqueue(request: CampaignWriteRequest): void {
    const signal = this.#scope.signal;
    let answered = false;
    const respond = (result: CampaignWriteResult): void => {
      if (answered) return;
      answered = true;
      request.respond(result);
    };
    const turn = this.#queue.then(() => this.#run({ ...request, respond }, signal));
    // Each turn answers its own request, so the queue only keeps the order.
    this.#queue = turn.catch(() => undefined);
  }

  async #run<K extends CampaignWriteKind>(
    request: CampaignWriteRequest<K>,
    signal: AbortSignal,
  ): Promise<void> {
    const handler = campaignWriteHandlers[request.kind];
    const writer = this.#options.writer();
    const campaign = this.#options.campaign.campaign;
    if (
      signal.aborted ||
      !request.ready() ||
      writer === undefined ||
      campaign === undefined ||
      this.#options.busy.busy ||
      (handler.manage(request.detail) && !writer.canManage)
    ) {
      request.respond(writeUnavailable());
      return;
    }
    if (request.kind === "twin" && this.#options.editing()) {
      request.respond({ ok: false, message: uiText("twins.finishEdits") });
      return;
    }
    const lease = this.#options.busy.acquire();
    let written = false;
    try {
      const receipt = await waitForSignal(
        handler.write(this.#context(campaign, writer, signal), request.detail),
        signal,
      );
      written = true;
      if (receipt !== undefined) await this.#options.campaign.load(signal, true);
      signal.throwIfAborted();
      request.respond(this.#answer(receipt));
    } catch (cause: unknown) {
      request.respond(
        written
          ? savedNotShown()
          : signal.aborted
            ? {
                ok: false,
                message: uiText(
                  "Saving was interrupted. Your draft is kept. Refresh before retrying.",
                ),
              }
            : { ok: false, ...handler.failure(cause, request.detail) },
      );
      // The editor already has its answer; the refresh shows what the server kept.
      if (!signal.aborted) void this.#options.campaign.load(signal, true);
    } finally {
      lease.release();
    }
  }

  /** Success once the shown campaign includes every confirmed change. */
  #answer(receipt: CampaignWriteReceipt | undefined): CampaignWriteResult {
    const campaign = this.#options.campaign.campaign;
    if (campaign === undefined) return savedNotShown();
    if (receipt === undefined) return { ok: true, campaign };
    if (!receipt.results.every((result) => shown(campaign, result))) return savedNotShown();
    const message = receipt.message === undefined ? {} : { message: receipt.message };
    const target = receipt.target;
    if (target === undefined) return { ok: true, campaign, ...message };
    const record = campaignCollection(campaign, target.collection).records.find(
      (item) => item.key === target.key,
    );
    const result = receipt.results.find(
      (item) => item.collection === target.collection && item.key === target.key,
    );
    if (record === undefined || result === undefined) return savedNotShown();
    const overwritten = receipt.check?.(record, result);
    return overwritten === undefined
      ? { ok: true, campaign, record, ...message }
      : { ok: false, ...overwritten };
  }

  #context(
    campaign: CampaignDataset,
    writer: CampaignWriter,
    signal: AbortSignal,
  ): CampaignWriteContext {
    const mutations = this.#options.campaign.mutations;
    const { csrfToken, canManage } = writer;
    return {
      campaign,
      canManage,
      csrfToken,
      signal,
      commit: async (changes) => (await mutations.commit(changes, csrfToken, signal)).results,
      mutateTwin: async (mutation) =>
        (await mutations.mutateTwin(mutation, csrfToken, signal)).results,
      deleteEnumItem: async (mutation) =>
        (await mutations.deleteEnumItem(mutation, csrfToken, signal)).results,
      upload: async (kind, target, file) =>
        (await this.#media.upload(kind, target, file, file.name, csrfToken, signal)).url,
    };
  }
}

function shown(campaign: CampaignDataset, result: CampaignMutationResult): boolean {
  const record: CampaignRecord | undefined = campaignCollection(
    campaign,
    result.collection,
  ).records.find((item) => item.key === result.key);
  return result.deleted
    ? record === undefined || record.revision > result.afterRevision
    : record !== undefined && record.revision >= result.afterRevision;
}

function savedNotShown(): CampaignWriteResult {
  return {
    ok: false,
    message: uiText(
      "The change was saved, but could not be refreshed. Your draft is kept. Refresh before retrying.",
    ),
  };
}
