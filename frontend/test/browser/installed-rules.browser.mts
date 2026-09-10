import { required } from './fixture-types.mts';
import type { APIRequestContext } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { request as playwrightRequest } from 'playwright';
import { jsonResponse, installReviewedPackage, zip } from './installed-graph-fixture.mts';

const paths = [process.env.CODEX_ENGINE_ZIP, process.env.CODEX_SHEETS_ZIP, process.env.CODEX_COMPENDIUM_ZIP];
const enabled = paths.every(Boolean);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'frontend/test-results/installed-rules');
let directory: string, host: ChildProcessByStdio<null, Readable, Readable>, admin: APIRequestContext, csrf: string, base: string, engine: Buffer, sheets: Buffer, compendium: Buffer, hostOutput = '';
before(async () => {
  if (!enabled) return;
  [engine, sheets, compendium] = await Promise.all(paths.map(path => readFile(resolve(required(path)))));
  await mkdir(output, { recursive: true }); directory = await mkdtemp(resolve(output, 'host-'));
  const binary = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/codex'], { cwd: root, windowsHide: true, timeout: 120_000 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve));
  host = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-data-dir', resolve(directory, 'data'), '-web-dir', resolve(root, 'frontend/dist')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_DM_PASSWORD: 'local-rules-dm', CODEX_PLAYER_PASSWORD: 'local-rules-player' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', chunk => { hostOutput += chunk; }); host.stderr.on('data', chunk => { hostOutput += chunk; });
  admin = await playwrightRequest.newContext({ baseURL: `http://127.0.0.1:${port}` }); let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await admin.get('/api/health')).ok()) { ready = true; break; } } catch { /* Startup. */ }
    if (host.exitCode !== null) break; await sleep(100);
  }
  assert.ok(ready, hostOutput);
  csrf = (await jsonResponse(await admin.post('/api/login', { data: { password: 'local-rules-dm' } }))).csrfToken;
  await installReviewedPackage(admin, csrf, 'dnd-engine', engine, []);
  await installReviewedPackage(admin, csrf, 'dnd-sheets', sheets, []);
  const state = await jsonResponse(await admin.get('/api/admin/addons/dnd-sheets'));
  base = `/api/addons/dnd-sheets/generations/${state.state.activeGenerationId}/services`;
});
after(async () => {
  await admin?.dispose();
  if (host && host.exitCode === null) { const closed = once(host, 'close'); host.kill(); await closed; }
  if (directory) {
    const child = relative(output, directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function call(method: string, params: unknown) {
  const headers = { 'X-Codex-CSRF': csrf };
  const connection = await jsonResponse(await admin.post(`${base}/connect`, { headers,
    data: { contractVersion: 'addon-service-connect.v1', contract: 'dnd5e.rules-engine', range: '^3.0.0', cardinality: 'one' } }));
  assert.equal(connection.providers.length, 1, JSON.stringify(connection));
  const target = connection.providers[0];
  return (await jsonResponse(await admin.post(`${base}/call`, { headers, data: {
    contractVersion: 'addon-service-call.v1', contract: 'dnd5e.rules-engine', providerAddonId: target.addonId,
    providerVersion: target.contractVersion, providerGeneration: target.generation, bindingRevision: target.bindingRevision,
    method, params, deadlineMs: ['hydrate', 'builder-plan', 'apply-builder-choice', 'reconcile-builder-decisions'].includes(method) ? 15_000 : 3000,
  } }))).result;
}
const wizard = { abilities: { INT: 16, CON: 14 }, classes: [{ classId: 'wizard', level: 5 }] };
const hydrate = (decisions: Record<string, unknown>) => call('hydrate', { contractVersion: 'rules-engine-hydrate.v1', decisions });
const plan = (decisions: Record<string, unknown>) => call('builder-plan', { contractVersion: 'rules-engine-builder-plan.v1', decisions });

test('installed rules engine keeps Sheets usable before a rules provider is installed', { skip: !enabled }, async () => {
  const context = await call('context', {}); assert.equal(context.available, false); assert.equal(context.status, 'missing');
  const result = await hydrate(wizard); assert.equal(result.sheet.derived.proficiencyBonus, 3);
  assert.ok(result.warnings.length > 0); assert.equal(result.identity, undefined);
  assert.equal((await plan(wizard)).available, false);
  const applied = await call('apply-builder-choice', { contractVersion: 'rules-engine-builder-change.v1', decisions: wizard, change: { choiceId: 'unknown', value: 'keep' } });
  assert.equal(applied.available, false); assert.deepEqual(applied.decisions, wizard);
});

test('installed Compendium drives complete class hydration and Builder through Sheets', { skip: !enabled }, async () => {
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', compendium, []);
  const context = await call('context', {}); assert.equal(context.available, true, JSON.stringify(context));
  const classes = await call('query-records', { contractVersion: 'rules-engine-query.v1', kind: 'class', limit: 200 });
  assert.ok(classes.records.length >= 12);
  for (const record of classes.records) {
    const decisions = { abilities: { STR: 16, DEX: 14, CON: 14, INT: 16, WIS: 14, CHA: 16 }, classes: [{ classId: record.id, level: 5 }] };
    const result = await hydrate(decisions);
    assert.equal(result.identity?.providerGeneration, context.identity.providerGeneration, `${record.id}: ${JSON.stringify(result.warnings)}`);
    assert.ok(result.sheet.derived.maxHp > 0, record.id); assert.equal(result.sheet.totalLevel, 5);
    assert.ok(result.sheet.resources.some((resource: Record<string, unknown>) => resource.kind === 'hitdice'), record.id);
    assert.equal((await plan(decisions)).available, true, record.id);
  }
  const result = await hydrate(wizard); assert.equal(result.sheet.derived.maxHp, 32); assert.deepEqual(result.sheet.spellcasting.slots, [4, 3, 2]);
  const decisions = { background: 'Acolyte', classes: [{ classId: 'fighter', level: 4 }] };
  const options = await plan(decisions); assert.ok(options.plan.creationAbilityChoices.some((choice: { id: string }) => choice.id === 'bgasi'));
  const applied = await call('apply-builder-choice', { contractVersion: 'rules-engine-builder-change.v1', decisions, change: { choiceId: 'bgasi', value: { ability: 'INT', amount: 2 } } });
  assert.equal(applied.available, true); assert.equal(applied.decisions.abilityGrants.find((grant: { id: string }) => grant.id === 'bgasi').assign.INT, 2);
  const reconciled = await call('reconcile-builder-decisions', { contractVersion: 'rules-engine-builder-reconcile.v1', decisions: applied.decisions });
  assert.equal(reconciled.available, true); assert.deepEqual(reconciled.decisions, applied.decisions);
});

test('installed engine refreshes changed Compendium content and recovers after provider loss', { skip: !enabled }, async () => {
  const before = await hydrate(wizard);
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', changedCompendium(compendium), []);
  const changed = await hydrate(wizard);
  assert.ok(changed.identity, JSON.stringify(changed.warnings));
  assert.notEqual(changed.identity.providerGeneration, before.identity.providerGeneration);
  assert.notEqual(changed.identity.contentRevision, before.identity.contentRevision);
  assert.equal(changed.sheet.derived.maxHp, 44); // The disposable provider changed the wizard hit die to d10.
  // The operator stops consumers before providers; no live-update choreography is required.
  for (const id of ['dnd-sheets', 'dnd-engine', 'dnd-2024-compendium']) {
    const state = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
    await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, { headers: { 'X-Codex-CSRF': csrf }, data: { expectedStateRevision: state.state.revision } }));
  }
  await installReviewedPackage(admin, csrf, 'dnd-engine', engine, []);
  await installReviewedPackage(admin, csrf, 'dnd-sheets', sheets, []);
  assert.equal((await call('context', {})).available, false);
  assert.equal((await hydrate(wizard)).identity, undefined); assert.equal((await plan(wizard)).available, false);
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', compendium, []);
  const restored = await hydrate(wizard);
  assert.deepEqual(restored, before);
});

function changedCompendium(archive: Buffer) {
  const end = archive.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])), files: Record<string, string | Buffer> = Object.create(null); assert.ok(end >= 0);
  const count = archive.readUInt16LE(end + 10); assert.ok(count < 10000); let cursor = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10), compressed = archive.readUInt32LE(cursor + 20), nameSize = archive.readUInt16LE(cursor + 28);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameSize).toString(), local = archive.readUInt32LE(cursor + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28), body = archive.subarray(start, start + compressed);
    assert.ok(method === 0 || method === 8); if (!name.endsWith('/')) files[name] = method === 8 ? inflateRawSync(body, { maxOutputLength: 32 * 1024 * 1024 }) : body;
    cursor += 46 + nameSize + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  const manifest = JSON.parse(files['addon.json'].toString()); manifest.version = '3.0.1'; manifest.content[0].revision = 'installed-rules-fixture-2'; files['addon.json'] = JSON.stringify(manifest);
  const recordPath = 'data/phb/classes/wizard.json', record = JSON.parse(files[recordPath].toString()); assert.equal(record.hitDie, 'd6');
  record.hitDie = 'd10'; files[recordPath] = JSON.stringify(record);
  delete files['checksums.json']; files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files);
}
