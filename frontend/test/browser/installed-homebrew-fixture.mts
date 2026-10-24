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
    subclasses: unknown[],
    publishedSubclasses: Map<string, unknown>,
    feats: unknown[],
    publishedFeats: Map<string, unknown>,
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
  parsePublishedSubclass(value: unknown): unknown;
  parsePublishedFeat(value: unknown): unknown;
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
 * A dnd-homebrew import: one item set and 14 items covering effects, grants
 * and a magic weapon.
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
    {
      id: "plus-one-longsword",
      name: "+1 Longsword",
      text: "You have a +1 bonus to attack rolls and damage rolls made with this magic weapon.",
      overrides: { itemType: "Weapon (Longsword)", rarity: "Uncommon" },
      baseItem: { kind: "weapon", ids: ["longsword"], bonus: 1 },
    },
  ],
};

/**
 * A dnd-homebrew import with one fighter subclass: a skill, extra Hit Points,
 * a pool of uses, a toggle that spends one, and a level 7 feature.
 * It copies addon-dnd-homebrew's docs/examples/sample-subclass.json.
 */
export const homebrewSubclassSample = {
  format: "dnd-homebrew",
  schemaVersion: 1,
  mode: "merge",
  sets: [],
  items: [],
  subclasses: [
    {
      id: "banner-warden",
      name: "Banner Warden",
      classId: "fighter",
      subclassLevel: 3,
      excerpt: "A standard-bearer who rallies allies and holds the line.",
      text: "Banner Wardens carry their company's colors into battle. Where the banner stands, the line holds.",
      classResources: [
        {
          key: "rallying-cries",
          name: "Rallying Cries",
          fixed: 1,
          proficiencyBonus: true,
          recharge: "long",
        },
      ],
      tableColumns: [
        {
          key: "banner-die",
          name: "Banner Die",
          progression: [
            {
              level: 3,
              value: "1d6",
            },
            {
              level: 10,
              value: "1d8",
            },
            {
              level: 18,
              value: "1d10",
            },
          ],
        },
      ],
      features: [
        {
          id: "colors-of-the-company",
          level: 3,
          name: "Colors of the Company",
          excerpt: "Proficiency in Persuasion; Advantage on saves against being Frightened.",
          text: "You gain proficiency in the Persuasion skill, and you have Advantage on saving throws you make to avoid or end the Frightened condition.",
          grants: {
            skills: ["persuasion"],
            advantages: [
              {
                on: "save",
                when: "to avoid or end the Frightened condition",
              },
            ],
          },
        },
        {
          id: "stalwart-bearer",
          level: 3,
          name: "Stalwart Bearer",
          excerpt: "+1 Hit Point maximum per Fighter level.",
          text: "Your Hit Point maximum increases by 1 for each Fighter level you have.",
          grants: {
            hpPerClassLevel: 1,
          },
        },
        {
          id: "raise-the-banner",
          level: 3,
          name: "Raise the Banner",
          excerpt: "Bonus Action, 1 Rallying Cry: +1 AC and +10 feet of Speed until you lower it.",
          text: "As a Bonus Action, you can expend one use of Rallying Cries to raise your banner. While it is raised, you gain a +1 bonus to Armor Class and your Speed increases by 10 feet.",
          grants: {
            activations: [
              {
                id: "raise-the-banner",
                name: "Raise the Banner",
                resource: "rallying-cries",
                modifiers: [
                  {
                    target: "armorClass",
                    add: 1,
                  },
                  {
                    target: "speed",
                    add: 10,
                  },
                ],
              },
            ],
          },
        },
        {
          id: "unbroken-line",
          level: 7,
          name: "Unbroken Line",
          excerpt: "Resistance to Psychic damage.",
          text: "You have Resistance to Psychic damage.",
          grants: {
            resistances: ["psychic"],
          },
        },
      ],
    },
  ],
};

/**
 * A dnd-homebrew import with one feat of each category: an origin feat that
 * adds Hit Points, a general half-feat with an always-prepared spell, a
 * fighting style and an epic boon with resistances behind a level 19
 * prerequisite. It copies addon-dnd-homebrew's docs/examples/sample-feats.json.
 */
export const homebrewFeatSample = {
  format: "dnd-homebrew",
  schemaVersion: 1,
  mode: "merge",
  sets: [],
  items: [],
  feats: [
    {
      id: "hearthborn",
      name: "Hearthborn",
      category: "origin",
      excerpt: "Hit Point maximum +1 per character level.",
      text: "You grew up beside a forge and shrug off hardship.\n\n**Hardy.** Your Hit Point maximum increases by 1 for each character level you have.",
      grants: {
        hpPerLevel: 1,
      },
    },
    {
      id: "storm-touched",
      name: "Storm Touched",
      category: "general",
      prerequisites: {
        level: 4,
        any: [
          {
            abilities: {
              INT: 13,
            },
          },
          {
            abilities: {
              WIS: 13,
            },
          },
        ],
      },
      excerpt:
        "Int or Wis +1 (max 20). Thunderwave always prepared, once per Long Rest without a slot.",
      text: "Lightning answers you.\n\n**Ability Score Increase.** Increase your Intelligence or Wisdom score by 1, to a maximum of 20.\n\n**Thunder Step.** You always have Thunderwave prepared. You can cast it once without a spell slot, and you regain that use when you finish a Long Rest. Its spellcasting ability is the ability increased by this feat.",
      grants: {
        abilityScoreIncrease: {
          choose: 1,
          amount: 1,
          from: ["INT", "WIS"],
        },
        castingAbility: {
          fromAbilityScoreIncrease: true,
        },
        spells: [
          {
            level: 1,
            ids: ["thunderwave"],
            alwaysPrepared: true,
            free: "1/long",
          },
        ],
      },
    },
    {
      id: "shieldwall",
      name: "Shieldwall",
      category: "fightingStyle",
      prerequisites: {
        any: [
          {
            feature: "fighter-fighting-style",
          },
          {
            feature: "paladin-fighting-style",
          },
          {
            feature: "ranger-fighting-style",
          },
        ],
      },
      excerpt: "+1 Armor Class while wearing Medium or Heavy armor.",
      text: "While you are wearing Medium or Heavy armor, you gain a +1 bonus to Armor Class.",
      grants: {
        acBonuses: [
          {
            add: 1,
            requires: {
              armorTypes: ["medium", "heavy"],
            },
          },
        ],
      },
    },
    {
      id: "boon-of-the-tempest",
      name: "Boon of the Tempest",
      category: "epicBoon",
      prerequisites: {
        level: 19,
      },
      excerpt: "One ability score +1 (max 30). Resistance to Lightning and Thunder damage.",
      text: "The storm is yours.\n\n**Ability Score Increase.** Increase one ability score of your choice by 1, to a maximum of 30.\n\n**Eye of the Storm.** You have Resistance to Lightning and Thunder damage.",
      grants: {
        abilityScoreIncrease: {
          choose: 1,
          amount: 1,
          from: ["STR", "DEX", "CON", "INT", "WIS", "CHA"],
          cap: 30,
        },
        resistances: ["lightning", "thunder"],
      },
    },
  ],
};
