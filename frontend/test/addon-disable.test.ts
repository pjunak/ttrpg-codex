import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAddonDisableReview } from "../src/core/addon-disable.js";
import { AddonAdminClient } from "../src/core/addon-admin.js";

const target = { addonId: "notes", generationId: "b".repeat(64), expectedStateRevision: 1 };
const review = { contractVersion: "addon-disable-review.v1", addonId: "notes", name: "Notes", version: "1.0.0", reviewSha256: "a".repeat(64),
  configurationRevision: 0, graphRevision: "c".repeat(64), targets: [target], stoppedAddonIds: ["notes"], restartedAddonIds: [], effects: [] };
afterEach(() => vi.unstubAllGlobals());
describe("reviewed disable", () => {
  it("rejects mismatched, duplicated or contradictory dependency authority", () => {
    expect(parseAddonDisableReview(review, "notes").targets).toEqual([target]);
    expect(() => parseAddonDisableReview(review, "other")).toThrow();
    for (const changed of [{ contractVersion: "addon-uninstall-review.v1" }, { reviewSha256: "invalid" }, { graphRevision: "bad" }, { targets: [] },
      { targets: [target, target] }, { targets: [{ ...target, expectedStateRevision: -1 }] }, { stoppedAddonIds: ["../notes"] },
      { stoppedAddonIds: ["notes", "notes"] }, { restartedAddonIds: ["notes"] }, { restartedAddonIds: ["other", "other"] }, { effects: [{ addonId: "dependent", name: "Dependent", disabled: true, reasons: [] }] },
      { targets: [target, { ...target, addonId: "dependent" }] }]) {
      expect(() => parseAddonDisableReview({ ...review, ...changed }, "notes")).toThrow();
    }
  });
  it("submits only the reviewed hash and does not retry uncertain confirmations", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(review)).mockRejectedValueOnce(new TypeError("lost response"));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal, client = new AddonAdminClient("csrf", signal);
    const parsed = await client.reviewDisable("notes");
    await expect(client.disable(parsed)).rejects.toThrow("lost response");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("/api/admin/addons/notes/disable-reviewed", expect.objectContaining({ signal, method: "POST",
      headers: expect.objectContaining({ "X-Codex-CSRF": "csrf" }), body: JSON.stringify({ reviewSha256: review.reviewSha256 }) }));
  });
});
