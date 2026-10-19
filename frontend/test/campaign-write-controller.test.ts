import { afterEach, describe, expect, it, vi } from "vitest";
import { BusyLeases } from "../src/app/busy-lease.js";
import { CampaignController } from "../src/app/campaign-controller.js";
import { CampaignWriteController } from "../src/app/campaign-write-controller.js";
import {
  campaignWriteEvent,
  type CampaignWriteRequest,
  type CampaignWriteResult,
} from "../src/app/campaign-writes.js";
import type {
  CampaignCollectionName,
  CampaignDataset,
  CampaignRecord,
} from "../src/core/campaign-data.js";
import { deferred } from "./deferred.js";
import { requestBodyText } from "./request-body.js";

const shapes = {
  characters: "list",
  relationships: "list",
  locations: "list",
  events: "list",
  mysteries: "list",
  factions: "keyed",
  pantheon: "list",
  artifacts: "list",
  settings: "keyed",
  historicalEvents: "list",
  campaign: "keyed",
  companions: "list",
} as const;

interface Put {
  operation: "put";
  collection: CampaignCollectionName;
  key: string;
  expectedRevision: number;
  value: unknown;
}

/** A campaign server holding locations, with hooks to delay or change its answers. */
function server(records: Record<string, Record<string, unknown>>) {
  const stored = new Map<string, CampaignRecord>(
    Object.entries(records).map(([key, value]) => [key, { key, revision: 1, value }]),
  );
  const hooks: {
    commit?: () => Promise<void>;
    read?: () => Promise<void>;
    /** Lets another author write right after this commit. */
    afterCommit?: () => void;
    reject?: number;
    /** A stale snapshot that reads return instead of the stored records. */
    shown?: CampaignDataset;
  } = {};
  const writes: Put[][] = [];
  const dataset = (): CampaignDataset => ({
    contractVersion: "campaign-data.v1",
    collections: (Object.entries(shapes) as Array<[CampaignCollectionName, "list" | "keyed"]>).map(
      ([name, shape]) => ({
        name,
        shape,
        materialized: true,
        revision: 1,
        records: name === "locations" ? [...stored.values()] : [],
      }),
    ),
  });
  const write = (key: string, value: unknown): CampaignRecord => {
    const before = stored.get(key);
    const next = { key, revision: (before?.revision ?? 0) + 1, value };
    stored.set(key, next);
    return next;
  };
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/api/campaign") {
      await hooks.read?.();
      return Response.json(hooks.shown ?? dataset());
    }
    if (path !== "/api/campaign/transactions") throw new Error(`unexpected ${path}`);
    const mutations = (JSON.parse(requestBodyText(init.body)) as { mutations: Put[] }).mutations;
    writes.push(mutations);
    await hooks.commit?.();
    if (hooks.reject !== undefined)
      return Response.json({ error: { kind: "CONFLICT" } }, { status: hooks.reject });
    const results = mutations.map((mutation) => {
      const before = stored.get(mutation.key)!.revision;
      return {
        collection: mutation.collection,
        key: mutation.key,
        beforeRevision: before,
        afterRevision: write(mutation.key, mutation.value).revision,
        deleted: false,
      };
    });
    hooks.afterCommit?.();
    return Response.json({
      contractVersion: "campaign-commit.v1",
      commitId: writes.length,
      occurredAt: "2026-10-19T12:00:00Z",
      results,
      collectionRevisions: { locations: 1 },
    });
  });
  return { stored, hooks, writes, fetch, write, dataset };
}

interface Lifecycle {
  hostConnected?: () => void;
  hostDisconnected?: () => void;
}

