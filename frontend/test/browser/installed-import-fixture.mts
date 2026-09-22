import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { zip } from './installed-graph-fixture.mts';

// Repackage a locally built test archive with a new manifest version; never
// extract it or alter its worker binaries. The real inspector reviews the ZIP.
export function replacementImportPackage(archive: Buffer, version = "3.0.1") {
  const { files, modes } = importPackageEntries(archive);
  const manifest = JSON.parse(files['addon.json'].toString()); manifest.version = version;
  files['addon.json'] = JSON.stringify(manifest); delete files['checksums.json'];
  files['checksums.json'] = JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) });
  return zip(files, modes);
}

export function importPackageFiles(archive: Buffer) {
  return importPackageEntries(archive).files;
}

function importPackageEntries(archive: Buffer) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const count = archive.readUInt16LE(end + 10), files: Record<string, string | Buffer> = Object.create(null);
  const modes: Record<string, number> = Object.create(null);
  let cursor = archive.readUInt32LE(end + 16), expanded = 0;
  assert.ok(count < 1000);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10), compressed = archive.readUInt32LE(cursor + 20);
    const nameSize = archive.readUInt16LE(cursor + 28), extra = archive.readUInt16LE(cursor + 30), comment = archive.readUInt16LE(cursor + 32);
    const local = archive.readUInt32LE(cursor + 42), name = archive.subarray(cursor + 46, cursor + 46 + nameSize).toString();
    assert.equal(archive.readUInt32LE(local), 0x04034b50); assert.ok(method === 0 || method === 8);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const compressedBody = archive.subarray(start, start + compressed);
    const body = method === 8 ? inflateRawSync(compressedBody, { maxOutputLength: 32 * 1024 * 1024 }) : compressedBody;
    expanded += body.length; assert.ok(expanded < 64 * 1024 * 1024);
    // ZIP attributes use Unix permission bits only when the creator is Unix.
    if (archive[cursor + 5] === 3) modes[name] = (archive.readUInt32LE(cursor + 38) >>> 16) & 0o777;
    files[name] = body; cursor += 46 + nameSize + extra + comment;
  }
  return { files, modes };
}

export function planningImport(items: unknown[], generatedAt = 1000, mode = 'merge') {
  return { format: 'dm-tools-planning', schemaVersion: 3, generatedAt, mode, items, flowLinks: [], references: [], consequences: [], notes: [] };
}
export function importQuest(id: string, title = id) {
  return { operation: 'create', id, schemaVersion: 3, kind: 'quest', parentId: null, title, summary: '', body: '', objective: '', setup: '', resolution: '', tags: [] };
}
