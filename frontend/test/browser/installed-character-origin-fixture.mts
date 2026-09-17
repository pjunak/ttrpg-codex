import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import type { Locator } from 'playwright';
import { choose, createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';

type Choice = { id: string; slot: number; value: unknown };
type Option = { id: string; label: string };
const skilled = (owner: string) => 'feat:skilled@' + encodeURIComponent(owner) + ':proficiencies';
const picks = (id: string, values: string[]): Choice[] => values.map((value, slot) => ({id, slot, value}));
const group = (sheet: Locator, id: string) => sheet.locator('[id="character-choice-' + encodeURIComponent(id) + '"]');
const options = (stored: any, id: string): string[] => stored.evaluation.guidance.choices[id].options.map((row: Option) => row.id);
const tools = (stored: any): string[] => stored.evaluation.sheet.proficiencies.tools;

async function origin(f: Fixture, key: string, background: string, species = 'dwarf') {
  const inputs = await createCharacter(f, key);
  inputs.build.species = species; inputs.build.background = background;
  inputs.build.levels = [{id:'one', classId:'fighter'}];
  inputs.build.choices = picks('skills:fighter', ['animal-handling','survival']);
  inputs.notes = 'Keep authored origin notes'; inputs.play.hp = 3;
  return inputs;
}

export function registerOriginChoiceTests(enabled: boolean, fixture: () => Fixture) {
  for (const locale of ['en','cs']) test('Human origin choices use shared controls and preserve other grants through replacement ('+locale+')', {skip:!enabled, timeout:60000}, async t => {
    const f=fixture(), key='origin-human-'+locale, inputs=await origin(f,key,'scribe','human');
    const background=skilled('background:scribe'), species=skilled('species:human:versatile');
    inputs.build.choices.push(...picks(background,['skill:arcana','skill:history','tool:flute']));
    const initial=await save(f,key,inputs,0,'seed');
    assert.equal(initial.evaluation.guidance.choices[species],undefined,'the recommended feat is not automatic');
    const eligible=options(initial,'species:human:versatile');
    assert.equal(eligible.includes('skilled'),true); assert.equal(eligible.includes('skill-expert'),false);
    assert.equal(eligible.includes('boon-of-skill'),false);
    const {page,sheet,status,read}=await openBuilder(t,f,key,locale);
    const selection=locale==='cs'?'Volba ':'Selection ', saved=locale==='cs'?/^Uloženo$/:/^Saved$/;
    await sheet.locator('#dnd-builder-tab-character').click();
    if(locale==='cs') {
      await page.setViewportSize({width:390,height:1000});
      await page.addStyleTag({content:'html { font-size:200% !important; }'});
    }
    assert.equal(options(initial,'species:human:skillful').includes('perception'),false,'Scribe already grants Perception');
    await choose(group(sheet,'species:human:skillful'),selection+'1','Stealth');
    await status.filter({hasText:saved}).waitFor();
    const feat=group(sheet,'species:human:versatile').getByRole('combobox',{name:selection+'1',exact:true});
    await feat.fill('Skilled'); await sheet.getByRole('option',{name:'Skilled',exact:true}).waitFor();
    await feat.press('ArrowDown'); await feat.press('Enter');
    await status.filter({hasText:saved}).waitFor();
    for(const [index,label] of ['Skill Medicine','Skill Nature','Tool Horn'].entries()) {
      await choose(group(sheet,species),selection+(index+1),label);
      await status.filter({hasText:saved}).waitFor();
      const control=group(sheet,species).getByRole('combobox',{name:selection+(index+1),exact:true});
      assert.equal(await control.evaluate(node=>node===document.activeElement),true,JSON.stringify(await control.evaluate(node=>({wanted:node.getAttribute('data-focus-key'),actual:document.activeElement?.getAttribute('data-focus-key')}))));
    }
    let stored=await read();
    assert.deepEqual(stored.state.inputs.build.choices.filter((choice:Choice)=>choice.id===background),inputs.build.choices.filter((choice:Choice)=>choice.id===background));
    assert.equal(options(stored,species).includes('skill:stealth'),false);
    assert.equal(options(stored,species).includes('tool:flute'),false);
    assert.equal(stored.evaluation.guidance.choices[species].done,true);
    assert.equal(stored.evaluation.sheet.skills.medicine.proficient,true);
    assert.equal(tools(stored).includes('horn'),true);
    await group(sheet,species).scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(f.output,'human-origin-'+locale+'.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.reload(); await page.locator('#character-view-addons').click();
    await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-character').click();
    assert.equal(await group(sheet,species).getByRole('combobox',{name:selection+'3',exact:true}).inputValue(),'Tool Horn');
    await choose(group(sheet,'species:human:versatile'),selection+'1','Tough');
    await status.filter({hasText:saved}).waitFor();
    stored=await read();
    assert.equal(stored.state.inputs.build.choices.some((choice:Choice)=>choice.id===species),false);
    assert.equal(stored.state.inputs.build.choices.filter((choice:Choice)=>choice.id===background).length,3);
    await choose(sheet,locale==='cs'?'Druh':'Species','Dwarf');
    await status.filter({hasText:saved}).waitFor();
    stored=await read();
    assert.equal(stored.state.inputs.build.choices.some((choice:Choice)=>choice.id.startsWith('species:human:')),false);
    assert.equal(stored.state.inputs.build.choices.filter((choice:Choice)=>choice.id===background).length,3);
    assert.equal(stored.state.inputs.notes,inputs.notes); assert.equal(stored.state.inputs.play.hp,3);
    assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
  });

  test('PHB background and tool feats save individual variants from their declared pools', {skip:!enabled, timeout:60000}, async () => {
    const f=fixture();
    for(const row of [
      {background:'noble',tool:'dice',pool:4,feat:skilled('background:noble'),values:['skill:arcana','tool:flute','tool:smiths-tools'],extra:['flute','smiths-tools']},
      {background:'guard',tool:'playing-cards',pool:4},
      {background:'soldier',tool:'three-dragon-ante',pool:4},
      {background:'entertainer',tool:'flute',pool:10,feat:'feat:musician:instruments',values:['drum','lute','lyre'],extra:['drum','lute','lyre']},
      {background:'artisan',tool:'alchemists-supplies',pool:17,feat:'feat:crafter:tools',values:['carpenters-tools','leatherworkers-tools','smiths-tools'],extra:['carpenters-tools','leatherworkers-tools','smiths-tools']},
    ]) {
      const key='origin-tools-'+row.background, inputs=await origin(f,key,row.background), choice='background:'+row.background+':tool';
      inputs.build.choices.push(...picks(choice,[row.tool]));
      if(row.feat)inputs.build.choices.push(...picks(row.feat,row.values!));
      const stored=await save(f,key,inputs,0,'seed');
      assert.equal(options(stored,choice).length,row.pool,row.background);
      assert.deepEqual([...tools(stored)].sort(),[row.tool,...(row.extra??[])].sort());
      assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
      if(row.background==='artisan') {
        assert.equal(options(stored,row.feat!).length,8);
        assert.equal(options(stored,row.feat!).includes('alchemists-supplies'),false,'Crafter uses its printed subset');
      }
      if(row.background==='entertainer') {
        assert.equal(options(stored,row.feat!).length,9,'the background instrument is already known');
        assert.equal(options(stored,row.feat!).includes('flute'),false);
        const forged=structuredClone(stored.state.inputs);
        forged.build.choices.find((entry:Choice)=>entry.id===row.feat&&entry.slot===2).value='flute';
        const rejected=await f.call('save',{key,operation:'build',operationId:key+'-duplicate',summary:'Invalid duplicate',expectedRevision:stored.revision,inputs:forged});
        assert.equal(rejected.status,'invalid'); assert.equal((await f.call('load',{key})).revision,stored.revision);
      }
    }
  });

  test('Changing an origin tool repairs only the conflicting later proficiency slot', {skip:!enabled, timeout:60000}, async () => {
    const f=fixture(), key='origin-tool-repair', inputs=await origin(f,key,'noble','human');
    const species=skilled('species:human:versatile'), background=skilled('background:noble');
    inputs.build.choices.push(...picks('background:noble:tool',['dice']),...picks('species:human:skillful',['perception']),...picks('species:human:versatile',['skilled']),
      ...picks(background,['skill:arcana','tool:flute','tool:smiths-tools']),...picks(species,['skill:medicine','tool:horn','tool:dragonchess']));
    const stored=await save(f,key,inputs,0,'seed'), changed=structuredClone(stored.state.inputs);
    changed.build.choices.find((entry:Choice)=>entry.id==='background:noble:tool').value='dragonchess';
    const repaired=await save(f,key,changed,stored.revision,'changed-tool');
    assert.deepEqual(repaired.state.inputs.build.choices.filter((entry:Choice)=>entry.id===species),picks(species,['skill:medicine','tool:horn']));
    assert.deepEqual(repaired.state.inputs.build.choices.filter((entry:Choice)=>entry.id===background),picks(background,['skill:arcana','tool:flute','tool:smiths-tools']));
    assert.equal(tools(repaired).includes('dice'),false); assert.equal(tools(repaired).includes('dragonchess'),true);
    assert.equal(repaired.state.inputs.notes,inputs.notes); assert.equal(repaired.state.inputs.play.hp,3);
    const replaced=structuredClone(repaired.state.inputs); replaced.build.background='soldier';
    const final=await save(f,key,replaced,repaired.revision,'replace-background');
    assert.equal(final.state.inputs.build.choices.some((entry:Choice)=>entry.id===background||entry.id==='background:noble:tool'),false);
    assert.deepEqual(final.state.inputs.build.choices.filter((entry:Choice)=>entry.id===species),picks(species,['skill:medicine','tool:horn']));
    assert.deepEqual((await f.call('load',{key})).state.inputs,final.state.inputs);
  });

  test('Human rejects ineligible and duplicate Origin feats without writing', {skip:!enabled, timeout:60000}, async () => {
    const f=fixture(),key='origin-feat-eligibility',inputs=await origin(f,key,'entertainer','human');
    const stored=await save(f,key,inputs,0,'seed'), pool=options(stored,'species:human:versatile');
    assert.equal(pool.includes('musician'),false,'nonrepeatable background feat cannot be taken again');
    assert.equal(pool.includes('skilled'),true); assert.equal(pool.includes('skill-expert'),false);
    for(const feat of ['musician','skill-expert']) {
      const forged=structuredClone(stored.state.inputs);
      forged.build.choices.push(...picks('species:human:versatile',[feat]));
      const rejected=await f.call('save',{key,operation:'build',operationId:key+'-'+feat,summary:'Invalid origin feat',expectedRevision:stored.revision,inputs:forged});
      assert.equal(rejected.status,'invalid',feat);
      assert.equal((await f.call('load',{key})).revision,stored.revision);
    }
  });
}
