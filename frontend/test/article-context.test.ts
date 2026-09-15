import {describe, it, expect} from "vitest";
import {articleContext, articleReference, articleOwner} from "../src/app/article-context.js";
import {parseCampaignDataset} from "../src/core/campaign-data.js";
type Records = Record<string, Record<string, Record<string, unknown>>>;
function dataset(input: Records) {
  return parseCampaignDataset({contractVersion:"campaign-data.v1",collections:["characters","relationships","locations","events","mysteries","factions","deletedDefaults","pantheon","artifacts","settings","historicalEvents","campaign","pets"].map(name=>({
    name,shape:["factions","deletedDefaults","settings","campaign"].includes(name)?"keyed":"list",materialized:true,revision:1,
    records:Object.entries(input[name]??{}).map(([key,value])=>({key,revision:1,value})),
  }))});
}
const data = dataset({
  locations:{world:{name:"World"}, gate:{name:"Gate",parentId:"world",connections:["missing"]},child:{name:"Child",parentId:"gate"}},
  factions:{watch:{name:"Watch",rankChains:[{id:"chain",name:"Command",ranks:["Captain"]}]}},
  characters:{
    captain:{name:"Captain",faction:"watch",rankChain:"chain",rank:"Captain",location:"gate"},
    public:{name:"Public member",faction:"watch",linkedTwinId:"private"},
    private:{name:"Private member",faction:"watch",visibility:"dm",linkedTwinId:"public"},
    unranked:{name:"Unranked",faction:"watch"},
    orphan:{name:"Retained rank",faction:"watch",rankChain:"old",rank:"Old rank"},
    unknown:{name:"Unrevealed name",knowledge:0,location:"gate"},
  },
  events:{arrival:{name:"Arrival",characters:["captain"],locations:["gate"]}},
  pets:{hound:{name:"Hound",ownerType:"faction",ownerId:"watch"},raven:{name:"Raven",ownerType:"character",ownerId:"captain"}},
});
const entries = (collection: string, key: string, id: string) => articleContext(data,collection,key).find(section=>section.id===id)?.groups.flatMap(group=>group.entries)??[];
describe("connected article projections",()=>{
  it("resolves exact references and never guesses unavailable targets",()=>{
    expect(articleReference(data,"characters","unknown")).toEqual({label:"Unknown character",href:"#/characters/unknown"});
    expect(articleReference(data,"characters","missing")).toEqual({label:"Unavailable entry"});
    expect(articleOwner(data,{ownerType:"party"})[0]?.href).toBe("#/party");
    expect(articleReference(data,"characters","public").href).toBe("#/characters/public");
  });
  it("derives location surroundings and character mentions/ownership",()=>{
    expect(entries("locations","gate","ancestors").map(item=>item.label)).toEqual(["World"]);
    expect(entries("locations","gate","children").map(item=>item.label)).toEqual(["Child"]);
    expect(entries("locations","gate","residents").map(item=>item.label)).toEqual(["Captain","Unknown character"]);
    expect(entries("locations","gate","connections")).toEqual([{label:"Unavailable entry"}]);
    expect(entries("locations","gate","events")[0]?.label).toBe("Arrival");
    expect(entries("characters","captain","companions")[0]?.label).toBe("Raven");
    expect(entries("characters","captain","events")[0]?.label).toBe("Arrival");
  });
  it("keeps every qualifying member, groups reciprocal twins and retains unmatched ranks",()=>{
    const before=JSON.stringify(data), roster=entries("factions","watch","members");
    expect(roster.map(item=>item.label)).toEqual(["Captain","Private member","Unranked","Retained rank"]);
    expect(entries("factions","watch","companions")[0]?.label).toBe("Hound");
    expect(JSON.stringify(data)).toBe(before);
    const unchained=articleContext(dataset({factions:{watch:{name:"Watch"}},characters:{member:{name:"Member",faction:"watch"}}}),"factions","watch");
    expect(unchained.find(section=>section.id==="members")?.groups[0]?.entries[0]?.label).toBe("Member");
  });
  it("bounds missing and cyclic ancestry and omits unavailable context",()=>{
    const cycle=dataset({locations:{a:{parentId:"b"},b:{parentId:"a"}}});
    const ancestors=articleContext(cycle,"locations","a").find(section=>section.id==="ancestors")!;
    expect(ancestors.groups[0]?.entries).toHaveLength(2);
    expect(ancestors.groups[0]?.entries[0]).toEqual({label:"Location hierarchy contains a cycle."});
    expect(articleContext(cycle,"locations","missing")).toEqual([]);
  });
});
