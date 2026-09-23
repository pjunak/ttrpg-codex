import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { readyCharacter } from './installed-character-command-fixture.mts';

type Row = Record<string, any>;
const levels = (classId: string, count: number) => Array.from({length:count},(_,i)=>({id:classId+'-'+i,classId}));
const spellbook = ['detect-magic','alarm','shield','magic-missile','mage-armor','sleep','feather-fall','identify','mirror-image','misty-step'];
const cantrips: Record<string,string[]> = {fighter:['light','mage-hand'],warlock:['eldritch-blast','minor-illusion'],wizard:['light','mage-hand','minor-illusion']};

async function complete(f: Fixture, key: string, inputs: Row, revision: number, suffix: string) {
 for(let round=0;round<10;round++) {
  const {evaluation:e}=await f.call('evaluate',{key,operation:'build',inputs,expectedRevision:revision});
  if(e.ready)break;
  const add=(id:string,value:unknown,slot=0)=>{if(!inputs.build.choices.some((row:Row)=>row.id===id&&row.slot===slot))inputs.build.choices.push({id,slot,value});};
  for(const choice of [...e.plan.creationChoices,...e.plan.creationAbilityChoices,...e.plan.classChoices]) {
   if(choice.kind==='asiMode'){add(choice.id,'asi');add(choice.ability.id,{INT:1,CON:1});}
   else if(choice.kind==='abilityBudget'){
    let remaining=Number(choice.budget);const assignment:Record<string,number>={};
    for(const ability of choice.eligible){const n=Math.min(remaining,Number(choice.perAbilityMax));if(n)assignment[ability]=n;remaining-=n;}add(choice.id,assignment);
   } else {
    const options=e.guidance.choices[choice.id]?.options??[];
    const safe=options.find((row:Row)=>row.id==='invocation-eldritch-mind');
    for(let slot=0;slot<Number(choice.count??1)&&options[slot];slot++)add(choice.id,safe?.id??options[slot].id,slot);
   }
  }
  for(const caster of e.sheet.spellcasting.perClass) {
   const id=caster.classId;
   inputs.build.spells.cantrips[id]=(cantrips[id]??[]).slice(0,caster.cantripsKnown);
   if(id==='wizard')inputs.build.spells.spellbook[id]=spellbook.slice(0,caster.spellbookKnown);
   inputs.play.preparedSpells[id]=id==='warlock'?['armor-of-agathys','hellish-rebuke']:['shield','magic-missile'];
  }
  for(const choice of e.spellOptions.pendingChoices)inputs.build.spells.grantChoices[choice.key]=choice.eligibleSpellIds.slice(0,choice.choose);
  for(const choice of e.spellOptions.castingAbilityChoices)inputs.build.spells.castingAbilities[choice.key]=choice.options[0];
 }
 const stored=await save(f,key,inputs,revision,suffix);
 assert.equal(stored.evaluation.ready,true,JSON.stringify(stored.evaluation.issues));
 return stored;
}
const slots=(stored:Row)=>stored.evaluation.sheet.spellcasting.slots.filter((n:number)=>n>0);
async function play(f:Fixture,key:string,stored:Row,change:Row,suffix:string) {
 const next=await f.call('save',{key,operation:'play',operationId:key+'-'+suffix,expectedRevision:stored.revision,summary:'Multiclass play acceptance',change});
 assert.equal(next.status,'ready',JSON.stringify(next.evaluation?.issues));return next;
}
async function sourceItems(f:Fixture,key:string) {
 let stored=await readyCharacter(f,key),input=structuredClone(stored.state.inputs);
 input.play.inventory=['staff-of-power','pearl-of-power'].map(id=>({id,name:id,reference:{kind:'magic-item',id},quantity:1,location:'carried',attuned:false,acquisition:'Keep acquisition',notes:'Keep item notes'}));
 input.notes='Keep character notes';stored=await save(f,key,input,stored.revision,'items');
 for(const id of ['staff-of-power','pearl-of-power']){
  stored=await f.call('save',{key,operation:'grant',operationId:key+'-authority-'+id,expectedRevision:stored.revision,summary:'Record item adjudication',
   grant:{id:'',actorId:'',grantedAt:'',active:true,itemId:id,name:'Reviewed item mechanics',reason:'The DM handles this item manually; no extra character statistic.',effectiveLevel:1,condition:'always',effects:[{target:'initiative',mode:'add',value:0}],waivers:[]}});
  assert.equal(stored.status,'ready',JSON.stringify(stored.evaluation?.issues));
 }
 return stored;
}

