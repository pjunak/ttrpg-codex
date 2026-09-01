import { describe, expect, it } from "vitest";
import {
  CampaignDataClient,
  CampaignDataHTTPError,
  CampaignDataRefreshInvalidatedError,
  parseCampaignDataset,
  type CampaignCollectionName,
  type CampaignDataFetch,
  type CampaignDataset,
} from "../src/core/campaign-data.js";
import { BoundaryValidationError } from "../src/core/boundary.js";

const shapes = {
  characters: "list",
  relationships: "list",
  locations: "list",
  events: "list",
  mysteries: "list",
  factions: "keyed",
  deletedDefaults: "keyed",
  pantheon: "list",
  artifacts: "list",
  settings: "keyed",
  historicalEvents: "list",
  campaign: "keyed",
  pets: "list",
} as const;

const dataset: CampaignDataset = {
  contractVersion: "campaign-data.v1",
  collections: (Object.entries(shapes) as Array<[CampaignCollectionName, "list" | "keyed"]>)
    .map(([name, shape]) => ({
      name,
      shape,
      materialized: name === "characters",
      revision: name === "characters" ? 2 : 0,
      records: name === "characters"
        ? [{ key: "alice", revision: 2, value: { id: "alice", name: "Alice" } }]
        : [],
    })),
};

describe("parseCampaignDataset", () => {
  it("accepts and copies the complete v1 dataset", () => {
    const parsed = parseCampaignDataset(dataset);

    expect(parsed).toEqual(dataset);
    expect(parsed).not.toBe(dataset);
    expect(parsed.collections).not.toBe(dataset.collections);
    expect(parsed.collections[0]?.records).not.toBe(dataset.collections[0]?.records);
  });

  it.each([
    { ...dataset, contractVersion: "campaign-data.v2" },
    { ...dataset, extra: true },
    { ...dataset, collections: dataset.collections.slice(1) },
    {
      ...dataset,
      collections: dataset.collections.map((collection, index) =>
        index === 0 ? { ...collection, shape: "keyed" } : collection
      ),
    },
    {
      ...dataset,
      collections: dataset.collections.map((collection, index) =>
        index === 0 ? { ...collection, records: [{ key: "bad\nkey", revision: 1, value: {} }] } : collection
      ),
    },
    {
      ...dataset,
      collections: dataset.collections.map((collection, index) =>
        index === 0 ? { ...collection, records: [{ key: "alice", revision: 0, value: {} }] } : collection
      ),
    },
  ])("rejects a malformed dataset %#", (value) => {
    expect(() => parseCampaignDataset(value)).toThrow(BoundaryValidationError);
  });
});

describe("CampaignDataClient", () => {
  it("uses a bounded same-origin request and retains the accepted dataset", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchData: CampaignDataFetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(dataset);
    };
    const client = new CampaignDataClient(fetchData);
    const signal = new AbortController().signal;

    await expect(client.refresh(signal)).resolves.toEqual(dataset);
    expect(client.current()).toEqual(dataset);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: "/api/campaign" });
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  });

  it("preserves the last good dataset after malformed data", async () => {
    const responses = [jsonResponse(dataset), jsonResponse({ invalid: true })];
    const client = new CampaignDataClient(async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected fetch");
      }
      return response;
    });
    const signal = new AbortController().signal;
    await client.refresh(signal);

    await expect(client.refresh(signal)).rejects.toBeInstanceOf(BoundaryValidationError);
    expect(client.current()).toEqual(dataset);
  });

  it("reports HTTP failures without parsing private details", async () => {
    const client = new CampaignDataClient(async () => new Response("private", { status: 503 }));

    await expect(client.refresh(new AbortController().signal)).rejects.toEqual(
      new CampaignDataHTTPError(503),
    );
  });

  it("does not accept a response invalidated by an authority change", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const client = new CampaignDataClient(async () => response);
    const refresh = client.refresh(new AbortController().signal);
    await Promise.resolve();

    client.reset();
    resolveResponse?.(jsonResponse(dataset));

    await expect(refresh).rejects.toBeInstanceOf(CampaignDataRefreshInvalidatedError);
    expect(client.current()).toBeUndefined();
  });
});

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
    },
  });
}
