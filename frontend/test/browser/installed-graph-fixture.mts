import type { APIRequestContext, APIResponse } from 'playwright';
import type { FixturePermission } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

// Small deterministic stored ZIPs exercise the real inspector without a package build dependency.
export function zip(files: Record<string, string | Buffer>, modes: Readonly<Record<string, number>> = {}) {
  const local = [], central = []; let offset = 0;
  for (const [path, source] of Object.entries(files)) {
    const name = Buffer.from(path), body = Buffer.from(source), checksum = crc32(body);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    // Unix creator + regular-file permissions retain native worker execute bits.
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(((0o100000 | ((modes[path] ?? 0o644) & 0o777)) << 16) >>> 0, 38);
    entry.writeUInt16LE(33, 14); entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function graphPackage({ id, mode, version = '1.0.0', label = 'Trail note', invalid = false, delay = 0 }: {
  id: string; mode: string; version?: string; label?: string; invalid?: boolean; delay?: number;
}) {
  const declaration = (id: string, surface: string, label: string, config: Record<string, unknown>, roles = ['dm', 'player']) => ({ id, surface, label, config, roles, requires: ['ui.contributions'] });
  const manifest = { packageFormat: 1, id, name: 'Graph test', version,
    compatibility: { host: '^2.0.0', addonApi: '^3.0.0' }, capabilities: { required: ['ui.contributions'], optional: [] },
    permissions: [{ id: 'core.data.read', resources: ['characters'], reason: 'Link clues to visible characters.' }], runtime: { ui: { mode, entry: 'web/index.js' } }, contributions: [
      declaration('notes', 'graph-contributor', 'Trail clues', { contractVersion: 1, view: 'relationships' }),
      declaration('board', 'graph-view', 'Trail board', { contractVersion: 1 }, ['dm']),
      declaration('detail', 'route', 'Trail notes', { path: 'notes' }),
    ] };
  const entry = `export function activate(context) {
    for (const declaration of context.ui.declarations()) {
      if (declaration.surface === 'route') {
        if (!customElements.get('test-trail-note')) customElements.define('test-trail-note', class extends HTMLElement {
          connectedCallback() { this.textContent = 'Reviewed package detail'; }
        });
        context.ui.bind(declaration.id, { kind: 'element', tag: 'test-trail-note' });
      } else context.ui.bind(declaration.id, { kind: 'model-provider', async provide(request, invocation) {
        if (${delay}) await new Promise(resolve => setTimeout(resolve, ${delay}));
        const captain = request.coreNodes.find(node => node.key === 'captain');
        return { contractVersion: 1, nodes: [{ id: 'note', label: ${JSON.stringify(label)}, summary: 'Follow the northern road.',
          color: '#987442', position: { x: 300, y: 0 }, detail: { route: 'detail' } }],
          edges: ${invalid} ? [{ id: 'bad', source: { node: 'note' }, target: { core: 'missing' }, type: 'Clue', label: '' }] :
            captain ? [{ id: 'link', source: { node: 'note' }, target: { core: captain.id }, type: 'Clue', label: 'Found by' }] : [] };
      } });
    }
  }`;
  const files: Record<string, string | Buffer> = { 'addon.json': JSON.stringify(manifest), 'web/index.js': entry };
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files)
    .map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')])) });
  return zip(files);
}

export async function jsonResponse(response: Pick<APIResponse, 'text' | 'ok' | 'status'>) {
  const body = await response.text();
  assert.equal(response.ok(), true, `${response.status()} ${body}`);
  return JSON.parse(body);
}

export async function installGraphPackage(request: APIRequestContext, csrf: string, options: Parameters<typeof graphPackage>[0]) {
  return installReviewedPackage(request, csrf, options.id, graphPackage(options), [{ id: 'core.data.read', resources: ['characters'], reason: 'Link clues to visible characters.' }]);
}

export async function installReviewedPackage(request: APIRequestContext, csrf: string, id: string, archive: Buffer, permissions: FixturePermission[]) {
  const headers = { 'X-Codex-CSRF': csrf };
  const staged = await jsonResponse(await request.post('/api/admin/addons/generations', {
    headers: { ...headers, 'Content-Type': 'application/zip' }, data: archive,
  }));
  const review = await jsonResponse(await request.post(`/api/admin/addons/${id}/activation-reviews`, { headers, data: { generationId: staged.generationId } }));
  assert.deepEqual(review.proposal.blockers, []);
  assert.deepEqual(review.proposal.targetManifest.permissions, permissions);
  const approved = await jsonResponse(await request.post(`/api/admin/addon-activation-reviews/${review.reviewId}/approval`, { headers, data: { grantedPermissionIds: permissions.map(permission => permission.id) } }));
  assert.equal(approved.proposalSha256, review.proposalSha256);
  return jsonResponse(await request.post(`/api/admin/addon-activation-reviews/${review.reviewId}/activation`, { headers }));
}

// Browse/rules conformance fixtures explicitly opt into their full content corpus.
// Installation itself keeps the production default of pending optional books.
export async function enableAllRuleSources(request: APIRequestContext, csrf: string): Promise<void> {
  const policy = await jsonResponse(await request.get('/api/admin/rules-policy'));
  await jsonResponse(await request.post('/api/admin/rules-policy', { headers: { 'X-Codex-CSRF': csrf }, data: {
    expectedRevision: policy.revision, expectedGraphRevision: policy.graphRevision,
    enabled: policy.sources.map(({ addonId, setId, id }: { addonId: string; setId: string; id: string }) => ({ addonId, setId, id })),
  } }));
}
