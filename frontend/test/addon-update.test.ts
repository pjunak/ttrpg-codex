import { afterEach, expect, it, vi } from "vitest";
import { AddonAdminClient } from "../src/core/addon-admin.js";

const generation = "a".repeat(64), hash = "b".repeat(64);
const activation = { reviewId: "activation", addonId: "notes", generationId: generation, proposalSha256: hash, status: "prepared",
  proposal: { addonId: "notes", generationId: generation, targetManifest: { id: "notes", name: "Notes", version: "2.0.0", permissions: [{ id: "core.data.read", reason: "Read records" }] },
    requiredPermissionIds: ["core.data.read"], suggestedPermissionIds: ["core.data.read"], changes: { runtimeChanged: true }, blockers: [] } };
const schema = { contractVersion: "addon-schema-review.v1", addonId: "notes", generationId: generation, reviewId: "data-review", reviewSha256: hash, snapshotSha256: hash,
  forActivation: true, expectedStateRevision: 1, status: "prepared", createdAt: "2026-09-27T10:00:00Z", expiresAt: "2026-09-27T10:30:00Z", documents: 0, changes: [], blockers: [] };
afterEach(() => vi.unstubAllGlobals());
it("binds a confirmation to both reviews and rejects a mismatched result", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(activation)).mockResolvedValueOnce(Response.json(schema))
    .mockResolvedValueOnce(Response.json({ reviewId: "other", state: { addonId: "notes", activeGenerationId: generation } }))
    .mockResolvedValueOnce(Response.json({ error: { kind: "UPDATE_RESTORED", message: "restored" } }, { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  const client = new AddonAdminClient("csrf", new AbortController().signal), review = await client.review("notes", generation);
  const data = await client.reviewUpdateData(review);
  await expect(client.resolveUpdate(review, data, "remove", review.required)).rejects.toThrow("invalid server response");
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ proposalSha256: hash, schemaReviewId: "data-review", schemaReviewSha256: hash, action: "remove", grantedPermissionIds: ["core.data.read"] });
  await expect(client.resolveUpdate(review, data, "remove", review.required)).rejects.toMatchObject({ status: 409, code: "UPDATE_RESTORED" });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("rejects permission suggestions absent from the reviewed manifest", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...activation, proposal: { ...activation.proposal, suggestedPermissionIds: ["undeclared"] } })));
  await expect(new AddonAdminClient("csrf", new AbortController().signal).review("notes", generation)).rejects.toThrow();
});
