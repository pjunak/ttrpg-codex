import { required } from "./fixture-types.mts";
import type { APIRequestContext } from "playwright";
import type { AddressInfo } from "node:net";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { request as playwrightRequest } from "playwright";
import {
  jsonResponse,
  installReviewedPackage,
  enableAllRuleSources,
} from "./installed-graph-fixture.mts";
import {
  homebrewBackgroundSample,
  homebrewFeatSample,
  homebrewModel,
  homebrewSample,
  homebrewSpeciesSample,
  homebrewSpellSample,
  homebrewSubclassSample,
  type HomebrewModel,
} from "./installed-homebrew-fixture.mts";

// Homebrew items reach character sheets only through the Engine, so every case
// needs the Compendium (the ruleset), the Engine, Character Sheets and Homebrew.
const paths = [
  process.env.CODEX_ENGINE_ZIP,
  process.env.CODEX_SHEETS_ZIP,
  process.env.CODEX_COMPENDIUM_ZIP,
  process.env.CODEX_HOMEBREW_ZIP,
];
const enabled = paths.every(Boolean);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(root, "frontend/test-results/installed-homebrew");
let directory: string,
  model: HomebrewModel,
  host: ChildProcessByStdio<null, Readable, Readable>,
  dm: APIRequestContext,
  player: APIRequestContext,
  dmCsrf: string,
  playerCsrf: string,
  hostOutput = "";

