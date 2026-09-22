import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { resolve } from 'node:path';
import { createCharacter, openBuilder, save, type Fixture } from './installed-character-builder-fixture.mts';
import { readyCharacter } from './installed-character-command-fixture.mts';

type Row = Record<string, any>;
const owner = (id: string) => 'feat:magic-initiate@' + encodeURIComponent('grant:' + id);
async function spellCharacter(f: Fixture, key: string, count = 3) {
  let stored = await readyCharacter(f,key);
  for(const [index,list] of ['wizard','cleric','druid'].slice(0,count).entries()) {
    const previous=new Set(stored.state.inputs.grants.map((grant:Row)=>grant.id));
    stored=await f.call('save',{key,operation:'grant',operationId:key+'-grant-'+list,expectedRevision:stored.revision,summary:'Grant spell training',
      grant:{id:'',actorId:'',grantedAt:'',name:list+' training',reason:'Installed spell acceptance',active:true,effectiveLevel:1,condition:'always',effects:[],waivers:[],feat:{kind:'feat',id:'magic-initiate'}}});
    assert.equal(stored.status,'ready',JSON.stringify(stored));
    const id=stored.state.inputs.grants.find((grant:Row)=>!previous.has(grant.id)).id, prefix=owner(id);
    const inputs=structuredClone(stored.state.inputs);
    inputs.build.choices.push({id:prefix+':spell-list',slot:0,value:list});
    stored=await save(f,key,inputs,stored.revision,'list-'+list);
    const selected=structuredClone(stored.state.inputs);
    for(const choice of stored.evaluation.spellOptions.pendingChoices.filter((row:Row)=>row.key.startsWith(prefix+':'))) {
      assert.deepEqual(choice.from.class,[list]);
      selected.build.spells.grantChoices[choice.key]=choice.spellLevel===1?['detect-magic']:choice.eligibleSpellIds.slice(0,2);
      assert.ok(choice.spellLevel!==1||choice.eligibleSpellIds.includes('detect-magic'));
    }
    selected.build.spells.castingAbilities[prefix+':magic-initiate-casting']=['INT','WIS','CHA'][index];
    selected.notes='Preserve spell ownership';
    stored=await save(f,key,selected,stored.revision,'spells-'+list);
    assert.equal(stored.evaluation.ready,true,JSON.stringify(stored.evaluation.issues));
  }
  const inputs=structuredClone(stored.state.inputs);
  inputs.play.inventory=[{id:'spell-sword',reference:{kind:'weapon',id:'longsword'},name:'Spell Sword',quantity:1,location:'equipped',attuned:false,acquisition:'Retain acquisition',notes:'Retain notes'}];
  return save(f,key,inputs,stored.revision,'weapon');
}
const freeGrants=(stored:Row):Row[]=>stored.evaluation.spellOptions.granted.filter((row:Row)=>row.ref==='detect-magic');
const freeKey=(grant:Row):string=>grant.slots.find((key:string)=>key.startsWith('charge:'));

