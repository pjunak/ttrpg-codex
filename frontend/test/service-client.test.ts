import { requestBodyText } from "./request-body.js";
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
  it("renews request credentials on an existing binding without replay or reviving disposed authority", async () => {
    let current = csrfToken;
    const owner = new AbortController();
    const fetchService = vi.fn<AddonServiceFetch>(async (_url, init) =>
      JSON.parse(requestBodyText(init.body)).contractVersion === "addon-service-connect.v1"
        ? jsonResponse(connection())
        : jsonResponse({
            contractVersion: "addon-service-result.v1",
            providerAddonId: "rules-engine",
            providerGeneration,
            result: { ok: true },
          }),
    );
    const client = new BrowserAddonServiceClient({
      addonId: "dnd-sheets",
      generationId,
      csrfToken,
      currentCsrfToken: () => current,
      signal: owner.signal,
      fetchService,
    });
    const handle = await client
      .api()
      .connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one" });
    current = "n".repeat(32);
    expect(fetchService).toHaveBeenCalledOnce();
    await handle.call("hydrate", {});
    expect(new Headers(fetchService.mock.calls[0]![1].headers).get("X-Codex-CSRF")).toBe(csrfToken);
    expect(new Headers(fetchService.mock.calls[1]![1].headers).get("X-Codex-CSRF")).toBe(current);
    expect(JSON.parse(requestBodyText(fetchService.mock.calls[1]![1].body))).toMatchObject({
      providerGeneration,
      bindingRevision: 0,
    });
    owner.abort("generation-replaced");
    current = "x".repeat(32);
    await expect(handle.call("hydrate", {})).rejects.toBe("generation-replaced");
    expect(fetchService).toHaveBeenCalledTimes(2);
  });

  it("sends own-provider discovery only when explicitly requested", async () => {
    const fetchService = vi.fn<AddonServiceFetch>(async () => jsonResponse(connection()));
    const client = createClient(fetchService).api();
    await client.connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one" });
    expect(JSON.parse(requestBodyText(fetchService.mock.calls[0]?.[1].body))).not.toHaveProperty(
      "includeOwn",
    );
    await client.connect("dnd5e.rules-engine", {
      range: "^3.0.0",
      cardinality: "one",
      includeOwn: true,
    });
    expect(JSON.parse(requestBodyText(fetchService.mock.calls[1]?.[1].body))).toHaveProperty(
      "includeOwn",
      true,
    );
    await expect(
      client.connect("dnd5e.rules-engine", {
        range: "^3.0.0",
        cardinality: "one",
        includeOwn: "true" as unknown as boolean,
      }),
    ).rejects.toThrow(BoundaryValidationError);
    expect(fetchService).toHaveBeenCalledTimes(2);
  });

  it("connects to its own worker without a consumer requirement or provider ID", async () => {
    const ownConnection = {
      contractVersion: "addon-service-connection.v1",
      contract: "dnd5e.character",
      range: "3.0.0",
      cardinality: "one",
      providers: [
        {
          addonId: "dnd-sheets",
          contractVersion: "3.0.0",
          generation: generationId,
          bindingRevision: 0,
        },
      ],
    };
    const fetchService = vi.fn<AddonServiceFetch>(async (_url, init) =>
      JSON.parse(requestBodyText(init.body)).contractVersion === "addon-service-connect.v1"
        ? jsonResponse(ownConnection)
        : jsonResponse({
            contractVersion: "addon-service-result.v1",
            providerAddonId: "dnd-sheets",
            providerGeneration: generationId,
            result: { saved: true },
          }),
    );
    const handle = await createClient(fetchService).api().own("dnd5e.character");
    expect(JSON.parse(requestBodyText(fetchService.mock.calls[0]?.[1].body))).toEqual({
      contractVersion: "addon-service-connect.v1",
      contract: "dnd5e.character",
      own: true,
    });
    expect(handle).toMatchObject({ range: "3.0.0", cardinality: "one", available: true });
    await expect(handle.call("save", {})).resolves.toEqual({ saved: true });
    expect(JSON.parse(requestBodyText(fetchService.mock.calls[1]?.[1].body))).toMatchObject({
      contract: "dnd5e.character",
      providerAddonId: "dnd-sheets",
      providerVersion: "3.0.0",
    });

    const stopped = vi.fn<AddonServiceFetch>(async () =>
      jsonResponse({ ...ownConnection, providers: [] }),
    );
    const unavailable = await createClient(stopped).api().own("dnd5e.character");
    expect(unavailable.available).toBe(false);
    const empty = vi.fn<AddonServiceFetch>(async () =>
      jsonResponse({ ...ownConnection, range: "" }),
    );
    await expect(createClient(empty).api().own("dnd5e.character")).rejects.toThrow(
      BoundaryValidationError,
    );
  });

  it("connects and calls one exact schema-validated provider binding", async () => {
    const fetchService = vi.fn<AddonServiceFetch>(async (_input, init) => {
      const request = JSON.parse(requestBodyText(init.body)) as { contractVersion: string };
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
      range: "^3.0.0",
      cardinality: "one",
    });

    expect(handle.available).toBe(true);
    expect(handle.providers).toEqual([
      {
        addonId: "rules-engine",
        contractVersion: "3.1.0",
        generation: providerGeneration,
        bindingRevision: 0,
      },
    ]);
    await expect(
      handle.call<{ sheet: { level: number } }>("hydrate", {
        contractVersion: "rules-engine.hydrate.request.v3",
        character: {},
      }),
    ).resolves.toMatchObject({ sheet: { level: 3 } });

    expect(fetchService.mock.calls[0]?.[0]).toBe(
      `/api/addons/dnd-sheets/generations/${generationId}/services/connect`,
    );
    const call = fetchService.mock.calls[1]?.[1];
    expect(new Headers(call?.headers).get("X-Codex-CSRF")).toBe(csrfToken);
    expect(JSON.parse(requestBodyText(call?.body))).toMatchObject({
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
    const handle = await createClient(async () =>
      jsonResponse({
        ...connection(),
        providers: [],
      }),
    )
      .api()
      .connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one" });

    expect(handle.available).toBe(false);
    await expect(handle.call("hydrate", {})).rejects.toEqual(
      new AddonServiceHTTPError(503, "SERVICE_UNAVAILABLE"),
    );
  });

  it("requires an explicit provider for a many-provider connection", async () => {
    const fetchService = vi.fn<AddonServiceFetch>(async (_input, init) => {
      const request = JSON.parse(requestBodyText(init.body)) as { contractVersion: string };
      return request.contractVersion === "addon-service-connect.v1"
        ? jsonResponse({
            ...connection(),
            cardinality: "many",
            providers: [
              connection().providers[0],
              {
                ...connection().providers[0],
                addonId: "homebrew-engine",
                generation: "d".repeat(64),
              },
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
      range: "^3.0.0",
      cardinality: "many",
    });

    await expect(handle.call("context", {})).rejects.toThrow(BoundaryValidationError);
    await expect(
      handle.call("context", {}, { providerAddonId: "homebrew-engine" }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects malformed and stale responses without leaking server details", async () => {
    const malformed = createClient(async () =>
      jsonResponse({
        ...connection(),
        leaked: "private",
      }),
    );
    await expect(
      malformed.api().connect("dnd5e.rules-engine", {
        range: "^3.0.0",
        cardinality: "one",
      }),
    ).rejects.toThrow(BoundaryValidationError);

    const stale = createClient(
      async () =>
        new Response(
          JSON.stringify({
            error: { kind: "STALE_BINDING", message: "private provider detail" },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    await expect(
      stale.api().connect("dnd5e.rules-engine", {
        range: "^3.0.0",
        cardinality: "one",
      }),
    ).rejects.toEqual(new AddonServiceHTTPError(409, "STALE_BINDING"));

    const proxyPage = createClient(
      async () =>
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    );
    await expect(
      proxyPage.api().connect("dnd5e.rules-engine", {
        range: "^3.0.0",
        cardinality: "one",
      }),
    ).rejects.toEqual(new AddonServiceHTTPError(502, "HTTP_ERROR"));
  });

  it("exposes a provider issue only as bounded one-line text on INVALID_REQUEST", async () => {
    const rejection = async (error: Record<string, unknown>): Promise<AddonServiceHTTPError> => {
      const client = createClient(
        async () =>
          new Response(JSON.stringify({ error: { message: "host message", ...error } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const failure: unknown = await client
        .api()
        .connect("dnd5e.rules-engine", { range: "^3.0.0", cardinality: "one" })
        .catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(AddonServiceHTTPError);
      return failure as AddonServiceHTTPError;
    };
    const issue = "items[3]: effect 1: <b>unknown</b> target";
    expect(await rejection({ kind: "INVALID_REQUEST", issue })).toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      issue,
    });
    // Length counts code points, so 300 astral characters still fit.
    expect((await rejection({ kind: "INVALID_REQUEST", issue: "𝔞".repeat(300) })).issue).toBe(
      "𝔞".repeat(300),
    );
    for (const error of [
      { kind: "CONFLICT", issue },
      { kind: "INVALID_REQUEST" },
      { kind: "INVALID_REQUEST", issue: 42 },
      { kind: "INVALID_REQUEST", issue: "" },
      { kind: "INVALID_REQUEST", issue: " padded" },
      { kind: "INVALID_REQUEST", issue: "two\nlines" },
      { kind: "INVALID_REQUEST", issue: "a\u202eb" },
      { kind: "INVALID_REQUEST", issue: "x".repeat(301) },
    ]) {
      const failure = await rejection(error);
      expect(failure.code).toBe(error.kind);
      expect(failure.issue).toBeUndefined();
    }
  });
});

function connection(): Record<string, unknown> & { providers: Array<Record<string, unknown>> } {
  return {
    contractVersion: "addon-service-connection.v1",
    contract: "dnd5e.rules-engine",
    range: "^3.0.0",
    cardinality: "one",
    providers: [
      {
        addonId: "rules-engine",
        contractVersion: "3.1.0",
        generation: providerGeneration,
        bindingRevision: 0,
      },
    ],
  };
}

function createClient(
  fetchService: AddonServiceFetch,
  signal: AbortSignal = new AbortController().signal,
): BrowserAddonServiceClient {
  return new BrowserAddonServiceClient({
    addonId: "dnd-sheets",
    generationId,
    csrfToken,
    signal,
    fetchService,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
