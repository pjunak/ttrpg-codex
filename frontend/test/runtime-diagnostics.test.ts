import { describe, expect, it } from "vitest";
import { BrowserDiagnostics } from "../src/addons/browser-diagnostics.js";
import { HostRequestError } from "../src/core/api.js";
import { parseWorkerDiagnostics } from "../src/core/worker-diagnostics.js";

describe("administrative diagnostics", () => {
 it("bounds browser failures, omits raw content and clears at authority loss", () => {
  const store = new BrowserDiagnostics(); let changes = 0; const dispose = store.subscribe(() => changes++);
  store.record("activation", new Error("secret")); expect(store.list()).toEqual([]);
  store.enable(true);
  for (let i=0;i<40;i++) store.record("activation", { addonId:"example-addon", generationId:"a".repeat(64), cause:new HostRequestError(503,"secret","private campaign") });
  const entries=store.list();expect(entries).toHaveLength(32);expect(entries[0]?.code).toBe("UNAVAILABLE");
  expect(JSON.stringify(entries)).not.toMatch(/secret|private campaign/);
  store.enable(false);expect(store.list()).toEqual([]);expect(changes).toBe(41);
  dispose();store.enable(false);expect(changes).toBe(41);
 });
 it("rejects malformed or oversized worker histories before rendering", () => {
  expect(parseWorkerDiagnostics(undefined)).toBeUndefined();
  expect(parseWorkerDiagnostics({state:"ready",pid:3,requests:[]})).toMatchObject({pid:3,requests:[]});
  for(const value of [{pid:-1},{requests:Array(33).fill({})},{health:{status:"invented",at:"now"}},{requests:[{method:"call",outcome:"OK",requestRef:"raw-token",milliseconds:1,at:new Date().toISOString()}]}]){
   expect(()=>parseWorkerDiagnostics(value)).toThrow();
  }
 });
});
