import assert from "node:assert/strict";
import { test } from "node:test";
import { assertToolchainVersions } from "./check-toolchains.mts";

const versions = {
  typescript: "7.0.2",
  "@types/node": "26.6.3",
  oxlint: "1.85.0",
  "oxlint-tsgolint": "7.0.2003",
  prettier: "3.9.9",
};

void test("companion compiler drift and missing analysis tools cannot pass suite preparation", () => {
  assertToolchainVersions(versions, { ...versions }, "companion");
  assert.throws(
    () => assertToolchainVersions(versions, { ...versions, typescript: "5.9.3" }, "companion"),
    /companion: typescript must match host 7\.0\.2/,
  );
  const { "oxlint-tsgolint": _removed, ...missing } = versions;
  assert.throws(() => assertToolchainVersions(versions, missing, "companion"), /found missing/);
  assert.throws(
    () => assertToolchainVersions({ ...versions, typescript: "^7.0.2" }, versions, "companion"),
    /Host must pin an exact stable typescript version/,
  );
});
