import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  github,
  packageFile,
  packFiles,
  publish,
} from "../.github/actions/publish-addon/publish.mts";

const repo = "example/addon",
  sha = "a".repeat(40),
  tag = `build-${sha}`;
const pkg = {
  name: "addon-1.0.0.zip",
  bytes: new Uint8Array([80, 75, 3, 4]),
  digest: "sha256:" + "b".repeat(64),
};
const asset = { name: pkg.name, digest: pkg.digest, state: "uploaded" };
const release = {
  id: 8,
  tag_name: tag,
  target_commitish: sha,
  draft: true,
  prerelease: false,
  assets: [] as unknown[],
};
function fixture(
  options: {
    existing?: unknown;
    latest?: unknown;
    order?: string;
    lineage?: string;
    tagSHA?: string;
    uploaded?: unknown;
  } = {},
) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let uploads = 0;
  const api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    calls.push({ path, method, body });
    if (path.endsWith(`compare/${sha}...main`)) return { status: options.lineage ?? "identical" };
    if (path.includes("/git/ref/"))
      return options.tagSHA ? { object: { sha: options.tagSHA } } : null;
    if (path.endsWith("/releases/tags/" + tag)) return options.existing ?? null;
    if (method === "POST") return release;
    if (path.endsWith("/releases/latest")) return options.latest ?? null;
    if (path.includes("/compare/")) return { status: options.order ?? "ahead" };
    if (method === "PATCH") return { ...release, draft: false, assets: [asset] };
    throw new Error("Unexpected API path: " + path);
  };
  const run = () =>
    publish({
      api,
      upload: async (id, name, bytes) => {
        uploads++;
        assert.equal(id, 8);
        assert.equal(name, pkg.name);
        assert.equal(bytes, pkg.bytes);
        return options.uploaded ?? asset;
      },
      repo,
      sha,
      runId: "42",
      package: pkg,
    });
  return { run, calls, uploads: () => uploads };
}

void test("publishes the inspected bytes under an exact commit tag, draft first", async () => {
  const f = fixture();
  assert.equal(await f.run(), `https://github.com/${repo}/releases/tag/${tag}`);
  const writes = f.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1]!.body, { draft: false, make_latest: "true" });
  const create = writes[0]!.body as Record<string, unknown>;
  assert.equal(create.tag_name, tag);
  assert.equal(create.target_commitish, sha);
  assert.equal(create.draft, true);
  assert.match(String(create.body), /1.0.0.*SHA-256/s);
  assert.equal(f.uploads(), 1);
});

void test("older tested commit remains downloadable without replacing latest", async () => {
  const f = fixture({ latest: { tag_name: "build-newer" }, order: "behind" });
  await f.run();
  assert.deepEqual(f.calls.at(-1)!.body, { draft: false, make_latest: "false" });
});

void test("same package version from a new commit publishes a new release", async () => {
  const f = fixture({ latest: { tag_name: "build-older" }, order: "ahead" });
  await f.run();
  assert.equal(f.uploads(), 1);
  assert.deepEqual(f.calls.at(-1)!.body, { draft: false, make_latest: "true" });
});

void test("rerun reuses matching published assets without overwriting or changing latest", async () => {
  const f = fixture({ existing: { ...release, draft: false, assets: [asset] }, tagSHA: sha });
  await f.run();
  assert.equal(f.uploads(), 0);
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
});

void test("interrupted draft resumes after verifying its already uploaded bytes", async () => {
  const f = fixture({ existing: { ...release, assets: [asset] } });
  await f.run();
  assert.equal(f.uploads(), 0);
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 1);
});