before(async () => {
  if (!enabled) return;
  const [engine, sheets, compendium, homebrew] = await Promise.all(
    paths.map((path) => readFile(resolve(required(path)))),
  );
  await mkdir(output, { recursive: true });
  directory = await mkdtemp(resolve(output, "host-"));
  model = await homebrewModel(homebrew, resolve(directory, "homebrew"));
  const binary = resolve(directory, process.platform === "win32" ? "codex.exe" : "codex");
  await promisify(execFile)("go", ["build", "-o", binary, "./cmd/codex"], {
    cwd: root,
    timeout: 300_000,
  });
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise((done) => probe.close(done));
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
      env: {
        ...process.env,
        CODEX_DM_PASSWORD: "local-homebrew-dm",
        CODEX_PLAYER_PASSWORD: "local-homebrew-player",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  host.stdout.on("data", (chunk) => (hostOutput += chunk));
  host.stderr.on("data", (chunk) => (hostOutput += chunk));
  dm = await playwrightRequest.newContext({ baseURL: `http://127.0.0.1:${port}` });
  player = await playwrightRequest.newContext({ baseURL: `http://127.0.0.1:${port}` });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await dm.get("/api/health")).ok();
    } catch {
      /* Startup. */
    }
    if (!ready) await sleep(100);
  }
  assert.ok(ready, hostOutput);
  dmCsrf = (
    await jsonResponse(await dm.post("/api/login", { data: { password: "local-homebrew-dm" } }))
  ).csrfToken;
  playerCsrf = (
    await jsonResponse(
      await player.post("/api/login", { data: { password: "local-homebrew-player" } }),
    )
  ).csrfToken;
  await installReviewedPackage(dm, dmCsrf, "dnd-2024-compendium", compendium, []);
  await enableAllRuleSources(dm, dmCsrf);
  await installReviewedPackage(dm, dmCsrf, "dnd-engine", engine, []);
  await installReviewedPackage(dm, dmCsrf, "dnd-sheets", sheets, []);
  await installReviewedPackage(dm, dmCsrf, "dnd-homebrew", homebrew, []);
});
after(async () => {
  await dm?.dispose();
  await player?.dispose();
  if (host && host.exitCode === null) {
    const closed = once(host, "close");
    host.kill();
    await closed;
  }
  if (directory)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function generation(id: string): Promise<string> {
  return (await jsonResponse(await dm.get(`/api/admin/addons/${id}`))).state.activeGenerationId;
}
async function connect(
  request: APIRequestContext,
  csrf: string,
  addon: string,
  body: Record<string, unknown>,
) {
  const base = `/api/addons/${addon}/generations/${await generation(addon)}/services`;
  const connection = await jsonResponse(
    await request.post(`${base}/connect`, {
      headers: { "X-Codex-CSRF": csrf },
      data: { contractVersion: "addon-service-connect.v1", ...body },
    }),
  );
  return async (method: string, params: unknown, idempotencyKey?: string) => {
    const target = connection.providers[0];
    assert.ok(target, `no provider for ${JSON.stringify(body)}: ${JSON.stringify(connection)}`);
    const response = await request.post(`${base}/call`, {
      headers: { "X-Codex-CSRF": csrf },
      data: {
        contractVersion: "addon-service-call.v1",
        contract: connection.contract,
        providerAddonId: target.addonId,
        providerVersion: target.contractVersion,
        providerGeneration: target.generation,
        bindingRevision: target.bindingRevision,
        method,
        params,
        deadlineMs: 30000,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    });
    return { status: response.status(), body: JSON.parse(await response.text()) };
  };
}
const engineAs = (request: APIRequestContext, csrf: string) =>
  connect(request, csrf, "dnd-sheets", {
    contract: "dnd5e.rules-engine",
    range: "^6.0.0",
    cardinality: "one",
  });

async function data(operation: string, body: Record<string, unknown>) {
  return jsonResponse(
    await dm.post(
      `/api/addons/dnd-homebrew/generations/${await generation("dnd-homebrew")}/data/${operation}`,
      {
        headers: { "X-Codex-CSRF": dmCsrf },
        data: body,
      },
    ),
  );
}
async function all(dataId: string) {
  const page = await data("query", {
    contractVersion: "addon-data-query.v1",
    kind: "collection",
    dataId,
    limit: 200,
    where: [],
    includeDataRevision: true,
  });
  assert.equal(page.nextCursor, undefined);
  return page as {
    documents: { key: string; revision: number; value: unknown }[];
    dataRevision: number;
  };
}
/** The browser's Publish, through the same planner and a guarded transaction. */
async function publish(): Promise<number> {
  const collections = [
    "homebrew_sets",
    "homebrew_items",
    "homebrew_published",
    "homebrew_meta",
    "homebrew_subclasses",
    "homebrew_published_subclasses",
    "homebrew_feats",
    "homebrew_published_feats",
    "homebrew_spells",
    "homebrew_published_spells",
    "homebrew_species",
    "homebrew_published_species",
    "homebrew_backgrounds",
    "homebrew_published_backgrounds",
  ];
  const read = await Promise.all(collections.map(all));
  const [
    sets,
    items,
    published,
    meta,
    subclasses,
    publishedSubclasses,
    feats,
    publishedFeats,
    spells,
    publishedSpells,
    species,
    publishedSpecies,
    backgrounds,
    publishedBackgrounds,
  ] = read;
  const plan = model.planPublish(
    sets!.documents.map((document) => document.value),
    items!.documents.map((document) => document.value),
    new Map(
      published!.documents.map((document) => [
        document.key,
        { value: model.parsePublished(document.value), revision: document.revision },
      ]),
    ),
    meta!.documents[0]
      ? { value: meta!.documents[0].value, revision: meta!.documents[0].revision }
      : undefined,
    Date.now(),
    subclasses!.documents.map((document) => document.value),
    new Map(
      publishedSubclasses!.documents.map((document) => [
        document.key,
        { value: model.parsePublishedSubclass(document.value), revision: document.revision },
      ]),
    ),
    feats!.documents.map((document) => document.value),
    new Map(
      publishedFeats!.documents.map((document) => [
        document.key,
        { value: model.parsePublishedFeat(document.value), revision: document.revision },
      ]),
    ),
    spells!.documents.map((document) => document.value),
    new Map(
      publishedSpells!.documents.map((document) => [
        document.key,
        { value: model.parsePublishedSpell(document.value), revision: document.revision },
      ]),
    ),
    species!.documents.map((document) => document.value),
    new Map(
      publishedSpecies!.documents.map((document) => [
        document.key,
        { value: model.parsePublishedSpecies(document.value), revision: document.revision },
      ]),
    ),
    backgrounds!.documents.map((document) => document.value),
    new Map(
      publishedBackgrounds!.documents.map((document) => [
        document.key,
        { value: model.parsePublishedBackground(document.value), revision: document.revision },
      ]),
    ),
  );
  assert.deepEqual(plan.problems, []);
  if (plan.mutations.length === 0) return 0;
  await data("transactions", {
    contractVersion: "addon-data-transaction.v1",
    expectedDataSets: read.map((set, index) => ({
      kind: "collection",
      dataId: collections[index],
      revision: set!.dataRevision,
    })),
    mutations: plan.mutations.map((mutation) => ({ ...mutation, kind: "collection" })),
  });
  return plan.mutations.length;
}

function inputs(inventory: unknown[]) {
  return {
    contractVersion: "rules-character.v3",
    inputs: {
      build: {
        method: "array",
        baseScores: { STR: 15, DEX: 13, CON: 14, INT: 12, WIS: 10, CHA: 8 },
        rolls: [],
        species: "dwarf",
        lineage: "",
        background: "soldier",
        levels: Array.from({ length: 3 }, (_, i) => ({ id: `level-${i + 1}`, classId: "fighter" })),
        subclasses: {},
        choices: [],
        spells: {
          cantrips: {},
          spellbook: {},
          grantChoices: {},
          castingAbilities: {},
          swaps: [],
          acquisitions: [],
        },
      },
      play: {
        hp: 0,
        temporaryHp: 0,
        inventory,
        currency: {},
        resourceUses: {},
        activeFeatures: {},
        preparedSpells: {},
        rolls: [],
        asOf: "2026-10-21T00:00:00Z",
      },
      grants: [],
    },
  };
}
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id: `inv-${id}`,
  reference: { kind: "magic-item", id },
  name: id,
  quantity: 1,
  location: "equipped",
  attuned: false,
  acquisition: "",
  notes: "",
  ...extra,
});
type Evaluation = {
  identity: { contentRevision: string };
  evaluation: {
    inputs: unknown;
    sheet: Record<string, any>;
    spellOptions: Record<string, any>;
    issues: { id: string; severity: string }[];
  };
};

void test(
  "the DM imports the sample items through the add-on's own worker",
  { skip: !enabled },
  async () => {
    const importer = await connect(dm, dmCsrf, "dnd-homebrew", {
      contract: "codex.import-adapter",
      own: true,
    });
    // A rejected preview names the bad entry, so the Import Center can say what to fix.
    const broken = structuredClone(homebrewSample);
    required(required(broken.items[1]).characterEffects?.[0]).target = "speedy";
    const rejected = await importer("preview", {
      contractVersion: "import-preview.v1",
      format: "dnd-homebrew",
      document: broken,
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.kind, "INVALID_REQUEST");
    assert.match(rejected.body.error.issue, /^items\[1\]: .*target "speedy" is not supported$/u);
    const preview = await importer("preview", {
      contractVersion: "import-preview.v1",
      format: "dnd-homebrew",
      document: homebrewSample,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.result.summary, {
      creates: 15,
      updates: 0,
      skips: 0,
      deletes: 0,
    });
    const commit = await importer(
      "commit",
      { contractVersion: "import-commit.v1", token: preview.body.result.token },
      "import-1",
    );
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.equal((await all("homebrew_items")).documents.length, 14);
    const playerImporter = await connect(player, playerCsrf, "dnd-homebrew", {
      contract: "codex.import-adapter",
      own: true,
    });
    const refused = await playerImporter("describe", {});
    assert.notEqual(refused.status, 200, "a player must not use the importer");
  },
);

void test("published items apply on DM and player sheets", { skip: !enabled }, async () => {
  const dmEngine = await engineAs(dm, dmCsrf);
  const before = (
    await dmEngine("query-records", {
      contractVersion: "rules-engine-query.v1",
      kind: "magic-item",
      limit: 200,
    })
  ).body.result;
  assert.equal(
    before.records.filter((record: { id: string }) => record.id.startsWith("hb.")).length,
    0,
    "drafts reached the engine",
  );
  assert.equal(await publish(), 15);
  const records: { id: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = (
      await dmEngine("query-records", {
        contractVersion: "rules-engine-query.v1",
        kind: "magic-item",
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })
    ).body.result;
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(records.filter((record) => record.id.startsWith("hb.")).length, 14);
  assert.ok(
    records.some((record) => record.id === "ring-of-protection"),
    "compendium items are still there",
  );

  for (const [request, csrf] of [
    [dm, dmCsrf],
    [player, playerCsrf],
  ] as const) {
    const evaluate = await engineAs(request, csrf);
    const plain = (await evaluate("evaluate-character", inputs([]))).body.result as Evaluation;
    const call = await evaluate(
      "evaluate-character",
      inputs([
        card("hb.ward"),
        card("hb.lore"),
        card("hb.clarity"),
        card("hb.vigor"),
        card("hb.fortune"),
      ]),
    );
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const equipped = call.body.result as Evaluation;
    const sheet = equipped.evaluation.sheet,
      base = plain.evaluation.sheet;
    assert.equal(sheet.derived.armorClass, base.derived.armorClass + 1);
    assert.equal(sheet.derived.maxHp, base.derived.maxHp + 5);
    assert.equal(sheet.abilities.INT.score, Math.min(20, base.abilities.INT.score + 1));
    assert.equal(sheet.skills.insight.proficient, true);
    const itemIssues = equipped.evaluation.issues.filter((issue) =>
      /^(item-|placement-|rules-data:magic-item:hb\.)/u.test(issue.id),
    );
    assert.deepEqual(
      itemIssues,
      [],
      "items must not raise item blockers or break the Engine's grants vocabulary",
    );
  }
});

void test(
  "item properties reach the sheet: an advantage, an item spell, a use and Rune-Bound",
  { skip: !enabled },
  async () => {
    const engine = await engineAs(dm, dmCsrf);
    const call = await engine(
      "evaluate-character",
      inputs([card("hb.endurance"), card("hb.blessing"), card("hb.fortune")]),
    );
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const result = (call.body.result as Evaluation).evaluation;
    const fromItem = (entry: any, id: string) =>
      entry?.source?.type === "item" && entry.source.id === `inv-hb.${id}`;
    const blockers = (issues: { id: string; severity: string }[]) =>
      issues
        .filter((issue) => issue.severity === "blocker")
        .map((issue) => issue.id)
        .sort();
    const bare = ((await engine("evaluate-character", inputs([]))).body.result as Evaluation)
      .evaluation;
    assert.deepEqual(
      blockers(result.issues),
      blockers(bare.issues),
      "equipping items adds no blockers to the unfinished test build",
    );
    assert.ok(
      result.sheet.advantages?.some(
        (entry: any) => entry.on === "deathSave" && fromItem(entry, "endurance"),
      ),
      JSON.stringify(result.sheet.advantages),
    );
    assert.equal(result.sheet.deathSaveAdvantage, true);
    const fortune = result.sheet.resources.find((entry: any) => fromItem(entry, "fortune"));
    assert.equal(fortune?.max, 1, JSON.stringify(result.sheet.resources));
    const bound = result.sheet.conditions?.find((row: any) => row.id === "rune-bound");
    assert.equal(bound?.level, 3, JSON.stringify(result.sheet.conditions));
    assert.equal(bound?.granted, true);

    // Play changes need a finished build, which this fixture is not; the Engine's
    // own tests cast item spells. Here the item only has to offer its choice.
    const choice = result.spellOptions.castingAbilityChoices.find((entry: any) =>
      fromItem(entry, "blessing"),
    );
    assert.deepEqual(
      choice?.options,
      ["INT", "WIS", "CHA"],
      JSON.stringify(result.spellOptions.castingAbilityChoices),
    );
  },
);

void test(
  "a homebrew +1 longsword and the Compendium's +1 weapon and +2 shield add their bonus",
  { skip: !enabled },
  async () => {
    const engine = await engineAs(dm, dmCsrf);
    const evaluate = async (inventory: unknown[]) => {
      const call = await engine("evaluate-character", inputs(inventory));
      assert.equal(call.status, 200, JSON.stringify(call.body));
      return (call.body.result as Evaluation).evaluation;
    };
    const gear = (id: string, kind: string, ref: string, extra: Record<string, unknown> = {}) => ({
      ...card(ref, extra),
      id: `inv-${id}`,
      reference: { kind, id: ref },
    });
    const plain = await evaluate([
      gear("longsword", "weapon", "longsword"),
      gear("dagger", "weapon", "dagger"),
      gear("shield", "armor", "shield"),
    ]);
    const magic = await evaluate([
      card("hb.plus-one-longsword"),
      gear("weapon", "magic-item", "weapon-1-2-or-3", { baseItemId: "dagger", bonus: 1 }),
      gear("shield", "magic-item", "shield-1-2-or-3", { bonus: 2 }),
    ]);
    const row = (sheet: Record<string, any>, itemId: string) => {
      const found = sheet.weapons.find((weapon: any) => weapon.itemId === itemId);
      assert.ok(found, JSON.stringify(sheet.weapons));
      return found;
    };
    // "1d8 +2" becomes "1d8 +3".
    const raised = (damage: string) =>
      damage.replace(/([+-]\d+)$/u, (modifier) => {
        const value = Number(modifier) + 1;
        return value < 0 ? String(value) : `+${value}`;
      });
    for (const [plainId, magicId, base] of [
      ["inv-longsword", "inv-hb.plus-one-longsword", "longsword"],
      ["inv-dagger", "inv-weapon", "dagger"],
    ] as const) {
      const before = row(plain.sheet, plainId),
        after = row(magic.sheet, magicId);
      assert.equal(after.ref, base);
      assert.equal(after.attackBonus, before.attackBonus + 1, JSON.stringify(after));
      assert.equal(after.damage, raised(before.damage), JSON.stringify(after));
      assert.ok(
        after.modifiers.some(
          (entry: any) => entry.source.type === "item" && entry.source.id === magicId,
        ),
        JSON.stringify(after.modifiers),
      );
    }
    assert.equal(magic.sheet.derived.armorClass, plain.sheet.derived.armorClass + 2);
    assert.deepEqual(
      magic.issues.filter((issue) => /^(item-|rules-data:magic-item:)/u.test(issue.id)),
      [],
      "picked magic gear raises no item issues",
    );
  },
);

void test(
  "weights, a weightless container and an attunement requirement reach the sheet",
  { skip: !enabled },
  async () => {
    const engine = await engineAs(dm, dmCsrf);
    const request = inputs([
      card("hb.lantern-of-embers", { attuned: true }),
      card("hb.bottomless-satchel"),
      card("hb.ward", { location: "carried", containerId: "satchel" }),
    ]);
    (request.inputs.play as Record<string, unknown>).containers = [
      { id: "satchel", name: "Bottomless Satchel", itemId: "inv-hb.bottomless-satchel" },
    ];
    const call = await engine("evaluate-character", request);
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const result = (call.body.result as Evaluation).evaluation;
    const carrying = result.sheet.carrying;
    assert.equal(carrying?.items?.["inv-hb.ward"]?.eachLb, 0.5, JSON.stringify(carrying));
    assert.equal(carrying.itemsLb, 3, "the lantern and the satchel count");
    assert.equal(carrying.weightlessLb, 0.5, "the stone inside the satchel does not");
    assert.deepEqual(carrying.containers.satchel, {
      loadLb: 0.5,
      weightless: true,
      stored: false,
      capacityLb: 100,
    });
    const requirement = result.issues.find(
      (issue) => issue.id === "attunement:inv-hb.lantern-of-embers",
    );
    assert.equal(
      requirement?.severity,
      "blocker",
      "a fighter cannot attune to a sorcerer's or wizard's lantern",
    );
  },
);

void test(
  "a republish changes the rules identity and a withdrawn item blocks its holder",
  { skip: !enabled },
  async () => {
    const evaluate = await engineAs(dm, dmCsrf);
    const before = (await evaluate("evaluate-character", inputs([card("hb.echo")]))).body
      .result as Evaluation;
    const items = await all("homebrew_items");
    const echo = items.documents.find((document) => document.key === "echo")!;
    await data("transactions", {
      contractVersion: "addon-data-transaction.v1",
      mutations: [
        {
          operation: "delete",
          kind: "collection",
          dataId: "homebrew_items",
          key: "echo",
          expectedRevision: echo.revision,
        },
      ],
    });
    assert.equal(await publish(), 2, "one withdrawal and the metadata");
    const after = (await evaluate("evaluate-character", inputs([card("hb.echo")]))).body
      .result as Evaluation;
    assert.notEqual(after.identity.contentRevision, before.identity.contentRevision);
    assert.ok(
      after.evaluation.issues.some(
        (issue) => issue.id === "item-source:inv-hb.echo" && issue.severity === "blocker",
      ),
      JSON.stringify(after.evaluation.issues),
    );
    assert.equal(await publish(), 0, "an unchanged publish writes nothing");
  },
);

void test(
  "a homebrew subclass imports, publishes and applies to a character",
  { skip: !enabled },
  async () => {
    const importer = await connect(dm, dmCsrf, "dnd-homebrew", {
      contract: "codex.import-adapter",
      own: true,
    });
    const preview = await importer("preview", {
      contractVersion: "import-preview.v1",
      format: "dnd-homebrew",
      document: homebrewSubclassSample,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.result.summary, { creates: 1, updates: 0, skips: 0, deletes: 0 });
    const commit = await importer(
      "commit",
      { contractVersion: "import-commit.v1", token: preview.body.result.token },
      "import-subclass",
    );
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.equal(await publish(), 2, "the subclass with its features, and the metadata");

    const engine = await engineAs(dm, dmCsrf);
    const subclassPage = (
      await engine("query-records", {
        contractVersion: "rules-engine-query.v1",
        kind: "subclass",
        limit: 200,
      })
    ).body.result;
    assert.ok(
      subclassPage.records.some((record: { id: string }) => record.id === "hb.banner-warden"),
      "the Builder can offer it",
    );
    const build = (subclass?: string, active: Record<string, boolean> = {}) => {
      const request = inputs([]);
      if (subclass) request.inputs.build.subclasses = { fighter: subclass };
      request.inputs.play.activeFeatures = active;
      return request;
    };
    const base = ((await engine("evaluate-character", build())).body.result as Evaluation)
      .evaluation.sheet;
    const call = await engine("evaluate-character", build("hb.banner-warden"));
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const result = (call.body.result as Evaluation).evaluation;
    const sheet = result.sheet;
    assert.deepEqual(
      result.issues.filter((issue) => /banner-warden/u.test(issue.id)),
      [],
    );
    assert.ok(
      ["colors-of-the-company", "stalwart-bearer", "raise-the-banner"].every((id) =>
        sheet.features.some((feature: { id: string }) => feature.id === `hb.banner-warden.${id}`),
      ),
      JSON.stringify(sheet.features),
    );
    assert.equal(sheet.skills.persuasion.proficient, true);
    assert.equal(sheet.derived.maxHp, base.derived.maxHp + 3, "1 per Fighter level");
    assert.equal(
      sheet.resources.find((entry: { key: string }) => entry.key === "rallying-cries")?.max,
      3,
      JSON.stringify(sheet.resources),
    );
    assert.ok(!sheet.resistances.includes("psychic"), "the level 7 feature waits for level 7");
    const banner = sheet.activations.find(
      (entry: { id: string }) => entry.id === "raise-the-banner",
    );
    assert.equal(banner?.resource?.key, "rallying-cries", JSON.stringify(sheet.activations));
    const raised = (
      (await engine("evaluate-character", build("hb.banner-warden", { [banner.key]: true }))).body
        .result as Evaluation
    ).evaluation.sheet;
    assert.equal(raised.derived.armorClass, sheet.derived.armorClass + 1);
    assert.equal(raised.derived.speed, sheet.derived.speed + 10);
  },
);

void test(
  "homebrew feats import, publish, join the Builder's feats and apply to a character",
  { skip: !enabled },
  async () => {
    const importer = await connect(dm, dmCsrf, "dnd-homebrew", {
      contract: "codex.import-adapter",
      own: true,
    });
    const preview = await importer("preview", {
      contractVersion: "import-preview.v1",
      format: "dnd-homebrew",
      document: homebrewFeatSample,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.result.summary, { creates: 4, updates: 0, skips: 0, deletes: 0 });
    const commit = await importer(
      "commit",
      { contractVersion: "import-commit.v1", token: preview.body.result.token },
      "import-feats",
    );
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.equal(await publish(), 5, "four feats and the metadata");

    const engine = await engineAs(dm, dmCsrf);
    const feats: { id: string; value: { category: string } }[] = [];
    let cursor: string | undefined;
    do {
      const page = (
        await engine("query-records", {
          contractVersion: "rules-engine-query.v1",
          kind: "feat",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        })
      ).body.result;
      feats.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(
      feats
        .filter((record) => record.id.startsWith("hb."))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => [record.id, record.value.category]),
      [
        ["hb.boon-of-the-tempest", "epicBoon"],
        ["hb.hearthborn", "origin"],
        ["hb.shieldwall", "fightingStyle"],
        ["hb.storm-touched", "general"],
      ],
      "the Builder can offer each in its category",
    );
    // A DM-given feat applies like one the character chose.
    const gifted = (featIds: string[]) => {
      const request = inputs([]);
      (request.inputs as { grants: unknown[] }).grants = featIds.map((id) => ({
        id: `gift-${id}`,
        name: `Gift of ${id}`,
        reason: "test",
        actorId: "dm",
        grantedAt: "2026-10-21T00:00:00Z",
        active: true,
        effectiveLevel: 1,
        condition: "always",
        feat: { kind: "feat", id },
        effects: [],
        waivers: [],
      }));
      return request;
    };
    const base = ((await engine("evaluate-character", gifted([]))).body.result as Evaluation)
      .evaluation.sheet;
    const call = await engine(
      "evaluate-character",
      gifted(["hb.hearthborn", "hb.boon-of-the-tempest"]),
    );
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const result = (call.body.result as Evaluation).evaluation;
    assert.equal(result.sheet.derived.maxHp, base.derived.maxHp + 3, "1 per character level");
    assert.ok(
      ["lightning", "thunder"].every((type) => result.sheet.resistances.includes(type)),
      JSON.stringify(result.sheet.resistances),
    );
    assert.deepEqual(
      result.issues
        .filter((issue) => issue.id.startsWith("feat:hb."))
        .map((issue) => [issue.id, issue.severity]),
      [["feat:hb.boon-of-the-tempest", "blocker"]],
      "the level 19 prerequisite holds for a level 3 character",
    );
  },
);

void test(
  "homebrew spells import, publish and join the spell lists of their classes",
  { skip: !enabled },
  async () => {
    const importer = await connect(dm, dmCsrf, "dnd-homebrew", {
      contract: "codex.import-adapter",
      own: true,
    });
    const preview = await importer("preview", {
      contractVersion: "import-preview.v1",
      format: "dnd-homebrew",
      document: homebrewSpellSample,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.result.summary, { creates: 3, updates: 0, skips: 0, deletes: 0 });
    const commit = await importer(
      "commit",
      { contractVersion: "import-commit.v1", token: preview.body.result.token },
      "import-spells",
    );
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.equal(await publish(), 4, "three spells and the metadata");

    // Players' sheets read the spells with the player's authority.
    for (const [request, csrf] of [
      [dm, dmCsrf],
      [player, playerCsrf],
    ] as const) {
      const engine = await engineAs(request, csrf);
      const spells: { id: string; value: { level: number; classes: string[] } }[] = [];
      let cursor: string | undefined;
      do {
        const page = (
          await engine("query-records", {
            contractVersion: "rules-engine-query.v1",
            kind: "spell",
            limit: 200,
            ...(cursor ? { cursor } : {}),
          })
        ).body.result;
        spells.push(...page.records);
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(
        spells
          .filter((record) => record.id.startsWith("hb."))
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((record) => [record.id, record.value.level, record.value.classes]),
        [
          ["hb.ember-lance", 1, ["sorcerer", "wizard"]],
          ["hb.hearth-ward", 0, ["cleric", "druid"]],
          ["hb.whispered-map", 2, ["bard", "wizard"]],
        ],
      );
      assert.ok(
        spells.some((record) => record.id === "fireball"),
        "compendium spells are still there",
      );
    }
    // A caster is offered the homebrew spells of its own list, up to its level.
    const engine = await engineAs(dm, dmCsrf);
    const offered = async (classId: string) => {
      const request = inputs([]);
      request.inputs.build.levels = Array.from({ length: 3 }, (_, i) => ({
        id: `level-${i + 1}`,
        classId,
      }));
      const call = await engine("evaluate-character", request);
      assert.equal(call.status, 200, JSON.stringify(call.body));
      const options = (call.body.result as Evaluation).evaluation.spellOptions.classes.find(
        (entry: { classId: string }) => entry.classId === classId,
      ) as { spellIds: string[] } | undefined;
      assert.ok(options, `a level 3 ${classId} casts spells`);
      return options.spellIds.filter((id) => id.startsWith("hb.")).sort();
    };
    assert.deepEqual(await offered("wizard"), ["hb.ember-lance", "hb.whispered-map"]);
    assert.deepEqual(await offered("cleric"), ["hb.hearth-ward"]);
  },
);

void test(
  "homebrew species and backgrounds import, publish, join the Builder and apply to a character",
  { skip: !enabled },
  async () => {
    const importer = await connect(dm, dmCsrf, "dnd-homebrew", {
      contract: "codex.import-adapter",
      own: true,
    });
    for (const [document, key] of [
      [homebrewSpeciesSample, "import-species"],
      [homebrewBackgroundSample, "import-backgrounds"],
    ] as const) {
      const preview = await importer("preview", {
        contractVersion: "import-preview.v1",
        format: "dnd-homebrew",
        document,
      });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.deepEqual(preview.body.result.summary, {
        creates: 2,
        updates: 0,
        skips: 0,
        deletes: 0,
      });
      const commit = await importer(
        "commit",
        { contractVersion: "import-commit.v1", token: preview.body.result.token },
        key,
      );
      assert.equal(commit.status, 200, JSON.stringify(commit.body));
    }
    assert.equal(await publish(), 5, "two species, two backgrounds and the metadata");

    // The Builder lists them beside the Compendium's, for the DM and players.
    for (const [request, csrf] of [
      [dm, dmCsrf],
      [player, playerCsrf],
    ] as const) {
      const engine = await engineAs(request, csrf);
      for (const [kind, expected, compendium] of [
        ["species", ["hb.emberkin", "hb.mossfolk"], "dwarf"],
        ["background", ["hb.hearth-warden", "hb.lamplighter"], "soldier"],
      ] as const) {
        const page = (
          await engine("query-records", {
            contractVersion: "rules-engine-query.v1",
            kind,
            limit: 200,
          })
        ).body.result as { records: { id: string }[] };
        const ids = page.records.map((record) => record.id);
        assert.deepEqual(ids.filter((id) => id.startsWith("hb.")).sort(), expected);
        assert.ok(ids.includes(compendium), `compendium ${kind} records are still there`);
      }
    }

    const engine = await engineAs(dm, dmCsrf);
    const evaluate = async (build: Record<string, unknown>) => {
      const request = inputs([]);
      Object.assign(request.inputs.build, build);
      const call = await engine("evaluate-character", request);
      assert.equal(call.status, 200, JSON.stringify(call.body));
      return (call.body.result as Evaluation).evaluation;
    };
    // A Small Emberkin of the Cinder lineage, with the sample's tool choice.
    const ember = await evaluate({
      species: "hb.emberkin",
      lineage: "cinder",
      choices: [
        { id: "species:hb.emberkin:size", slot: 0, value: "Small" },
        { id: "species:hb.emberkin:craft", slot: 0, value: "smiths-tools" },
      ],
    });
    assert.equal(ember.sheet["speed"], 30);
    assert.equal(ember.sheet["senses"]["darkvision"], 60);
    assert.ok(ember.sheet["resistances"].includes("fire"));
    assert.ok(ember.sheet["proficiencies"]["tools"].includes("smiths-tools"));
    assert.ok(
      ember.spellOptions["granted"].some((spell: { ref: string }) => spell.ref === "fire-bolt"),
      "the lineage grants Fire Bolt",
    );
    assert.ok(!ember.issues.some((issue) => issue.id.includes(":size")), "the size is chosen");
    // Lamplighter's skills, tool and feat, with its wizard list preset.
    const lamplighter = await evaluate({ background: "hb.lamplighter" });
    for (const skill of ["investigation", "perception"])
      assert.equal(lamplighter.sheet["skills"][skill].proficient, true, skill);
    assert.ok(lamplighter.sheet["proficiencies"]["tools"].includes("tinkers-tools"));
    assert.ok(
      lamplighter.sheet["feats"].some((feat: { id: string }) => feat.id === "magic-initiate"),
    );
    // Hearth Warden's origin feat is this campaign's Hearthborn.
    const warden = await evaluate({ background: "hb.hearth-warden" });
    assert.ok(warden.sheet["feats"].some((feat: { id: string }) => feat.id === "hb.hearthborn"));
  },
);

void test("the real UI edits, publishes and shows the gallery", { skip: !enabled }, async () => {
  const { chromium } = await import("playwright");
  const shots = process.env.HOMEBREW_SHOTS;
  const browser = await chromium.launch();
  try {
    const errors: string[] = [];
    const page = await (
      await browser.newContext({
        storageState: await dm.storageState(),
        viewport: { width: 1360, height: 950 },
      })
    ).newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(
      `${(await dm.get("/api/health")).url().replace("/api/health", "")}/#/addons/dnd-homebrew/homebrew`,
    );
    await page.getByRole("heading", { name: "Homebrew", exact: true }).waitFor();
    assert.equal(await page.locator('a[href="#/addons/dnd-homebrew/homebrew"]').count(), 1);
    await page.getByRole("button", { name: /^Ward/u }).click();
    await page.locator(".hb-effect-row").first().waitFor();
    if (shots) await page.screenshot({ path: `${shots}/ui-editor.png`, fullPage: true });
    await page.getByRole("button", { name: /^Lantern of Embers/u }).click();
    await page.locator(".hb-toggle-change").first().waitFor();
    // The pickers read the installed Compendium's classes and spells.
    const classes = page.locator('select[name="requirementClasses"]');
    await classes.waitFor({ state: "attached" });
    assert.deepEqual(
      await classes.evaluate((select: HTMLSelectElement) =>
        [...select.selectedOptions].map((entry) => entry.value),
      ),
      ["sorcerer", "wizard"],
    );
    assert.ok(
      (await classes.locator("option").count()) >= 12,
      "the Compendium's classes are offered",
    );
    if (shots) await page.screenshot({ path: `${shots}/ui-properties.png`, fullPage: true });
    await page.getByRole("button", { name: /^Ward/u }).click();
    await page.locator(".hb-effect-row").first().waitFor();
    const description = page.locator('textarea[name="text"]');
    await description.fill("You gain a +1 bonus to Armor Class while you carry this stone.");
    await page.locator(".hb-editor-actions").getByRole("button", { name: "Save" }).click();
    await page.getByText("Unpublished changes: 1.").waitFor();
    await page.getByRole("button", { name: "Publish changes (1)" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Runestone: Ward").waitFor();
    if (shots) await page.screenshot({ path: `${shots}/ui-publish.png` });
    await dialog.getByRole("button", { name: "Publish" }).click();
    await page.getByText("Everything is published.").waitFor();
    const published = (await all("homebrew_published")).documents.find(
      (document) => document.key === "hb.ward",
    )!;
    assert.match(JSON.stringify(published.value), /while you carry this stone/u);

    const playerPage = await (
      await browser.newContext({
        storageState: await player.storageState(),
        viewport: { width: 1360, height: 950 },
      })
    ).newPage();
    playerPage.on("pageerror", (error) => errors.push(error.message));
    const origin = (await player.get("/api/health")).url().replace("/api/health", "");
    await playerPage.goto(`${origin}/#/addons/dnd-homebrew/homebrew-gallery`);
    await playerPage.getByText("No items have been revealed yet.").waitFor();
    assert.equal(
      await playerPage.locator('a[href="#/addons/dnd-homebrew/homebrew-gallery"]').count(),
      1,
    );
    assert.equal(await playerPage.locator('a[href="#/addons/dnd-homebrew/homebrew"]').count(), 0);
    await playerPage.goto(`${origin}/#/addons/dnd-homebrew/homebrew-gallery?id=hb.ward`);
    await playerPage.locator(".hb-card.focused").getByText("Runestone: Ward").waitFor();
    if (shots) await playerPage.screenshot({ path: `${shots}/ui-gallery.png`, fullPage: true });
    // A new draft named like a deleted one gets the next free id automatically.
    const temp = {
      id: "temp",
      schemaVersion: 1,
      setId: "",
      name: "Temp",
      text: "",
      overrides: {},
      tags: [],
      characterMechanics: "narrative",
      characterEffects: [],
      playerVisible: false,
      retired: false,
      updatedAt: 1,
    };
    await data("transactions", {
      contractVersion: "addon-data-transaction.v1",
      mutations: [
        {
          operation: "put",
          kind: "collection",
          dataId: "homebrew_items",
          key: "temp",
          expectedRevision: 0,
          value: temp,
        },
      ],
    });
    const created = (await all("homebrew_items")).documents.find(
      (document) => document.key === "temp",
    )!;
    await data("transactions", {
      contractVersion: "addon-data-transaction.v1",
      mutations: [
        {
          operation: "delete",
          kind: "collection",
          dataId: "homebrew_items",
          key: "temp",
          expectedRevision: created.revision,
        },
      ],
    });
    await page.reload();
    await page.getByRole("heading", { name: "Homebrew", exact: true }).waitFor();
    await page.getByRole("button", { name: "New item" }).click();
    await page.locator('input[name="name"]').fill("Temp");
    await page
      .locator(".hb-editor-actions")
      .getByRole("button", { name: "Save and add another" })
      .click();
    await page.getByRole("button", { name: /^Temp/u }).waitFor();
    assert.equal(
      await page.locator('input[name="name"]').inputValue(),
      "",
      "the editor is ready for the next item",
    );
    const keys = (await all("homebrew_items")).documents.map((document) => document.key);
    assert.ok(keys.includes("temp-2") && !keys.includes("temp"), JSON.stringify(keys));

    // The subclass editor: one grant added through the vocabulary's own form.
    await page.getByRole("button", { name: /^Banner Warden/u }).click();
    const unbroken = page
      .locator("fieldset.hb-feature")
      .filter({ has: page.locator('input[name="features[3].name"]') });
    await unbroken.waitFor();
    assert.equal(await page.locator("fieldset.hb-feature").count(), 4);
    if (shots) await page.screenshot({ path: `${shots}/ui-subclass.png`, fullPage: true });
    const addField = unbroken.locator('select[name="features[3].grants#add"]');
    await addField.evaluate((select: HTMLSelectElement) => {
      select.value = "hpBonus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator('input[name="features[3].grants.hpBonus"]').fill("5");
    await page.locator(".hb-editor-actions").getByRole("button", { name: "Save" }).click();
    // The new item above is still unpublished, so the subclass makes two changes.
    await page.getByText("Unpublished changes: 2.").waitFor();
    await page.getByRole("button", { name: "Publish changes (2)" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
    await page.getByText("Everything is published.").waitFor();
    const warden = (await all("homebrew_published_subclasses")).documents.find(
      (entry) => entry.key === "hb.banner-warden",
    )!;
    const line = (
      warden.value as { records: { id: string; grants?: Record<string, unknown> }[] }
    ).records.find((record) => record.id === "hb.banner-warden.unbroken-line");
    assert.deepEqual(line?.grants, { resistances: ["psychic"], hpBonus: 5 });

    // The spell editor: a changed range republishes the record and its stat block.
    await page.getByRole("button", { name: /^Ember Lance/u }).click();
    const range = page.locator('input[name="range"]');
    await range.waitFor();
    if (shots) await page.screenshot({ path: `${shots}/ui-spell.png`, fullPage: true });
    await range.fill("90 feet");
    await page.locator(".hb-editor-actions").getByRole("button", { name: "Save" }).click();
    await page.getByText("Unpublished changes: 1.").waitFor();
    await page.getByRole("button", { name: "Publish changes (1)" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
    await page.getByText("Everything is published.").waitFor();
    const lance = (await all("homebrew_published_spells")).documents.find(
      (entry) => entry.key === "hb.ember-lance",
    )!.value as { record: { range: string; text: string } };
    assert.equal(lance.record.range, "90 feet");
    assert.match(lance.record.text, /\*\*Range:\*\* 90 feet {2}\n/u);
    if (shots) {
      const narrow = await (
        await browser.newContext({
          storageState: await dm.storageState(),
          viewport: { width: 390, height: 844 },
        })
      ).newPage();
      await narrow.goto(`${origin}/#/addons/dnd-homebrew/homebrew`);
      await narrow.getByRole("button", { name: /^Banner Warden/u }).click();
      await narrow.locator("fieldset.hb-feature").first().waitFor();
      await narrow.screenshot({ path: `${shots}/ui-subclass-narrow.png`, fullPage: true });
      assert.ok(
        await narrow.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        "the subclass editor fits a phone",
      );
    }

    await playerPage.goto(`${origin}/#/addons/dnd-homebrew/homebrew`);
    await playerPage.waitForTimeout(500);
    assert.equal(
      await playerPage.locator(".hb-tree").count(),
      0,
      "players must not reach the DM editor",
    );
    // Saving over the deleted draft's key is refused once before the retry.
    const conflicts = errors.filter((error) => /status of 409/u.test(error));
    assert.ok(conflicts.length <= 1, JSON.stringify(conflicts));
    assert.deepEqual(
      errors.filter((error) => !conflicts.includes(error)),
      [],
    );
  } finally {
    await browser.close();
  }
});
