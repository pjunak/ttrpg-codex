import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { InstalledFixture } from "./fixture-types.mts";
import { zip, jsonResponse, installReviewedPackage } from "./installed-graph-fixture.mts";

function schemaPackage(id: string, version: number): Buffer {
  const files: Record<string, string> = {
    "addon.json": JSON.stringify({ packageFormat: 1, id, name: "Saved-data fixture", version: version + ".0.0",
      compatibility: { host: "^2.0.0", addonApi: "^3.0.0" }, capabilities: { required: [], optional: [] }, permissions: [],
      collections: [{ id: "notes", keyed: true, visibility: "dm", schema: "contracts/notes.json", schemaVersion: version + ".0.0",
        ...(version === 3 ? { indexes: [{ path: "/text", unique: true }] } : {}) }] }),
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
  const write = async (generation: string, text: string, expectedRevision: number, key = "one") => jsonResponse(await admin.post(`/api/addons/${id}/generations/${generation}/data/transactions`, { headers, data: {
    contractVersion: "addon-data-transaction.v1", mutations: [{ operation: "put", kind: "collection", dataId: "notes", key, expectedRevision, value: { text } }],
  } }));
  const values = async (generation: string) => jsonResponse(await admin.post(`/api/addons/${id}/generations/${generation}/data/query`, { headers, data: { contractVersion: "addon-data-query.v1", kind: "collection", dataId: "notes", where: [], limit: 10 } }));
  const stage = async (version: number) => jsonResponse(await admin.post("/api/admin/addons/generations", { headers: { ...headers, "Content-Type": "application/zip" }, data: schemaPackage(id, version) }));
  await write(old, "Authored values stay unchanged", 0);
  const next = await stage(2);
  const page = await open(t, "dm", mobile); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.evaluate(cs => localStorage.setItem("codex_lang", cs ? "cs" : "en"), mobile);
  await page.goto("/#/settings"); await page.reload(); await page.locator('[data-category="addons"]').click();
  const manager = page.locator("codex-addon-manager"), row = manager.locator(`[data-addon-id="${id}"]`), schema = manager.locator("codex-addon-schema-upgrade"), dialog = schema.locator("dialog");
  const refresh = async () => { await manager.getByRole("button", { name: mobile ? "Zkontrolovat aktualizace" : "Check for updates", exact: true }).click(); await manager.locator('.addon-manager[aria-busy="false"]').waitFor(); };
  const openReview = async (generation: string) => {
    await row.locator(":scope > details").first().evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await row.locator(`li[data-generation="${generation}"]`).getByRole("button").first().click();
    await schema.getByRole("button", { name: mobile ? "Pokračovat v aktualizaci" : "Continue update", exact: true }).click();
    await dialog.getByRole("link", { name: mobile ? "Stáhnout zálohu dat doplňku" : "Download add-on data backup", exact: true }).waitFor();
  };
  await openReview(next.generationId);
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).state.activeGenerationId, old, "review must leave the current add-on active");
  const backupPath = await dialog.getByRole("link").getAttribute("href"); assert.ok(backupPath);
  const backup = await admin.get(backupPath); assert.equal(backup.headers()["cache-control"], "no-store");
  const image = await jsonResponse(backup); assert.equal(image.addonId, id); assert.equal(Buffer.from(image.bodiesBase64[0], "base64").toString(), '{"text":"Authored values stay unchanged"}');
  assert.equal(await dialog.locator("h3").evaluate(node => node === document.activeElement), true);
  for (let i=0; i<7; i++) { await page.keyboard.press("Tab"); assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true); }
  await dialog.getByRole("button", { name: mobile ? "Ukončit aktualizaci" : "Exit upgrade", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).state.activeGenerationId, old);
  await openReview(next.generationId);
  const heal = () => dialog.getByRole("button", { name: mobile ? "Opravit a aktualizovat" : "Heal and update", exact: true }).click();
  let expectedText = "Authored values stay unchanged";
  if (!mobile) {
    expectedText = "Newer edit made during review"; await write(old, expectedText, 1);
    await heal(); await dialog.getByRole("alert").waitFor();
    assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).state.activeGenerationId, old);
    await dialog.getByRole("button", { name: "Try again", exact: true }).click();
    await dialog.getByRole("link").waitFor();
    const current = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
    await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers, data: { expectedStateRevision: current.state.revision } }));
    await heal(); await dialog.getByRole("button", { name: "Review the current update", exact: true }).click();
    await schema.getByRole("button", { name: "Continue update", exact: true }).click();
    await dialog.getByRole("link").waitFor();
  }
  await dialog.screenshot({ path: resolve(output, `automatic-update-${mobile ? "phone-cs" : "desktop-en"}.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const pattern = "**/api/admin/addon-activation-reviews/*/update/resolve";
  let calls = 0;
  if (mobile) await page.route(pattern, async route => { calls++; await route.fetch(); await route.fulfill({ status: 502, json: { error: { kind: "GATEWAY_FAILURE" } } }); });
  await heal();
  if (mobile) {
    await dialog.getByRole("button", { name: "Ověřit výsledek aktualizace", exact: true }).waitFor();
    assert.equal(calls, 1); await page.unroute(pattern);
    await dialog.getByRole("button", { name: "Ověřit výsledek aktualizace", exact: true }).click();
  }
  await schema.waitFor({ state: "detached" });
  const saved = await values(next.generationId); assert.equal(saved.documents[0].value.text, expectedText); assert.equal(saved.documents[0].revision, mobile ? 1 : 2);
  await write(next.generationId, expectedText, 0, "two");
  const incompatible = await stage(3); await refresh(); await openReview(incompatible.generationId);
  assert.equal(await dialog.getByRole("button", { name: mobile ? "Opravit a aktualizovat" : "Heal and update", exact: true }).isDisabled(), true);
  await dialog.screenshot({ path: resolve(output, `automatic-update-removal-${mobile ? "phone-cs" : "desktop-en"}.png`) });
  if (mobile) await page.route(pattern, async route => { await route.fetch(); await route.abort("failed"); });
  await dialog.getByRole("button", { name: mobile ? "Odstranit data a aktualizovat" : "Remove data and update", exact: true }).click();
  if (mobile) {
    await dialog.getByRole("button", { name: "Ověřit výsledek aktualizace", exact: true }).waitFor(); await page.unroute(pattern);
    // A lost reset response must not erase new saves on its exact retry.
    await jsonResponse(await admin.post(`/api/addons/${id}/generations/${incompatible.generationId}/data/transactions`, { headers, data: {
      contractVersion: "addon-data-transaction.v1", mutations: [{ operation: "put", kind: "collection", dataId: "notes", key: "new", expectedRevision: 0, value: { text: "Saved after reset", rating: 1 } }],
    } }));
    await dialog.getByRole("button", { name: "Ověřit výsledek aktualizace", exact: true }).click();
  }
  await schema.waitFor({ state: "detached" }); assert.equal((await values(incompatible.generationId)).documents.length, mobile ? 1 : 0);
  assert.equal((await jsonResponse(await admin.get(`/api/admin/addons/${id}`))).state.activeGenerationId, incompatible.generationId);
  const player = await open(t, "player");
  for (const operation of ["saved-data", "resolve", "cancel"]) {
    const path = `/api/admin/addon-activation-reviews/private/update/${operation}`;
    assert.equal((await player.context().request.post(path, { data: {} })).status(), 403);
    assert.equal((await admin.post(path, { data: {} })).status(), 403);
  }
  assert.equal((await player.context().request.get(backupPath)).status(), 403);
}
