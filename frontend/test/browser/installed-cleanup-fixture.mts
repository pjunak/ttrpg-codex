import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { InstalledFixture } from "./fixture-types.mts";
import { installReviewedPackage, jsonResponse, zip } from "./installed-graph-fixture.mts";

function archive(id: string, version: string): Buffer {
  const files: Record<string, string> = {
    "addon.json": JSON.stringify({
      packageFormat: 1,
      id,
      name: "Cleanup fixture",
      version,
      compatibility: { host: "^2.0.0", addonApi: "^3.0.0" },
      capabilities: { required: [], optional: [] },
      permissions: [],
    }),
  };
  files["checksums.json"] = JSON.stringify({
    algorithm: "sha256",
    files: Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        createHash("sha256").update(body).digest("hex"),
      ]),
    ),
  });
  return zip(files);
}
export async function exercisePackageCleanup({
  t,
  open,
  admin,
  csrf,
  output,
  mobile,
}: InstalledFixture): Promise<void> {
  // This host deliberately keeps historical builds for rollback acceptance.
  // The operator API remains available, but neither retention policy exposes
  // manual housekeeping controls to users. Automatic retention has Go and
  // installed recovery coverage against a separate disposable host.
  const id = `cleanup-${mobile ? "phone" : "desktop"}`,
    headers = { "X-Codex-CSRF": csrf };
  const first = await installReviewedPackage(admin, csrf, id, archive(id, "1.0.0"), []);
  await jsonResponse(await admin.post("/api/recovery", { headers, data: {} }));
  const second = await installReviewedPackage(admin, csrf, id, archive(id, "2.0.0"), []);
  const third = await installReviewedPackage(admin, csrf, id, archive(id, "3.0.0"), []);
  const one = first.state.activeGenerationId,
    two = second.state.activeGenerationId;
  const review = async (scope: unknown) =>
    jsonResponse(
      await admin.post("/api/admin/addon-package-cleanup/review", { headers, data: scope }),
    );
  const protectedBuild = await review({ addonId: id, generationId: one });
  assert.equal(protectedBuild.removeCount, 0);
  assert.equal(protectedBuild.generations[0].protection, "recovery");
  const retained = await review({ addonId: id, keepInactive: 1 });
  assert.equal(
    retained.generations.find((g: { generationId: string }) => g.generationId === two).protection,
    "retention",
  );
  const scope = { addonId: id, generationId: two },
    stale = await review(scope);
  await jsonResponse(
    await admin.post(`/api/admin/addons/${id}/activation-reviews`, {
      headers,
      data: { generationId: two },
    }),
  );
  assert.equal(
    (
      await admin.post("/api/admin/addon-package-cleanup/apply", {
        headers,
        data: { scope, reviewSha256: stale.reviewSha256 },
      })
    ).status(),
    409,
  );
  const fresh = await review(scope),
    receipt = { scope, reviewSha256: fresh.reviewSha256 };
  assert.equal(
    (
      await jsonResponse(
        await admin.post("/api/admin/addon-package-cleanup/apply", { headers, data: receipt }),
      )
    ).complete,
    true,
  );
  assert.equal(
    (
      await jsonResponse(
        await admin.post("/api/admin/addon-package-cleanup/apply", { headers, data: receipt }),
      )
    ).complete,
    true,
  );
  const snapshot = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
  assert.equal(snapshot.state.activeGenerationId, third.state.activeGenerationId);
  assert.equal(snapshot.generations.length, 2);

  const page = await open(t, "dm", mobile);
  page.setDefaultTimeout(15000);
  await page.goto("/#/settings");
  await page.locator('[data-category="addons"]').click();
  const manager = page.locator("codex-addon-manager");
  for (const cs of [false, true]) {
    await page.evaluate((cs) => localStorage.setItem("codex_lang", cs ? "cs" : "en"), cs);
    await page.reload();
    await page.locator('[data-category="addons"]').click();
    await manager.locator('.addon-manager[aria-busy="false"]').waitFor();
    assert.equal(
      await manager
        .getByRole("button", {
          name: /Clean up saved packages|Remove saved package|Vyčistit uložené balíčky|Odstranit uložený balíček/u,
        })
        .count(),
      0,
    );
    assert.equal(await manager.locator(".addon-cleanup-review").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  await manager.screenshot({
    path: resolve(output, `package-storage-${mobile ? "phone" : "desktop"}.png`),
  });
  const player = await open(t, "player");
  for (const operation of ["review", "apply", "retry"]) {
    const path = `/api/admin/addon-package-cleanup/${operation}`;
    assert.equal((await player.context().request.post(path, { data: {} })).status(), 403);
    assert.equal((await admin.post(path, { data: {} })).status(), 403);
  }
}
