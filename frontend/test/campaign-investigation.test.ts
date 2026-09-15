import {describe, it, expect} from "vitest";
import {parseCampaignDataset} from "../src/core/campaign-data.js";
import {investigationQuestions, investigationStatus, investigationQueue} from "../src/app/campaign-investigation.js";
import {collectionModel, collectionFacetChoices, queryCollection} from "../src/app/collection-model.js";
import {defaultCollectionView} from "../src/app/collection-view.js";
import {campaignPages} from "../src/app/routes.js";
import {setUiLocale} from "../src/app/ui-localization.js";

function dataset(changes: Record<string, {key: string; revision: number; value: unknown}[]>) {
  return parseCampaignDataset({contractVersion: "campaign-data.v1", collections:
    ["characters","relationships","locations","events","mysteries","factions","deletedDefaults","pantheon","artifacts","settings","historicalEvents","campaign","pets"].map(name => ({
      name, shape: ["factions","deletedDefaults","settings","campaign"].includes(name) ? "keyed" : "list",
      materialized: true, revision: 1, records: changes[name] ?? [],
    }))});
}
const record = (key: string, value: unknown) => ({key, revision: 1, value});
const mysteries = campaignPages.find(page => page.collection === "mysteries")!;

describe("investigation reading", () => {
  it("derives completion from meaningful answers while preserving manual intent and empty mysteries", () => {
    expect(investigationStatus({})).toMatchObject({solved:false, total:0, open:0});
    expect(investigationStatus({questions:[{text:"Why?",answer:" \n\t"}]})).toMatchObject({solved:false, open:1});
    const value = {solved:false, questions:[{text:"Why?",answer:"Because."}]};
    expect(investigationStatus(value)).toEqual({solved:true, total:1, answered:1, open:0, manual:false});
    expect(value.solved).toBe(false);
    expect(investigationStatus({solved:true, questions:["Still open?"]})).toMatchObject({solved:true, open:1, manual:true});
    expect(investigationStatus({solved:"true"}).solved).toBe(false);
    expect(investigationQuestions([null, 8, " ", {question:"Old question?",answer:" yes "}, "Plain question"])).toEqual([
      {text:"Old question?",answer:"yes"}, {text:"Plain question",answer:""},
    ]);
  });
  it("uses the same effective status for facets, search and cards without altering stored records", () => {
    const data = dataset({mysteries:[
      record("answered", {name:"Žár",solved:false,questions:[{text:"Proč?",answer:"Strážce"}]}),
      record("open", {name:"Open case",questions:[{text:"How?",answer:" "}]}),
      record("empty", {name:"Empty case"}),
      record("manual", {name:"Manual",solved:true,questions:["Still open?"]}),
    ]});
    const before = JSON.stringify(data), model = collectionModel(data,mysteries);
    const solved = {...defaultCollectionView, filters:[{field:"solved",value:"true"}]};
    expect(queryCollection(model,solved).groups[0]!.entries.map(item => item.key)).toEqual(["manual","answered"]);
    expect(collectionFacetChoices(model,defaultCollectionView,"solved").find(choice => choice.value === "false")?.count).toBe(2);
    setUiLocale("cs");
    try {
      expect(queryCollection(collectionModel(data,mysteries),{...defaultCollectionView,query:"vyreseno strazce"}).count).toBe(1);
    } finally { setUiLocale("en"); }
    expect(JSON.stringify(data)).toBe(before);
  });
  it("combines role-projected sources, prefers available twins and respects knowledge reading", () => {
    const publicCase = record("case/%2F", {name:"Veřejná záhada",questions:["Public clue?"],visibility:"public",linkedTwinId:"dm"});
    const dmCase = record("dm", {name:"Tajná záhada",questions:[{text:"Kde je strážce?",answer:"U brány"}],visibility:"dm",linkedTwinId:"case/%2F"});
    const characters = [
      record("known", {name:"Žofie",knowledge:2,unknown:[{text:"Kde je Žofie?",answer:""}]}),
      record("hidden", {name:"Hidden",knowledge:1,unknown:["Secret question"]}),
    ];
    const dm = investigationQueue(dataset({mysteries:[publicCase,dmCase],characters}));
    expect(dm.map(item => item.source)).toEqual(["Žofie","Tajná záhada"]);
    expect(investigationQueue(dataset({mysteries:[publicCase,dmCase],characters}),"STRAZCE")).toHaveLength(1);
    const player = investigationQueue(dataset({mysteries:[publicCase],characters}));
    expect(player.map(item => item.route)).toEqual(["#/characters/known","#/mysteries/case%2F%252F"]);
    expect(player.find(item => item.kind === "mysteries")?.editRoute).toBe("#/mysteries/case%2F%252F/edit?return=%23%2Fmysteries");
  });
});
