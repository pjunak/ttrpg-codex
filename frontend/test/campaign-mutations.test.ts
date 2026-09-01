import { describe, expect, it } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  CampaignMutationClient,
  CampaignMutationHTTPError,
  parseCampaignCommitReceipt,
  parseCampaignEnumDeleteResult,
  parseCampaignTwinResult,
  type CampaignMutationFetch,
} from "../src/core/campaign-mutations.js";

const receipt = {
  contractVersion: "campaign-commit.v1",
  commitId: 12,
  occurredAt: "2026-09-01T12:00:00Z",
  results: [{
    collection: "campaign",
    key: "main",
    beforeRevision: 2,
    afterRevision: 3,
    deleted: false,
  }],
  collectionRevisions: { campaign: 4, settings: 2 },
};

describe("parseCampaignCommitReceipt", () => {
  it("accepts the exact payload-free receipt", () => {
    expect(parseCampaignCommitReceipt(receipt)).toEqual(receipt);
  });

  it.each([
    { ...receipt, contractVersion: "campaign-commit.v2" },
    { ...receipt, privateTarget: "secret" },
    { ...receipt, results: [] },
    { ...receipt, results: [{ ...receipt.results[0], afterRevision: 2 }] },
    { ...receipt, collectionRevisions: { private: 2 } },
  ])("rejects a malformed receipt %#", (value) => {
    expect(() => parseCampaignCommitReceipt(value)).toThrow(BoundaryValidationError);
  });
});

describe("parseCampaignTwinResult", () => {
  it("accepts a twin result built on the same commit receipt", () => {
    const result = parseCampaignTwinResult({
      ...receipt,
      contractVersion: "campaign-twin-result.v1",
      twinKey: "twin-alice",
    });
    expect(result.twinKey).toBe("twin-alice");
    expect(result.results).toEqual(receipt.results);
  });
});

describe("parseCampaignEnumDeleteResult", () => {
  it("accepts an enum result built on the commit receipt", () => {
    const result = parseCampaignEnumDeleteResult({
      ...receipt,
      contractVersion: "campaign-enum-delete-result.v1",
      usageCount: 3,
    });
    expect(result.usageCount).toBe(3);
  });
});

describe("CampaignMutationClient", () => {
  it("serializes the versioned request with session-bound CSRF", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchMutation: CampaignMutationFetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(receipt);
    };
    const client = new CampaignMutationClient(fetchMutation);
    const signal = new AbortController().signal;

    await expect(client.commit([{
      operation: "put",
      collection: "campaign",
      key: "main",
      expectedRevision: 2,
      value: { name: "Aethelara", futureField: true },
    }], "c".repeat(32), signal)).resolves.toEqual(receipt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: "/api/campaign/transactions" });
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("X-Codex-CSRF")).toBe("c".repeat(32));
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contractVersion: "campaign-mutation.v1",
      mutations: [{
        operation: "put",
        collection: "campaign",
        key: "main",
        expectedRevision: 2,
        value: { name: "Aethelara", futureField: true },
      }],
    });
  });

  it("reports HTTP status without parsing private error details", async () => {
    const client = new CampaignMutationClient(async () =>
      new Response(`{"error":"private-derived-id"}`, { status: 409 })
    );

    await expect(client.commit([{
      operation: "delete", collection: "pets", key: "owl", expectedRevision: 1,
    }], "c".repeat(32), new AbortController().signal)).rejects.toEqual(
      new CampaignMutationHTTPError(409),
    );
  });

  it("serializes explicit twin operations through the same write queue", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const client = new CampaignMutationClient(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        ...receipt,
        contractVersion: "campaign-twin-result.v1",
        twinKey: "secret-town",
      });
    });
    const result = await client.mutateTwin({
      action: "link",
      collection: "locations",
      sourceKey: "town",
      sourceExpectedRevision: 2,
      targetKey: "secret-town",
      targetExpectedRevision: 4,
    }, "d".repeat(32), new AbortController().signal);

    expect(result.twinKey).toBe("secret-town");
    expect(calls[0]?.input).toBe("/api/campaign/twins");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contractVersion: "campaign-twin.v1",
      action: "link",
      collection: "locations",
      sourceKey: "town",
      sourceExpectedRevision: 2,
      targetKey: "secret-town",
      targetExpectedRevision: 4,
    });
  });

  it("rejects invalid twin revisions before crossing the boundary", async () => {
    const client = new CampaignMutationClient(async () => {
      throw new Error("fetch must not run");
    });

    await expect(client.mutateTwin({
      action: "create",
      collection: "characters",
      sourceKey: "alice",
      sourceExpectedRevision: 0,
    }, "d".repeat(32), new AbortController().signal)).rejects.toThrow(
      BoundaryValidationError,
    );
  });

  it("serializes explicit enum replacement through the shared write queue", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const client = new CampaignMutationClient(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        ...receipt,
        contractVersion: "campaign-enum-delete-result.v1",
        usageCount: 2,
      });
    });
    const result = await client.deleteEnumItem({
      category: "genders",
      itemId: "old",
      expectedRevision: 2,
      mode: "replace",
      replacementId: "new",
    }, "d".repeat(32), new AbortController().signal);

    expect(result.usageCount).toBe(2);
    expect(calls[0]?.input).toBe("/api/campaign/enums/delete");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contractVersion: "campaign-enum-delete.v1",
      category: "genders",
      itemId: "old",
      expectedRevision: 2,
      mode: "replace",
      replacementId: "new",
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
