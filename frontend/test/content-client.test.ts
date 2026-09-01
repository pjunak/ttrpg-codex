import { describe, expect, it, vi } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  AddonContentHTTPError,
  BrowserAddonContentClient,
  type AddonContentFetch,
} from "../src/addons/content-client.js";

const generationId = "a".repeat(64);
const digest = "b".repeat(64);

describe("BrowserAddonContentClient", () => {
  it("reads and validates the immutable generation catalog", async () => {
    const fetchContent = vi.fn<AddonContentFetch>(async () => jsonResponse({
      contractVersion: "addon-content-catalog.v1",
      addonId: "compendium",
      generationId,
      sets: [{
        id: "rules",
        revision: "2026.09.1",
        groups: { field: "source.book", additionalField: "source.license", label: "Sourcebook" },
        schemaSha256: digest,
        recordCount: 3,
        kinds: { class: 1, spell: 2 },
      }],
    }));
    const api = createClient(fetchContent).api();

    await expect(api.catalog()).resolves.toEqual({
      sets: [{
        id: "rules", revision: "2026.09.1",
        groups: { field: "source.book", additionalField: "source.license", label: "Sourcebook" },
        schemaSha256: digest, recordCount: 3, kinds: { class: 1, spell: 2 },
      }],
    });
    expect(fetchContent).toHaveBeenCalledWith(
      `/api/addons/compendium/generations/${generationId}/content`,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "force-cache" }),
    );
  });

  it("gets records with encoded identities and verifies their envelope", async () => {
    const fetchContent = vi.fn<AddonContentFetch>(async () => jsonResponse({
      contractVersion: "addon-content-record.v1",
      addonId: "compendium",
      generationId,
      setId: "rules",
      revision: "2026.09.1",
      record: {
        kind: "magic item", id: "amulet/health",
        value: { kind: "magic item", id: "amulet/health", name: "Amulet of Health" },
      },
    }));

    await expect(createClient(fetchContent).api().set<{ name: string }>("rules")
      .get("magic item", "amulet/health"))
      .resolves.toMatchObject({ id: "amulet/health", value: { name: "Amulet of Health" } });
    expect(fetchContent.mock.calls[0]?.[0]).toBe(
      `/api/addons/compendium/generations/${generationId}/content/records?set=rules&kind=magic+item&id=amulet%2Fhealth`,
    );
  });

  it("uses bounded queries and parses stable cursors", async () => {
    const fetchContent = vi.fn<AddonContentFetch>(async () => jsonResponse({
      contractVersion: "addon-content-query-result.v1",
      addonId: "compendium",
      generationId,
      setId: "rules",
      revision: "2026.09.1",
      records: [{ kind: "spell", id: "shield", value: { kind: "spell", id: "shield" } }],
      nextCursor: "MTA",
    }));
    const rules = createClient(fetchContent).api().set("rules");

    await expect(rules.query({ kind: "spell", limit: 25, cursor: "Mg" })).resolves.toEqual({
      revision: "2026.09.1",
      records: [{ kind: "spell", id: "shield", value: { kind: "spell", id: "shield" } }],
      nextCursor: "MTA",
    });
    expect(fetchContent.mock.calls[0]?.[0]).toContain(
      "/content/query?set=rules&limit=25&kind=spell&cursor=Mg",
    );
  });

  it("rejects malformed responses and revoked generations", async () => {
    const owner = new AbortController();
    const fetchContent = vi.fn<AddonContentFetch>(async () => jsonResponse({
      contractVersion: "addon-content-query-result.v1",
      addonId: "compendium",
      generationId,
      setId: "rules",
      revision: "1",
      records: [{ kind: "spell", id: "shield", value: { kind: "spell", id: "wrong" } }],
    }));
    const rules = createClient(fetchContent, owner.signal).api().set("rules");

    await expect(rules.query()).rejects.toThrow(BoundaryValidationError);
    owner.abort("generation-replaced");
    await expect(rules.query()).rejects.toBe("generation-replaced");
    expect(fetchContent).toHaveBeenCalledOnce();
  });

  it("reports status without exposing server details", async () => {
    const client = createClient(async () => new Response(
      JSON.stringify({ error: { message: "private package path" } }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ));

    await expect(client.api().set("rules").get("spell", "shield"))
      .rejects.toEqual(new AddonContentHTTPError(409, "get"));
  });
});

function createClient(
  fetchContent: AddonContentFetch,
  signal: AbortSignal = new AbortController().signal,
): BrowserAddonContentClient {
  return new BrowserAddonContentClient({
    addonId: "compendium", generationId, signal, fetchContent,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
