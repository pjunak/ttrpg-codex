import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeBackupEntry } from "./backup-fixture.mts";
import { test } from "node:test";
import { jsonResponse, installReviewedPackage } from "./installed-graph-fixture.mts";
import { replacementImportPackage } from "./installed-import-fixture.mts";
import { openBuilder, type Fixture } from "./installed-character-builder-fixture.mts";
import { spellCharacter } from "./installed-character-spell-fixture.mts";
import { exported, printOutput } from "./installed-character-output-fixture.mts";

export function registerCharacterCompatibilityTests(enabled: boolean, fixture: () => Fixture) {
  for (const variant of ["response", "major"] as const) test("incompatible rules preserve saved reading, outputs and spent grants (" + variant + ")",
    { skip: !enabled, timeout: 90000 }, async t => {
      const f = fixture(), key = "incompatible-provider-" + variant;
      let saved = await spellCharacter(f, key, 2);
      const grant = saved.evaluation.spellOptions.granted.find((row: Record<string, any>) => row.ref === "detect-magic");
      const slot = grant.slots.find((value: string) => value.startsWith("charge:"));
      saved = await f.call("save", { key, operation: "play", operationId: key + "-cast", expectedRevision: saved.revision,
        summary: "Spend a saved grant", change: { operation: "cast-granted-spell", key: grant.key, slot } });
      assert.equal(saved.status, "ready"); assert.equal(saved.state.inputs.play.resourceUses[slot], 1);
      const archive = await readFile(resolve(process.env.CODEX_ENGINE_ZIP!));
      t.after(() => installReviewedPackage(f.admin, f.csrf, "dnd-engine", archive, []));
      const replacement = replacementImportPackage(archive, "4.0.1", (files, manifest) => {
        if (variant === "response") {
          const schema = JSON.parse(files["contracts/character.response.schema.json"]!.toString());
          schema.properties.contractVersion.const = "rules-character-response.v99";
          files["contracts/character.response.schema.json"] = JSON.stringify(schema);
        } else {
          manifest.services.provides[0].version = "5.0.0";
          const service = JSON.parse(files["contracts/rules-engine.service.json"]!.toString());
          service.version = "5.0.0"; files["contracts/rules-engine.service.json"] = JSON.stringify(service);
        }
      });
      await installReviewedPackage(f.admin, f.csrf, "dnd-engine", replacement, []);
      const frozen = await f.call("load", { key });
      assert.equal(frozen.status, "unavailable"); assert.equal(frozen.revision, saved.revision); assert.deepEqual(frozen.state, saved.state);
      const locale = variant === "major" ? "cs" : "en", { page, sheet } = await openBuilder(t, f, key, locale);
      await sheet.locator("#dnd-tab-sheet").click();
      assert.equal(await sheet.getByLabel(locale === "cs" ? "Aktuální životy" : "Current HP", { exact: true }).isDisabled(), true);
      await sheet.locator("#dnd-tab-tools").click();
      assert.deepEqual((await exported(page, sheet, locale)).inputs, saved.state.inputs);
      const popup = await printOutput(page, sheet, locale);
      const printed = await popup.locator("body").innerText();
      assert.ok(printed.includes("Spell Sword") && printed.includes("Retain notes") && printed.includes("Detect Magic"), "Frozen print retains saved equipment and granted spells");
      await popup.close();
      assert.deepEqual((await f.call("load", { key })).state, saved.state, "Read, print and export never rewrite accepted state");
      await installReviewedPackage(f.admin, f.csrf, "dnd-engine", archive, []);
      const restored = await f.call("load", { key });
      assert.equal(restored.status, "ready"); assert.equal(restored.revision, saved.revision);
      assert.deepEqual(restored.state, saved.state); assert.equal(restored.rulesChanged, false, "The original immutable provider needs no rules adoption");
      assert.equal(restored.evaluation.inputs.play.resourceUses[slot], 1);
    });

  test("incompatible sheet schema blocks activation and preserves worker authority and backup state",
    { skip: !enabled, timeout: 90000 }, async t => {
      const f = fixture(), key = "incompatible-sheet-schema", saved = await spellCharacter(f, key, 2);
      const before = await jsonResponse(await f.admin.get("/api/admin/addons/dnd-sheets"));
      const archive = await readFile(resolve(process.env.CODEX_SHEETS_ZIP!));
      const replacement = replacementImportPackage(archive, "5.0.0", (_files, manifest) => { manifest.recordExtensions[0].schemaVersion = "5.0.0"; });
      const headers = { "X-Codex-CSRF": f.csrf };
      const staged = await jsonResponse(await f.admin.post("/api/admin/addons/generations", { headers: { ...headers, "Content-Type": "application/zip" }, data: replacement }));
      const review = await jsonResponse(await f.admin.post("/api/admin/addons/dnd-sheets/activation-reviews", { headers, data: { generationId: staged.generationId } }));
      assert.ok(review.proposal.blockers.some((issue: { code: string }) => issue.code === "DATA_MIGRATION_REQUIRED"), JSON.stringify(review.proposal.blockers));
      assert.equal((await f.admin.post("/api/admin/addon-activation-reviews/" + review.reviewId + "/approval", { headers, data: { grantedPermissionIds: [] } })).ok(), false);
      assert.equal((await f.admin.post("/api/admin/addon-activation-reviews/" + review.reviewId + "/activation", { headers })).ok(), false);
      const after = await jsonResponse(await f.admin.get("/api/admin/addons/dnd-sheets"));
      assert.deepEqual(after.state, before.state, "A blocked schema must not displace the working generation");
      const forged = await f.admin.post("/api/addons/dnd-sheets/generations/" + before.state.activeGenerationId + "/data/transactions", {
        headers, data: { contractVersion: "addon-data-transaction.v1", mutations: [{ operation: "put", kind: "record-extension",
          dataId: "dnd-sheets", key, expectedRevision: saved.revision, value: saved.state }] },
      });
      assert.equal(forged.status(), 403);
      const read = await f.call("load", { key }); assert.equal(read.revision, saved.revision); assert.deepEqual(read.state, saved.state);
      const backup = await f.admin.get("/api/backup"); assert.equal(backup.status(), 200);
      const directory = await mkdtemp(resolve(f.output, "schema-backup-"));
      t.after(async () => { const child = relative(f.output, directory); assert.ok(child && !child.startsWith("..") && !isAbsolute(child)); await rm(directory, { recursive: true, force: true }); });
      const path = resolve(directory, "codex.db"); await writeBackupEntry(await backup.body(), "codex.db", path);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const row = db.prepare("SELECT body_json, revision, schema_version FROM addon_documents WHERE addon_id=? AND data_kind='record-extension' AND data_id=? AND document_key=?").get("dnd-sheets", "dnd-sheets", key);
        assert.ok(row); assert.equal(row.schema_version, "4.0.0"); assert.equal(row.revision, saved.revision);
        assert.deepEqual(JSON.parse(String(row.body_json)), saved.state, "The portable archive retains the exact schema-4 character");
      } finally { db.close(); }
    });
}
