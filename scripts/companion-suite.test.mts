import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { companionInputs, requireNoSkips, verifyPackages, type SuiteEvidence } from "./companion-suite.mts";

function sample(t: test.TestContext) {
 const directory=mkdtempSync(join(tmpdir(),"companion-proof-"));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const evidence:SuiteEvidence={contractVersion:"companion-suite.v1",hostCommit:"a".repeat(40),hostDirty:false,packages:[]};
 for(const id of Object.keys(companionInputs) as (keyof typeof companionInputs)[]) {
  const bytes=Buffer.from("synthetic ZIP "+id),file=id+".zip";writeFileSync(join(directory,file),bytes);
  evidence.packages.push({id,version:"1.0.0",file,sourceCommit:"b".repeat(40),sourceDirty:false,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
 }
 return {directory,evidence};
}
test("publication supplies every exact inspected ZIP and refuses partial coverage",t=>{
 const {directory,evidence}=sample(t),environment=verifyPackages(evidence,directory,true);
 assert.deepEqual(Object.keys(environment).sort(),Object.values(companionInputs).sort());
 evidence.packages.pop();
 assert.throws(()=>verifyPackages(evidence,directory,true),/every companion ZIP/);
 assert.equal(Object.keys(verifyPackages(evidence,directory,false)).length,3);
});
test("changed, duplicate and escaped artifact paths cannot replace an inspected package",t=>{
 const {directory,evidence}=sample(t),first=evidence.packages[0]!;
 writeFileSync(join(directory,first.file),"replacement");
 assert.throws(()=>verifyPackages(evidence,directory,true),/changed after inspection/);
 first.file="../outside.zip";
 assert.throws(()=>verifyPackages(evidence,directory,true),/Invalid companion/);
 const second=sample(t);second.evidence.packages.push(second.evidence.packages[0]!);
 assert.throws(()=>verifyPackages(second.evidence,second.directory,true),/Duplicate/);
});
test("missing or skipped installed acceptance cannot pass publication",()=>{
 requireNoSkips("TAP version 13\n# tests 23\n# skipped 0\n");
 for(const text of ["", "# skipped 1\n", "# skipped 0\n# skipped 2\n"]){assert.throws(()=>requireNoSkips(text),/zero skipped/);}
});
