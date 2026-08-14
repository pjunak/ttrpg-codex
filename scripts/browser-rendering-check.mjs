#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';

const BROWSER_TYPES = Object.freeze({ chromium, firefox });

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function parseArgs(argv) {
  const options = { root: '.', fixture: '', browser: 'chromium' };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== '--root' && name !== '--fixture' && name !== '--browser') {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    options[name.slice(2)] = value;
    index += 1;
  }
  if (!options.fixture) throw new Error('--fixture is required');
  if (options.browser !== 'all' && !BROWSER_TYPES[options.browser]) {
    throw new Error('--browser must be chromium, firefox, or all');
  }
  return options;
}

async function createStaticServer(root) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
      const requested = resolve(root, ...segments);
      if (!isContained(root, requested) || !(await stat(requested)).isFile()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      const body = await readFile(requested);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': MIME_TYPES.get(extname(requested).toLowerCase()) || 'application/octet-stream',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return server;
}

function serverPort(server) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server has no TCP port');
  return address.port;
}

function fixtureUrl(root, fixture, port) {
  const relativeFixture = relative(root, fixture).split(sep)
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `http://127.0.0.1:${port}/${relativeFixture}`;
}

function closeServer(server) {
  return new Promise((accept, reject) => {
    server.close(error => (error ? reject(error) : accept()));
  });
}

export async function runBrowserRenderingCheck({ root = '.', fixture, browser: browserName = 'chromium' }) {
  const absoluteRoot = resolve(root);
  const absoluteFixture = resolve(absoluteRoot, fixture);
  if (!isContained(absoluteRoot, absoluteFixture)) {
    throw new Error(`Fixture must stay inside the served root: ${fixture}`);
  }
  if (!(await stat(absoluteFixture)).isFile()) throw new Error(`Fixture is not a file: ${fixture}`);

  const server = await createStaticServer(absoluteRoot);
  const failures = [];
  try {
    const url = fixtureUrl(absoluteRoot, absoluteFixture, serverPort(server));
    const browserNames = browserName === 'all' ? Object.keys(BROWSER_TYPES) : [browserName];
    for (const currentBrowserName of browserNames) {
      const launchedBrowser = await BROWSER_TYPES[currentBrowserName].launch({ headless: true });
      try {
        for (const deviceScaleFactor of [1, 2]) {
          const context = await launchedBrowser.newContext({
            deviceScaleFactor,
            locale: 'en-US',
            viewport: { width: 1280, height: 900 },
          });
          try {
            const page = await context.newPage();
            const pageErrors = [];
            page.on('console', message => {
              if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
            });
            page.on('pageerror', error => pageErrors.push(`page: ${error.message}`));
            await page.goto(url, { waitUntil: 'networkidle' });
            await page.waitForFunction(() => typeof globalThis.runRenderingContract === 'function');
            const result = await page.evaluate(async scale => {
              await globalThis.document.fonts?.ready;
              return globalThis.runRenderingContract({ deviceScaleFactor: scale });
            }, deviceScaleFactor);
            const prefix = `${currentBrowserName} DPR ${deviceScaleFactor}`;
            if (!result || !Array.isArray(result.checks) || result.checks.length === 0) {
              failures.push(`${prefix}: fixture returned no checks`);
              continue;
            }
            const name = result.name || relative(absoluteRoot, absoluteFixture);
            const failedChecks = result.checks.filter(check => check?.pass !== true);
            for (const check of failedChecks) {
              failures.push(
                `${prefix} ${check?.name || 'unnamed check'}: `
                + `expected ${JSON.stringify(check?.expected)}, got ${JSON.stringify(check?.actual)}`,
              );
            }
            failures.push(...pageErrors.map(error => `${prefix} ${error}`));
            const passed = result.checks.length - failedChecks.length;
            console.log(`${name} ${prefix}: ${passed}/${result.checks.length} checks passed`);
          } finally {
            await context.close();
          }
        }
      } finally {
        await launchedBrowser.close();
      }
    }
  } finally {
    await closeServer(server);
  }
  if (failures.length) throw new Error(`Browser rendering contract failed:\n- ${failures.join('\n- ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserRenderingCheck(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
