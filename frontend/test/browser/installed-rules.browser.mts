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
import { jsonResponse, installReviewedPackage, zip, enableAllRuleSources } from './installed-graph-fixture.mts';

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
    data: { contractVersion: 'addon-service-connect.v1', contract: 'dnd5e.rules-engine', range: '^4.0.0', cardinality: 'one' } }));
  assert.equal(connection.providers.length, 1, JSON.stringify(connection));
  const target = connection.providers[0];
  return (await jsonResponse(await admin.post(`${base}/call`, { headers, data: {
    contractVersion: 'addon-service-call.v1', contract: 'dnd5e.rules-engine', providerAddonId: target.addonId,
    providerVersion: target.contractVersion, providerGeneration: target.generation, bindingRevision: target.bindingRevision,
    method, params, deadlineMs: 30000,
  } }))).result;
}
function inputs(classId = 'wizard', level = 5) {
  return { build: { method: 'array', baseScores: { STR: 15, DEX: 13, CON: 14, INT: 12, WIS: 10, CHA: 8 }, rolls: [], species: 'dwarf', lineage: '', background: 'soldier', levels: Array.from({length:level},(_,i)=>({id:`level-${i+1}`,classId})), subclasses: {}, choices: [], spells: { cantrips: {}, spellbook: {}, grantChoices: {}, castingAbilities: {}, swaps: [], acquisitions: [] } }, play: { hp:0, temporaryHp:0, inventory:[], currency:{}, resourceUses:{}, activeFeatures:{}, preparedSpells:{}, rolls:[], asOf:'2026-09-11T00:00:00Z' }, grants:[], notes:'' };
}
const evaluate = (value = inputs()) => call('evaluate-character', { contractVersion: 'rules-character.v1', inputs: value });

test('installed engine reports missing rules and never invents a validated character', { skip: !enabled }, async () => {
  const context = await call('context', {}); assert.equal(context.available, false); assert.equal(context.status, 'missing');
  await assert.rejects(() => evaluate());
});

test('installed sources evaluate every class with bounded projections and explicit incomplete choices', { skip: !enabled }, async () => {
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', compendium, []);
  await enableAllRuleSources(admin, csrf);
  const context = await call('context', {}); assert.equal(context.available, true, JSON.stringify(context));
  const classes = await call('query-records', { contractVersion: 'rules-engine-query.v1', kind: 'class', limit: 200 });
  assert.ok(classes.records.length >= 12);
  for (const record of classes.records) for (const level of [1,5,20]) {
    const result = await evaluate(inputs(record.id,level)), evaluation = result.evaluation;
    assert.equal(result.identity.providerGeneration, context.identity.providerGeneration);
    assert.ok(evaluation.sheet.derived.maxHp > 0, record.id); assert.equal(evaluation.sheet.totalLevel, level);
    assert.ok(evaluation.sheet.resources.some((resource: Record<string, unknown>) => resource.kind === 'hitdice'), record.id);
    assert.equal(evaluation.ready, false, 'incomplete build was silently accepted');
    assert.ok(evaluation.issues.some((issue: {severity:string})=>issue.severity==='blocker'));
    const snapshot = { inputs:evaluation.inputs, projection:{sheet:evaluation.sheet,explanations:evaluation.explanations,evidence:evaluation.evidence,issues:evaluation.issues}, rules:result.identity };
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 250000, `${record.id} level ${level} snapshot exceeds storage limit`);
  }
  const result = await evaluate(); assert.equal(result.evaluation.sheet.derived.maxHp, 37); assert.deepEqual(result.evaluation.sheet.spellcasting.slots, [4,3,2]);
  assert.ok(result.evaluation.plan.creationAbilityChoices.some((choice:{id:string})=>choice.id==='bgasi'));
});

test('installed engine refreshes changed content and recovers after provider loss', { skip: !enabled }, async () => {
  const before = await evaluate();
  await installReviewedPackage(admin, csrf, 'dnd-2024-compendium', changedCompendium(compendium), []);
  const changed = await evaluate();
  assert.notEqual(changed.identity.providerGeneration, before.identity.providerGeneration);
  assert.notEqual(changed.identity.contentRevision, before.identity.contentRevision);
  assert.equal(changed.evaluation.sheet.derived.maxHp,49);
  for (const id of ['dnd-sheets','dnd-engine','dnd-2024-compendium']) {
    const state = await jsonResponse(await admin.get(`/api/admin/addons/${id}`));
    await jsonResponse(await admin.post(`/api/admin/addons/${id}/disable`, {headers:{'X-Codex-CSRF':csrf},data:{expectedStateRevision:state.state.revision}}));
  }
  await installReviewedPackage(admin,csrf,'dnd-engine',engine,[]);
  await installReviewedPackage(admin,csrf,'dnd-sheets',sheets,[]);
  assert.equal((await call('context',{})).available,false); await assert.rejects(()=>evaluate());
  await installReviewedPackage(admin,csrf,'dnd-2024-compendium',compendium,[]);
  assert.deepEqual(await evaluate(),before);
});
function unpack(archive: Buffer): Record<string, string | Buffer> {
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
  return files;
}