export function registerMulticlassAcceptanceTests(enabled:boolean,fixture:()=>Fixture) {
 test('multiclass progression keeps Pact Magic, prepared limits and spent pools independent',{skip:!enabled,timeout:90000},async()=>{
  const f=fixture(),key='multiclass-progression';let stored=await readyCharacter(f,key),input=structuredClone(stored.state.inputs);
  input.build.baseScores={STR:12,DEX:14,CON:10,INT:15,WIS:8,CHA:13};
  input.build.choices=input.build.choices.filter((row:Row)=>row.id!=='skills:fighter');
  input.build.choices.push({id:'skills:fighter',slot:0,value:'history'},{id:'skills:fighter',slot:1,value:'perception'});
  input.build.levels=[...levels('fighter',4),...levels('warlock',1)];input.build.subclasses.fighter='eldritch-knight';
  input.notes='Keep multiclass notes';input.play.currency.gp=27;input.play.hp=3;
  stored=await complete(f,key,input,stored.revision,'level-five');assert.deepEqual(slots(stored),[3]);
  stored=await play(f,key,stored,{operation:'cast-spell',classId:'fighter',ref:'shield',slot:'pact-slot'},'pact-cast');
  stored=await play(f,key,stored,{operation:'cast-spell',classId:'warlock',ref:'hellish-rebuke',slot:'slot-1'},'ordinary-cast');
  assert.equal(stored.state.inputs.play.resourceUses['pact-slot'],1);assert.equal(stored.state.inputs.play.resourceUses['slot-1'],1);
  input=structuredClone(stored.state.inputs);input.build.levels=[...levels('fighter',4),...levels('warlock',1),...levels('fighter',7).slice(4)];
  stored=await complete(f,key,input,stored.revision,'level-eight');assert.deepEqual(slots(stored),[4,2]);
  assert.equal(stored.state.inputs.play.resourceUses['pact-slot'],1);assert.equal(stored.state.inputs.play.resourceUses['slot-1'],1);
  stored=await play(f,key,stored,{operation:'rest',rest:'short'},'short-rest');
  assert.equal(stored.state.inputs.play.resourceUses['pact-slot'],0);assert.equal(stored.state.inputs.play.resourceUses['slot-1'],1);
  input=structuredClone(stored.state.inputs);input.build.levels.push(...levels('wizard',3));input.build.subclasses.wizard='evoker';
  stored=await complete(f,key,input,stored.revision,'level-eleven');assert.deepEqual(slots(stored),[4,3,2]);
  const casters=stored.evaluation.sheet.spellcasting.perClass;
  for(const id of ['fighter','wizard'])assert.equal(casters.find((row:Row)=>row.classId===id).maxSpellLevel,2);
  const invalid=structuredClone(stored.state.inputs);invalid.play.preparedSpells.wizard.push('fireball');
  const rejected=await f.call('save',{key,operation:'build',operationId:key+'-invalid-preparation',expectedRevision:stored.revision,summary:'Cannot prepare a shared-slot level',inputs:invalid});
  assert.equal(rejected.status,'invalid');assert.ok(rejected.evaluation.issues.some((row:Row)=>row.id==='spell-eligibility:prepared:wizard:fireball'));
  assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
  stored=await play(f,key,stored,{operation:'cast-spell',classId:'wizard',ref:'shield',slot:'slot-3'},'upcast');
  assert.equal(stored.state.inputs.play.resourceUses['slot-3'],1);
  stored=await play(f,key,stored,{operation:'rest',rest:'long'},'long-rest');
  for(const id of ['slot-1','slot-3','pact-slot'])assert.equal(stored.state.inputs.play.resourceUses[id],0);
  assert.equal(stored.state.inputs.notes,'Keep multiclass notes');assert.equal(stored.state.inputs.play.currency.gp,27);
  assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
 });

 test('attunement source distinguishes class membership from feat spellcasting',{skip:!enabled,timeout:60000},async()=>{
  const f=fixture(),key='attunement-traits';let stored=await sourceItems(f,key);
  for(const id of ['staff-of-power','pearl-of-power'])assert.equal(stored.evaluation.guidance.equipment[id].attuneReason,'prerequisite');
  const input=structuredClone(stored.state.inputs);input.build.background='sage';
  input.build.choices=input.build.choices.filter((row:Row)=>row.id!=='bgasi');input.build.choices.push({id:'bgasi',slot:0,value:{INT:2,WIS:1}});
  stored=await complete(f,key,input,stored.revision,'origin-spells');
  assert.equal(stored.evaluation.guidance.equipment['pearl-of-power'].canAttune,true);
  assert.equal(stored.evaluation.guidance.equipment['staff-of-power'].attuneReason,'prerequisite');
  const next=structuredClone(stored.state.inputs);next.play.inventory.find((row:Row)=>row.id==='pearl-of-power').attuned=true;
  stored=await save(f,key,next,stored.revision,'attune');
  const withdrawn=structuredClone(stored.state.inputs);withdrawn.build.background='soldier';withdrawn.build.choices=withdrawn.build.choices.filter((row:Row)=>row.id!=='bgasi');
  const rejected=await f.call('save',{key,operation:'build',operationId:key+'-withdraw',expectedRevision:stored.revision,summary:'Withdraw intrinsic spellcasting',inputs:withdrawn});
  assert.equal(rejected.status,'invalid');assert.ok(rejected.evaluation.issues.some((row:Row)=>row.id==='attunement:pearl-of-power'));
  assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
 });


 test('attunement narrative requirements require an exact independent DM waiver',{skip:!enabled,timeout:60000},async()=>{
  const f=fixture(),key='attunement-adjudication';let stored=await readyCharacter(f,key),inputs=structuredClone(stored.state.inputs);
  inputs.play.inventory=[{id:'thrower',name:'Dwarven Thrower',reference:{kind:'magic-item',id:'dwarven-thrower'},quantity:1,location:'carried',attuned:false,acquisition:'Keep acquisition',notes:'Keep adjudication notes'}];
  stored=await save(f,key,inputs,stored.revision,'item');
  const grant={id:'',actorId:'',grantedAt:'',active:true,itemId:'thrower',name:'Reviewed item mechanics',reason:'Manual item effect acceptance',effectiveLevel:1,condition:'always',effects:[{target:'initiative',mode:'add',value:0}],waivers:[]};
  stored=await f.call('save',{key,operation:'grant',operationId:key+'-mechanics',expectedRevision:stored.revision,summary:grant.reason,grant});
  assert.equal(stored.status,'ready');assert.equal(stored.evaluation.guidance.equipment.thrower.attuneReason,'prerequisite');
  inputs=structuredClone(stored.state.inputs);inputs.play.inventory[0].attuned=true;
  const rejected=await f.call('save',{key,operation:'build',operationId:key+'-no-waiver',expectedRevision:stored.revision,summary:'Unadjudicated condition',inputs});
  assert.equal(rejected.status,'invalid');assert.ok(rejected.evaluation.issues.some((row:Row)=>row.id==='attunement:thrower'&&row.message.includes('Belt of Dwarvenkind')));
  stored=await f.call('save',{key,operation:'grant',operationId:key+'-waiver',expectedRevision:stored.revision,summary:'Record an independent attunement ruling',grant:{...grant,itemId:undefined,name:'Attunement ruling',effects:[],waivers:['attunement:thrower']}});
  assert.equal(stored.status,'ready');const waiver=stored.state.inputs.grants.find((row:Row)=>row.waivers.includes('attunement:thrower')).id;
  inputs=structuredClone(stored.state.inputs);inputs.play.inventory[0].attuned=true;
  stored=await save(f,key,inputs,stored.revision,'attuned');
  const lost=await f.call('save',{key,operation:'revoke-grant',operationId:key+'-revoke-blocked',expectedRevision:stored.revision,summary:'Withdraw ruling',grantId:waiver});
  assert.equal(lost.status,'invalid');assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
  inputs=structuredClone(stored.state.inputs);inputs.play.inventory[0].attuned=false;
  stored=await save(f,key,inputs,stored.revision,'unattune');
  const repaired=await f.call('save',{key,operation:'revoke-grant',operationId:key+'-revoke-repaired',expectedRevision:stored.revision,summary:'Withdraw the repaired attunement ruling',grantId:waiver});
  assert.equal(repaired.status,'ready',JSON.stringify(repaired.evaluation?.issues));assert.equal(repaired.state.inputs.play.inventory[0].attuned,false);
  assert.deepEqual(repaired.state.inputs.grants,stored.state.inputs.grants.filter((row:Row)=>row.id!==waiver));
  assert.equal(repaired.evaluation.guidance.equipment.thrower.attuneReason,'prerequisite');
  assert.equal(repaired.state.inputs.play.inventory[0].notes,'Keep adjudication notes');
 });

 for(const locale of ['en','cs'])test('attunement class removal stays repairable through shared controls ('+locale+')',{skip:!enabled,timeout:60000},async t=>{
  const f=fixture(),key='attunement-class-'+locale;let stored=await sourceItems(f,key);
  const {page,sheet,status,read}=await openBuilder(t,f,key,locale),attune=locale==='cs'?'Sladit se: ':'Attune ',saved=locale==='cs'?/^Uloženo$/:/^Saved$/;
  if(locale==='cs'){await sheet.locator('#dnd-tab-tools').click();await sheet.getByRole('combobox',{name:'Rozložení deníku',exact:true}).selectOption('classic');}
  await sheet.locator('#dnd-tab-sheet').click();
  const staff=sheet.getByRole('button',{name:attune+'staff-of-power',exact:true});
  assert.equal(await staff.isDisabled(),true);
  assert.equal(await staff.getAttribute('aria-description'),locale==='cs'?'Splňte předpoklad tohoto předmětu nebo zaznamenejte rozhodnutí DM.':"Meet this item's prerequisite or record a DM ruling.");
  const input=structuredClone(stored.state.inputs);input.build.baseScores={STR:14,DEX:12,CON:13,INT:15,WIS:10,CHA:8};input.build.levels.push({id:'wizard-entry',classId:'wizard'});
  stored=await complete(f,key,input,stored.revision,'wizard');
  await page.reload();await page.locator('#character-view-addons').click();await sheet.locator('#dnd-tab-sheet').click();await staff.waitFor();
  assert.equal(await staff.isDisabled(),false);await staff.focus();await staff.press('Enter');await status.filter({hasText:saved}).waitFor();
  stored=await read();assert.equal(stored.state.inputs.play.inventory[0].attuned,true);
  await sheet.locator('#dnd-tab-builder').click();await sheet.locator('#dnd-builder-tab-wizard').click();
  await sheet.getByRole('button',{name:locale==='cs'?'Odebrat úroveň':'Remove level',exact:true}).click();
  await status.filter({hasText:locale==='cs'?'Předpoklad není splněn.':'The prerequisite is not met.'}).waitFor();
  assert.equal((await read()).revision,stored.revision);
  await sheet.locator('#dnd-tab-sheet').click();assert.equal(await staff.isDisabled(),false,'an attuned item must remain available for explicit repair');
  await page.setViewportSize({width:390,height:1000});await page.addStyleTag({content:'html {font-size:200% !important;}'});
  await staff.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(f.output,'attunement-repair-'+locale+'.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await staff.focus();await staff.press('Enter');await status.filter({hasText:saved}).waitFor();
  const repaired=await read();assert.equal(repaired.state.inputs.build.levels.length,1);assert.equal(repaired.state.inputs.play.inventory[0].attuned,false);
  assert.equal(repaired.state.inputs.notes,stored.state.inputs.notes);assert.deepEqual(repaired.state.inputs.grants,stored.state.inputs.grants);
  assert.deepEqual(repaired.state.inputs.play.inventory,stored.state.inputs.play.inventory.map((row:Row)=>({...row,attuned:false})));
  const move=sheet.getByRole('combobox',{name:(locale==='cs'?'Přesunout: ':'Move ')+'staff-of-power',exact:true});
  assert.equal(await move.evaluate(node=>node===document.activeElement),true,'focus stays with the repaired item when its action becomes disabled');
  await page.screenshot({path:resolve(f.output,'attunement-repaired-'+locale+'.png')});
  await page.reload();await page.locator('#character-view-addons').click();await sheet.locator('#dnd-tab-sheet').click();await staff.waitFor();assert.equal(await staff.isDisabled(),true);
 });
}
