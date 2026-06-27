'use strict';

// Spawn the real server as a child process with an isolated tempdir
// so integration tests exercise the entire express stack — auth
// middleware, role parsing, visibility filter, migrations — exactly
// as it runs in production.
//
// Each call to startServer() returns a handle with:
//   { baseUrl, fetch, dataDir, snapshotsDir, kill, port }
//
// The helper picks a free port via net.createServer + close, so
// concurrent test files don't collide.

const { spawn } = require('child_process');
const fs        = require('fs');
const fsp       = fs.promises;
const os        = require('os');
const path      = require('path');
const net       = require('net');

const ROOT = path.resolve(__dirname, '..', '..');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForReady(baseUrl, timeoutMs = 8000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/version`);
      if (res.ok) return true;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`Server did not become ready at ${baseUrl} within ${timeoutMs}ms: ${lastErr?.message || 'unknown'}`);
}

/**
 * Start a fresh server in a child process with an isolated tempdir.
 *
 * @param {object} [opts]
 * @param {string} [opts.dmPassword='dm-pass']         - DM_PASSWORD env
 * @param {string} [opts.playerPassword='player-pass'] - PLAYER_PASSWORD env (empty = disabled)
 * @param {Object<string,string>} [opts.env]           - additional env overrides
 * @param {Object<string, any>}   [opts.seedData]      - { 'characters.json': [...], ... } seeded into the data dir before boot
 * @returns {Promise<{baseUrl: string, port: number, dataDir: string, snapshotsDir: string, kill: () => Promise<void>, fetch: typeof fetch}>}
 */
async function startServer(opts = {}) {
  const dmPwd     = opts.dmPassword     ?? 'dm-pass';
  const playerPwd = opts.playerPassword ?? 'player-pass';

  const dataDir      = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-data-'));
  const snapshotsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-snaps-'));

  // Seed any pre-existing collections before boot so the migration
  // sees realistic state.
  if (opts.seedData) {
    for (const [filename, content] of Object.entries(opts.seedData)) {
      await fsp.writeFile(path.join(dataDir, filename), JSON.stringify(content, null, 2), 'utf8');
    }
  }
  // Seed arbitrary nested files (relative paths under the data dir) before
  // boot — e.g. addon code at addons/<id>/<hash>/server/index.cjs. String
  // values are written verbatim (code); objects are JSON-stringified.
  if (opts.seedFiles) {
    for (const [rel, content] of Object.entries(opts.seedFiles)) {
      const p = path.join(dataDir, rel);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    }
  }

  const port = await pickFreePort();

  const env = {
    ...process.env,
    PORT:                  String(port),
    DM_PASSWORD:           dmPwd,
    PLAYER_PASSWORD:       playerPwd,
    CODEX_DATA_DIR:        dataDir,
    CODEX_SNAPSHOTS_DIR:   snapshotsDir,
    NODE_ENV:              'test',
    ...(opts.env || {}),
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Capture stderr so test failures can surface real errors.
  let stderrBuf = '';
  child.stderr.on('data', d => { stderrBuf += d.toString(); });
  // Drain stdout so the buffer doesn't fill up and block the child.
  child.stdout.on('data', () => {});

  const baseUrl = `http://127.0.0.1:${port}`;

  child.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) {
      // Surface unexpected exits — most likely a startup crash.
      // eslint-disable-next-line no-console
      console.error(`[server-process] exited code=${code} sig=${sig}\n${stderrBuf}`);
    }
  });

  try {
    await waitForReady(baseUrl);
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (_) {}
    throw new Error(`${e.message}\nstderr: ${stderrBuf}`);
  }

  // A small fetch wrapper that defaults credentials and threads
  // cookies so test code doesn't have to manage a CookieJar.
  let cookieJar = '';
  const wrappedFetch = async (urlPath, init = {}) => {
    const url     = urlPath.startsWith('http') ? urlPath : (baseUrl + urlPath);
    const headers = { ...(init.headers || {}) };
    if (cookieJar) headers.cookie = cookieJar;
    const res = await fetch(url, { ...init, headers });
    // Update jar from any Set-Cookie headers — in undici/Node fetch,
    // multiple Set-Cookie values are joined; getSetCookie() preserves
    // each as a separate string.
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(';')[0];
      // Replace if same key already present, else append.
      const key = pair.split('=')[0];
      const parts = cookieJar ? cookieJar.split('; ').filter(p => p.split('=')[0] !== key) : [];
      parts.push(pair);
      cookieJar = parts.join('; ');
    }
    return res;
  };

  return {
    baseUrl,
    port,
    dataDir,
    snapshotsDir,
    fetch: wrappedFetch,
    /** Reset the in-memory cookie jar (effectively "logout client-side"). */
    clearCookies: () => { cookieJar = ''; },
    /** Read the current cookie jar — handy for asserting cookie format. */
    cookieValue:  () => cookieJar,
    kill: async () => {
      const exited = new Promise(r => child.once('exit', r));
      try { child.kill('SIGTERM'); } catch (_) {}
      // Hard kill after 2 s in case SIGTERM is ignored.
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
      await exited;
      clearTimeout(timer);
      // Best-effort cleanup of the temp dirs. fsp.rm with force/retry
      // because Windows occasionally holds onto recently-closed file
      // handles for a few ms after the child exits.
      try { await fsp.rm(dataDir,      { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
      try { await fsp.rm(snapshotsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
    },
  };
}

module.exports = { startServer, pickFreePort };