function changedCompendium(archive: Buffer) {
  const files = unpack(archive);
  const manifest = JSON.parse(files['addon.json'].toString()); manifest.version = '3.0.1'; manifest.content[0].revision = 'installed-rules-fixture-2'; files['addon.json'] = JSON.stringify(manifest);
  const recordPath = 'data/phb/classes/wizard.json', record = JSON.parse(files[recordPath].toString()); assert.equal(record.hitDie, 'd6');
  record.hitDie = 'd10'; files[recordPath] = JSON.stringify(record);
  delete files['checksums.json']; files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files);
}

test('installed engine combines compatible source packages and respects per-book policy', { skip: !enabled }, async () => {
  const files = unpack(compendium), original = JSON.parse(files['addon.json'].toString());
  for (const name of Object.keys(files)) if (!name.startsWith('contracts/')) delete files[name];
  const manifest = { packageFormat: 1, id: 'extra-rule-books', name: 'Extra rule books', version: '1.0.0', compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, rules: { supports: ['dnd-2014', 'dnd-2024'] }, capabilities: { required: [], optional: [] }, permissions: [], services: original.services, content: original.content };
  manifest.content[0].revision = 'extra-1';
  files['addon.json'] = JSON.stringify(manifest);
  for (const suffix of ['one', 'two']) {
    files[`data/book-${suffix}.json`] = JSON.stringify({ kind: 'book', id: `extra-${suffix}`, name: `Extra ${suffix}` });
    files[`data/spell-${suffix}.json`] = JSON.stringify({ kind: 'spell', id: `extra-spell-${suffix}`, name: `Extra spell ${suffix}`, book: `extra-${suffix}`, level: 0, school: 'Evocation' });
  }
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  const before = await call('context', {});
  await installReviewedPackage(admin, csrf, 'extra-rule-books', zip(files), []);
  const pending = await call('context', {});
  assert.equal(pending.available, true); assert.notEqual(pending.identity.contentRevision, before.identity.contentRevision);
  let policy = await jsonResponse(await admin.get('/api/admin/rules-policy'));
  assert.equal(policy.ruleset.id, 'dnd-2024');
  assert.equal(policy.sources.filter((source: { addonId: string; pending: boolean; enabled: boolean }) => source.addonId === 'extra-rule-books' && source.pending && !source.enabled).length, 2);
  const choose = async (include: boolean) => {
    policy = await jsonResponse(await admin.get('/api/admin/rules-policy'));
    await jsonResponse(await admin.post('/api/admin/rules-policy', { headers: { 'X-Codex-CSRF': csrf }, data: {
      expectedRevision: policy.revision, expectedGraphRevision: policy.graphRevision,
      enabled: policy.sources.filter((source: { addonId: string; id: string; enabled: boolean }) => source.addonId === 'extra-rule-books' ? include && source.id === 'extra-one' : source.enabled).map(({ addonId, setId, id }: { addonId: string; setId: string; id: string }) => ({ addonId, setId, id })),
    } }));
  };
  await choose(true);
  const record = await call('get-record', { contractVersion: 'rules-engine-get.v1', kind: 'spell', id: 'extra-spell-one' });
  assert.equal(record.record.providerAddonId, 'extra-rule-books');
  assert.equal(record.identity.providerAddonId, 'dnd-2024-compendium');
  await assert.rejects(() => call('get-record', { contractVersion: 'rules-engine-get.v1', kind: 'spell', id: 'extra-spell-two' }));
  await choose(false);
  const disabled = await call('context', {}); assert.equal(disabled.available, true); assert.notEqual(disabled.identity.contentRevision, record.identity.contentRevision);
  await assert.rejects(() => call('get-record', { contractVersion: 'rules-engine-get.v1', kind: 'spell', id: 'extra-spell-one' }));
});
