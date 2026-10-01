import { afterEach, describe, expect, it, vi } from "vitest";
import { changePassword, getCredentialStatus } from "../src/core/credentials.js";
import { recoveryRequest, type RecoveryAction } from "../src/core/recovery.js";

const csrf = "c".repeat(32);
const credentials = { contractVersion: "credential-status.v1", revision: 2, playerEnabled: true };
const recovery = { contractVersion: "recovery-points.v2", revision: 3, points: [] };
const operations = [
  { name: "password status", value: credentials, run: getCredentialStatus },
  {
    name: "password change",
    value: credentials,
    run: (signal: AbortSignal) =>
      changePassword(
        {
          role: "player",
          currentPassword: "local-dm",
          newPassword: "local-player",
          expectedRevision: 1,
        },
        csrf,
        signal,
      ),
  },
  ...(
    [
      undefined,
      { kind: "create" },
      { kind: "restore", scope: "campaign", id: 1, expectedRevision: 2 },
      { kind: "delete", scope: "addon", addonId: "example", id: 1, expectedRevision: 2 },
      { kind: "revert", scope: "campaign", count: 1, expectedRevision: 2 },
    ] satisfies (RecoveryAction | undefined)[]
  ).map((action) => ({
    name: `recovery ${action?.kind ?? "list"}`,
    value: recovery,
    run: (signal: AbortSignal) => recoveryRequest(signal, csrf, action),
  })),
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("Account and recovery request lifetime", () => {
  for (const operation of operations) {
    for (const phase of ["headers", "body"] as const) {
      it.each(["success", "failure"] as const)(
        `${operation.name} releases cancelled ${phase} before late %s without replay`,
        async (outcome) => {
          const started = deferred();
          const release = deferred();
          const finished = deferred();
          const hold = async () => {
            started.resolve();
            await release.promise;
            finished.resolve();
            if (outcome === "failure") throw new Error("Retired Settings response");
          };
          const response = Response.json(operation.value);
          response.json = async () => {
            if (phase === "body") await hold();
            return operation.value;
          };
          const fetch = vi.fn<typeof globalThis.fetch>(async () => {
            if (phase === "headers") await hold();
            return response;
          });
          vi.stubGlobal("fetch", fetch);
          const controller = new AbortController();
          const reason = new Error("Settings disconnected");
          let settlement: unknown;
          const pending = operation.run(controller.signal).then(
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
            await pending;
          }
          expect(settlement).toBe(reason);
          expect(fetch).toHaveBeenCalledOnce();
        },
      );
    }
    it(`${operation.name} never sends for an already retired scope`, async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(operation.value));
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      controller.abort("retired Settings");
      await expect(operation.run(controller.signal)).rejects.toBe("retired Settings");
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it.each(["success", "failure"] as const)(
    "recovery error JSON cannot swallow cancellation before late %s",
    async (outcome) => {
      const started = deferred();
      const release = deferred();
      const finished = deferred();
      const response = Response.json(
        { error: { kind: "RECOVERY_COMPATIBILITY" } },
        { status: 409 },
      );
      response.json = async () => {
        started.resolve();
        await release.promise;
        finished.resolve();
        if (outcome === "failure") throw new Error("Retired error body");
        return { error: { kind: "RECOVERY_COMPATIBILITY" } };
      };
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      const reason = new Error("Recovery review retired");
      let settlement: unknown;
      const pending = recoveryRequest(controller.signal, csrf, {
        kind: "restore",
        scope: "addon",
        addonId: "example",
        id: 1,
        expectedRevision: 2,
      }).catch((error: unknown) => {
        settlement = error;
      });
      await started.promise;
      try {
        controller.abort(reason);
        await vi.waitFor(() => expect(settlement).toBe(reason));
      } finally {
        release.resolve();
        await finished.promise;
        await pending;
      }
      expect(settlement).toBe(reason);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});
