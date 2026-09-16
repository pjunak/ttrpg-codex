import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { choose, createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';

type Choice = { id: string; slot: number; value: unknown };
type Descriptor = { id: string; kind: string; source: { type: string; id: string }; acquisition?: { id: string } };
const skilled = (owner: string) => 'feat:skilled@' + encodeURIComponent(owner) + ':proficiencies';
const picks = (owner: string, values: string[]): Choice[] => values.map((value,slot)=>({id:skilled(owner),slot,value}));

async function repeatedCharacter(f: Fixture, key: string) {
  const inputs=await createCharacter(f,key);
  inputs.build.species='dwarf'; inputs.build.background='scribe';
  inputs.build.levels=Array.from({length:6},(_,index)=>({id:'level-'+index,classId:'fighter'}));
  inputs.notes='Preserve authored notes across repeated feat changes'; inputs.play.hp=3;
  inputs.build.choices=[
    ...[4,6].flatMap(level=>[{id:'asi:fighter:'+level,slot:0,value:'feat'},{id:'asi:fighter:'+level+':feat',slot:0,value:'skilled'}]),
    ...picks('background:scribe',['skill:arcana','tool:flute','tool:smiths-tools']),
    ...picks('asi:fighter:4:feat',['skill:history','tool:drum','tool:disguise-kit']),
    ...picks('asi:fighter:6:feat',['skill:medicine','tool:dragonchess','tool:lute']),
  ];
  return {inputs,stored:await save(f,key,inputs,0,'seed')};
}

export function registerRepeatableFeatTests(enabled: boolean, fixture: () => Fixture) {
  for(const locale of ['en','cs']) test('Skilled keeps independent mixed choices through shared phone controls and reload ('+locale+')',{skip:!enabled,timeout:60000},async t=>{
    const f=fixture(), key='repeatable-ui-'+locale, {inputs,stored}=await repeatedCharacter(f,key);
    const descriptors=stored.evaluation.plan.creationChoices.filter((row:Descriptor)=>row.source.type==='feat'&&row.source.id==='skilled');
    assert.equal(descriptors.length,3);
    assert.equal(new Set(descriptors.map((row:Descriptor)=>row.id)).size,3);
    for(const row of descriptors) {
      assert.equal(stored.evaluation.guidance.choices[row.id].picked,3);
      assert.equal(stored.evaluation.guidance.choices[row.id].done,true);
    }
    const later=stored.evaluation.guidance.choices[skilled('asi:fighter:6:feat')].options.map((row:{id:string})=>row.id);
    assert.equal(later.includes('skill:arcana'),false); assert.equal(later.includes('tool:flute'),false);
    assert.equal(later.includes('tool:lute'),true,'current choice stays eligible');
    const {page,sheet,status,read}=await openBuilder(t,f,key,locale), selection=locale==='cs'?'Volba 3':'Selection 3', saved=locale==='cs'?/^Uloženo$/:/^Saved$/;
    const group=(owner:string)=>sheet.locator('[id="'+ 'character-choice-'+encodeURIComponent(skilled(owner))+'"]');
    await sheet.locator('#dnd-builder-tab-character').click();
    assert.match(await group('asi:fighter:6:feat').locator('h3').innerText(),locale==='cs'?/Fighter, úroveň 6/:/Fighter level 6/);
    await page.setViewportSize({width:390,height:1000}); await page.addStyleTag({content:'html { font-size:200% !important; }'});
    const control=group('background:scribe').getByRole('combobox',{name:selection,exact:true});
    await control.focus(); await control.fill('Tool Lyre');
    await sheet.getByRole('option',{name:'Tool Lyre',exact:true}).waitFor(); await control.press('ArrowDown'); await control.press('Enter');
    await status.filter({hasText:saved}).waitFor();
    let latest=await read();
    assert.equal(latest.state.inputs.build.choices.find((choice:Choice)=>choice.id===skilled('background:scribe')&&choice.slot===2).value,'tool:lyre');
    assert.deepEqual(latest.state.inputs.build.choices.filter((choice:Choice)=>choice.id===skilled('asi:fighter:6:feat')),inputs.build.choices.filter((choice:Choice)=>choice.id===skilled('asi:fighter:6:feat')));
    assert.equal(latest.state.inputs.notes,inputs.notes); assert.equal(latest.state.inputs.play.hp,3);
    await page.screenshot({path:resolve(f.output,'skilled-origin-phone-'+locale+'.png')});
    const geometry=await page.evaluate(()=>{
      const roots: (Document|ShadowRoot)[]=[document], elements: HTMLElement[]=[];
      for(const root of roots) for(const element of root.querySelectorAll<HTMLElement>('*')) { elements.push(element); if(element.shadowRoot)roots.push(element.shadowRoot); }
      const describe=(node:HTMLElement)=>({tag:node.tagName,cls:node.className,right:node.getBoundingClientRect().right,width:node.getBoundingClientRect().width,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,overflow:getComputedStyle(node).overflow,text:node.textContent?.slice(0,50)});
      return {width:document.documentElement.scrollWidth,viewport:innerWidth,overflow:elements.filter(node=>node.getBoundingClientRect().right>innerWidth&&node.getClientRects().length).map(describe).slice(0,35),
        textOverflow:elements.filter(node=>node.scrollWidth>node.clientWidth+2&&node.clientWidth>0&&getComputedStyle(node).overflow==='visible').map(describe).slice(0,35)};
    });
    assert.equal(geometry.width<=geometry.viewport,true,JSON.stringify(geometry));
    const budget=sheet.locator('#character-choice-bgasi');
    assert.equal(await budget.locator('.character-stepper').evaluateAll(nodes=>nodes.every(node=>{
      const bounds=node.getBoundingClientRect(), input=node.querySelector('input')!.getBoundingClientRect(), arrows=node.querySelector('.character-stepper-arrows')!.getBoundingClientRect();
      return input.width>=48 && input.right<=arrows.left+1 && arrows.right<=bounds.right+1;
    })),true,'ability fields retain readable inputs and separate buttons at enlarged text size');
    await group('asi:fighter:6:feat').scrollIntoViewIfNeeded(); await page.screenshot({path:resolve(f.output,'skilled-phone-'+locale+'.png')});
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-character').click();
    assert.equal(await group('background:scribe').getByRole('combobox',{name:selection,exact:true}).inputValue(),'Tool Lyre');
    assert.equal(await group('asi:fighter:6:feat').getByRole('combobox',{name:selection,exact:true}).inputValue(),'Tool Lute');
    latest=await read();
    assert.equal(latest.state.inputs.build.choices.filter((choice:Choice)=>choice.id.startsWith('feat:skilled@')).length,9);
  });

  test('Skilled origin, advancement replacement and level removal preserve other acquisitions',{skip:!enabled,timeout:60000},async()=>{
    const f=fixture(),key='repeatable-withdrawal',{inputs,stored}=await repeatedCharacter(f,key);
    let next=structuredClone(stored.state.inputs); next.build.background='soldier';
    let changed=await save(f,key,next,stored.revision,'background');
    assert.equal(changed.state.inputs.build.choices.some((choice:Choice)=>choice.id===skilled('background:scribe')),false);
    assert.equal(changed.evaluation.sheet.skills.arcana.proficient,false);
    assert.equal(changed.state.inputs.build.choices.filter((choice:Choice)=>choice.id.startsWith('feat:skilled@')).length,6);
    next=structuredClone(changed.state.inputs);
    next.build.choices=next.build.choices.filter((choice:Choice)=>!choice.id.startsWith('asi:fighter:4'));
    next.build.choices.push({id:'asi:fighter:4',slot:0,value:'asi'});
    changed=await save(f,key,next,changed.revision,'advancement');
    assert.equal(changed.state.inputs.build.choices.some((choice:Choice)=>choice.id===skilled('asi:fighter:4:feat')),false);
    assert.equal(changed.evaluation.sheet.skills.history.proficient,false); assert.equal(changed.evaluation.sheet.skills.medicine.proficient,true);
    next=structuredClone(changed.state.inputs); next.build.levels=next.build.levels.slice(0,5);
    changed=await save(f,key,next,changed.revision,'level');
    assert.equal(changed.state.inputs.build.choices.some((choice:Choice)=>choice.id.startsWith('feat:skilled@')),false);
    assert.equal(changed.evaluation.sheet.skills.medicine.proficient,false);
    assert.equal(changed.state.inputs.notes,inputs.notes); assert.equal(changed.state.inputs.play.hp,3);
    assert.deepEqual((await f.call('load',{key})).state.inputs,changed.state.inputs);
  });

  test('Repeated DM feat choices survive sibling revocation and withdraw on amendment',{skip:!enabled,timeout:60000},async()=>{
    const f=fixture(),key='repeatable-dm',inputs=await createCharacter(f,key);
    inputs.build.species='dwarf'; inputs.build.background='soldier'; inputs.build.levels=[{id:'one',classId:'fighter'}];
    let stored=await save(f,key,inputs,0,'seed');
    const grant={id:'',actorId:'',grantedAt:'',active:true,effects:[],waivers:[],name:'Study reward',reason:'Installed acceptance',condition:'always',effectiveLevel:1,feat:{kind:'feat',id:'skilled'}};
    for(const suffix of ['first','second']) {
      stored=await f.call('save',{key,operation:'grant',operationId:key+'-'+suffix,summary:'Grant training',expectedRevision:stored.revision,grant});
      assert.equal(stored.status,'ready',JSON.stringify(stored));
    }
    const [first,second]=stored.state.inputs.grants;
    const next=structuredClone(stored.state.inputs);
    next.build.choices=[...picks('grant:'+first.id,['skill:arcana','tool:flute','tool:disguise-kit']),...picks('grant:'+second.id,['skill:history','tool:drum','tool:lute'])];
    stored=await save(f,key,next,stored.revision,'choices');
    stored=await f.call('save',{key,operation:'revoke-grant',operationId:key+'-revoke',summary:'Revoke first training',grantId:first.id,expectedRevision:stored.revision});
    assert.equal(stored.status,'ready',JSON.stringify(stored.evaluation?.guidance.saveIssues));
    assert.equal(stored.state.inputs.build.choices.length,3);
    assert.equal(stored.state.inputs.build.choices.every((choice:Choice)=>choice.id===skilled('grant:'+second.id)),true);
    assert.equal(stored.evaluation.sheet.skills.arcana.proficient,false); assert.equal(stored.evaluation.sheet.skills.history.proficient,true);
    stored=await f.call('save',{key,operation:'amend-grant',operationId:key+'-amend',summary:'Replace remaining training',grantId:second.id,expectedRevision:stored.revision,grant:{...grant,feat:{kind:'feat',id:'tough'}}});
    assert.equal(stored.status,'ready',JSON.stringify(stored.evaluation?.guidance.saveIssues));
    assert.deepEqual(stored.state.inputs.build.choices,[]); assert.equal(stored.evaluation.sheet.skills.history.proficient,false);
    assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
  });


  test('Historical ambiguous feat choices are explicitly assigned through borrowed Builder controls',{skip:!enabled,timeout:60000},async t=>{
    const f=fixture(),key='repeatable-assignment',{stored}=await repeatedCharacter(f,key);
    const historical=structuredClone(stored.state.inputs);
    historical.build.choices=historical.build.choices.filter((choice:Choice)=>!choice.id.startsWith('feat:skilled@'));
    historical.build.choices.push(...picks('background:scribe',['skill:arcana','tool:flute','tool:lyre']).map(choice=>({...choice,id:'feat:skilled:proficiencies'})));
    const evaluation=await f.call('evaluate',{key,operation:'build',expectedRevision:stored.revision,inputs:historical});
    assert.equal(evaluation.evaluation.guidance.canSave,false);
    const {page,sheet,status,read}=await openBuilder(t,f,key);
    // Simulate a historical stored snapshot at the read boundary. All
    // evaluation and the user's subsequent save use the installed workers.
    let supplied=false;
    await page.route('**/services/call',async route=>{
      const body=route.request().postDataJSON();
      if(body.method==='load'&&body.params?.key===key&&!supplied) {
        supplied=true; const response=await route.fetch(), payload=await response.json();
        payload.result.state.inputs=historical; payload.result.evaluation=evaluation.evaluation;
        await route.fulfill({response,json:payload});
      } else await route.continue();
    });
    await page.reload(); await page.locator('#character-view-addons').click(); await sheet.locator('#dnd-tab-builder').click(); await sheet.locator('#dnd-builder-tab-character').click();
    const repair=sheet.locator('section').filter({has:page.getByRole('heading',{name:'Assign saved feat choices',exact:true})}).last();
    await repair.getByRole('combobox',{name:'Granting source',exact:true}).waitFor();
    assert.equal((await read()).revision,stored.revision,'loading cannot choose an owner or write data');
    const target=skilled('asi:fighter:4:feat');
    await choose(repair,'Granting source',evaluation.evaluation.guidance.choices[target].label);
    await status.filter({hasText:/^Saved$/}).waitFor();
    const saved=await read(), selected=saved.state.inputs.build.choices.filter((choice:Choice)=>choice.id.startsWith('feat:skilled'));
    assert.deepEqual(selected,picks('asi:fighter:4:feat',['skill:arcana','tool:flute','tool:lyre']));
    assert.equal(saved.evaluation.sheet.skills.arcana.proficient,true);
    assert.equal(await sheet.getByRole('heading',{name:'Assign saved feat choices',exact:true}).count(),0);
  });

  test('Unscoped historical feat selections bind once and ambiguous ownership cannot save',{skip:!enabled,timeout:60000},async()=>{
    const f=fixture(),key='repeatable-legacy',inputs=await createCharacter(f,key);
    inputs.build.species='dwarf'; inputs.build.background='scribe'; inputs.build.levels=[{id:'one',classId:'fighter'}];
    inputs.build.choices=picks('background:scribe',['skill:arcana','tool:flute','tool:lyre']).map(choice=>({...choice,id:'feat:skilled:proficiencies'}));
    const saved=await save(f,key,inputs,0,'legacy');
    assert.equal(saved.state.inputs.build.choices.every((choice:Choice)=>choice.id===skilled('background:scribe')),true);
    const ambiguous=structuredClone(inputs); ambiguous.build.levels=Array.from({length:4},(_,index)=>({id:'level-'+index,classId:'fighter'}));
    ambiguous.build.choices.push({id:'asi:fighter:4',slot:0,value:'feat'},{id:'asi:fighter:4:feat',slot:0,value:'skilled'});
    const rejected=await f.call('save',{key,operation:'build',operationId:key+'-ambiguous',summary:'Unassigned historical choices',expectedRevision:saved.revision,inputs:ambiguous});
    assert.equal(rejected.status,'invalid'); assert.equal(rejected.evaluation.issues.some((issue:{id:string})=>issue.id.startsWith('ambiguous-feat-choice:')),true);
    assert.equal((await f.call('load',{key})).revision,saved.revision);
  });
}
