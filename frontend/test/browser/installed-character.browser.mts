import { inventoryView, characterTab } from "./installed-character-navigation-fixture.mts";
import assert from "node:assert/strict";
import { trackBrowserContext } from "./browser-diagnostics.mts";
import { reportBrowserFailure } from "./failure-diagnostics.mts";
import { before, after, test } from "node:test";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Readable } from "node:stream";
import { chromium, request, type APIRequestContext, type Browser } from "playwright";
import {
  jsonResponse,
  installReviewedPackage,
  enableAllRuleSources,
} from "./installed-graph-fixture.mts";
import { registerCharacterCreationTests } from "./installed-character-creation-fixture.mts";
import { registerCharacterOutputTests } from "./installed-character-output-fixture.mts";
import { registerCompactTests } from "./installed-character-compact-fixture.mts";
import { registerRefusalTest } from "./installed-character-command-fixture.mts";
import { installedHostDiagnostics } from "./installed-host-diagnostics.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(root, "frontend/test-results/installed-character");
const paths = [
  process.env.CODEX_ENGINE_ZIP,
  process.env.CODEX_SHEETS_ZIP,
  process.env.CODEX_COMPENDIUM_ZIP,
];
const enabled = paths.every(Boolean);
let directory: string,
  host: ChildProcessByStdio<null, Readable, Readable>,
  admin: APIRequestContext,
  browser: Browser,
  csrf: string,
  origin: string;
