import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
interface SchemaReview { reviewId: string; reviewSha256: string; blockers: { code: string }[] }
import type { InstalledFixture } from "./fixture-types.mts";
import { zip, jsonResponse, installReviewedPackage } from "./installed-graph-fixture.mts";

function schemaPackage(id: string, version: number): Buffer {
  const files: Record<string, string> = {
    "addon.json": JSON.stringify({ packageFormat: 1, id, name: "Saved-data fixture", version: version + ".0.0",
      compatibility: { host: "^2.0.0", addonApi: "^3.0.0" }, capabilities: { required: [], optional: [] }, permissions: [],
      collections: [{ id: "notes", keyed: true, visibility: "dm", schema: "contracts/notes.json", schemaVersion: version + ".0.0" }] }),
    "contracts/notes.json": JSON.stringify({ type: "object", additionalProperties: false, required: version === 3 ? ["text", "rating"] : ["text"],
      properties: { text: { type: "string" }, ...(version > 1 ? { rating: { type: "integer" } } : {}) } }),
  };
  files["checksums.json"] = JSON.stringify({ algorithm: "sha256", files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex")])) });
  return zip(files);
}
export async function exerciseSchemaUpgrade({ t, open, admin, csrf, output, mobile }: InstalledFixture): Promise<void> {
  const id = "schema-" + (mobile ? "phone" : "desktop"), headers = { "X-Codex-CSRF": csrf };
  const installed = await installReviewedPackage(admin, csrf, id, schemaPackage(id, 1), []);
  const old = installed.state.activeGenerationId;
  await jsonResponse(await admin.post(`/api/addons/${id}/generations/${old}/data/transactions`, { headers, data: {
    contractVersion: "addon-data-transaction.v1", mutations: [{ operation: "put", kind: "collection", dataId: "notes", key: "one", expectedRevision: 0, value: { text: "Authored values stay unchanged" } }],
  } }));
  const next = await jsonResponse(await admin.post("/api/admin/addons/generations", { headers: { ...headers, "Content-Type": "application/zip" }, data: schemaPackage(id, 2) }));
  const page = await open(t, "dm", mobile); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.evaluate(cs => localStorage.setItem("codex_lang", cs ? "cs" : "en"), mobile);
  await page.goto("/#/settings"); await page.reload(); await page.locator('[data-category="addons"]').click();
  const manager = page.locator("codex-addon-manager"), row = manager.locator(`[data-addon-id="${id}"]`), schema = manager.locator("codex-addon-schema-upgrade");
  const openReview = async () => {
    await row.locator(`li[data-generation="${next.generationId}"]`).getByRole("button").first().click();
    await schema.getByRole("heading", { name: mobile ? "Kontrola kompatibility uložených dat" : "Review saved-data compatibility" }).waitFor();
  };
  await row.locator(":scope > details").first().evaluate(node => { (node as HTMLDetailsElement).open = true; });
  await openReview();
  await schema.getByText(mobile ? /nejprve doplněk vypněte/u : /disable the add-on first/u).waitFor();
  assert.equal(await schema.getByRole("button").count(), 0, "active package cannot upgrade values");
  await manager.getByRole("dialog").getByRole("button", { name: mobile ? "Zrušit kontrolu" : "Cancel review", exact: true }).click();
  const current = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers, data: { expectedStateRevision: current.state.revision } }));
  await manager.getByRole("button", { name: mobile ? "Zkontrolovat aktualizace" : "Check for updates", exact: true }).click();
  await row.getByText(mobile ? "Vypnuto nebo čeká na aktivaci" : "Disabled or awaiting activation", { exact: true }).waitFor();
  await openReview();
  await schema.getByRole("button", { name: mobile ? "Zkontrolovat uložená data" : "Review saved data", exact: true }).click();
  await schema.getByText(mobile ? "Zkontrolované dokumenty: 1" : "Saved documents checked: 1", { exact: true }).waitFor();
  assert.equal(await schema.locator("[data-schema-title]").evaluate(node => node === document.activeElement), true);
  const recoveryLink = schema.getByRole("link", { name: mobile ? "Stáhnout snímek před změnou" : "Download pre-upgrade snapshot", exact: true });
  const recoveryPath = await recoveryLink.getAttribute("href"); assert.ok(recoveryPath);
  const recovered = await admin.get(recoveryPath); assert.equal(recovered.headers()["cache-control"], "no-store");
  const recovery = await recovered.json() as { format: string; bodiesBase64: string[] };
  assert.equal(recovery.format, "codex-addon-schema-snapshot.v1");
  assert.deepEqual(JSON.parse(Buffer.from(recovery.bodiesBase64[0]!, "base64").toString()), { text: "Authored values stay unchanged" });
  const reviewPath = recoveryPath.replace(/\/recovery$/u, "");
  const review = await (await admin.get(reviewPath)).json() as SchemaReview;
  // Other roles, DM player-preview, and missing CSRF cannot prepare, apply or read recovery.
  const player = await open(t, "player");
  assert.equal((await player.context().request.get(recoveryPath)).status(), 403);
  const preview = await (await admin.post("/api/player-preview", { headers })).json() as { token: string };
  assert.equal((await admin.get(recoveryPath, { headers: { "X-Codex-Player-Preview": preview.token } })).status(), 403);
  assert.equal((await admin.post(reviewPath + "/apply", { data: { reviewSha256: review.reviewSha256 } })).status(), 403);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (!mobile) await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await schema.getByText(mobile ? "Změny schématu" : "Schema changes", { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await manager.getByRole("dialog").screenshot({ path: resolve(output, "schema-review-" + (mobile ? "phone-cs" : "desktop-en-200") + ".png") });
  if (!mobile) await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  let applies = 0;
  const pattern = "**" + reviewPath + "/apply";
  if (mobile) await page.route(pattern, async route => { applies++; await route.fetch(); await route.abort("failed"); });
  await schema.getByRole("button", { name: mobile ? "Použít zkontrolované změny schématu" : "Apply reviewed schema changes", exact: true }).click();
  if (mobile) {
    await schema.getByText("Výsledek se nepodařilo potvrdit. Před opakováním ověřte uloženou kontrolu.", { exact: true }).waitFor();
    assert.equal(applies, 1);
    assert.equal(await schema.getByRole("button", { name: "Použít zkontrolované změny schématu", exact: true }).isDisabled(), true);
    await page.unroute(pattern);
    await schema.getByRole("button", { name: "Ověřit uložený výsledek", exact: true }).click();
  }
  await schema.getByText(mobile ? /Změny schématu byly použity/u : /Saved-data schema changes applied/u).waitFor();
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).state.activeGenerationId, undefined);
  await schema.getByRole("button", { name: mobile ? "Zkontrolovat aktivaci" : "Review activation", exact: true }).click();
  await schema.waitFor({ state: "detached" });
  await manager.getByRole("button", { name: mobile ? "Schválit a aktivovat" : "Approve and activate", exact: true }).click();
  await row.getByRole("button", { name: mobile ? "Vypnout" : "Disable", exact: true }).waitFor();
  const values = await jsonResponse(await admin.post(`/api/addons/${id}/generations/${next.generationId}/data/query`, { headers, data: {
    contractVersion: "addon-data-query.v1", kind: "collection", dataId: "notes", where: [], limit: 10,
  } }));
  assert.equal(values.documents[0]!.revision, 1); assert.deepEqual(values.documents[0]!.value, { text: "Authored values stay unchanged" });
  // A required-value conversion remains blocked; schema-only review cannot invent it.
  const incompatible = await jsonResponse(await admin.post("/api/admin/addons/generations", { headers: { ...headers, "Content-Type": "application/zip" }, data: schemaPackage(id, 3) }));
  const active = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers, data: { expectedStateRevision: active.state.revision } }));
  const blocked = await (await admin.post(`/api/admin/addons/${id}/schema-reviews`, { headers, data: { generationId: incompatible.generationId } })).json() as SchemaReview;
  assert.ok(blocked.blockers.some(b => b.code === "INVALID_STORED_DOCUMENT"));
  assert.equal((await admin.post(`/api/admin/addon-schema-reviews/${blocked.reviewId}/apply`, { headers, data: { reviewSha256: blocked.reviewSha256 } })).status(), 422);
}
