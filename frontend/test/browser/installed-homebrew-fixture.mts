import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importPackageFiles } from "./installed-import-fixture.mts";

/** The homebrew publish planner, loaded from the package's own browser code. */
export interface HomebrewModel {
  planPublish(
    sets: unknown[],
    items: unknown[],
    published: Map<string, unknown>,
    meta: unknown,
    now: number,
  ): {
    problems: unknown[];
    mutations: {
      dataId: string;
      key: string;
      expectedRevision: number;
      value?: unknown;
      operation: string;
    }[];
  };
  parsePublished(value: unknown): unknown;
}

/**
 * Publishing runs in the browser, so the test drives the same planner the
 * Homebrew page uses: the archive's web/ modules, written out and imported.
 */
export async function homebrewModel(archive: Buffer, directory: string): Promise<HomebrewModel> {
  const files = importPackageFiles(archive);
  for (const [name, body] of Object.entries(files)) {
    if (!name.startsWith("web/") || !name.endsWith(".js")) continue;
    const target = resolve(directory, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return (await import(pathToFileURL(resolve(directory, "web/model.js")).href)) as HomebrewModel;
}

/**
 * A dnd-homebrew import: one item set and 13 items covering effects and grants.
 * It copies addon-dnd-homebrew's docs/examples/sample-items.json; the import
 * format is that add-on's public contract, so a change there shows up here.
 */
export const homebrewSample = {
  format: "dnd-homebrew",
  schemaVersion: 1,
  mode: "merge",
  sets: [
    {
      id: "runestones",
      name: "Runestones",
      namePrefix: "Runestone",
      itemType: "Wondrous Item",
      rarity: "Uncommon",
      bodyPlacements: ["other"],
      tags: ["stone"],
      description:
        "A palm-sized stone carved with one glowing rune. It works while you carry it in a hand, a pouch or on a cord.",
      curse: "",
      playerVisible: true,
      weightLb: 0.5,
      condition: {
        id: "rune-bound",
        name: "Rune-Bound",
        summary:
          "Level 3 or more: faint runes glow on your skin, and you have Disadvantage on Dexterity (Stealth) checks in darkness.",
      },
    },
  ],
  items: [
    {
      id: "ward",
      setId: "runestones",
      name: "Ward",
      text: "You gain a +1 bonus to Armor Class.",
      characterEffects: [
        {
          target: "armorClass",
          mode: "add",
          value: 1,
        },
      ],
    },
    {
      id: "lore",
      setId: "runestones",
      name: "Lore",
      text: "Your Intelligence score increases by 1, to a maximum of 20.",
      characterEffects: [
        {
          target: "abilityScore",
          key: "INT",
          mode: "add",
          value: 1,
        },
        {
          target: "abilityScore",
          key: "INT",
          mode: "maximum",
          value: 20,
        },
      ],
    },
    {
      id: "clarity",
      setId: "runestones",
      name: "Clarity",
      text: "You gain proficiency in the Insight skill.",
      characterEffects: [
        {
          target: "proficiency",
          key: "insight",
          mode: "set",
          value: 1,
        },
      ],
    },
    {
      id: "vigor",
      setId: "runestones",
      name: "Vigor",
      text: "Your Hit Point maximum increases by 5.",
      characterEffects: [
        {
          target: "maxHp",
          mode: "add",
          value: 5,
        },
      ],
    },
    {
      id: "fortune",
      setId: "runestones",
      name: "Fortune",
      text: "Once per Long Rest, you can reroll a D20 Test. You must use the new roll.",
      grants: {
        resources: [
          {
            key: "uses",
            name: "Fortune",
            fixed: 1,
            recharge: "long",
          },
        ],
      },
    },
    {
      id: "endurance",
      setId: "runestones",
      name: "Endurance",
      text: "You have Advantage on Death Saving Throws.",
      grants: {
        advantages: [
          {
            on: "deathSave",
          },
        ],
      },
    },
    {
      id: "calm",
      setId: "runestones",
      name: "Calm",
      text: "You have Advantage on Wisdom saving throws to resist the Charmed condition.",
      grants: {
        advantages: [
          {
            on: "save",
            abilities: ["WIS"],
            when: "to resist the Charmed condition",
          },
        ],
      },
    },
    {
      id: "blessing",
      setId: "runestones",
      name: "Blessing",
      text: "Once per Long Rest, you can cast *Bless* without a spell slot. Intelligence, Wisdom or Charisma is your spellcasting ability for it (choose when you first carry the stone).",
      grants: {
        resources: [
          {
            key: "uses",
            name: "Blessing",
            fixed: 1,
            recharge: "long",
          },
        ],
        spells: [
          {
            ids: ["bless"],
            resource: "uses",
          },
        ],
        castingAbility: {
          id: "casting",
          choose: ["INT", "WIS", "CHA"],
        },
      },
    },
    {
      id: "night-eye",
      setId: "runestones",
      name: "Night Eye",
      text: "While you stand in darkness, you have Darkvision with a range of 60 feet, or the range of your Darkvision increases by 30 feet.",
      grants: {
        activations: [
          {
            id: "in-darkness",
            name: "In darkness",
            modifiers: [
              {
                target: "senseBonus",
                key: "darkvision",
                add: 30,
              },
              {
                target: "sense",
                key: "darkvision",
                value: 60,
              },
            ],
          },
        ],
      },
    },
    {
      id: "flame-ward",
      setId: "runestones",
      name: "Flame Ward",
      text: "You have Resistance to Fire damage.",
      grants: {
        resistances: ["fire"],
      },
    },
    {
      id: "echo",
      setId: "runestones",
      name: "Echo",
      text: "The stone hums softly whenever a creature within 10 feet of you tells a deliberate lie. The DM decides what you notice.",
    },
    {
      id: "lantern-of-embers",
      name: "Lantern of Embers",
      text: "While attuned to the lantern, you know one Wizard cantrip of your choice; Intelligence is your spellcasting ability for it.\n\nAs a Bonus Action you can make the flame burn blue or return it to orange. While it burns blue, you have Resistance to Cold damage.",
      overrides: {
        rarity: "Rare",
        attunement: true,
        weightLb: 2,
      },
      attunementPrerequisites: {
        any: [
          {
            classes: {
              sorcerer: 1,
            },
          },
          {
            classes: {
              wizard: 1,
            },
          },
        ],
      },
      tags: ["light-source"],
      grants: {
        spells: [
          {
            id: "cantrip",
            choose: 1,
            spellLevel: 0,
            from: {
              class: ["wizard"],
            },
          },
        ],
        castingAbility: {
          fixed: "INT",
        },
        activations: [
          {
            id: "blue-flame",
            name: "Blue flame",
            modifiers: [
              {
                target: "resistance",
                value: "cold",
              },
            ],
          },
        ],
      },
    },
    {
      id: "bottomless-satchel",
      name: "Bottomless Satchel",
      text: "The satchel holds up to 100 pounds of gear, which weighs nothing while it is inside.",
      overrides: {
        rarity: "Uncommon",
        weightLb: 1,
      },
      container: {
        capacityLb: 100,
        weightless: true,
      },
    },
  ],
};
