import { describe, expect, it } from "vitest";
import { parseRuleDetails } from "../src/addons/rule-details.js";

describe("public rule details",()=>{
 it("detaches explanations and retains exact saved calculation inputs",()=>{
  const original={label:"Constitution",reference:{kind:"species",id:"synthetic"},explanation:{label:"Score",formula:"base + grant",value:17,terms:[{label:"DM given: reward",value:2,grantId:"reward"}],sources:[{kind:"species",id:"synthetic"}]}};
  const parsed=parseRuleDetails(original);original.explanation.value=99;
  expect(parsed.explanation?.value).toBe(17);expect(parsed.explanation?.terms[0]?.grantId).toBe("reward");
 });
 it("rejects malformed, cyclic and oversized payloads before crossing the isolated bridge",()=>{
  const cyclic:Record<string,unknown>={label:"Cycle"};cyclic["self"]=cyclic;
  for(const value of [null,{label:42},{label:"Rule",url:"javascript:bad"},{label:"Rule",reference:{kind:"feat",id:42}},{label:"Rule",explanation:{label:"X",formula:"X",terms:false,sources:[]}},{label:"Rule",summary:"x".repeat(60001)},cyclic])expect(()=>parseRuleDetails(value)).toThrow();
 });
});
