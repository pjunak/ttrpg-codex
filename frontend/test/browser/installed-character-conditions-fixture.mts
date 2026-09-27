import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { choose, openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { characterTab } from "./installed-character-navigation-fixture.mts";
import { exported, printOutput, review } from "./installed-character-output-fixture.mts";

const frozen = new Map<string, Awaited<ReturnType<Fixture["call"]>>>();
const messages = (locale: string) => locale === "cs"
  ? {conditions:"Stavy",add:"Přidat stav",exhaustion:"Vyčerpání",grappled:"Uchvácení",stunned:"Omráčení",level:"Vyčerpání: stupeň",remove:"Odebrat: Uchvácení",saved:/^Uloženo$/,layout:"Rozložení deníku",replace:"Nahradit postavu",close:"Zavřít",adjustment:"Úprava hodů k20: -4"}
  : {conditions:"Conditions",add:"Add condition",exhaustion:"Exhaustion",grappled:"Grappled",stunned:"Stunned",level:"Exhaustion level",remove:"Remove Grappled",saved:/^Saved$/,layout:"Sheet layout",replace:"Replace character",close:"Close",adjustment:"D20 roll adjustment: -4"};

export function registerConditionTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en","cs"]) test("Conditions preserve source facts, compact play and saved output (" + locale + ")", {skip:!enabled,timeout:90000}, async t => {
    const f = fixture(), key = "conditions-"+locale, text = messages(locale), initial = await readyCharacter(f,key);
    const {page,sheet,status,read} = await openBuilder(t,f,key,locale);
    await characterTab(sheet,"combat");
    await choose(sheet,text.add,text.exhaustion); await status.filter({hasText:text.saved}).waitFor();
    const level = sheet.getByRole("spinbutton",{name:text.level,exact:true});
    await level.fill("2"); await status.filter({hasText:text.saved}).waitFor();
    assert.equal(await level.evaluate(node=>node===document.activeElement),true);
    let saved = await read();
    assert.deepEqual(saved.state.inputs.play.conditions,[{id:"exhaustion",level:2}]);
    assert.equal(saved.state.projection.sheet.derived.speed,initial.state.projection.sheet.derived.speed-10);
    assert.equal(saved.state.projection.sheet.conditionEffects.d20Adjustment,-4);
    assert.deepEqual(saved.state.projection.sheet.abilities,initial.state.projection.sheet.abilities);
    await choose(sheet,text.add,text.stunned); await status.filter({hasText:text.saved}).waitFor();
    assert.equal((await read()).state.projection.sheet.derived.speed,saved.state.projection.sheet.derived.speed,"Stunned in 2024 does not reduce Speed");
    await choose(sheet,text.add,text.grappled); await status.filter({hasText:text.saved}).waitFor();
    assert.equal((await read()).state.projection.sheet.derived.speed,0);
    await sheet.getByRole("button",{name:text.remove,exact:true}).click(); await status.filter({hasText:text.saved}).waitFor();
    assert.equal(await sheet.locator('[data-focus-key="conditions/heading"]').evaluate(node=>node===document.activeElement),true);
    saved = await read(); assert.equal(saved.state.projection.sheet.derived.speed,initial.state.projection.sheet.derived.speed-10);
    assert.deepEqual(saved.state.inputs.play.inventory,initial.state.inputs.play.inventory);
    for (const layout of ["compact","classic"]) {
      await characterTab(sheet,"tools"); await sheet.getByLabel(text.layout,{exact:true}).selectOption(layout);
      await characterTab(sheet,"combat");
      for (const width of [1360,1024,390,320]) {
        await page.setViewportSize({width,height:1000});
        await page.evaluate(({width,layout})=>{document.documentElement.style.fontSize=width<500?"200%":"";document.documentElement.dataset.theme=layout==="compact"?"classic":"moonlit";},{width,layout});
        const conditions = sheet.getByRole("region",{name:text.conditions,exact:true});
        await conditions.scrollIntoViewIfNeeded();
        assert.equal(await conditions.locator("[data-condition-id]").count(),2);
        assert.equal(await conditions.getByRole("button",{name:text.adjustment,exact:true}).isVisible(),true);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        if (width===1360 || width===320) await page.screenshot({path:resolve(f.output,"conditions-"+locale+"-"+layout+"-"+width+".png")});
      }
    }
    await page.setViewportSize({width:1360,height:1000}); await page.evaluate(()=>{document.documentElement.style.fontSize="";});
    await page.reload(); await page.locator("#character-view-addons").click(); await characterTab(sheet,"combat");
    assert.equal(await level.inputValue(),"2");
    await characterTab(sheet,"tools"); const envelope = await exported(page,sheet,locale);
    assert.deepEqual(envelope.inputs.play.conditions,saved.state.inputs.play.conditions);
    await review(sheet,locale,envelope,false); await sheet.getByRole("button",{name:text.replace,exact:true}).click(); await status.filter({hasText:text.saved}).waitFor();
    const popup = await printOutput(page,sheet,locale); await popup.getByRole("heading",{name:text.conditions,exact:true}).waitFor();
    assert.ok((await popup.locator("body").innerText()).includes(text.exhaustion)); await popup.close();
    frozen.set(key,await read());
  });

  for (const outcome of ["lost-reply","disjoint","conflict"]) test("Conditions autosave preserves "+outcome,{skip:!enabled,timeout:60000},async t=>{
    const f=fixture(),key="conditions-save-"+outcome,initial=await readyCharacter(f,key),{page,sheet,status,read}=await openBuilder(t,f,key);
    await characterTab(sheet,"combat");
    const writes: Record<string,any>[]=[];
    let release!:()=>void,entered!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;}),arriving=new Promise<void>(resolve=>{entered=resolve;}); t.after(()=>release());
    await page.route("**/services/call",async route=>{
      const body=route.request().postDataJSON(); if(body?.method!=="save"){await route.continue();return;}
      writes.push(body.params);
      if(writes.length===1){if(outcome==="lost-reply"){assert.equal((await route.fetch()).ok(),true);await route.abort("failed");return;}entered();await held;}
      await route.continue();
    });
    await choose(sheet,"Add condition","Exhaustion");
    if(outcome==="lost-reply"){
      await status.getByRole("button",{name:"Retry",exact:true}).click();await status.filter({hasText:/^Saved$/}).waitFor();
      assert.deepEqual(writes[1],writes[0]);assert.equal(writes.length,2);assert.equal((await read()).revision,initial.revision+1);
    }else{
      await arriving; const remote=await read();
      if(outcome==="conflict")remote.state.inputs.play.conditions=[{id:"prone",level:1}];else remote.state.inputs.play.currency.gp=12;
      await save(f,key,remote.state.inputs,remote.revision,"other");release();
      await status.filter({hasText:outcome==="conflict"?/edited elsewhere/:/^Saved$/}).waitFor();
      assert.equal((await read()).revision,initial.revision+(outcome==="conflict"?1:2));
      if(outcome==="disjoint")assert.equal((await read()).state.inputs.play.currency.gp,12);
    }
    assert.equal(await sheet.getByRole("spinbutton",{name:"Exhaustion level",exact:true}).inputValue(),"1");
    assert.deepEqual((await read()).state.inputs.play.conditions,[{id:outcome==="conflict"?"prone":"exhaustion",level:1}]);
  });
}

