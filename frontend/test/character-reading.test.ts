import { describe, it, expect } from "vitest";
import { characterKnowledge, characterReadingValue } from "../src/app/character-reading.js";
import { projectEntities } from "../src/app/campaign-projection.js";
import { projectRelationshipGraph } from "../src/app/campaign-graph.js";
import { projectCampaignGraph } from "../src/app/campaign-graph-modes.js";
import { searchCampaign } from "../src/app/campaign-search.js";
import { collectionModel } from "../src/app/collection-model.js";
import { campaignPages } from "../src/app/routes.js";
import { parseCampaignDataset } from "../src/core/campaign-data.js";
const page = campaignPages.find(page => page.collection === "characters")!;
const source = { name:"Secret identity", title:"Hidden title", description:"Hidden story", species:"Hidden species", tags:["hidden-tag"], faction:"neutral" };
function dataset(knowledge: number | undefined) {
  return parseCampaignDataset({contractVersion:"campaign-data.v1",collections:["characters","relationships","locations","events","mysteries","factions","deletedDefaults","pantheon","artifacts","settings","historicalEvents","campaign","pets"].map(name=>({name,shape:["factions","deletedDefaults","settings","campaign"].includes(name)?"keyed":"list",materialized:true,revision:1,records:name==="characters"?[{key:"character",revision:1,value:{...source,...(knowledge === undefined ? {} : {knowledge})}}]:[]}))});
}
describe("character knowledge presentation",()=>{
  for(const level of [0,1,2,3,4]) it(`uses level ${level} consistently across reading and search`,()=>{
    const campaign=dataset(level), entity=projectEntities(campaign,page)[0]!;
    expect(entity.name).toBe(level===0?"Unknown character":source.name);
    expect(entity.title).toBe(level<2?"":source.title);
    expect(entity.excerpt).toBe(level<2?"":source.description);
    expect(searchCampaign(campaign,"Secret identity").length).toBe(level===0?0:1);
    expect(searchCampaign(campaign,"Hidden").length).toBe(level<2?0:1);
    const entry=collectionModel(campaign,page).entries[0]!;
    expect(entry.search.includes("hidden")).toBe(level>=2);
    expect(entry.search.includes("secret identity")).toBe(level>=1);
    for(const graph of [projectRelationshipGraph(campaign),projectCampaignGraph(campaign,"factions")]) {
      const node=graph.nodes.find(node=>node.legacyKey==="character")!;
      expect(node.name).toBe(entity.name);
      expect(node.search.includes("hidden")).toBe(level>=2);
    }
    expect(campaign.collections[0]!.records[0]!.value).toMatchObject(source);
  });
  it("keeps unclassified records readable and inspection detached from storage",()=>{
    expect(characterKnowledge(source)).toBe(4);
    expect(projectEntities(dataset(undefined),page)[0]!.name).toBe(source.name);
    const hidden=Object.freeze({...source,knowledge:0});
    expect(characterReadingValue(hidden)).not.toHaveProperty("description");
    expect(characterReadingValue(hidden,true)).toBe(hidden);
    expect(hidden.name).toBe("Secret identity");
  });
});