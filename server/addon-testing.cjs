'use strict';
// ═══════════════════════════════════════════════════════════════
//  ADDON TESTING — server-side Tier-B green-gate runner (Phase 8).
//
//  Runs an addon's declared SERVER self-tests (`tests.server`) with
//  `node --test` against the STAGED (.incoming) tree BEFORE the install is
//  promoted — so a red test set means the new version is never activated (the
//  existing stage→atomic-rename pipeline makes "revert" free: just don't
//  rename). Running addon tests is executing addon code, so it stays inside the
//  DM-only / allowlisted / SHA-pinned trust envelope and is time-capped.
//
//  `spawn` is INJECTED (like the broker injects `fetch`) so this is unit-
//  testable without coupling to child_process; server.js passes the real one.
//
//  NB: the staged tree has no node_modules — server self-tests must be self-
//  contained (Node built-ins `node:test`/`node:assert` + the addon's own files
//  via relative require). Tests needing the host harness are CLIENT tests, run
//  in the browser at staged activation (the wizard, Phase 9).
// ═══════════════════════════════════════════════════════════════

const MAX_OUTPUT = 200_000;   // keep the tail of noisy output, bounded

/**
 * Spawn `node --test <paths>` in `cwd`, capped by `timeoutMs`.
 *
 * @param {string} cwd                working dir (the staged .incoming tree)
 * @param {string[]} paths           absolute test file/dir paths
 * @param {object} deps              `{ spawn, timeoutMs?, execPath? }`
 * @returns {Promise<{ok, code, signal, timedOut, output}>}
 */
function runNodeTests(cwd, paths, { spawn, timeoutMs = 30_000, execPath, env } = {}) {
  return new Promise((resolve) => {
    if (typeof spawn !== 'function') {
      return resolve({ ok: false, code: null, signal: null, timedOut: false, output: 'no spawn provided' });
    }
    if (!Array.isArray(paths) || !paths.length) {
      return resolve({ ok: true, code: 0, signal: null, timedOut: false, output: 'no test files' });
    }
    const node = execPath || process.execPath;
    // Spawn a CLEAN test run. node:test sets NODE_TEST_CONTEXT in the env of
    // its own subprocesses; if we (or the server) are ever invoked from within
    // a `node --test` run, a nested `node --test` would inherit that and run in
    // a degraded mode that skips AWAITING async tests (silently passing them).
    // Stripping it guarantees the gate actually runs the addon's tests.
    const childEnv = { ...(env || process.env) };
    delete childEnv.NODE_TEST_CONTEXT;
    let out = '';
    let timedOut = false;
    let child;
    try {
      // --test-isolation=none runs the files in THIS spawned process (no per-
      // file worker subprocess). That keeps the timeout kill fully effective —
      // SIGKILL ends the actual test instead of orphaning a worker that lingers
      // (and, on Windows, holds the staged files open).
      child = spawn(node, ['--test', '--test-isolation=none', ...paths],
        { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, code: null, signal: null, timedOut: false, output: 'spawn failed: ' + e.message });
    }
    const append = (d) => { out += d.toString(); if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT); };
    if (child.stdout) child.stdout.on('data', append);
    if (child.stderr) child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, timedOut, output: out + '\n' + e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, signal, timedOut, output: out });
    });
  });
}

module.exports = { runNodeTests, MAX_OUTPUT };