export async function verifyFrozenConditions(t: TestContext,f: Fixture): Promise<void> {
  for(const [key,saved] of frozen){
    const locale=key.endsWith("-cs")?"cs":"en",text=messages(locale),{page,sheet,read}=await openBuilder(t,f,key,locale);
    try{
      const loaded=await read();assert.equal(loaded.status,"unavailable");assert.deepEqual(loaded.state,saved.state);
      await characterTab(sheet,"combat"); const conditions=sheet.getByRole("region",{name:text.conditions,exact:true});
      assert.equal(await conditions.locator("[data-condition-id]").count(),2);
      assert.equal(await conditions.getByRole("button",{name:/^(Remove |Odebrat: )/}).count(),0);
      await conditions.locator("details").first().evaluate(node=>{(node as HTMLDetailsElement).open=true;});
      assert.ok((await conditions.innerText()).includes("Each level subtracts 2"));
      await characterTab(sheet,"tools");assert.deepEqual((await exported(page,sheet,locale)).inputs.play.conditions,saved.state.inputs.play.conditions);
      const popup=await printOutput(page,sheet,locale);assert.ok((await popup.locator("body").innerText()).includes(text.exhaustion));await popup.close();
      assert.equal((await read()).revision,saved.revision);
    }finally{await page.context().close();}
  }
}
