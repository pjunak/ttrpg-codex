import { expect, it } from "vitest";
import { parsePackageStorage } from "../src/core/addon-storage.js";
import { parseAppRoute } from "../src/app/routes.js";

const wire = () => ({ contractVersion: "addon-package-storage.v1", automatic: true, pending: 0 });

it("accepts the cleanup status and rejects anything else", () => {
  expect(parsePackageStorage(wire())).toEqual(wire());
  for (const patch of [
    { contractVersion: "unknown" },
    { automatic: "true" },
    { pending: -1 },
    { pending: 1.5 },
    { packages: [] },
    { source: "secret" },
  ])
    expect(() => parsePackageStorage({ ...wire(), ...patch })).toThrow();
});

it("no longer routes reviews of individual stored builds", () => {
  expect(parseAppRoute(`#/settings/addons/example/packages/${"a".repeat(64)}`).kind).toBe(
    "not-found",
  );
});
