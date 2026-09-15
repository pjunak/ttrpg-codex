import { describe, it, expect } from "vitest";
import { groupTwinRecords, twinRepresentatives } from "../src/app/campaign-twins.js";
import { projectEntities, projectEntity, projectDashboard, recentCampaignActivity } from "../src/app/campaign-projection.js";
import { searchCampaign } from "../src/app/campaign-search.js";
import { campaignPages } from "../src/app/routes.js";
import { parseCampaignDataset } from "../src/core/campaign-data.js";
const pair = [
  { key: "public", revision: 1, value: { name: "Public town", visibility: "public", linkedTwinId: "private", updatedAt: "2026-09-15T12:00:00Z" } },
  { key: "private", revision: 1, value: { name: "Private town", visibility: "dm", linkedTwinId: "public", updatedAt: "2026-09-14T12:00:00Z" } },
];
const page = campaignPages.find(page => page.collection === "locations")!;
const dataset = parseCampaignDataset({contractVersion:"campaign-data.v1",collections:["characters","relationships","locations","events","mysteries","factions","deletedDefaults","pantheon","artifacts","settings","historicalEvents","campaign","pets"].map(name=>({name,shape:["factions","deletedDefaults","settings","campaign"].includes(name)?"keyed":"list",materialized:true,revision:1,records:name==="locations"?pair:[]}))});
describe("reciprocal twin display",()=>{
  it("groups only opposite reciprocal pairs and retains malformed/unavailable survivors",()=>{
    expect(groupTwinRecords(pair).map(r=>r.key)).toEqual(["private"]);
    expect(groupTwinRecords([pair[0]!])).toEqual([pair[0]]);
    for(const values of [
      [pair[0]!,{...pair[1]!,value:{...pair[1]!.value,linkedTwinId:"other"}}],
      [pair[0]!,{...pair[1]!,value:{...pair[1]!.value,visibility:"public"}}],
    ]) expect(groupTwinRecords(values)).toHaveLength(2);
    expect(twinRepresentatives(pair).get("public")).toBe("private");
  });
  it("keeps direct articles addressable while lists/counts/search/activity group pairs",()=>{
    expect(projectEntities(dataset,page).map(e=>e.key)).toEqual(["private"]);
    expect(projectEntity(dataset,pair[0]!,page).route).toBe("#/locations/public");
    expect(projectDashboard(dataset).counts["locations"]).toBe(1);
    expect(recentCampaignActivity(dataset).map(e=>e.key)).toEqual(["public"]);
    expect(searchCampaign(dataset,"town")[0]?.results).toHaveLength(1);
    expect(searchCampaign(dataset,"public")[0]?.results[0]?.key).toBe("public");
    expect(searchCampaign(dataset,"private")[0]?.results[0]?.key).toBe("private");
  });
});