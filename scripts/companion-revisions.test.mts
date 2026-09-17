import assert from "node:assert/strict";
import test from "node:test";
import { companionRepositories, parseRevisions, resolvePublishedRevisions, verifyRevisions } from "./companion-revisions.mts";

function sample() {
  return parseRevisions({ contractVersion: "companion-revisions.v1", companions:
    Object.entries(companionRepositories).map(([id, repository], index) => ({ id, repository, revision: String(index + 1).repeat(40) })) });
}

test("pins require all known repositories, unique IDs and immutable full commits", () => {
  const valid = sample();
  assert.deepEqual(parseRevisions(JSON.parse(JSON.stringify(valid))), valid);
  for (const revision of ["main", "abc123", "a".repeat(40) + "\n"]) {
    const changed = sample(); changed.companions[0]!.revision = revision;
    assert.throws(() => parseRevisions(changed), /full commit SHAs/);
  }
  const missing = sample(); missing.companions.pop();
  assert.throws(() => parseRevisions(missing), /all four/);
  const duplicate = sample(); duplicate.companions[1] = duplicate.companions[0]!;
  assert.throws(() => parseRevisions(duplicate), /unique/);
  const redirected = sample(); redirected.companions[0]!.repository = "someone/another-repo";
  assert.throws(() => parseRevisions(redirected), /known repositories/);
});

test("local sources and inspected provenance must match the same pinned source set", () => {
  const pins = sample(), sources = pins.companions.map(pin => ({ id: pin.id, sourceCommit: pin.revision }));
  verifyRevisions(sources, pins, "full");
  verifyRevisions(sources.slice(0, 3), pins, "public");
  assert.throws(() => verifyRevisions(sources.slice(0, 3), pins, "full"), /Missing source.*compendium/);
  sources[1]!.sourceCommit = "e".repeat(40);
  assert.throws(() => verifyRevisions(sources, pins, "full"), /addon-dnd-engine: expected 2{40}, found e{40}/);
  assert.throws(() => verifyRevisions([...sources, sources[0]!], pins, "full"), /duplicate companion source/);
});

test("remote availability checks exact pinned commits and uses the private credential only for private content", async () => {
  const pins = sample(), seen: string[] = [];
  const output = await resolvePublishedRevisions(pins, "full", { public: "public-token", private: "private-token" }, async (url, init) => {
    const pin = pins.companions.find(item => url.endsWith(item.revision))!;
    assert.equal(url, "https://api.github.com/repos/" + pin.repository + "/git/commits/" + pin.revision);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + (pin.id === "dnd-2024-compendium" ? "private-token" : "public-token"));
    assert.ok(init.signal);
    seen.push(pin.id);
    return { ok: true, status: 200, json: async () => ({ sha: pin.revision }) };
  });
  assert.equal(seen.length, 4);
  assert.match(output, /dnd_sheets=3{40}\n/);
  assert.match(output, /dnd_2024_compendium=4{40}\n/);
  assert.doesNotMatch(output, /token/);
});

test("public coverage neither reads private content nor emits a private checkout ref", async () => {
  let calls = 0;
  const output = await resolvePublishedRevisions(sample(), "public", {}, async url => {
    assert.doesNotMatch(url, /compendium/); calls++;
    return { ok: true, status: 200, json: async () => ({ sha: url.split("/").at(-1) }) };
  });
  assert.equal(calls, 3); assert.doesNotMatch(output, /compendium/);
  await assert.rejects(resolvePublishedRevisions(sample(), "full", {}), /ADDON_SUITE_TOKEN/);
});

test("missing, inaccessible, replaced and failed remote commits fail together without leaking responses or tokens", async () => {
  await assert.rejects(resolvePublishedRevisions(sample(), "full", { private: "secret-value" }, async url => {
    if (url.includes("addon-dm-tools")) return { ok: false, status: 404, json: async () => ({ token: "secret-value" }) };
    if (url.includes("addon-dnd-engine")) return { ok: false, status: 403, json: async () => ({ token: "secret-value" }) };
    if (url.includes("addon-dnd-character-sheets")) return { ok: true, status: 200, json: async () => ({ sha: "wrong" }) };
    throw new Error("request failed with secret-value");
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const expected of [/HTTP 404/, /HTTP 403/, /different commit/, /availability check failed/, /Publish the pinned companion commits/]) assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});
