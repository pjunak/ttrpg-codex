import { describe, expect, it, vi } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  AddonDataHTTPError,
  BrowserAddonDataClient,
  type AddonCommitReceipt,
  type AddonDataFetch,
} from "../src/addons/data-client.js";

const generationId = "a".repeat(64);
const csrfToken = "c".repeat(32);
const commit: AddonCommitReceipt = {
  contractVersion: "addon-data-commit.v1",
  commitId: 12,
  occurredAt: "2026-09-01T12:00:00Z",
  results: [{
    kind: "collection",
    dataId: "dm_notes",
    key: "note-1",
    beforeRevision: 0,
    afterRevision: 1,
    deleted: false,
  }],
  dataSets: [{ kind: "collection", dataId: "dm_notes", revision: 1 }],
};

describe("BrowserAddonDataClient", () => {
  it("binds reads to the exact generation without sending the CSRF token", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const client = createClient(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        contractVersion: "addon-data-document.v1",
        key: "note-1",
        revision: 4,
        value: { text: "Prepare the ruins" },
      });
    });

    await expect(client.api().collection<{ text: string }>("dm_notes").get("note-1"))
      .resolves.toEqual({ key: "note-1", revision: 4, value: { text: "Prepare the ruins" } });

    expect(calls[0]?.input).toBe(
      `/api/addons/dm-tools/generations/${generationId}/data/get`,
    );
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("X-Codex-CSRF")).toBeNull();
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contractVersion: "addon-data-get.v1",
      kind: "collection",
      dataId: "dm_notes",
      key: "note-1",
    });
  });

  it("sends bounded indexed queries and parses their continuation cursor", async () => {
    const fetchData = vi.fn<AddonDataFetch>(async () => jsonResponse({
      contractVersion: "addon-data-query-result.v1",
      documents: [{ key: "note-2", revision: 3, value: { status: "open" } }],
      nextCursor: "MTA",
    }));
    const notes = createClient(fetchData).api().collection<{ status: string }>("dm_notes");

    await expect(notes.query({
      cursor: "Mg",
      limit: 25,
      where: [{ path: "/status", equals: "open" }],
    })).resolves.toEqual({
      documents: [{ key: "note-2", revision: 3, value: { status: "open" } }],
      nextCursor: "MTA",
    });
    expect(JSON.parse(String(fetchData.mock.calls[0]?.[1].body))).toEqual({
      contractVersion: "addon-data-query.v1",
      kind: "collection",
      dataId: "dm_notes",
      cursor: "Mg",
      limit: 25,
      where: [{ path: "/status", equals: "open" }],
    });
  });

  it("serializes writes and attaches CSRF only to the transaction boundary", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    let releaseFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const client = createClient(async (input, init) => {
      calls.push({ input, init });
      return calls.length === 1 ? firstResponse : jsonResponse({
        ...commit,
        commitId: 13,
        results: [{ ...commit.results[0], beforeRevision: 1, afterRevision: 2 }],
        dataSets: [{ ...commit.dataSets[0], revision: 2 }],
      });
    });
    const notes = client.api().collection<{ text: string }>("dm_notes");

    const first = notes.put("note-1", { text: "First" }, 0);
    const second = notes.put("note-1", { text: "Second" }, 1);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    releaseFirst?.(jsonResponse(commit));
    await expect(first).resolves.toEqual(commit);
    await expect(second).resolves.toMatchObject({ commitId: 13 });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe(
      `/api/addons/dm-tools/generations/${generationId}/data/transactions`,
    );
    expect(new Headers(calls[0]?.init.headers).get("X-Codex-CSRF")).toBe(csrfToken);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contractVersion: "addon-data-transaction.v1",
      mutations: [{
        operation: "put",
        kind: "collection",
        dataId: "dm_notes",
        key: "note-1",
        expectedRevision: 0,
        value: { text: "First" },
      }],
    });
  });

  it("rejects malformed boundaries and stale generation authority", async () => {
    const owner = new AbortController();
    const fetchData = vi.fn<AddonDataFetch>(async () => jsonResponse({
      contractVersion: "addon-data-document.v1",
      key: "note-1",
      revision: 1,
      value: {},
      leakedField: "private",
    }));
    const client = createClient(fetchData, owner.signal);

    await expect(client.api().collection("dm_notes").get("note-1"))
      .rejects.toThrow(BoundaryValidationError);
    owner.abort("generation-replaced");
    await expect(client.api().collection("dm_notes").query())
      .rejects.toBe("generation-replaced");
    expect(fetchData).toHaveBeenCalledOnce();
  });

  it("reports HTTP status without exposing server error details", async () => {
    const client = createClient(async () => new Response(
      JSON.stringify({ error: { message: "private schema path" } }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ));

    await expect(client.api().recordExtension("characters", "sheet_state").get("alice"))
      .rejects.toEqual(new AddonDataHTTPError(422, "get"));
  });
});

it("pins query revisions and refuses missing or changed revisions", async () => {
  for (const revision of [undefined, -1, 1, 0]) {
    const calls: unknown[] = [];
    const client = createClient(async (_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return jsonResponse({ contractVersion: "addon-data-query-result.v1", documents: [], dataRevision: revision });
    });
    const read = client.api().collection("dm_notes").query({ includeDataRevision: true, expectedDataRevision: 0 });
    if (revision === 0) await expect(read).resolves.toEqual({ documents: [], dataRevision: 0 });
    else await expect(read).rejects.toBeInstanceOf(BoundaryValidationError);
    expect(calls[0]).toMatchObject({ includeDataRevision: true, expectedDataRevision: 0 });
  }
});

it("copies guards before queuing and validates their exact shape", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = createClient(async (_url, init) => { calls.push(JSON.parse(String(init.body))); return jsonResponse(commit); });
  const mutations = [{ operation: "delete" as const, kind: "collection" as const, dataId: "dm_notes", key: "note-1", expectedRevision: 1 }];
  const guards = [{ kind: "collection" as const, dataId: "dm_notes", revision: 0 }];
  const write = client.api().transact(mutations, { expectedDataSets: guards });
  guards[0]!.revision = 99;
  await write;
  expect(calls[0]?.["expectedDataSets"]).toEqual([{ kind: "collection", dataId: "dm_notes", revision: 0 }]);
  for (const invalid of [[guards[0], guards[0]], [{ kind: "collection", dataId: "dm_notes" }], [{ ...guards[0], revision: -1 }], [{ ...guards[0], extra: true }]]) {
    expect(() => client.api().transact(mutations, { expectedDataSets: invalid as typeof guards })).toThrow(BoundaryValidationError);
  }
  expect(calls).toHaveLength(1);
});

function createClient(
  fetchData: AddonDataFetch,
  signal: AbortSignal = new AbortController().signal,
): BrowserAddonDataClient {
  return new BrowserAddonDataClient({
    addonId: "dm-tools",
    generationId,
    csrfToken,
    signal,
    fetchData,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