void test("wrong tag, non-main commit and different package bytes never publish", async () => {
  for (const options of [
    { tagSHA: "c".repeat(40) },
    { lineage: "diverged" },
    { existing: { ...release, assets: [{ ...asset, digest: "wrong" }] } },
    { existing: { ...release, draft: false } },
    { uploaded: { ...asset, digest: "wrong" } },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(
      f.calls.some((c) => c.method === "PATCH"),
      false,
    );
  }
});

void test("package input rejects loose files, multiple archives and invalid ZIPs", () => {
  const dir = mkdtempSync(join(tmpdir(), "addon-release-"));
  try {
    assert.throws(() => packageFile(dir));
    writeFileSync(join(dir, pkg.name), pkg.bytes);
    assert.equal(packageFile(dir).name, pkg.name);
    writeFileSync(join(dir, "second.zip"), pkg.bytes);
    assert.throws(() => packageFile(dir));
    rmSync(join(dir, "second.zip"));
    writeFileSync(join(dir, pkg.name), "not zip");
    assert.throws(() => packageFile(dir));
  } finally {
    for (const name of readdirSync(dir)) rmSync(join(dir, name));
    rmdirSync(dir);
  }
});

void test("GitHub transport uses fixed origins and does not blindly repeat writes", async () => {
  const requests: string[] = [];
  const client = github("fictional-token", async (url, options) => {
    requests.push(url instanceof Request ? url.url : String(url));
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer fictional-token");
    return new Response(null, { status: options?.method === "GET" ? 404 : 503 });
  });
  assert.equal(await client.api("/repos/example/addon/releases/latest"), null);
  await assert.rejects(client.upload(repo)(8, pkg.name, pkg.bytes), /503/);
  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.startsWith("https://uploads.github.com/repos/example/addon/"));
});

void test("language packs are published beside the package, package first", async () => {
  const pack = {
    name: "addon-1.0.0.cs.langpack.zip",
    bytes: new Uint8Array([80, 75, 5, 6]),
    digest: "sha256:" + "c".repeat(64),
  };
  const packAsset = { name: pack.name, digest: pack.digest, state: "uploaded" };
  const run = async (existing: unknown) => {
    const uploads: string[] = [];
    const writes: unknown[] = [];
    await publish({
      api: async (path, method = "GET", body) => {
        if (method !== "GET") writes.push(body);
        if (path.endsWith(`compare/${sha}...main`)) return { status: "identical" };
        if (path.includes("/git/ref/")) return existing === null ? null : { object: { sha } };
        if (path.endsWith("/releases/tags/" + tag)) return existing;
        if (method === "POST") return release;
        if (path.endsWith("/releases/latest")) return null;
        if (method === "PATCH") return { ...release, draft: false };
        throw new Error("Unexpected API path: " + path);
      },
      upload: async (_id, name) => {
        uploads.push(name);
        return name === pkg.name ? asset : packAsset;
      },
      repo,
      sha,
      runId: "42",
      package: pkg,
      packs: [pack],
    });
    return { uploads, writes };
  };
  const first = await run(null);
  assert.deepEqual(first.uploads, [pkg.name, pack.name]);
  assert.match(
    String((first.writes[0] as Record<string, unknown>)["body"]),
    /Language pack: addon-1\.0\.0\.cs\.langpack\.zip/,
  );
  // An interrupted draft uploads only the missing pack; a published release
  // reuses both and never gains or loses assets.
  assert.deepEqual((await run({ ...release, assets: [asset] })).uploads, [pack.name]);
  assert.deepEqual(
    (await run({ ...release, draft: false, assets: [asset, packAsset] })).uploads,
    [],
  );
  await assert.rejects(
    run({ ...release, draft: false, assets: [asset] }),
    /lacks a package or pack/,
  );
  await assert.rejects(
    run({ ...release, assets: [asset, { ...packAsset, digest: "wrong" }] }),
    /differs/,
  );
  await assert.rejects(
    run({ ...release, assets: [asset, { ...packAsset, name: "addon-1.0.0.de.langpack.zip" }] }),
    /unexpected assets/,
  );
});

void test("language pack input accepts only packs named after the package", () => {
  const dir = mkdtempSync(join(tmpdir(), "addon-packs-"));
  try {
    assert.deepEqual(packFiles(dir, pkg), []);
    writeFileSync(join(dir, "addon-1.0.0.pt-BR.langpack.zip"), pkg.bytes);
    assert.deepEqual(
      packFiles(dir, pkg).map((pack) => pack.name),
      ["addon-1.0.0.pt-BR.langpack.zip"],
    );
    for (const name of [
      "addon-1.0.0.en.langpack.zip",
      "other-1.0.0.cs.langpack.zip",
      "addon-1.0.0.cs.zip",
      "addon-1.0.0.CS.langpack.zip",
    ]) {
      writeFileSync(join(dir, name), pkg.bytes);
      assert.throws(() => packFiles(dir, pkg));
      rmSync(join(dir, name));
    }
    writeFileSync(join(dir, "addon-1.0.0.pt-BR.langpack.zip"), "not zip");
    assert.throws(() => packFiles(dir, pkg));
  } finally {
    for (const name of readdirSync(dir)) rmSync(join(dir, name));
    rmdirSync(dir);
  }
});
