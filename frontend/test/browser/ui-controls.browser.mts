import type {} from './ui-controls-fixture-api.ts';
import assert from 'node:assert/strict';
import { before, after, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
let browser: Browser, server: ViteDevServer, origin: string;
before(async () => {
 server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, logLevel: 'error', cacheDir: fileURLToPath(new URL('../../node_modules/.vite-ui-tests', import.meta.url)), server: { host:'127.0.0.1', port:0 } });
 await server.listen(); origin = 'http://127.0.0.1:' + (server.httpServer!.address() as AddressInfo).port; browser = await chromium.launch({headless:true});
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(t: TestContext, width = 1100) {
 const context = await browser.newContext({ viewport: { width, height: 900 }, locale:'en-US', hasTouch: width < 768, isMobile: width < 768 }); t.after(()=>context.close());
 const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error=>errors.push(error.message)); page.setDefaultTimeout(5000);
 t.after(()=>assert.deepEqual(errors, [])); await page.goto(origin+'/test/browser/ui-controls-fixture.html'); await page.waitForFunction(()=>window.uiControlsFixture !== undefined); return page;
}
test('combo separates editing from native selection and skips disabled choices', async t => {
 const page = await fixture(t), combo = page.getByRole('combobox',{name:'Origin',exact:true});
 assert.equal(await combo.inputValue(),'Choose…'); await combo.fill('alf'); assert.equal(await page.getByRole('listbox').getByRole('option').count(),1);
 assert.equal(await page.locator('[name=origin]').inputValue(),''); await combo.press('ArrowDown'); await combo.press('Enter');
 assert.equal(await page.locator('[name=origin]').inputValue(),'a'); assert.equal(await combo.inputValue(),'Álfheim'); assert.equal(await page.evaluate(()=>window.uiControlsFixture.changes),1);
 await combo.click(); await combo.press('ArrowDown'); await combo.press('ArrowDown'); await combo.press('ArrowDown');
 assert.equal(await page.locator('.ui-active').getAttribute('aria-label'),'Dwarf'); await combo.press('Escape'); assert.equal(await combo.inputValue(),'Álfheim');
 await combo.fill('not an origin'); await combo.press('Tab'); assert.equal(await combo.inputValue(),'Álfheim');
 await page.getByLabel('Notes',{exact:true}).fill('Authored notes'); await page.getByRole('button',{name:'Apply filters',exact:true}).click();
 assert.equal((await page.evaluate(()=>window.uiControlsFixture.submissions))[0]?.origin,'a');
});
test('required, form reset and disabled state retain native semantics and focus', async t => {
 const page = await fixture(t), combo = page.getByRole('combobox',{name:'Origin',exact:true});
 await page.getByRole('button',{name:'Apply filters',exact:true}).click(); assert.equal(await combo.evaluate(node=>node === document.activeElement),true); assert.equal(await combo.getAttribute('aria-invalid'),'true');
 await combo.fill('Dwarf'); await combo.press('ArrowDown'); await combo.press('Enter');
 assert.equal(await combo.getAttribute('aria-invalid'),null); await page.getByRole('button',{name:'Reset',exact:true}).click(); await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[role=combobox]')?.value==='Choose…'); assert.equal(await combo.inputValue(),'Choose…');
 await page.evaluate(()=>window.uiControlsFixture.disabled(true)); assert.equal(await combo.isDisabled(),true);
 await page.evaluate(()=>window.uiControlsFixture.disabled(false)); await combo.click(); await page.evaluate(()=>window.uiControlsFixture.disabled(true)); assert.equal(await page.locator('.ui-popup:popover-open').count(),0);
});
test('search publishes complete IME input once and clear preserves focus', async t => {
 const page = await fixture(t), search = page.getByRole('searchbox',{name:'Search records',exact:true});
 await search.evaluate(node=>{ const input=node as HTMLInputElement; input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); input.value='roz'; input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true})); });
 assert.deepEqual(await page.evaluate(()=>window.uiControlsFixture.queries),[]);
 await search.evaluate(node=>{ const input=node as HTMLInputElement; input.value='rozhovor'; input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); input.dispatchEvent(new InputEvent('input',{bubbles:true})); });
 assert.deepEqual(await page.evaluate(()=>window.uiControlsFixture.queries),['rozhovor']);
 await page.getByRole('button',{name:'Clear search',exact:true}).click(); assert.deepEqual(await page.evaluate(()=>window.uiControlsFixture.queries),['rozhovor','']);
 assert.equal(await search.evaluate(node=>node===document.activeElement),true);
});
test('large options are bounded, loading cannot commit, live refresh and disposal restore native control', async t => {
 const page = await fixture(t), combo = page.getByRole('combobox',{name:'Origin',exact:true});
 await page.evaluate(()=>window.uiControlsFixture.options(500)); await combo.click(); assert.equal(await page.getByRole('listbox').getByRole('option').count(),100);
 await combo.fill('Option 499'); assert.equal(await page.getByRole('listbox').getByRole('option').count(),1); await combo.press('ArrowDown');
 await page.evaluate(()=>window.uiControlsFixture.state('loading')); await combo.press('Enter'); assert.equal(await page.locator('[name=origin]').inputValue(),'0');
 assert.equal(await combo.getAttribute('aria-busy'),'true');
 await page.evaluate(()=>{window.uiControlsFixture.state(''); window.uiControlsFixture.value('499');});
 await combo.press('Escape'); assert.equal(await combo.inputValue(),'Option 499');
 await combo.click(); await page.evaluate(()=>window.uiControlsFixture.dispose()); assert.equal(await page.locator('.ui-popup').count(),0); assert.equal(await page.locator('[name=origin]').isVisible(),true);
 await page.evaluate(()=>{window.uiControlsFixture.reattach(); window.uiControlsFixture.abort();}); // old generation cannot dispose a new mount
 assert.equal(await page.locator('.ui-combobox').count(),2);
 await page.evaluate(()=>window.uiControlsFixture.dispose());
});
test('modal Escape closes a combo before its dialog and tabs share keyboard navigation', async t => {
 const page = await fixture(t); await page.getByRole('button',{name:'Open dialog',exact:true}).click();
 const combo=page.getByRole('combobox',{name:'Nested choice',exact:true}); await combo.click(); await combo.press('Escape');
 assert.equal(await page.getByRole('dialog').count(),1); await combo.press('Tab'); assert.equal(await page.getByRole('button',{name:'Close',exact:true}).evaluate(node=>node===document.activeElement),true);
 await page.keyboard.press('Tab'); assert.equal(await combo.evaluate(node=>node===document.activeElement),true); await combo.press('Escape');
 assert.equal(await page.getByRole('dialog').count(),0); assert.equal(await page.getByRole('button',{name:'Open dialog',exact:true}).evaluate(node=>node===document.activeElement),true);
 await page.getByRole('tab',{name:'First view',exact:true}).focus(); await page.keyboard.press('End');
 assert.equal(await page.getByRole('tab',{name:'Second view',exact:true}).getAttribute('aria-selected'),'true');
 await page.getByRole('button',{name:'Saving…',exact:true}).click(); assert.equal(await page.evaluate(()=>window.uiControlsFixture.pendingClicks),0);
});
test('SDK session disposal removes lent UI without erasing authored values', async t => {
 const page = await fixture(t); await page.getByLabel('Notes',{exact:true}).fill('Keep this value');
 await page.evaluate(async()=>{ const dispose = await window.uiControlsFixture.sdk(); const input=document.querySelector<HTMLInputElement>('[role=combobox]')!; input.click(); dispose(); });
 assert.equal(await page.locator('.ui-popup').count(),0); assert.equal(await page.locator('[name=notes]').inputValue(),'Keep this value');
});
for (const theme of ['classic','moonlit']) for (const locale of ['en','cs']) test('shared controls reflow and preserve edits: '+theme+' '+locale, async t => {
 const page=await fixture(t,320); await page.evaluate(({theme,locale})=>{window.uiControlsFixture.theme(theme); window.uiControlsFixture.locale(locale);},{theme,locale});
 await page.getByLabel('Notes',{exact:true}).fill('Unsaved text'); const combo=page.getByRole('combobox',{name:'Origin',exact:true}); await combo.fill('dwarf'); await combo.press('ArrowDown');
 const popup=await page.locator('.ui-popup:popover-open').boundingBox(); assert.ok(popup && popup.x>=0 && popup.x+popup.width<=320 && popup.y+popup.height<=900);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=320),true);
 await page.evaluate(()=>document.documentElement.style.fontSize='200%'); await combo.press('Escape'); assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),'Unsaved text');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=320),true);
 if (process.env.CODEX_UI_SCREENSHOTS === '1') { const directory=fileURLToPath(new URL('../../../docs/plans/',import.meta.url));await mkdir(directory,{recursive:true});await page.screenshot({path:directory+'ui-controls-'+theme+'-'+locale+'.png',fullPage:true}); }
});