export function registerSpellOwnershipTests(enabled:boolean,fixture:()=>Fixture) {
 test('spell ownership keeps repeated free casts, abilities and withdrawn grants independent',{skip:!enabled,timeout:60000},async()=>{
  const f=fixture(),key='spell-ownership';let stored=await spellCharacter(f,key);
  const grants=freeGrants(stored);
  assert.equal(grants.length,3);assert.equal(new Set(grants.map(freeKey)).size,3);
  assert.deepEqual(new Set(grants.map(row=>row.castingAbility)),new Set(['INT','WIS','CHA']));
  for(const [index,grant] of grants.entries()) {
    stored=await f.call('save',{key,operation:'play',operationId:key+'-cast-'+index,expectedRevision:stored.revision,summary:'Cast independent free spell',change:{operation:'cast-granted-spell',key:grant.key,slot:freeKey(grant)}});
    assert.equal(stored.status,'ready',JSON.stringify(stored));assert.equal(stored.state.inputs.play.resourceUses[freeKey(grant)],1);
  }
  const before=structuredClone(stored.state.inputs);
  stored=await f.call('save',{key,operation:'play',operationId:key+'-short',expectedRevision:stored.revision,summary:'Short rest',change:{operation:'rest',rest:'short'}});
  assert.equal(stored.status,'ready');for(const grant of grants)assert.equal(stored.state.inputs.play.resourceUses[freeKey(grant)],1);
  const removed=grants[0]!.source.acquisition.id.slice('grant:'.length);
  stored=await f.call('save',{key,operation:'revoke-grant',operationId:key+'-revoke',expectedRevision:stored.revision,summary:'Withdraw one training',grantId:removed});
  assert.equal(stored.status,'ready',JSON.stringify(stored));
  assert.equal(freeGrants(stored).length,2);
  assert.equal(stored.state.inputs.play.resourceUses[freeKey(grants[0]!)],undefined);
  for(const grant of grants.slice(1))assert.equal(stored.state.inputs.play.resourceUses[freeKey(grant)],1);
  assert.deepEqual(stored.state.inputs.play.inventory,before.play.inventory);assert.equal(stored.state.inputs.notes,before.notes);
  stored=await f.call('save',{key,operation:'play',operationId:key+'-long',expectedRevision:stored.revision,summary:'Long rest',change:{operation:'rest',rest:'long'}});
  assert.equal(stored.status,'ready');for(const grant of grants.slice(1))assert.equal(stored.state.inputs.play.resourceUses[freeKey(grant)],0);
  assert.deepEqual((await f.call('load',{key})).state.inputs,stored.state.inputs);
 });

 test('spell ownership normalizes one legacy owner and rejects ambiguous saved choices',{skip:!enabled,timeout:60000},async()=>{
  const f=fixture(),key='spell-legacy';let stored=await spellCharacter(f,key,1);
  const grant=freeGrants(stored)[0]!,prefix=owner(stored.state.inputs.grants[0].id),inputs=structuredClone(stored.state.inputs);
  inputs.build.spells.grantChoices={'feat:magic-initiate:mi-cantrips':inputs.build.spells.grantChoices[prefix+':mi-cantrips'],'feat:magic-initiate:mi-spell':['detect-magic']};
  inputs.build.spells.castingAbilities={'feat:magic-initiate:magic-initiate-casting':'INT'};
  inputs.play.resourceUses['charge-detect-magic']=1;
  stored=await save(f,key,inputs,stored.revision,'old-keys');
  assert.equal(stored.state.inputs.play.resourceUses[freeKey(grant)],1);
  assert.equal(stored.state.inputs.play.resourceUses['charge-detect-magic'],undefined);
  const repeated=await spellCharacter(f,'spell-ambiguous',2),ambiguous=structuredClone(repeated.state.inputs);
  ambiguous.build.spells.grantChoices={'feat:magic-initiate:mi-spell':['detect-magic']};
  const rejected=await f.call('save',{key:'spell-ambiguous',operation:'build',operationId:'spell-ambiguous-old',expectedRevision:repeated.revision,summary:'Unassigned old state',inputs:ambiguous});
  assert.equal(rejected.status,'invalid');
  assert.deepEqual(rejected.evaluation.inputs.build.spells.grantChoices,ambiguous.build.spells.grantChoices);
 });

 test('spell ownership honors background list presets and distinct repetition',{skip:!enabled,timeout:60000},async()=>{
  const f=fixture();
  for(const [background,list] of [['acolyte','cleric'],['guide','druid'],['sage','wizard']] as const){
   const key='spell-origin-'+background,inputs=await createCharacter(f,key);
   inputs.build.species='dwarf';inputs.build.background=background;inputs.build.levels=[{id:'one',classId:'fighter'}];
   const stored=await save(f,key,inputs,0,'origin');
   assert.equal(stored.evaluation.spellOptions.pendingChoices.length,2);
   for(const choice of stored.evaluation.spellOptions.pendingChoices)assert.deepEqual(choice.from.class,[list]);
   const preset=stored.evaluation.plan.creationChoices.find((row:Row)=>row.id.endsWith(':spell-list'));
   assert.equal(preset.default,list);assert.deepEqual(stored.evaluation.guidance.choices[preset.id].options.map((row:Row)=>row.id),[list]);
  }
  const key='spell-distinct',stored=await spellCharacter(f,key,2),inputs=structuredClone(stored.state.inputs);
  const lists=inputs.build.choices.filter((row:Row)=>row.id.endsWith(':spell-list')).sort((a:Row,b:Row)=>a.id.localeCompare(b.id));
  lists[1].value=lists[0].value;
  const rejected=await f.call('save',{key,operation:'build',operationId:key+'-duplicate',expectedRevision:stored.revision,summary:'Attempt same list twice',inputs});
  assert.equal(rejected.status,'invalid');
  assert.ok(rejected.evaluation.issues.some((issue:Row)=>issue.id.startsWith('invalid-option:')));
 });

 for(const locale of ['en','cs']) test('spell UI shares filters and complete Combat details ('+locale+')',{skip:!enabled,timeout:60000},async t=>{
  const f=fixture(),key='spell-ui-'+locale;let stored=await spellCharacter(f,key);
  const wizard=structuredClone(stored.state.inputs);
  wizard.build.baseScores={STR:14,DEX:12,CON:13,INT:15,WIS:10,CHA:8};wizard.build.levels.push({id:'wizard-one',classId:'wizard'});
  wizard.build.spells.cantrips.wizard=['light','mage-hand','minor-illusion'];
  wizard.build.spells.spellbook.wizard=['detect-magic','alarm','shield','magic-missile','mage-armor','sleep'];
  wizard.play.preparedSpells.wizard=['detect-magic','shield','magic-missile','mage-armor'];
  stored=await save(f,key,wizard,stored.revision,'wizard');assert.equal(stored.evaluation.ready,true,JSON.stringify(stored.evaluation.issues));
  stored=await f.call('save',{key,operation:'play',operationId:key+'-sense',expectedRevision:stored.revision,summary:'Activate conditional sense',change:{operation:'toggle-feature',key:'species:dwarf:stonecunning',enabled:true}});
  assert.equal(stored.status,'ready');
  const {page,sheet,read}=await openBuilder(t,f,key,locale);
  if(locale==='cs'){await sheet.locator('#dnd-tab-tools').click();await sheet.getByRole('combobox',{name:'Rozložení deníku',exact:true}).selectOption('classic');}
  await page.setViewportSize({width:390,height:1000});await page.addStyleTag({content:'html {font-size:200% !important;}'});
  await sheet.locator('#dnd-tab-spells').click();
  const search=sheet.getByRole('searchbox',{name:locale==='cs'?'Filtrovat kouzla':'Filter spells',exact:true}).first();
  const level=sheet.getByRole('combobox',{name:locale==='cs'?'Stupeň kouzla':'Spell level',exact:true}).first();
  await search.fill('Detect Magic');assert.equal(await sheet.locator('[data-spell-grant]:visible').count(),3);
  assert.equal(await sheet.locator('[data-spell-name="Detect Magic"]:visible').count(),5,'class, ritual and each granted row share the filter');
  await level.selectOption('0');assert.equal(await sheet.locator('[data-spell-name]:visible').count(),0);
  await sheet.getByText(locale==='cs'?'Žádná odpovídající kouzla.':'No matching spells.',{exact:true}).first().waitFor();
  await level.selectOption('1');assert.equal(await sheet.locator('[data-spell-grant]:visible').count(),3);
  await search.fill('missing-spell-query');assert.equal(await sheet.locator('[data-spell-grant]:visible').count(),0);
  assert.equal((await read()).revision,stored.revision,'filters cannot save state');
  await search.fill('Detect Magic');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await search.evaluate(node=>node.closest('section')?.scrollIntoView({block:'start'}));
  await page.screenshot({path:resolve(f.output,'spell-filter-phone-'+locale+'.png')});
  await sheet.locator('#dnd-tab-combat').click();
  await sheet.locator('.dse-attack').getByText(locale==='cs'?'Zranění při držení oběma rukama:':'Versatile damage:',{exact:false}).waitFor();
  await sheet.locator('.dse-attack').getByRole('button',{name:/1d8/}).waitFor();
  await sheet.locator('.dse-attack').getByRole('button',{name:/1d10/}).waitFor();
  await sheet.locator('.dse-attack').getByRole('button',{name:'Sap',exact:true}).waitFor();
  assert.match(await sheet.locator('.dse-combat').first().innerText(),/120 ft/);
  assert.match(await sheet.locator('.dse-combat').first().innerText(),/Touching stone; ends after 10 minutes/);
  assert.equal(await sheet.locator('.dse-resource').evaluateAll(nodes=>nodes.every(node=>{const name=node.querySelector('span')?.getBoundingClientRect(),count=node.querySelector('strong')?.getBoundingClientRect();return !name||!count||name.bottom<=count.top+1||name.right<=count.left+1;})),true,'resource labels must not overlap their counters');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,JSON.stringify(await sheet.locator('*').evaluateAll(nodes=>nodes.map(node=>({tag:node.tagName,cls:node.className,right:node.getBoundingClientRect().right,width:node.getBoundingClientRect().width})).filter(row=>row.width>0&&row.right>innerWidth).slice(-15))));
  await sheet.locator('.dse-attack').evaluate(node=>node.closest('section')?.scrollIntoView({block:'start'}));
  await page.screenshot({path:resolve(f.output,'combat-details-phone-'+locale+'.png')});
  await sheet.locator('#dnd-tab-builder').click();await sheet.locator('#dnd-builder-tab-spells').click();
  const first=stored.evaluation.spellOptions.pendingChoices[0].key;
  const group=sheet.locator('[data-builder-target="'+first+'"]');await group.locator('summary').first().click();
  await group.getByRole('searchbox').fill('missing-spell-query');
  await group.getByText(locale==='cs'?'Žádná odpovídající kouzla.':'No matching spells.',{exact:true}).waitFor();
  assert.equal((await read()).revision,stored.revision);
 });
}

