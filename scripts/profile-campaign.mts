import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { get as getHTTP } from "node:http";
import { gunzipSync } from "node:zlib";
import { cpus } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, request, type APIResponse } from "playwright";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const output=resolve(root,"frontend/test-results/performance");
const label=process.argv[2]??"current";
assert.match(label,/^[a-z][a-z0-9-]{0,39}$/);
const samples=Number(process.argv[3]??3);assert.ok(Number.isInteger(samples)&&samples>=1&&samples<=10);
const counts={characters:1800,locations:400,events:200,relationships:900};
const json=async(response:APIResponse)=>{assert.ok(response.ok(),`${response.status()} ${await response.text()}`);return response.json() as Promise<Record<string,unknown>>};
await mkdir(output,{recursive:true});
const directory=await mkdtemp(resolve(output,"host-"));
let host:ChildProcess|undefined,hostOutput="";
const browser=await chromium.launch({headless:true});
const results:unknown[]=[];
const wirePayloads: {name:string; identityBytes:number; encodedBytes:number; contentEncoding:string}[]=[];
async function readWire(url:string, cookie:string, encoding:string) {
 return new Promise<{body:Buffer;encoding:string}>((resolveWire,reject)=>{
  const outgoing=getHTTP(url,{headers:{"Cookie":cookie,"Accept-Encoding":encoding}},incoming=>{
   const chunks:Buffer[]=[];incoming.on("data",(chunk:Buffer)=>chunks.push(chunk));incoming.on("error",reject);
   incoming.on("end",()=>{
    if(incoming.statusCode!==200)reject(new Error("Wire probe failed: "+incoming.statusCode));
    else resolveWire({body:Buffer.concat(chunks),encoding:String(incoming.headers["content-encoding"]??"identity")});
   });
  });
  outgoing.setTimeout(10_000,()=>outgoing.destroy(new Error("Wire probe timed out")));outgoing.on("error",reject);
 });
}
const git=async(args:string[])=>(await promisify(execFile)("git",args,{cwd:root,windowsHide:true})).stdout.trim();
const digest=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
const buildAssets:Record<string,string>={};
for(const name of (await readdir(resolve(root,"frontend/dist/assets"))).sort()) {
 buildAssets[name]=digest(await readFile(resolve(root,"frontend/dist/assets",name)));
}
const provenance={hostRevision:await git(["rev-parse","HEAD"]),hostDirty:!!(await git(["status","--porcelain"])),trackedPatchSha256:digest(await git(["diff","HEAD","--binary"])),harnessSha256:digest(await readFile(fileURLToPath(import.meta.url))),buildAssets};
try {
 const binary=resolve(directory,process.platform==="win32"?"codex.exe":"codex");
 await promisify(execFile)("go",["build","-o",binary,"./cmd/codex"],{cwd:root,windowsHide:true,timeout:120_000});
 const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=(probe.address() as AddressInfo).port;await new Promise<void>(done=>probe.close(()=>done()));
 const origin=`http://127.0.0.1:${port}`;
 host=spawn(binary,["-listen",`127.0.0.1:${port}`,"-data-dir",resolve(directory,"data"),"-web-dir",resolve(root,"frontend/dist")],{cwd:root,windowsHide:true,env:{...process.env,CODEX_DM_PASSWORD:"local-performance-dm",CODEX_PLAYER_PASSWORD:"local-performance-player"},stdio:["ignore","pipe","pipe"]});
 host.stdout?.on("data",chunk=>{hostOutput+=chunk});host.stderr?.on("data",chunk=>{hostOutput+=chunk});
 const admin=await request.newContext({baseURL:origin});
 try {
 let ready=false;
 for(let attempt=0;attempt<100;attempt++){try{if((await admin.get("/api/health")).ok()){ready=true;break}}catch{/* Startup. */}if(host.exitCode!==null)break;await sleep(100)}
 assert.ok(ready,hostOutput);
 const auth=await json(await admin.post("/api/login",{data:{password:"local-performance-dm"}})), headers={"X-Codex-CSRF":String(auth["csrfToken"])};
 const mutations:{operation:string;collection:string;key:string;expectedRevision:number;value:Record<string,unknown>}[]=[];
 const prose="A synthetic campaign entry for repeatable performance measurement. Routes, witnesses and local history connect the archived scenes. ".repeat(4);
 for(let index=0;index<counts.characters;index++){
  const id=`person-${index}`;mutations.push({operation:"put",collection:"characters",key:id,expectedRevision:0,value:{id,name:`Person ${String(index).padStart(4,"0")}`,description:prose,title:"Campaign witness",visibility:index%10===0?"dm":"public",knowledge:4,tags:["synthetic",`region-${index%20}`]}})
 }
 for(let index=0;index<counts.locations;index++){
  const id=`place-${index}`;mutations.push({operation:"put",collection:"locations",key:id,expectedRevision:0,value:{id,name:`Place ${index}`,description:prose,visibility:"public",knowledge:4,x:(index%20)/19,y:Math.floor(index/20)/19,pinType:"town"}})
 }
 for(let index=0;index<counts.events;index++){
  const id=`event-${index}`;mutations.push({operation:"put",collection:"events",key:id,expectedRevision:0,value:{id,name:`Session event ${index}`,short:prose,sitting:Math.floor(index/4),order:index%4,visibility:"public"}})
 }
 for(let index=0;index<counts.relationships;index++){
  const value={source:`person-${index}`,target:`person-${index+1}`,type:"ally",label:"Known companion",visibility:"public"};
  const key="relationship:"+Buffer.from(JSON.stringify([value.source,value.target,value.type])).toString("base64url");
  mutations.push({operation:"put",collection:"relationships",key,expectedRevision:0,value})
 }
 for(let index=0;index<mutations.length;index+=100)await json(await admin.post("/api/campaign/transactions",{headers,data:{contractVersion:"campaign-mutation.v1",mutations:mutations.slice(index,index+100)}}));
 const paint=await browser.newPage();
 const map=await paint.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=1600;canvas.height=1000;const ctx=canvas.getContext("2d")!;ctx.fillStyle="#648894";ctx.fillRect(0,0,1600,1000);return canvas.toDataURL("image/png").split(",")[1]!});
 await paint.close();
 await json(await admin.post("/api/media/world-map/main",{headers:{...headers,"Content-Type":"image/png","X-Codex-Filename":"synthetic.png"},data:Buffer.from(map,"base64")}));
 const cookie=(await admin.storageState()).cookies.map(item=>item.name+"="+item.value).join("; ");
 for(const name of ["/api/campaign",...Object.keys(buildAssets).filter(name=>/\.(js|css)$/.test(name)).map(name=>"/assets/"+name)]) {
  const identity=await readWire(origin+name,cookie,"identity");
  const encoded=await readWire(origin+name,cookie,"gzip");
  assert.deepEqual(encoded.encoding==="gzip"?gunzipSync(encoded.body):encoded.body,identity.body,"Wire encoding changed "+name);
  wirePayloads.push({name,identityBytes:identity.body.length,encodedBytes:encoded.body.length,contentEncoding:encoded.encoding});
 }
 const apiSamples:number[]=[];
 for(let index=0;index<3;index++){const started=performance.now();await json(await admin.get("/api/campaign"));apiSamples.push(Math.round(performance.now()-started))}
 for(const profile of [{name:"desktop",width:1440,height:1000,cpu:1,latency:0,download:-1},{name:"phone",width:390,height:844,cpu:4,latency:150,download:1_600_000/8}]){
  for(let sample=0;sample<samples;sample++){
   const context=await browser.newContext({baseURL:origin,viewport:{width:profile.width,height:profile.height},isMobile:profile.name==="phone",hasTouch:profile.name==="phone",locale:"en-US",reducedMotion:"reduce"});
   try {
    await json(await context.request.post("/api/login",{data:{password:"local-performance-dm"}}));
    await context.addInitScript(()=>{localStorage.setItem("codex_lang","en")});
    const page=await context.newPage();page.setDefaultTimeout(120_000);
    const cdp=await context.newCDPSession(page);
    await cdp.send("Network.enable");await cdp.send("Network.clearBrowserCache");
    await cdp.send("Emulation.setCPUThrottlingRate",{rate:profile.cpu});
    if(profile.download>0)await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:profile.latency,downloadThroughput:profile.download,uploadThroughput:750_000/8});
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    const nextPaint=async()=>page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
    const measure=async(action:()=>Promise<unknown>,ready:()=>Promise<unknown>)=>{const started=performance.now();await action();await ready();await nextPaint();return Math.round(performance.now()-started)};
    const campaignResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/campaign");
    const cold=await measure(()=>page.goto("/#/"),()=>page.locator(".session-section").waitFor());
    const campaignHeaders=(await campaignResponse).headers();
    const browserEncoding={contentEncoding:campaignHeaders["content-encoding"]??"identity",overNetwork:campaignHeaders["x-content-encoding-over-network"]??null};
    if(browserEncoding.overNetwork)console.warn("Browser delivery timing is affected by local decompression:",browserEncoding.overNetwork);
    const resources=await page.evaluate(()=>performance.getEntriesByType("resource").map(entry=>{const resource=entry as PerformanceResourceTiming;return {name:new URL(resource.name).pathname,transfer:resource.transferSize,encoded:resource.encodedBodySize,decoded:resource.decodedBodySize,duration:Math.round(resource.duration)}}));
    const warm=await measure(()=>page.reload(),()=>page.locator(".session-section").waitFor());
    await page.goto("/#/search");const search=page.locator("#campaign-query");await search.waitFor();
    const searchMs=await measure(()=>search.fill("Person 1799"),()=>page.locator('.search-result strong').filter({hasText:"Person 1799"}).waitFor());
    const article=await measure(()=>page.locator('.search-result').filter({hasText:"Person 1799"}).click(),()=>page.locator("#record-title").filter({hasText:"Person 1799"}).waitFor());
    const mapLoad=await measure(()=>page.goto("/#/map/world"),()=>page.locator('.sc-marker[title="Place 210"]').waitFor());
    const zoom=await measure(async()=>{for(let index=0;index<2;index++)await page.getByRole("button",{name:"Zoom in",exact:true}).click()},async()=>{});
    console.log(JSON.stringify({profile:profile.name,sample:sample+1,cold,warm,search:searchMs,article,mapLoad,zoom}));
    const selection=await measure(()=>page.locator('.sc-marker[title="Place 210"]').click(),()=>page.getByRole("complementary",{name:"Map location",exact:true}).waitFor());
    const viewport=page.locator(".leaflet-container");const box=await viewport.boundingBox();assert.ok(box);
    const pan=await measure(async()=>{await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+65,box.y+box.height/2+35,{steps:5});await page.mouse.up()},async()=>{});
    assert.deepEqual(errors,[]);
    const row={profile:profile.name,sample:sample+1,cold,warm,search:searchMs,article,mapLoad,zoom,selection,pan,browserEncoding,resources};
    results.push(row);console.log(JSON.stringify({...row,resources:undefined}));
   }finally{await context.close()}
  }
 }
 const report={label,date:new Date().toISOString(),...provenance,browser:browser.version(),node:process.version,cpu:cpus()[0]?.model,counts,samples,apiSamples,wirePayloads,profiles:{desktop:"1440x1000, CPU 1x, unthrottled localhost",phone:"390x844 touch emulation, CPU 4x slowdown, 150 ms latency, 1.6 Mbps down / 750 kbps up"},results};
 await writeFile(resolve(output,`${label}.json`),JSON.stringify(report,null,2)+"\n");console.log(`Saved frontend/test-results/performance/${label}.json`);
 }finally{await admin.dispose()}
}finally{
 await browser.close();
 if(host&&host.exitCode===null){const closed=once(host,"close");host.kill();await closed}
 const child=relative(output,directory);assert.ok(child&&!child.startsWith("..")&&!isAbsolute(child));
 await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
