'use strict';
// Unit tests for the server-side addon test runner (Phase 8 green-gate).
// Uses the real child_process.spawn against throwaway temp dirs.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fsp      = require('fs').promises;
const os       = require('os');
const path     = require('path');
const { spawn } = require('child_process');
const { runNodeTests } = require('../server/addon-testing.cjs');

async function tmp(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'addon-runner-'));
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}
// Best-effort cleanup: a just-SIGKILLed node can momentarily hold handles on
// Windows, so retry and never fail the test on a stray EBUSY.
async function cleanup(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); } catch (_) {}
}
const PASS = `const {test}=require('node:test');const a=require('node:assert');test('p',()=>a.equal(1,1));`;
const FAIL = `const {test}=require('node:test');const a=require('node:assert');test('f',()=>a.equal(1,2));`;
const SLOW = `const {test}=require('node:test');test('s',async()=>{await new Promise(r=>setTimeout(r,8000));});`;

test('green for a passing test file', async () => {
  const dir = await tmp({ 'a.test.cjs': PASS });
  try {
    const r = await runNodeTests(dir, [path.join(dir, 'a.test.cjs')], { spawn, timeoutMs: 20000 });
    assert.equal(r.ok, true, r.output);
    assert.equal(r.code, 0);
  } finally { await cleanup(dir); }
});

test('red for a failing test file (non-zero exit)', async () => {
  const dir = await tmp({ 'a.test.cjs': FAIL });
  try {
    const r = await runNodeTests(dir, [path.join(dir, 'a.test.cjs')], { spawn, timeoutMs: 20000 });
    assert.equal(r.ok, false);
    assert.notEqual(r.code, 0);
  } finally { await cleanup(dir); }
});

test('timeout → not ok, timedOut flagged', async () => {
  const dir = await tmp({ 'a.test.cjs': SLOW });
  try {
    const r = await runNodeTests(dir, [path.join(dir, 'a.test.cjs')], { spawn, timeoutMs: 1500 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
  } finally { await cleanup(dir); }
});

test('no test files → ok (nothing to gate)', async () => {
  const r = await runNodeTests(process.cwd(), [], { spawn });
  assert.equal(r.ok, true);
});

test('missing spawn → not ok (never throws)', async () => {
  const r = await runNodeTests(process.cwd(), ['x'], {});
  assert.equal(r.ok, false);
});
