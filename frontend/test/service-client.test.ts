import { describe, expect, it, vi } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  AddonServiceHTTPError,
  BrowserAddonServiceClient,
  type AddonServiceFetch,
} from "../src/addons/service-client.js";

const generationId = "a".repeat(64);
const providerGeneration = "b".repeat(64);
const csrfToken = "c".repeat(32);

describe("BrowserAddonServiceClient", () => {
  it("sends own-provider discovery only when explicitly requested", async () => {
    const fetchService = vi.fn<AddonServiceFetch>(async () => jsonResponse(connection()));
    const client = createClient(fetchService).api();
    await client.connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one" });
    expect(JSON.parse(String(fetchService.mock.calls[0]?.[1].body))).not.toHaveProperty("includeOwn");
    await client.connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one", includeOwn: true });
    expect(JSON.parse(String(fetchService.mock.calls[1]?.[1].body))).toHaveProperty("includeOwn", true);
    await expect(client.connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one", includeOwn: "true" as unknown as boolean })).rejects.toThrow(BoundaryValidationError);
    expect(fetchService).toHaveBeenCalledTimes(2);
  });

  it("connects and calls one exact schema-validated provider binding", async () => {
    const fetchService = vi.fn<AddonServiceFetch>(async (_input, init) => {
      const request = JSON.parse(String(init.body)) as { contractVersion: string };
      return request.contractVersion === "addon-service-connect.v1"
        ? jsonResponse(connection())
        : jsonResponse({
          contractVersion: "addon-service-result.v1",
          providerAddonId: "rules-engine",
          providerGeneration,
          result: { contractVersion: "rules-engine.hydrate.response.v3", sheet: { level: 3 } },
        });
    });
    const handle = await createClient(fetchService).api().connect("dnd5e.rules-engine", {
      range: "^3.0.0", cardinality: "one",
    });

    expect(handle.available).toBe(true);
    expect(handle.providers).toEqual([{
      addonId: "rules-engine", contractVersion: "3.1.0",
      generation: providerGeneration, bindingRevision: 0,
    }]);
    await expect(handle.call<{ sheet: { level: number } }>(
      "hydrate", { contractVersion: "rules-engine.hydrate.request.v3", character: {} },
    )).resolves.toMatchObject({ sheet: { level: 3 } });

    expect(fetchService.mock.calls[0]?.[0]).toBe(
      `/api/addons/dnd-sheets/generations/${generationId}/services/connect`,
    );
    const call = fetchService.mock.calls[1]?.[1];
    expect(new Headers(call?.headers).get("X-Codex-CSRF")).toBe(csrfToken);
    expect(JSON.parse(String(call?.body))).toMatchObject({
      contractVersion: "addon-service-call.v1",
      contract: "dnd5e.rules-engine",
      providerAddonId: "rules-engine",
      providerVersion: "3.1.0",
      providerGeneration,
      bindingRevision: 0,
      method: "hydrate",
      deadlineMs: 2000,
    });
  });

  it("keeps an optional unavailable connection explicit", async () => {
    const handle = await createClient(async () => jsonResponse({
      ...connection(), providers: [],
    })).api().connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one" });

    expect(handle.available).toBe(false);
    await expect(handle.call("hydrate", {}))
      .rejects.toEqual(new AddonServiceHTTPError(503, "SERVICE_UNAVAILABLE"));
  });

  it("requires an explicit provider for a many-provider connection", async () => {
    const fetchService = vi.fn<AddonServiceFetch>(async (_input, init) => {
      const request = JSON.parse(String(init.body)) as { contractVersion: string };
      return request.contractVersion === "addon-service-connect.v1"
        ? jsonResponse({
          ...connection(), cardinality: "many",
          providers: [
            connection().providers[0],
            { ...connection().providers[0], addonId: "homebrew-engine", generation: "d".repeat(64) },
          ],
        })
        : jsonResponse({
          contractVersion: "addon-service-result.v1",
          providerAddonId: "homebrew-engine",
          providerGeneration: "d".repeat(64),
          result: { ok: true },
        });
    });
    const handle = await createClient(fetchService).api().connect("dnd5e.rules-engine", {
      range: "^3.0.0", cardinality: "many",
    });

    await expect(handle.call("context", {})).rejects.toThrow(BoundaryValidationError);
    await expect(handle.call("context", {}, { providerAddonId: "homebrew-engine" }))
      .resolves.toEqual({ ok: true });
  });

  it("rejects malformed and stale responses without leaking server details", async () => {
    const malformed = createClient(async () => jsonResponse({
      ...connection(), leaked: "private",
    }));
    await expect(malformed.api().connect("dnd5e.rules-engine", {
      range: "^3.0.0", cardinality: "one",
    })).rejects.toThrow(BoundaryValidationError);

    const stale = createClient(async () => new Response(JSON.stringify({
      error: { kind: "STALE_BINDING", message: "private provider detail" },
    }), { status: 409, headers: { "Content-Type": "application/json" } }));
    await expect(stale.api().connect("dnd5e.rules-engine", {
      range: "^3.0.0", cardinality: "one",
    })).rejects.toEqual(new AddonServiceHTTPError(409, "STALE_BINDING"));
  });
});

function connection(): Record<string, unknown> & { providers: Array<Record<string, unknown>> } {
  return {
    contractVersion: "addon-service-connection.v1",
    contract: "dnd5e.rules-engine",
    range: "^3.0.0",
    cardinality: "one",
    providers: [{
      addonId: "rules-engine", contractVersion: "3.1.0",
      generation: providerGeneration, bindingRevision: 0,
    }],
  };
}

function createClient(
  fetchService: AddonServiceFetch,
  signal: AbortSignal = new AbortController().signal,
): BrowserAddonServiceClient {
  return new BrowserAddonServiceClient({
    addonId: "dnd-sheets", generationId, csrfToken, signal, fetchService,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