export async function verifyFrozenSpellDetails(t:TestContext,f:Fixture) {
 const {page,sheet,read}=await openBuilder(t,f,'spell-ui-en');
 const frozen=await read();assert.equal(frozen.status,'unavailable');
 await sheet.locator('#dnd-tab-spells').click();
 await sheet.getByRole('searchbox',{name:'Filter spells',exact:true}).first().fill('Detect Magic');
 assert.equal(await sheet.locator('[data-spell-name="Detect Magic"]:visible').count(),5);
 await sheet.locator('#dnd-tab-combat').click();assert.match(await sheet.locator('.dse-combat').first().innerText(),/120 ft/);
 await sheet.locator('#dnd-tab-tools').click();await sheet.getByRole('button',{name:'Print / PDF',exact:true}).click();
 const popupEvent=page.waitForEvent('popup');
 await sheet.getByRole('button',{name:'Open print preview',exact:true}).click();
 const popup=await popupEvent;
 assert.match(await popup.locator('body').innerText(),/Detect Magic/);
 assert.match(await popup.locator('body').innerText(),/120 ft/);
 assert.match(await popup.locator('body').innerText(),/1d10/);
 assert.match(await popup.locator('body').innerText(),/Touching stone; ends after 10 minutes/);
 await popup.close();
 assert.equal((await read()).revision,frozen.revision);
}