const diagnostics = installedHostDiagnostics(output, () => host);
before(async () => {
  if (!enabled) return;
  await diagnostics.run("start-host", async () => {
    await mkdir(output, { recursive: true });
    directory = await mkdtemp(resolve(output, "host-"));
    const binary = resolve(directory, process.platform === "win32" ? "codex.exe" : "codex");
    await promisify(execFile)("go", ["build", "-o", binary, "./cmd/codex"], {
      cwd: root,
      windowsHide: true,
      timeout: 120000,
    });
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as AddressInfo).port;
    await new Promise((done) => probe.close(done));
    origin = `http://127.0.0.1:${port}`;
    host = spawn(
      binary,
      [
        "-listen",
        `127.0.0.1:${port}`,
        "-data-dir",
        resolve(directory, "data"),
        "-web-dir",
        resolve(root, "frontend/dist"),
      ],
      {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_DM_PASSWORD: "local-character-dm",
          CODEX_PLAYER_PASSWORD: "local-character-player",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    host.stdout.on("data", (chunk) => {
      diagnostics.append(chunk);
    });
    host.stderr.on("data", (chunk) => {
      diagnostics.append(chunk);
    });
    admin = await request.newContext({ baseURL: origin });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await admin.get("/api/health")).ok()) {
          ready = true;
          break;
        }
      } catch {
        /* Local fixture starting. */
      }
      await sleep(100);
    }
    assert.ok(ready, "Character fixture host did not become ready");
  });
  csrf = await diagnostics.run("login", async (evidence) => {
    const response = await admin.post("/api/login", { data: { password: "local-character-dm" } });
    evidence.status = response.status();
    return (await jsonResponse(response)).csrfToken;
  });
  const ids = ["dnd-engine", "dnd-sheets", "dnd-2024-compendium"];
  for (let index = 0; index < paths.length; index++)
    await diagnostics.run(`install-${ids[index]!}`, async () =>
      installReviewedPackage(admin, csrf, ids[index]!, await readFile(resolve(paths[index]!)), []),
    );
  await diagnostics.run("enable-rule-sources", () => enableAllRuleSources(admin, csrf));
  await diagnostics.run("seed-character", async (evidence) => {
    const response = await admin.post("/api/campaign/transactions", {
      headers: { "X-Codex-CSRF": csrf },
      data: {
        contractVersion: "campaign-mutation.v1",
        mutations: [
          {
            operation: "put",
            collection: "characters",
            key: "new-hero",
            expectedRevision: 0,
            value: { id: "new-hero", name: "New Hero", knowledge: 4, visibility: "public" },
          },
        ],
      },
    });
    evidence.status = response.status();
    return jsonResponse(response);
  });
  browser = await diagnostics.run("launch-browser", () => chromium.launch({ headless: true }));
});
after(async () => {
  await browser?.close();
  await admin?.dispose();
  if (host && host.exitCode === null) {
    const closed = once(host, "close");
    host.kill();
    await closed;
  }
  if (directory) {
    const child = relative(output, directory);
    assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function call(method: string, params: Record<string, unknown>) {
  const state = await diagnostics.run(
    "read-generation",
    async (evidence) => {
      const response = await admin.get("/api/admin/addons/dnd-sheets");
      evidence.status = response.status();
      return jsonResponse(response);
    },
    method,
  );
  const base = `/api/addons/dnd-sheets/generations/${state.state.activeGenerationId}/services`,
    headers = { "X-Codex-CSRF": csrf };
  const target = await diagnostics.run(
    "connect-service",
    async (evidence) => {
      const response = await admin.post(`${base}/connect`, {
        headers,
        data: {
          contractVersion: "addon-service-connect.v1",
          contract: "dnd5e.character",
          range: "^2.0.0",
          cardinality: "many",
          includeOwn: true,
        },
      });
      evidence.status = response.status();
      const connection = await jsonResponse(response);
      const target = connection.providers.find(
        (provider: { addonId: string }) => provider.addonId === "dnd-sheets",
      );
      assert.ok(target);
      return target;
    },
    method,
  );
  return diagnostics.run(
    "call-service",
    async (evidence) => {
      const response = await admin.post(`${base}/call`, {
        headers,
        data: {
          contractVersion: "addon-service-call.v1",
          contract: "dnd5e.character",
          providerAddonId: target.addonId,
          providerVersion: target.contractVersion,
          providerGeneration: target.generation,
          bindingRevision: target.bindingRevision,
          method,
          params: { contractVersion: "character.v2", key: "new-hero", ...params },
          deadlineMs: 30000,
        },
      });
      evidence.status = response.status();
      return (await jsonResponse(response)).result;
    },
    method,
  );
}

registerCompactTests(enabled, () => ({ admin, browser, csrf, origin, output, call }));
registerRefusalTest(enabled, () => ({ admin, browser, csrf, origin, output, call }));

void test(
  "incomplete builds autosave with bounded steppers, searchable choices and no draft or history UI",
  { skip: !enabled },
  async (t) => {
    const context = await browser.newContext({
      storageState: await admin.storageState(),
      viewport: { width: 1440, height: 1000 },
    });
    await trackBrowserContext(t, context);
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/#/characters/new-hero");
    await page.locator("#character-view-addons").click();
    const sheet = page.locator(".addon-dnd-character");
    try {
      await sheet.getByLabel("STR", { exact: true }).waitFor({ timeout: 10000 });
    } catch (error) {
      await reportBrowserFailure(t, page, resolve(output, "failed-autosave"), { errors }, error);
    }
    await page.waitForFunction(
      () => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"),
    );
    assert.equal(await sheet.locator(".dnd-sheet-heading").count(), 0);
    assert.equal(await sheet.locator("#dnd-tab-notes").count(), 0);
    assert.equal(
      await sheet
        .getByRole("tablist", { name: "Character views" })
        .getAttribute("aria-orientation"),
      "vertical",
    );
    await sheet.locator("#dnd-tab-sheet").focus();
    await page.keyboard.press("End");
    assert.equal(await sheet.locator("#dnd-tab-tools").getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowUp");
    assert.equal(await sheet.locator("#dnd-tab-builder").getAttribute("aria-selected"), "true");
    assert.equal(
      await sheet.locator(".dse-build-rail").evaluate((node) => (node as HTMLDetailsElement).open),
      true,
    );
    const rail = await sheet.locator(".dse-build-rail").boundingBox(),
      main = await sheet.locator(".dse-builder-main").boundingBox();
    assert.ok(rail && main && rail.x + rail.width <= main.x);
    const builderTab = await sheet.locator("#dnd-tab-builder").boundingBox(),
      toolsTab = await sheet.locator("#dnd-tab-tools").boundingBox(),
      spellsTab = await sheet.locator("#dnd-tab-spells").boundingBox();
    assert.ok(
      builderTab &&
        toolsTab &&
        spellsTab &&
        builderTab.x === toolsTab.x &&
        toolsTab.y > builderTab.y &&
        builderTab.y > spellsTab.y + 80,
    );
    await sheet.locator("#dnd-builder-tab-dm-given").click();
    await sheet.getByRole("button", { name: "Give a DM grant", exact: true }).waitFor();
    await sheet.locator("#dnd-builder-tab-character").click();
    assert.equal(
      await sheet.getByRole("button", { name: "Give a DM grant", exact: true }).count(),
      0,
    );
    assert.equal(await sheet.locator("#dnd-tab-history").count(), 0);
    assert.equal(
      await sheet.getByRole("button", { name: /draft|Save changes|Edit sheet/i }).count(),
      0,
    );
    const strength = sheet.locator(".character-stepper").first();
    await strength.getByRole("button", { name: "Increase", exact: true }).click();
    await strength.getByRole("button", { name: "Increase", exact: true }).click();
    assert.match(await sheet.locator(".dnd-builder-progress").innerText(), /2 \/ 27.*25/);
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.build.baseScores.STR, 10);
    for (const ability of ["STR", "DEX", "CON"])
      await sheet.getByLabel(ability, { exact: true }).press("End");
    assert.match(await sheet.locator(".dnd-builder-progress").innerText(), /27 \/ 27.*0/);
    assert.equal(await sheet.getByLabel("INT", { exact: true }).inputValue(), "8");
    assert.equal(
      await sheet
        .locator(".character-stepper")
        .nth(3)
        .getByRole("button", { name: "Increase", exact: true })
        .isDisabled(),
      true,
    );
    for (const ability of ["STR", "DEX", "CON"])
      await sheet.getByLabel(ability, { exact: true }).press("Home");
    await sheet.getByLabel("STR", { exact: true }).press("ArrowUp");
    await sheet.getByLabel("STR", { exact: true }).press("ArrowUp");
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    const species = sheet.getByRole("combobox", { name: "Species", exact: true });
    await species.fill("dwa");
    await sheet.getByRole("option", { name: "Dwarf", exact: true }).hover();
    assert.ok(
      await sheet
        .getByRole("option", { name: "Dwarf", exact: true })
        .getAttribute("aria-describedby"),
    );
    assert.ok(
      (await sheet.getByRole("option", { name: "Dwarf", exact: true }).locator("small").innerText())
        .length > 0,
    );
    await sheet.getByRole("option", { name: "Dwarf", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.build.species, "dwarf");
    await sheet.getByRole("combobox", { name: "Background", exact: true }).fill("sold");
    await sheet.getByRole("option", { name: "Soldier", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    await sheet.locator("#dnd-builder-tab-add-class").click();
    await sheet.getByRole("combobox", { name: "Add class", exact: true }).fill("fight");
    await sheet.getByRole("option", { name: "Fighter", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.build.levels[0].classId, "fighter");
    await sheet.locator("#dnd-builder-tab-fighter").click();
    await sheet.getByRole("button", { name: "Add level", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.build.levels.length, 2);
    await sheet.getByRole("button", { name: "Remove level", exact: true }).last().click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.build.levels.length, 1);
    await sheet.getByRole("button", { name: "Remove level", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.build.levels.length, 0);
    assert.equal(await sheet.locator("#dnd-builder-tab-fighter").count(), 0);
    await sheet.locator("#dnd-builder-tab-add-class").click();
    await sheet.getByRole("combobox", { name: "Add class", exact: true }).fill("fight");
    await sheet.getByRole("option", { name: "Fighter", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal(await sheet.locator("#dnd-builder-tab-levels").count(), 0);
    await sheet.locator("#dnd-builder-tab-fighter").click();
    await sheet.getByRole("heading", { name: "Fighter", exact: true }).waitFor();
    await sheet.locator("#dnd-builder-tab-character").click();
    await page.screenshot({
      path: resolve(output, "autosave-builder-desktop.png"),
      fullPage: true,
    });
    for (const width of [1920, 1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(
        () =>
          window.innerWidth >= 768 ||
          (document.querySelector(".campaign-sidebar")?.getBoundingClientRect().right ?? 0) <= 1,
      );
      assert.ok(
        await sheet.evaluate(
          (element) =>
            element.scrollWidth <= document.documentElement.clientWidth &&
            element.getBoundingClientRect().width <= 1360,
        ),
      );
      await page.screenshot({
        path: resolve(output, `autosave-builder-${width}.png`),
        fullPage: true,
      });
    }
    await page.reload();
    await page.locator("#character-view-addons").click();
    await sheet.locator("#dnd-tab-builder").click();
    await sheet.getByRole("combobox", { name: "Species", exact: true }).waitFor();
    assert.equal(
      await sheet.getByRole("combobox", { name: "Species", exact: true }).inputValue(),
      "Dwarf",
    );
    assert.equal(await sheet.locator("#dnd-tab-notes").count(), 0);
    assert.deepEqual(errors, []);
  },
);

void test(
  "character edits, grants and play save only the current state and removed endpoints fail",
  { skip: !enabled },
  async () => {
    const initial = await call("load", {}),
      input = initial.state?.inputs ?? initial.evaluation.inputs;
    input.build.species = "dwarf";
    input.build.background = "soldier";
    input.build.levels = [{ id: "fighter-one", classId: "fighter" }];
    input.build.method = "array";
    input.build.baseScores = { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 };
    input.build.choices = [];
    for (let round = 0; round < 6; round++) {
      const evaluated = await call("evaluate", {
        operation: "build",
        inputs: input,
        expectedRevision: initial.revision,
      });
      if (evaluated.evaluation.ready) break;
      for (const descriptor of [
        ...evaluated.evaluation.plan.creationChoices,
        ...evaluated.evaluation.plan.creationAbilityChoices,
        ...evaluated.evaluation.plan.classChoices,
      ] as Record<string, any>[]) {
        if (input.build.choices.some((choice: { id: string }) => choice.id === descriptor.id))
          continue;
        if (descriptor.kind === "abilityBudget") {
          let remaining = Number(descriptor.budget);
          const assignment: Record<string, number> = {};
          for (const ability of descriptor.eligible) {
            const amount = Math.min(remaining, Number(descriptor.perAbilityMax));
            if (amount) assignment[ability] = amount;
            remaining -= amount;
          }
          input.build.choices.push({ id: descriptor.id, slot: 0, value: assignment });
        } else {
          const choices = evaluated.evaluation.guidance.choices[descriptor.id]?.options ?? [];
          for (let slot = 0; slot < Number(descriptor.count ?? 1) && choices[slot]; slot++)
            input.build.choices.push({ id: descriptor.id, slot, value: choices[slot].id });
        }
      }
    }
    let current = await call("save", {
      operation: "build",
      operationId: "complete-character",
      summary: "Complete fighter",
      expectedRevision: initial.revision,
      inputs: input,
    });
    assert.equal(current.status, "ready", JSON.stringify(current));
    assert.equal(current.evaluation.ready, true, JSON.stringify(current.evaluation.issues));
    for (const method of ["history", "revision", "compare"])
      await assert.rejects(() => call(method, {}));
    await assert.rejects(() =>
      call("save", {
        operation: "restore",
        operationId: "removed-restore",
        summary: "Removed",
        expectedRevision: current.revision,
      }),
    );
    const grant = {
      id: "forged",
      actorId: "forged",
      grantedAt: "",
      name: "Reward",
      reason: "Quest",
      active: true,
      effectiveLevel: 1,
      condition: "always",
      effects: [{ target: "maxHp", mode: "add", value: 2 }],
      waivers: [],
    };
    current = await call("save", {
      operation: "grant",
      operationId: "autosave-grant",
      summary: "Reward",
      expectedRevision: current.revision,
      grant,
    });
    assert.equal(current.status, "ready");
    assert.notEqual(current.state.inputs.grants[0].actorId, "forged");
    current = await call("save", {
      operation: "amend-grant",
      operationId: "autosave-amend",
      summary: "Amend",
      expectedRevision: current.revision,
      grantId: current.state.inputs.grants[0].id,
      grant: { ...grant, reason: "Changed", effects: [] },
    });
    assert.equal(current.state.inputs.grants.length, 1);
    current = await call("save", {
      operation: "revoke-grant",
      operationId: "autosave-revoke",
      summary: "Remove",
      expectedRevision: current.revision,
      grantId: current.state.inputs.grants[0].id,
    });
    assert.equal(current.state.inputs.grants.length, 0);
    current = await call("save", {
      operation: "play",
      operationId: "autosave-rest",
      summary: "Long rest",
      expectedRevision: current.revision,
      change: { operation: "rest", rest: "long" },
    });
    const max = current.state.inputs.play.hp;
    assert.ok(max > 0);
    current = await call("save", {
      operation: "play",
      operationId: "autosave-damage",
      summary: "Damage",
      expectedRevision: current.revision,
      change: { operation: "damage", amount: 2 },
    });
    assert.equal(current.state.inputs.play.hp, max - 2);
    // A play action the rules refuse is answered, not thrown: nothing is saved.
    const refused = await call("save", {
      operation: "play",
      operationId: "invalid-overheal",
      summary: "Invalid",
      expectedRevision: current.revision,
      change: { operation: "set-hp", amount: max + 1 },
    });
    assert.equal(refused.status, "invalid");
    assert.ok(refused.message.length > 0);
    assert.equal(refused.revision, current.revision);
  },
);

void test(
  "play tabs stay editable, Tools owns transfer, and layouts fit desktop and phone",
  { skip: !enabled },
  async (t) => {
    const context = await browser.newContext({
      storageState: await admin.storageState(),
      viewport: { width: 1440, height: 1000 },
    });
    await trackBrowserContext(t, context);
    const page = await context.newPage();
    await page.goto(origin + "/#/characters/new-hero");
    await page.locator("#character-view-addons").click();
    const sheet = page.locator(".addon-dnd-character");
    await inventoryView(sheet);
    await sheet.locator('.dse-bp-head > button, [data-focus-key="pack/add"]').waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"),
    );
    await sheet.locator('.dse-bp-head > button, [data-focus-key="pack/add"]').click();
    const picker = sheet.getByRole("dialog");
    await picker.getByLabel("Find catalog item").fill("dagger");
    await picker.getByRole("button", { name: "Add Dagger", exact: true }).click();
    await picker.getByRole("button", { name: "Add selected items", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.play.inventory[0].name, "Dagger");
    const quantity = sheet.getByLabel("Dagger quantity");
    await quantity.fill("3");
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.play.inventory[0].quantity, 3);
    await sheet.getByLabel("Move Dagger", { exact: true }).selectOption("equipped");
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.play.inventory[0].location, "equipped");
    await characterTab(sheet, "sheet");
    await sheet.getByLabel("Current HP", { exact: true }).fill("5");
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.play.hp, 5);
    for (const width of [1920, 1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(
        () =>
          window.innerWidth >= 768 ||
          (document.querySelector(".campaign-sidebar")?.getBoundingClientRect().right ?? 0) <= 1,
      );
      assert.ok(
        await sheet.evaluate(
          (element) =>
            element.scrollWidth <= document.documentElement.clientWidth &&
            element.getBoundingClientRect().width <= 1360,
        ),
      );
      await page.screenshot({
        path: resolve(output, `autosave-sheet-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(
      () => document.querySelector(".addon-dnd-character")!.getBoundingClientRect().width > 1120,
    );
    const compactHeight = await sheet
      .locator(".dse-cards")
      .evaluate((element) => element.getBoundingClientRect().height);
    assert.equal(await sheet.getByRole("button", { name: /Export/ }).count(), 0);
    await sheet.locator("#dnd-tab-tools").click();
    await sheet.getByRole("button", { name: "Export character", exact: true }).waitFor();
    await sheet.getByLabel("Sheet layout").selectOption("classic");
    await sheet.locator("#dnd-tab-sheet").click();
    assert.equal(await sheet.getAttribute("data-layout"), "classic");
    const classicHeight = await sheet
      .locator(".dse-cards")
      .evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(compactHeight < classicHeight, JSON.stringify({ compactHeight, classicHeight }));
    t.diagnostic(JSON.stringify({ compactHeight, classicHeight }));
    await page.screenshot({ path: resolve(output, "classic-layout-1440.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(
      () => (document.querySelector(".campaign-sidebar")?.getBoundingClientRect().right ?? 0) <= 1,
    );
    assert.ok(
      await sheet.evaluate(
        (element) =>
          element.scrollWidth <= document.documentElement.clientWidth &&
          element.getBoundingClientRect().width <= 1120,
      ),
    );
    await page.screenshot({ path: resolve(output, "autosave-classic-390.png"), fullPage: true });
    await sheet.locator("#dnd-tab-tools").click();
    await sheet.getByRole("button", { name: "Import character", exact: true }).click();
    const current = await call("load", {}),
      envelope = {
        format: "dnd-character.v1",
        schemaVersion: "4.0.0",
        inputs: { ...current.state.inputs, notes: "Imported notes" },
      };
    await sheet.getByLabel("Or paste the export").fill(JSON.stringify(envelope));
    await sheet.getByRole("button", { name: "Review import", exact: true }).click();
    await sheet.getByRole("button", { name: "Replace character", exact: true }).click();
    await sheet
      .locator("[data-character-status]")
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    assert.equal((await call("load", {})).state.inputs.notes, "Imported notes");
  },
);
registerCharacterCreationTests(enabled, () => ({ admin, browser, csrf, origin, output, call }));
registerCharacterOutputTests(enabled, () => ({ admin, browser, csrf, origin, output, call }));
