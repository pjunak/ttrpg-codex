import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Locator } from "playwright";
import type { FixtureRecord, InstalledFixture } from "./fixture-types.mts";
import { required } from "./fixture-types.mts";
import { jsonResponse } from "./installed-graph-fixture.mts";

const collections = [
  "planning_items",
  "planning_flow_links",
  "planning_references",
  "planning_consequences",
  "dm_notes",
  "planning_views",
] as const;

export async function exercisePlannerSession({
  t,
  open,
  admin,
  csrf,
  output,
  mobile,
}: Pick<InstalledFixture, "t" | "open" | "admin" | "csrf" | "output" | "mobile">) {
  const locale = mobile ? "cs" : "en",
    prefix = `session-${locale}-`;
  const id = (name: string) => prefix + name;
  const generation = (await jsonResponse(await admin.get("/api/admin/addons/dm-tools"))).state
    .activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`,
    headers = { "X-Codex-CSRF": csrf };
  const transact = async (mutations: unknown[]) =>
    jsonResponse(
      await admin.post(`${base}/transactions`, {
        headers,
        data: { contractVersion: "addon-data-transaction.v1", mutations },
      }),
    );
  const records = async (dataId: string): Promise<FixtureRecord[]> => {
    const all: FixtureRecord[] = [];
    let cursor: string | undefined, revision: number | undefined;
    do {
      const page = await jsonResponse(
        await admin.post(`${base}/query`, {
          headers,
          data: {
            contractVersion: "addon-data-query.v1",
            kind: "collection",
            dataId,
            limit: 200,
            where: [],
            includeDataRevision: true,
            ...(cursor === undefined ? {} : { cursor }),
            ...(revision === undefined ? {} : { expectedDataRevision: revision }),
          },
        }),
      );
      assert.ok(Number.isSafeInteger(page.dataRevision));
      if (revision !== undefined) assert.equal(page.dataRevision, revision);
      revision = page.dataRevision;
      all.push(...page.documents);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return all;
  };
  const put = (dataId: string, value: Record<string, unknown>, expectedRevision = 0) => ({
    operation: "put",
    kind: "collection",
    dataId,
    key: value.id,
    expectedRevision,
    value,
  });
  const item = (name: string, title: string, kind: string, parent: string | null) => ({
    id: id(name),
    title,
    kind,
    parentId: parent === null ? null : id(parent),
    schemaVersion: 3,
    summary: "",
    objective: "",
    body: "",
    setup: "",
    resolution: "",
    tags: [],
    updatedAt: 1,
    ...(kind === "event" ? { eventType: "story" } : {}),
    ...(kind === "branch" ? { branchType: "decision" } : {}),
  });
  const beforeSession = await Promise.all(collections.map(records));
  await transact(
    [
      item("root", "Northern campaign", "plotline", null),
      item("chapter", "Harbor chapter", "quest", "root"),
      item("canvas", "Arrival board", "quest", "chapter"),
      item("destination", "Inland chapter", "quest", "root"),
      item("other-arrival", "Arrival", "event", "destination"),
      item("arrival", "Arrival", "event", "canvas"),
      item("branch", "The choice", "branch", "canvas"),
      ...Array.from({ length: 205 }, (_, index) =>
        item(`scene-${index}`, `Scene ${String(index).padStart(3, "0")}`, "event", "canvas"),
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        item(`archive-${index}`, `Archive ${index}`, "quest", "root"),
      ),
    ].map((value) => put("planning_items", value)),
  );

  try {
    const page = await open(t, "dm", mobile);
    await page.evaluate((language) => localStorage.setItem("codex_lang", language), locale);
    if (mobile)
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.fontSize = "200%";
        });
      });
    await page.reload();
    const touchTypes: string[] = [];
    await page.exposeFunction("recordPlannerPointer", (type: string) => touchTypes.push(type));
    await page.evaluate(() =>
      document.addEventListener("pointerdown", (event) => {
        void (
          window as unknown as { recordPlannerPointer: (type: string) => Promise<void> }
        ).recordPlannerPointer(event.pointerType);
      }),
    );
    const activate = async (locator: Locator) => (mobile ? locator.tap() : locator.click());
    const label = (en: string, cs: string) => (mobile ? cs : en);
    const button = (en: string, cs: string) =>
      page.getByRole("button", { name: label(en, cs), exact: true });
    const editor = page.getByRole("dialog", {
      name: label("Edit planning item", "Upravit plánovací položku"),
      exact: true,
    });
    const details = editor.getByRole("form", {
      name: label("Planning item details", "Podrobnosti plánovací položky"),
      exact: true,
    });
    const ready = () => page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
    const status = (en: string, cs: string) =>
      page.getByText(label(en, cs), { exact: true }).waitFor();
    const tab = (en: string, cs: string) =>
      activate(editor.getByRole("tab", { name: label(en, cs), exact: true }));
    const close = () => activate(button("Close editor", "Zavřít editor"));
    const choose = async (form: Locator, name: string, text: string) => {
      const control = form.getByRole("combobox", { name, exact: true });
      assert.equal(
        await control.evaluate((element) => element.tagName),
        "INPUT",
        `${name} must use the shared searchable control`,
      );
      await control.fill(text);
      const option = page.getByRole("option", { name: text, exact: true });
      await option.waitFor();
      if (mobile) await option.tap();
      else {
        await control.press("ArrowDown");
        await control.press("Enter");
      }
    };
    const visit = async (key: string) => {
      await page.goto(`/#/addons/dm-tools/planner?item=${key}`);
      await ready();
      if (mobile)
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "moonlit";
        });
    };
    const edit = async (key: string) => {
      await visit(key);
      await activate(button("Edit item", "Upravit položku"));
      await details.waitFor();
    };
    await visit(id("canvas"));
    assert.equal(await page.locator(".dm-plan-card").count(), 207);
    assert.ok((await records("planning_items")).length > 200);
    const unchangedScene = required(
      (await records("planning_items")).find((row) => row.key === id("scene-204")),
    );
    t.diagnostic(`${locale}: loaded a complete paginated planning graph`);

    if (!mobile) {
      await page.locator(`[data-item-id="${id("branch")}"]`).click();
      await page.locator(`[data-item-id="${id("scene-204")}"]`).click({ modifiers: ["Shift"] });
      await button("Connect selected", "Propojit vybrané").click();
      const target = editor.getByRole("combobox", { name: "Flow target", exact: true });
      assert.equal(await target.inputValue(), "Scene 204");
      assert.equal(await target.evaluate((node) => node === document.activeElement), true);
      await close();
    }

    await edit(id("branch"));
    const labels = await editor.locator('header button, [role="tab"]').evaluateAll((controls) =>
      controls.map((control) => {
        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT),
          words: { word: string; fits: boolean }[] = [];
        const box = control.getBoundingClientRect();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const match of (node.textContent ?? "").matchAll(/\S+/gu)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const lines = [...range.getClientRects()];
            words.push({
              word: match[0],
              fits:
                lines.length === 1 &&
                lines.every((line) => line.left >= box.left && line.right <= box.right),
            });
          }
        }
        return { label: control.textContent, words };
      }),
    );
    assert.ok(
      labels.every((label) => label.words.every((word) => word.fits)),
      JSON.stringify({ locale, labels }),
    );
    await tab("Links", "Vazby");
    const flow = editor.locator("form[data-create-flow]");
    await choose(flow, label("Flow target", "Cíl návaznosti"), "Scene 204");
    await flow
      .getByLabel(label("Flow label", "Popisek návaznosti"), { exact: true })
      .fill("Take the ferry");
    await activate(
      flow.getByRole("button", { name: label("Create flow", "Vytvořit návaznost"), exact: true }),
    );
    await status("Flow created.", "Návaznost byla vytvořena.");
    const savedFlow = required(
      (await records("planning_flow_links")).find((row) => row.value.sourceId === id("branch")),
    );
    assert.equal(savedFlow.value.targetId, id("scene-204"));
    assert.equal(savedFlow.value.kind, "option");
    await close();
    await activate(button("Close reader", "Zavřít čtečku"));

    const create = async (kind: "quest" | "event", title: string) => {
      await activate(
        button(kind === "quest" ? "+ Quest" : "+ Event", kind === "quest" ? "+ Úkol" : "+ Událost"),
      );
      await details.getByLabel(label("Title", "Název"), { exact: true }).fill(title);
      await details
        .getByLabel(label("Body", "Text"), { exact: true })
        .fill("Keep **the courier's clue**.");
      await activate(
        editor.getByRole("button", { name: label("Save item", "Uložit položku"), exact: true }),
      );
      await status("Details saved.", "Podrobnosti byly uloženy.");
      const saved = required(
        (await records("planning_items")).find((row) => row.value.title === title),
      );
      await close();
      return saved;
    };
    const quest = await create("quest", `Courier route ${locale}`);
    assert.equal(quest.value.parentId, id("canvas"));
    await visit(quest.key);
    const clue = await create("event", `Courier clue ${locale}`);
    assert.equal(clue.value.parentId, quest.key);
    await activate(page.locator(`[data-item-id="${clue.key}"]`));
    await activate(button("Edit selected", "Upravit vybrané"));
    await details.waitFor();
    await tab("Links", "Vazby");
    await activate(
      editor
        .locator("summary")
        .filter({ hasText: new RegExp(`^${label("Add reference", "Přidat odkaz")}$`, "u") }),
    );
    const reference = editor.getByRole("form", {
      name: label("Create reference", "Vytvořit odkaz"),
      exact: true,
    });
    await choose(
      reference,
      label("Planning target", "Plánovací cíl"),
      "Northern campaign / Inland chapter / Arrival",
    );
    await activate(
      reference.getByRole("button", { name: label("Add reference", "Přidat odkaz"), exact: true }),
    );
    await status("Reference added.", "Odkaz byl přidán.");
    const savedReference = required(
      (await records("planning_references")).find((row) => row.value.itemId === clue.key),
    );
    assert.deepEqual(savedReference.value.target, {
      scope: "planning",
      itemId: id("other-arrival"),
    });

    await tab("Notes", "Poznámky");
    await activate(button("Add DM note", "Přidat poznámku PJ"));
    await status("DM note added.", "Poznámka PJ byla přidána.");
    const createdNote = required(
      (await records("dm_notes")).find((row) =>
        (row.value.anchorIds as string[]).includes(clue.key),
      ),
    );
    const note = editor.locator(`form[data-note-id="${createdNote.key}"]`);
    await note
      .getByLabel(label("DM note", "Poznámka PJ"), { exact: true })
      .fill("Shared courier reminder");
    const search = note.getByRole("searchbox", {
      name: label("Find linked planning items", "Najít propojené plánovací položky"),
      exact: true,
    });
    await search.fill("Inland chapter");
    const anchor = note.getByRole("checkbox", {
      name: "Northern campaign / Inland chapter / Arrival",
      exact: true,
    });
    await anchor.waitFor();
    await activate(anchor);
    await search.fill("No matching scene");
    await note
      .getByRole("status")
      .filter({
        hasText: label("No matching planning items.", "Žádné odpovídající plánovací položky."),
      })
      .waitFor();
    assert.equal(await note.getByRole("checkbox", { checked: true }).count(), 2);
    assert.equal(await note.getByRole("checkbox").count(), 2);
    await note.evaluate((form) =>
      form.addEventListener("submit", () => {
        form.dataset["unexpectedSubmit"] = "true";
      }),
    );
    await search.press("Enter");
    assert.equal(await note.getAttribute("data-unexpected-submit"), null);
    assert.deepEqual(
      required((await records("dm_notes")).find((row) => row.key === createdNote.key)),
      createdNote,
    );
    await activate(
      note.getByRole("button", { name: label("Clear search", "Vymazat hledání"), exact: true }),
    );
    assert.equal(await search.inputValue(), "");
    assert.equal(await note.getByRole("checkbox", { checked: true }).count(), 2);
    await search.fill("Inland chapter");
    const saveNote = note.getByRole("button", {
      name: label("Save note", "Uložit poznámku"),
      exact: true,
    });
    if (mobile)
      await saveNote.evaluate((button) =>
        button.addEventListener(
          "click",
          () => {
            button.ownerDocument.documentElement.dataset["plannerScrollBeforeSave"] = String(
              button.closest("dialog")!.scrollTop,
            );
          },
          { once: true },
        ),
      );
    await activate(saveNote);
    await status("DM note saved.", "Poznámka PJ byla uložena.");
    if (mobile) {
      const before = Number(
        await page.locator("html").getAttribute("data-planner-scroll-before-save"),
      );
      const { after, maximum } = await editor.evaluate((dialog) => ({
        after: dialog.scrollTop,
        maximum: dialog.scrollHeight - dialog.clientHeight,
      }));
      assert.ok(
        before > 100 && Math.abs(after - Math.min(before, maximum)) < 2,
        `Phone scroll jumped from ${before} to ${after} after saving (maximum ${maximum})`,
      );
    }
    assert.equal(await search.inputValue(), "Inland chapter");
    const savedNote = required(
      (await records("dm_notes")).find(
        (row) =>
          row.value.title === "Shared courier reminder" &&
          (row.value.anchorIds as string[]).includes(clue.key),
      ),
    );
    assert.deepEqual(
      new Set(savedNote.value.anchorIds as string[]),
      new Set([clue.key, id("other-arrival")]),
    );
    await search.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `planner-large-notes-${locale}.png`) });

    await tab("Details", "Podrobnosti");
    const body = details.getByLabel(label("Body", "Text"), { exact: true });
    await body.fill("Unfinished courier detail survives refresh");
    const beforeDraft = required(
      (await records("planning_items")).find((row) => row.key === clue.key),
    );
    await transact([
      put(
        "planning_items",
        { ...unchangedScene.value, summary: "Another DM edited this scene", updatedAt: 2 },
        unchangedScene.revision,
      ),
    ]);
    await editor.locator("[data-live-refresh]").waitFor();
    assert.equal(await body.inputValue(), "Unfinished courier detail survives refresh");
    await activate(button("Reload planner", "Obnovit plánovač"));
    await ready();
    assert.equal(await body.inputValue(), "Unfinished courier detail survives refresh");
    assert.deepEqual(
      required((await records("planning_items")).find((row) => row.key === clue.key)),
      beforeDraft,
    );
    await activate(
      editor.getByRole("button", { name: label("Save item", "Uložit položku"), exact: true }),
    );
    await status("Details saved.", "Podrobnosti byly uloženy.");
    await close();
    await activate(button("Read selected", "Číst vybranou položku"));
    await page
      .locator(".dm-planning-reader")
      .getByText("Unfinished courier detail survives refresh", { exact: true })
      .waitFor();
    await activate(button("Close reader", "Zavřít čtečku"));

    await visit(id("canvas"));
    const questCard = page.locator(`[data-item-id="${quest.key}"]`);
    await activate(questCard);
    await activate(button("Edit selected", "Upravit vybrané"));
    await choose(
      details,
      label("Parent", "Nadřazená položka"),
      "Northern campaign / Inland chapter",
    );
    await activate(
      editor.getByRole("button", { name: label("Save item", "Uložit položku"), exact: true }),
    );
    await status("Details saved.", "Podrobnosti byly uloženy.");
    assert.equal(
      required((await records("planning_items")).find((row) => row.key === quest.key)).value
        .parentId,
      id("destination"),
    );
    assert.deepEqual(
      required(
        (await records("planning_references")).find((row) => row.key === savedReference.key),
      ),
      savedReference,
    );
    assert.deepEqual(
      required((await records("dm_notes")).find((row) => row.key === savedNote.key)),
      savedNote,
    );
    await close();
    await page.locator(`.dm-planner-viewport[data-scope="${id("destination")}"]`).waitFor();
    const beforeDeletion = await Promise.all(collections.map(records));
    await activate(questCard);
    page.once("dialog", (dialog) => dialog.dismiss());
    await activate(button("Delete selection", "Odstranit výběr"));
    assert.deepEqual(await Promise.all(collections.map(records)), beforeDeletion);
    page.once("dialog", (dialog) => dialog.accept());
    await activate(button("Delete selection", "Odstranit výběr"));
    await status("Selection deleted.", "Výběr byl odstraněn.");
    assert.equal(
      (await records("planning_items")).some(
        (row) => row.key === clue.key || row.key === quest.key,
      ),
      false,
    );
    assert.deepEqual(
      required((await records("dm_notes")).find((row) => row.key === savedNote.key)).value
        .anchorIds,
      [id("other-arrival")],
    );
    await activate(button("Undo last deletion", "Vrátit poslední odstranění"));
    await status("Deletion undone.", "Odstranění bylo vráceno.");
    const restored = await Promise.all(collections.map(records));
    const restoredIds = new Set([quest.key, clue.key, savedReference.key, savedNote.key]);
    for (let index = 0; index < collections.length; index++) {
      assert.equal(restored[index]!.length, beforeDeletion[index]!.length);
      for (const original of beforeDeletion[index]!) {
        const row = required(restored[index]!.find((row) => row.key === original.key));
        if (restoredIds.has(row.key)) {
          const { updatedAt, ...content } = row.value,
            { updatedAt: previousUpdate, ...before } = original.value;
          assert.deepEqual(content, before, `${collections[index]}:${row.key}`);
          assert.ok(Number(updatedAt) > Number(previousUpdate));
          assert.ok(row.revision > original.revision);
        } else assert.deepEqual(row, original);
      }
    }
    assert.deepEqual(
      required((await records("planning_flow_links")).find((row) => row.key === savedFlow.key)),
      savedFlow,
    );
    await page.reload();
    await ready();
    await edit(clue.key);
    assert.equal(await body.inputValue(), "Unfinished courier detail survives refresh");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    if (mobile)
      assert.ok(
        touchTypes.filter((type) => type === "touch").length >= 12,
        "Phone actions must generate touch pointer events",
      );
    await page.screenshot({ path: resolve(output, `planner-session-complete-${locale}.png`) });
    t.diagnostic(
      `${locale}: authored subtree, annotations, move, refresh, delete and undo preserved`,
    );
  } finally {
    const current = await Promise.all(collections.map(records));
    const cleanup = current.flatMap((rows, index) => {
      const originalIds = new Set(beforeSession[index]!.map((row) => row.key));
      return rows
        .filter((row) => !originalIds.has(row.key))
        .map((row) => ({
          operation: "delete",
          kind: "collection",
          dataId: collections[index],
          key: row.key,
          expectedRevision: row.revision,
        }));
    });
    for (let index = 0; index < cleanup.length; index += 256)
      await transact(cleanup.slice(index, index + 256));
    assert.deepEqual(
      await Promise.all(collections.map(records)),
      beforeSession,
      "The synthetic session must not change another fixture's records",
    );
  }
}
