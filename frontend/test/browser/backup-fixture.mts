import assert from "node:assert/strict";
import { open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";

// Match the host's per-file/archive bound (internal/backuparchive/types.go).
// Database entries grow with the full installed suite; stream their expanded
// bytes instead of imposing an unrelated in-memory buffer limit.
const maximumBytes = 1024 * 1024 * 1024;

export async function writeBackupEntry(archive: Buffer, wanted: string, destination: string): Promise<void> {
  assert.ok(archive.length <= maximumBytes, "Backup exceeds the host archive bound");
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0 && end + 22 <= archive.length, "Missing ZIP directory");
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.ok(cursor + 46 <= end, "Truncated ZIP directory");
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const nameSize = archive.readUInt16LE(cursor + 28), extra = archive.readUInt16LE(cursor + 30), comment = archive.readUInt16LE(cursor + 32);
    assert.ok(cursor + 46 + nameSize + extra + comment <= end, "Truncated ZIP entry");
    const name = archive.subarray(cursor + 46, cursor + 46 + nameSize).toString();
    if (name === wanted) {
      const local = archive.readUInt32LE(cursor + 42), method = archive.readUInt16LE(cursor + 10);
      const compressed = archive.readUInt32LE(cursor + 20), expanded = archive.readUInt32LE(cursor + 24);
      assert.ok(expanded <= maximumBytes, "Backup entry exceeds the host file bound");
      assert.ok(local + 30 <= cursor && archive.readUInt32LE(local) === 0x04034b50, "Invalid local ZIP header");
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      assert.ok(start + compressed <= cursor, "Truncated ZIP data");
      assert.ok(method === 0 || method === 8, "Unsupported ZIP compression");
      assert.equal(archive.readUInt16LE(cursor + 8) & 1, 0, "Encrypted ZIP entry");
      const expectedCRC = archive.readUInt32LE(cursor + 16);
      let bytes = 0, checksum = 0;
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, next) {
        bytes += chunk.length;
        if (bytes > expanded) return next(new Error("Expanded backup entry exceeds its declared size"));
        checksum = crc32(chunk, checksum);
        next(null, chunk);
      } });
      const file = await open(destination, "wx");
      try {
        const input = Readable.from([archive.subarray(start, start + compressed)]);
        const output = file.createWriteStream();
        if (method === 8) await pipeline(input, createInflateRaw(), bounded, output);
        else await pipeline(input, bounded, output);
        assert.equal(bytes, expanded, "Expanded backup entry size mismatch");
        assert.equal(checksum, expectedCRC, "Backup entry checksum mismatch");
      } catch (error) {
        await file.close();
        await rm(destination, { force: true });
        throw error;
      }
      return;
    }
    cursor += 46 + nameSize + extra + comment;
  }
  throw new Error("Missing backup entry: " + wanted);
}
