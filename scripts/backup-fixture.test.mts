import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import test from "node:test";
import { writeBackupEntry } from "../frontend/test/browser/backup-fixture.mts";

function archive(body: Buffer, method = 8, size = body.length, checksum = crc32(body)) {
  const name = Buffer.from("codex.db"), payload = method === 8 ? deflateRawSync(body) : body;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
  const directory = local.length + name.length + payload.length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(directory, 16);
  return Buffer.concat([local, name, payload, central, name, end]);
}

async function destination(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "codex-backup-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "codex.db");
}

test("installed backup inspection streams a database larger than 64 MiB exactly", async t => {
  const body = Buffer.alloc(65 * 1024 * 1024, 0x37), path = await destination(t);
  await writeBackupEntry(archive(body), "codex.db", path);
  assert.equal((await stat(path)).size, body.length);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest("hex"), createHash("sha256").update(body).digest("hex"));
});

test("stored and compressed entries preserve bytes and refuse existing destinations", async t => {
  for (const method of [0, 8]) {
    const path = await destination(t), body = Buffer.from("portable database fixture");
    await writeBackupEntry(archive(body, method), "codex.db", path);
    assert.deepEqual(await readFile(path), body);
    await assert.rejects(writeBackupEntry(archive(Buffer.from("replacement"), method), "codex.db", path), /EEXIST/);
    assert.deepEqual(await readFile(path), body);
  }
});

test("inspection enforces declared sizes, the host bound and checksums on every method", async t => {
  for (const method of [0, 8]) for (const variant of ["short", "long", "bound", "checksum"]) {
    const body = Buffer.from("bounded database fixture"), path = await destination(t);
    const size = variant === "short" ? 1 : variant === "long" ? body.length + 1 : variant === "bound" ? 1024 ** 3 + 1 : body.length;
    await assert.rejects(writeBackupEntry(archive(body, method, size, variant === "checksum" ? 0 : crc32(body)), "codex.db", path),
      /declared size|size mismatch|host file bound|checksum mismatch/);
    await assert.rejects(stat(path), /ENOENT/);
  }
});

test("missing and truncated entries fail without creating output", async t => {
  const path = await destination(t), input = archive(Buffer.from("fixture"));
  await assert.rejects(writeBackupEntry(input, "absent.db", path), /Missing backup entry/);
  await assert.rejects(writeBackupEntry(input.subarray(0, input.length - 1), "codex.db", path), /Missing ZIP directory/);
  await assert.rejects(stat(path), /ENOENT/);
});