async function app(records: Record<string, Record<string, unknown>> = { gate: { name: "Gate" } }) {
  const backend = server(records);
  vi.stubGlobal("fetch", backend.fetch);
  const controllers: Lifecycle[] = [];
  const host = Object.assign(new EventTarget(), {
    addController: (controller: Lifecycle) => {
      controllers.push(controller);
    },
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  });
  const busy = new BusyLeases(() => undefined);
  const campaign = new CampaignController(host, {
    mayRefresh: () => true,
    accepted: () => undefined,
    refreshFailed: () => undefined,
    apply: () => undefined,
  });
  const writes = new CampaignWriteController(host, {
    campaign,
    busy,
    writer: () => ({ csrfToken: "x".repeat(32), canManage: true }),
    editing: () => false,
  });
  const connect = () => controllers.forEach((controller) => controller.hostConnected?.());
  connect();
  await campaign.load(new AbortController().signal);
  /** Asks for a write the way an editor's event does. */
  const request = (detail: CampaignWriteRequest["detail"], kind = "record-patch") =>
    new Promise<CampaignWriteResult>((respond) => {
      host.dispatchEvent(
        new CustomEvent(campaignWriteEvent, {
          detail: { kind, detail, ready: () => true, respond },
          cancelable: true,
        }),
      );
    });
  const rename = (name: string) =>
    request({
      collection: "locations",
      base: campaign.campaign!.collections.find((item) => item.name === "locations")!.records[0]!,
      fields: { name },
    });
  return {
    backend,
    busy,
    campaign,
    writes,
    request,
    rename,
    host,
    connect,
    disconnect: () => controllers.forEach((controller) => controller.hostDisconnected?.()),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("CampaignWriteController", () => {
  it("answers a patch with the record it read back", async () => {
    const { rename, backend } = await app();
    const result = await rename("Northern Gate");
    expect(result).toMatchObject({ ok: true, record: { key: "gate", revision: 2 } });
    expect(result.ok && result.record?.value).toMatchObject({ name: "Northern Gate" });
    expect(backend.writes).toHaveLength(1);
  });

  it("runs writes one at a time in the order they were asked for", async () => {
    const { request, campaign, backend } = await app({
      gate: { name: "Gate" },
      vale: { name: "Vale" },
    });
    const held = deferred();
    backend.hooks.commit = () => held.promise;
    const records = campaign.campaign!.collections.find(
      (item) => item.name === "locations",
    )!.records;
    const first = request({ collection: "locations", base: records[0]!, fields: { name: "One" } });
    const second = request({ collection: "locations", base: records[1]!, fields: { name: "Two" } });
    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));
    delete backend.hooks.commit;
    held.resolve();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(backend.writes.map((write) => write[0]?.key)).toEqual(["gate", "vale"]);
  });

  it("holds the app busy while it writes and refuses to start while something else does", async () => {
    const { rename, busy, backend } = await app();
    const held = deferred();
    backend.hooks.commit = () => held.promise;
    const saving = rename("Busy gate");
    await vi.waitFor(() => expect(busy.busy).toBe(true));
    held.resolve();
    await saving;
    expect(busy.busy).toBe(false);
    const signIn = busy.acquire();
    const refused = await rename("Refused gate");
    signIn.release();
    expect(refused).toMatchObject({ ok: false });
    expect(backend.writes).toHaveLength(1);
  });

  it("reports a write another author overwrote before the read-back", async () => {
    const { rename, backend } = await app();
    backend.hooks.afterCommit = () => {
      delete backend.hooks.afterCommit;
      backend.write("gate", { name: "Their gate" });
    };
    const result = await rename("Our gate");
    expect(result).toEqual({
      ok: false,
      conflict: true,
      message:
        "Your change was saved, but this field changed again elsewhere. Review the current value.",
    });
  });

  it("answers a rejected write before its refresh finishes", async () => {
    const { rename, backend } = await app();
    backend.hooks.reject = 409;
    const reading = deferred();
    backend.hooks.read = () => reading.promise;
    const result = await rename("Stale gate");
    expect(result).toMatchObject({ ok: false, conflict: true });
    await vi.waitFor(() =>
      expect(backend.fetch.mock.calls.filter(([path]) => path === "/api/campaign")).toHaveLength(2),
    );
    reading.resolve();
  });

  it("does not count a write as saved when the read-back does not show it", async () => {
    const { rename, backend } = await app();
    backend.hooks.shown = backend.dataset();
    const result = await rename("Unseen gate");
    expect(result).toEqual({
      ok: false,
      message:
        "The change was saved, but could not be refreshed. Your draft is kept. Refresh before retrying.",
    });
  });

  it("answers once when the app leaves mid-write, and a reconnected app writes at once", async () => {
    const { rename, backend, disconnect, connect, busy, campaign } = await app();
    const held = deferred();
    backend.hooks.commit = () => held.promise;
    const interrupted = rename("Interrupted gate");
    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));
    disconnect();
    expect(await interrupted).toEqual({
      ok: false,
      message: "Saving was interrupted. Your draft is kept. Refresh before retrying.",
    });
    expect(busy.busy).toBe(false);
    connect();
    await campaign.load(new AbortController().signal);
    delete backend.hooks.commit;
    // The held transport ignores the cancellation; the new write must not wait for it.
    expect((await rename("Fresh gate")).ok).toBe(true);
    held.resolve();
    expect(backend.writes).toHaveLength(2);
  });

  it("leaves requests of unknown kinds to their sender", async () => {
    const { host } = await app();
    const event = new CustomEvent(campaignWriteEvent, {
      detail: { kind: "unknown", detail: {}, ready: () => true, respond: vi.fn() },
      cancelable: true,
    });
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