test('option labels stay inert, duplicate labels keep distinct identities and composition never commits', async t => {
 const page=await fixture(t), combo=page.getByRole('combobox',{name:'Origin',exact:true});
 await page.evaluate(()=>{const select=document.querySelector<HTMLSelectElement>('[name=origin]')!;select.replaceChildren(new Option('Same','one'),new Option('Same','two'),new Option('<img src=x onerror=alert(1)>','markup'));window.uiControlsFixture.refresh();});
 await combo.click(); assert.equal(await page.getByRole('listbox').locator('img').count(),0); await combo.fill('Same'); assert.match(await page.getByRole('listbox').innerText(), /one[\s\S]*two/);
 await combo.press('ArrowDown'); await combo.press('ArrowDown'); await combo.press('Enter'); assert.equal(await page.locator('[name=origin]').inputValue(),'two');
 await combo.evaluate(node=>{const input=node as HTMLInputElement;input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='Same';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true}));});
 assert.equal(await page.locator('[name=origin]').inputValue(),'two'); assert.equal(await page.evaluate(()=>window.uiControlsFixture.changes),1);
 await combo.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))); await combo.press('Escape'); assert.equal(await combo.inputValue(),'Same');
});
test('theme changes, forced colors and abort keep focus and dispose popups', async t => {
 const page=await fixture(t), combo=page.getByRole('combobox',{name:'Origin',exact:true});
 await combo.fill('Dwarf'); await combo.press('ArrowDown'); await page.evaluate(()=>window.uiControlsFixture.theme('moonlit'));
 assert.equal(await combo.inputValue(),'Dwarf'); assert.equal(await combo.evaluate(node=>node===document.activeElement),true);
 await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
 assert.notEqual(await combo.evaluate(node=>getComputedStyle(node).outlineStyle),'none');
 await page.evaluate(()=>window.uiControlsFixture.abort()); assert.equal(await page.locator('.ui-popup').count(),0); assert.equal(await page.locator('[name=origin]').isVisible(),true);
});
test('semantic skin colors maintain readable fields, focus and primary actions', async t => {
 const page=await fixture(t);
 const contrast=(a:number[],b:number[])=>{const luminance=(rgb:number[])=>rgb.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((total,value,index)=>total+value*[.2126,.7152,.0722][index]!,0);const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 for(const theme of ['classic','moonlit']) for(const tone of ['','paper']) {
  const colors=await page.evaluate(({theme,tone})=>{
   window.uiControlsFixture.theme(theme);document.querySelector<HTMLElement>('#fixture')!.dataset['uiTone']=tone;
   const control=document.querySelector<HTMLElement>('[name=query]')!,button=document.querySelector<HTMLElement>('[data-ui-variant=primary]')!;
   const rgb=(value:string)=>value.match(/[\d.]+/g)!.slice(0,3).map(Number),c=getComputedStyle(control),b=getComputedStyle(button);
   return {text:rgb(c.color),field:rgb(c.backgroundColor),border:rgb(c.borderTopColor),buttonText:rgb(b.color),button:rgb(b.backgroundColor)};
  },{theme,tone});
  assert.ok(contrast(colors.text,colors.field)>=4.5,theme+' '+tone+' field text');assert.ok(contrast(colors.border,colors.field)>=3,theme+' '+tone+' boundary');assert.ok(contrast(colors.buttonText,colors.button)>=4.5,theme+' '+tone+' action text');
 }
});


test('live field replacement reconnects descriptions, validation and checkbox targets', async t => {
 const page=await fixture(t,390);
 await page.getByLabel('Notes',{exact:true}).evaluate(node=>{
  const replacement=document.createElement('input'); replacement.name='notes'; replacement.required=true;
  node.replaceWith(replacement);
 });
 const notes=page.getByLabel('Notes',{exact:true});
 await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[name=notes]')?.getAttribute('aria-describedby')!==null);
 assert.match(await notes.getAttribute('aria-describedby')??'',/codex-field-help-/);
 await notes.evaluate(node=>(node as HTMLInputElement).reportValidity());
 assert.equal(await notes.getAttribute('aria-invalid'),'true');
 await notes.fill('Replacement stays validated'); assert.equal(await notes.getAttribute('aria-invalid'),null);
 const label=page.getByRole('checkbox',{name:'One',exact:true}).locator('..'); assert.ok((await label.boundingBox())!.height>=44);
 await label.click(); assert.equal(await page.getByRole('checkbox',{name:'One',exact:true}).isChecked(),true);
 await page.evaluate(()=>window.uiControlsFixture.dispose());
 assert.equal(await page.locator('[name=notes]').getAttribute('aria-describedby'),null);
});

test('disabled active options and retired search enhancement cannot keep stale interaction', async t => {
 const page=await fixture(t),combo=page.getByRole('combobox',{name:'Origin',exact:true});
 await combo.fill('Dwarf'); await combo.press('ArrowDown');
 await page.evaluate(()=>{document.querySelector<HTMLOptionElement>('[name=origin] option[value=d]')!.disabled=true;});
 await page.waitForFunction(()=>document.querySelector('[role=combobox]')?.getAttribute('aria-activedescendant')===null);
 await combo.press('Enter'); assert.equal(await page.locator('[name=origin]').inputValue(),'');
 await combo.press('Escape');
 const search=page.getByRole('searchbox',{name:'Search records',exact:true}); await search.fill('settled');
 await search.evaluate(node=>node.removeAttribute('data-ui'));
 await page.getByRole('button',{name:'Clear search',exact:true}).waitFor({state:'detached'});
 await search.fill('native only'); assert.deepEqual(await page.evaluate(()=>window.uiControlsFixture.queries),['settled']);
});

test('search respects inherited disabled state and explicit programmatic reset', async t => {
 const page=await fixture(t,320),search=page.getByRole('searchbox',{name:'Search records',exact:true});
 await search.fill('first'); const clear=page.getByRole('button',{name:'Clear search',exact:true});
 const bounds=await clear.boundingBox(); assert.ok(bounds && bounds.width>=44 && bounds.x+bounds.width<=320);
 await page.evaluate(()=>{const input=document.querySelector<HTMLInputElement>('[name=query]')!;input.value='owner value';window.uiControlsFixture.refresh();});
 await search.fill('first'); assert.deepEqual(await page.evaluate(()=>window.uiControlsFixture.queries),['first','first']);
 await page.evaluate(()=>{const field=document.querySelector('[data-ui-key=search]')!,fieldset=document.createElement('fieldset');fieldset.disabled=true;field.before(fieldset);fieldset.append(field);});
 await page.waitForFunction(()=>document.querySelector<HTMLButtonElement>('.ui-search-clear')?.disabled===true);
 assert.equal(await clear.isDisabled(),true);
 await page.getByText('Origin',{exact:true}).click(); assert.equal(await page.getByRole('combobox',{name:'Origin',exact:true}).evaluate(node=>node===document.activeElement),true);
});
