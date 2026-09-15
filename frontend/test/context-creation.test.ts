import {describe,it,expect} from "vitest";
import {parseAppRoute, contextualCreateHash, recordEditHash, campaignPages} from "../src/app/routes.js";
import {creationBackHash, contextualCreationFields} from "../src/app/context-creation.js";
import {parseCampaignDataset} from "../src/core/campaign-data.js";
const campaign=parseCampaignDataset({contractVersion:"campaign-data.v1",collections:["characters","relationships","locations","events","mysteries","factions","deletedDefaults","pantheon","artifacts","settings","historicalEvents","campaign","pets"].map(name=>({
  name,shape:["factions","deletedDefaults","settings","campaign"].includes(name)?"keyed":"list",materialized:true,revision:1,
  records:["locations","factions"].includes(name)?[{key:"gate/upper%2F",revision:1,value:{name:"Source",visibility:"dm"}}]:[],
}))});
describe("contextual creation and editor return routes",()=>{
  it("carries exact references and opening visibility without writing records",()=>{
    const fields={"character-here":"location","event-here":"locations","sub-location":"parentId","faction-member":"faction"} as const;
    for(const action of Object.keys(fields) as (keyof typeof fields)[]) {
      const route=parseAppRoute(contextualCreateHash(action,"gate/upper%2F"));
      if(route.kind!=="create") throw Error("Expected create route");
      expect(route.context?.key).toBe("gate/upper%2F");
      expect(contextualCreationFields(route,campaign)).toMatchObject({[fields[action]]:action==="event-here"?["gate/upper%2F"]:"gate/upper%2F",visibility:"dm"});
      expect(creationBackHash(route,campaign)).toBe(action==="faction-member"?"#/factions/gate%2Fupper%252F":"#/locations/gate%2Fupper%252F");
    }
    const missing=parseAppRoute(contextualCreateHash("sub-location","missing"));
    if(missing.kind!=="create")throw Error("Expected create route");
    expect(contextualCreationFields(missing,campaign)).toEqual({});
    expect(creationBackHash(missing,campaign)).toBe("#/locations");
  });
  it("keeps internal collection views and rejects nested or external return destinations",()=>{
    const page=campaignPages.find(page=>page.id==="characters")!;
    const returnTo="#/characters?q=Gate&sort=name";
    expect(parseAppRoute(recordEditHash(page,"id/%2F",returnTo))).toMatchObject({kind:"record",key:"id/%2F",editing:true,returnTo});
    for(const bad of ["https://example.com","#/settings","#/characters/id/edit?return=%23%2F","#/characters#extra"]) {
      expect(parseAppRoute("#/characters/id/edit?return="+encodeURIComponent(bad)).kind).toBe("not-found");
    }
    for(const bad of ["#/create/character-here/%00","#/create/character-here/%E0%A4%A","#/create/unknown/id",
      "#/characters/id/edit?return=%23%2F&return=%23%2Fparty","#/characters/id/edit?unknown=1"]) expect(parseAppRoute(bad).kind).toBe("not-found");
  });
});
