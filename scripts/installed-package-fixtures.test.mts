import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importPackageFiles, replacementImportPackage } from '../frontend/test/browser/installed-import-fixture.mts';

// Written independently with Go archive/zip, Deflate and FileHeader.SetMode.
// Distinct Linux modes catch flattening as well as losing the executable bit.
const archive = Buffer.from(
  'UEsDBBQACAAIAAAAAAAAAAAAAAAAAAAAAAAKAAAAYWRkb24uanNvbgAjANz/eyJpZCI6ImRtLXRvb2xzIiwidmVyc2lvbiI6IjMuMC4wIn0D' +
  'AFBLBwhsQAlzKgAAACMAAABQSwMEFAAIAAgAAAAAAAAAAAAAAAAAAAAAABsAAAB3b3JrZXIvbGludXgtYW1kNjQvZG0tdG9vbHMAHADj/3Vu' +
  'Y2hhbmdlZCBhbWQ2NCB3b3JrZXIgYnl0ZXMDAFBLBwgLKSRDIwAAABwAAABQSwMEFAAIAAgAAAAAAAAAAAAAAAAAAAAAABsAAAB3b3JrZXIv' +
  'bGludXgtYXJtNjQvZG0tdG9vbHMAHADj/3VuY2hhbmdlZCBhcm02NCB3b3JrZXIgYnl0ZXMDAFBLBwh9jYxPIwAAABwAAABQSwMEFAAIAAgA' +
  'AAAAAAAAAAAAAAAAAAAAACEAAAB3b3JrZXIvd2luZG93cy1hbWQ2NC9kbS10b29scy5leGUAHgDh/3VuY2hhbmdlZCB3aW5kb3dzIHdvcmtl' +
  'ciBieXRlcwMAUEsHCG4BGAQlAAAAHgAAAFBLAwQUAAgACAAAAAAAAAAAAAAAAAAAAAAADAAAAHdlYi9pbmRleC5qcwAcAOP/ZXhwb3J0IGNv' +
  'bnN0IGZpeHR1cmUgPSB0cnVlOwMAUEsHCFzM594jAAAAHAAAAFBLAwQUAAgACAAAAAAAAAAAAAAAAAAAAAAADgAAAGNoZWNrc3Vtcy5qc29u' +
  'AAIA/f97fQMAUEsHCEO/pqMJAAAAAgAAAFBLAQIUAxQACAAIAAAAAABsQAlzKgAAACMAAAAKAAAAAAAAAAAAAACkgQAAAABhZGRvbi5qc29u' +
  'UEsBAhQDFAAIAAgAAAAAAAspJEMjAAAAHAAAABsAAAAAAAAAAAAAAO2BYgAAAHdvcmtlci9saW51eC1hbWQ2NC9kbS10b29sc1BLAQIUAxQA' +
  'CAAIAAAAAAB9jYxPIwAAABwAAAAbAAAAAAAAAAAAAADogc4AAAB3b3JrZXIvbGludXgtYXJtNjQvZG0tdG9vbHNQSwECFAMUAAgACAAAAAAA' +
  'bgEYBCUAAAAeAAAAIQAAAAAAAAAAAAAApIE6AQAAd29ya2VyL3dpbmRvd3MtYW1kNjQvZG0tdG9vbHMuZXhlUEsBAhQDFAAIAAgAAAAAAFzM' +
  '594jAAAAHAAAAAwAAAAAAAAAAAAAAKSBrgEAAHdlYi9pbmRleC5qc1BLAQIUAxQACAAIAAAAAABDv6ajCQAAAAIAAAAOAAAAAAAAAAAAAACk' +
  'gQsCAABjaGVja3N1bXMuanNvblBLBQYAAAAABgAGAI8BAABQAgAAAAA=',
  'base64',
);

function unixMode(archive: Buffer, path: string): number {
  const header = archive.lastIndexOf(Buffer.from(path)) - 46;
  assert.equal(archive.readUInt32LE(header), 0x02014b50, path + ': central directory entry');
  assert.equal(archive[header + 5], 3, path + ': Unix creator');
  return (archive.readUInt32LE(header + 38) >>> 16) & 0o777;
}

test('replacement packages preserve Linux worker execute bits and ordinary file modes on every platform', () => {
  const replacement = replacementImportPackage(archive);
  for (const [path, mode] of [
    ['addon.json', 0o644],
    ['worker/linux-amd64/dm-tools', 0o755],
    ['worker/linux-arm64/dm-tools', 0o750],
    ['worker/windows-amd64/dm-tools.exe', 0o644],
    ['web/index.js', 0o644],
    ['checksums.json', 0o644],
  ] as const) {
    assert.equal(unixMode(archive, path), mode);
    assert.equal(unixMode(replacement, path), mode, path);
  }
});

test('replacement packages change only the manifest version and matching checksums', () => {
  const original = importPackageFiles(archive), files = importPackageFiles(replacementImportPackage(archive));
  assert.deepEqual(Object.keys(files).sort(), Object.keys(original).sort());
  assert.deepEqual(JSON.parse(files['addon.json']!.toString()), { id: 'dm-tools', version: '3.0.1' });
  const checksums = JSON.parse(files['checksums.json']!.toString());
  assert.equal(checksums.algorithm, 'sha256');
  assert.deepEqual(Object.keys(checksums.files).sort(), Object.keys(files).filter(path => path !== 'checksums.json').sort());
  for (const [path, body] of Object.entries(files)) {
    if (path !== 'addon.json' && path !== 'checksums.json') assert.deepEqual(body, original[path], path);
    if (path !== 'checksums.json') assert.equal(checksums.files[path], createHash('sha256').update(body).digest('hex'), path);
  }
});
