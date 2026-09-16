import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fixtureCollection, required, type InstalledFixture, type FixtureCampaign, type FixtureRecord } from "./fixture-types.mts";
import { jsonResponse } from "./installed-graph-fixture.mts";
import { importQuest, planningImport } from "./installed-import-fixture.mts";

export async function exerciseCampaignBundle({t,open,admin,csrf,output,mobile}:InstalledFixture) {
 const page=await open(t,"dm",mobile);await page.goto("/#/addons/dm-tools/imports");
 await page.getByRole("heading",{name:"Campaign bundle",exact:true}).waitFor();
 const suffix=mobile?"phone":"desktop", title=`Imported campaign ${suffix}`;
 const document={format:"ttrpg-codex-campaign-bundle",schemaVersion:1,generatedAt:0,
  records:{characters:[{ref:"hero-local",operation:"create",record:{name:title,visibility:"public",description:"<img src=x onerror=alert(1)> Authored prose",location:{$ref:"place-local"}}}],
   locations:[{ref:"place-local",operation:"create",record:{name:`Secret place ${suffix}`,visibility:"dm",mapNotes:"Private map note"}}]},
  addonImports:[{addonId:"dm-tools",contributorId:"planning-json",document:{...planningImport([importQuest(`bundle-quest-${suffix}`,`Bundle quest ${suffix}`)]),references:[{operation:"create",id:`bundle-ref-${suffix}`,schemaVersion:3,itemId:`bundle-quest-${suffix}`,name:"Imported hero",relation:"involves",target:{scope:"core",collection:"characters",id:{$ref:"hero-local"}},quantity:1,notes:""}]}}]};
 const chooser=page.locator('.dm-tools-import input[type="file"]');
 const preview=async()=>{
  const pending=page.waitForResponse(response=>response.url().endsWith("/services/call")&&response.request().postDataJSON().method==="preview");
  await chooser.setInputFiles({name:"campaign.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(document))});
  const response=await pending,body=await jsonResponse(response);
  assert.equal(response.ok(),true,JSON.stringify(body));
  await page.getByText("Preview ready. No campaign data has changed.",{exact:true}).waitFor();return body.result;
 };
 const campaign=async()=>await jsonResponse(await admin.get("/api/campaign")) as FixtureCampaign;
 const before=fixtureCollection(await campaign(),"characters").records.length;
 await preview();
 await page.locator(".dm-import-change summary").filter({hasText:title}).click();
 await page.getByRole("heading",{name:"Player view",exact:true}).waitFor();
 assert.equal(await page.locator(".dm-import-preview img").count(),0);
 await page.getByText("Reserved IDs and references",{exact:true}).click();
 assert.equal(await page.locator(".dm-import-ref").count(),2);
 assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:resolve(output,`campaign-bundle-${suffix}.png`),fullPage:true});
 assert.equal(fixtureCollection(await campaign(),"characters").records.length,before);
 const cancel=page.waitForResponse(response=>response.url().endsWith("/services/call")&&response.request().postDataJSON().method==="cancel");
 await page.getByRole("button",{name:"Cancel preview",exact:true}).click();
 assert.equal((await cancel).ok(),true);
 const review=await preview();
 const pattern="**/services/call";let commits=0;
 await page.route(pattern,async route=>{
  if(mobile && route.request().postDataJSON().method==="status") return route.fulfill({status:503,contentType:"application/json",body:"{}"});
  if(route.request().postDataJSON().method!=="commit")return route.continue();
  commits++;const response=await route.fetch();assert.equal(response.ok(),true,await response.text());
  await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"SERVICE_UNAVAILABLE"}})});
 });
 await page.getByRole("button",{name:"Commit reviewed import",exact:true}).click();
 // The saved receipt resolves a lost reply; the client never retries the write.
 if (mobile) { await page.getByRole("button",{name:"Check import result",exact:true}).waitFor(); await page.locator('.dm-import-shell[aria-busy="false"]').waitFor(); await page.unroute(pattern); await page.reload(); }
 await page.getByText("Import committed: 4 writes and 0 deletions.",{exact:true}).waitFor();
 assert.equal(commits,1);await page.unroute(pattern);
 const after=await campaign();
 const hero=required(fixtureCollection(after,"characters").records.find(record=>(record.value as {name?:string}).name===title));
 assert.equal(hero.key,review.references.find((ref:{ref:string})=>ref.ref==="hero-local").id);
 const generation=(await jsonResponse(await admin.get("/api/admin/addons/dm-tools"))).state.activeGenerationId;
 const notes=await jsonResponse(await admin.post(`/api/addons/dm-tools/generations/${generation}/data/query`,{headers:{"X-Codex-CSRF":csrf},data:{contractVersion:"addon-data-query.v1",kind:"collection",dataId:"planning_items",limit:200,where:[]}}));
 assert.equal(notes.documents.some((record:FixtureRecord)=>record.key===`bundle-quest-${suffix}`),true);
 const references=await jsonResponse(await admin.post(`/api/addons/dm-tools/generations/${generation}/data/query`,{headers:{"X-Codex-CSRF":csrf},data:{contractVersion:"addon-data-query.v1",kind:"collection",dataId:"planning_references",limit:200,where:[]}}));
 assert.equal(references.documents.find((record:FixtureRecord)=>record.key===`bundle-ref-${suffix}`).value.target.id,hero.key);
 if (!mobile) await page.getByRole("button",{name:"Choose another document",exact:true}).click();
 document.addonImports=[];
 document.records.characters[0]!.record.name=`Stale bundle ${suffix}`;
 await preview();
 await jsonResponse(await admin.post("/api/campaign/transactions",{headers:{"X-Codex-CSRF":csrf},data:{contractVersion:"campaign-mutation.v1",mutations:[{operation:"put",collection:"characters",key:hero.key,expectedRevision:hero.revision,value:{...(hero.value as Record<string,unknown>),title:"Changed after preview"}}]}}));
 await page.getByRole("button",{name:"Commit reviewed import",exact:true}).click();
 await page.getByText("This attempt did not commit. Choose the file again to review a new preview.",{exact:true}).waitFor();
 assert.equal(fixtureCollection(await campaign(),"characters").records.length,before+1);
}
