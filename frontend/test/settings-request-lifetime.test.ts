import { afterEach, describe, expect, it, vi } from "vitest";
import { AddonAdminClient } from "../src/core/addon-admin.js";
import { AddonGitHubClient } from "../src/core/addon-github.js";
import { AddonStorageClient } from "../src/core/addon-storage.js";
import { authorityRejectedEvent, sessionFetch } from "../src/core/player-preview.js";

const csrf = "c".repeat(32);
const generation = {
  addonId: "example",
  generationId: "a".repeat(64),
  version: "1.0.0",
  installedAt: "2026-10-01T12:00:00Z",
};
const storage = {
  contractVersion: "addon-package-storage.v1",
  automatic: true,
  latestOnly: true,
  pending: 0,
  packages: [],
};
const clients = [
  {
    name: "administration",
    value: generation,
    run: (signal: AbortSignal) =>
      new AddonAdminClient(csrf, signal).stage(new File(["fixture"], "addon.zip")),
  },
  {
    name: "GitHub staging",
    value: generation,
    run: (signal: AbortSignal) =>
      new AddonGitHubClient(csrf, signal).stage(
        { repo: "owner/repository", channel: "release", branch: "main", artifact: "package" },
        "b".repeat(64),
      ),
  },
  {
    name: "package housekeeping",
    value: storage,
    run: (signal: AbortSignal) => new AddonStorageClient(csrf, signal).retry(),
  },
];

afterEach(() => vi.unstubAllGlobals());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Settings request lifetime", () => {
  it.each(["inherited", "overridden", "detached"] as const)(
    "preserves a Request's %s signal behavior",
    async (mode) => {
      const previous = new AbortController();
      previous.abort("retired Request");
      const input = new Request("https://codex.test/api/admin/addons", { signal: previous.signal });
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("current"));
      vi.stubGlobal("fetch", fetch);
      const init =
        mode === "overridden"
          ? { signal: new AbortController().signal }
          : mode === "detached"
            ? { signal: null }
            : undefined;
      if (mode === "inherited") {
        await expect(sessionFetch(input, init)).rejects.toBe("retired Request");
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(await (await sessionFetch(input, init)).text()).toBe("current");
        expect(fetch).toHaveBeenCalledOnce();
      }
    },
  );

  it("cancels a live Request using its inherited signal before late headers", async () => {
    const release = deferred();
    const controller = new AbortController();
    const input = new Request("https://codex.test/api/admin/addons", { signal: controller.signal });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await release.promise;
      return new Response("obsolete");
    });
    vi.stubGlobal("fetch", fetch);
    let settlement: unknown;
    const operation = sessionFetch(input).catch((error: unknown) => {
      settlement = error;
    });
    try {
      controller.abort("retired Request");
      await vi.waitFor(() => expect(settlement).toBe("retired Request"));
    } finally {
      release.resolve();
      await operation;
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  for (const client of clients) {
    for (const phase of ["headers", "body"] as const) {
      it.each(["success", "failure"] as const)(
        `${client.name} cancels held ${phase} before late %s without replay`,
        async (outcome) => {
          const started = deferred();
          const release = deferred();
          const finished = deferred();
          const response = Response.json(client.value);
          const hold = async () => {
            started.resolve();
            await release.promise;
            finished.resolve();
            if (outcome === "failure") throw new Error("retired request failed");
          };
          response.json = async () => {
            if (phase === "body") await hold();
            return client.value;
          };
          const fetch = vi.fn<typeof globalThis.fetch>(async () => {
            if (phase === "headers") await hold();
            return response;
          });
          vi.stubGlobal("fetch", fetch);
          const controller = new AbortController();
          const reason = new Error("Settings disconnected");
          let settlement: unknown;
          const operation = client.run(controller.signal).then(
            (value) => {
              settlement = value;
            },
            (error: unknown) => {
              settlement = error;
            },
          );
          await started.promise;
          try {
            controller.abort(reason);
            await vi.waitFor(() => expect(settlement).toBe(reason));
            expect(fetch).toHaveBeenCalledOnce();
          } finally {
            release.resolve();
            await finished.promise;
            await operation;
          }
          expect(settlement).toBe(reason);
          expect(fetch).toHaveBeenCalledOnce();
        },
      );
    }
    it(`${client.name} does not send a request for a retired scope`, async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(client.value));
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      controller.abort("retired Settings");
      await expect(client.run(controller.signal)).rejects.toBe("retired Settings");
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it.each([401, 403])(
    "a retired %s response cannot reject the current authority",
    async (status) => {
      vi.stubGlobal("location", new URL("https://codex.test/"));
      const events = new EventTarget();
      const rejected = vi.fn();
      events.addEventListener(authorityRejectedEvent, rejected);
      vi.stubGlobal("window", events);
      const started = deferred();
      const release = deferred();
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        started.resolve();
        await release.promise;
        return new Response("retired authority", { status });
      });
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      let settlement: unknown;
      const operation = sessionFetch("/api/admin/addons", {
        signal: controller.signal,
        headers: { "X-Codex-CSRF": csrf },
      }).catch((error: unknown) => {
        settlement = error;
      });
      await started.promise;
      try {
        controller.abort("retired authority");
        await vi.waitFor(() => expect(settlement).toBe("retired authority"));
      } finally {
        release.resolve();
        await operation;
      }
      expect(rejected).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([401, 403])(
    "does not publish a retired %s rejection when its headers arrive",
    async (status) => {
      vi.stubGlobal("location", new URL("https://codex.test/"));
      const events = new EventTarget();
      const rejected = vi.fn();
      events.addEventListener(authorityRejectedEvent, rejected);
      vi.stubGlobal("window", events);
      const release = deferred();
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        await release.promise;
        return new Response("obsolete authority", { status });
      });
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      const operation = sessionFetch("/api/admin/addons", {
        signal: controller.signal,
        headers: { "X-Codex-CSRF": csrf },
      }).catch(() => undefined);
      controller.abort("retired Settings");
      release.resolve();
      await operation;
      expect(rejected).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});
