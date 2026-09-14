import { expect, it } from "vitest";
import { parsePackageStorage } from "../src/core/addon-storage.js";
import { addonPackageReviewHash, parseAppRoute } from "../src/app/routes.js";
const hash = "a".repeat(64);
const item = { addonId: "example", generationId: hash, version: "1.0.0", available: false, active: false, downloadable: true };
const wire = () => ({ contractVersion: "addon-package-storage.v1", automatic: true, pending: 0, packages: [item] });
it("accepts exact historical identity and rejects unbounded, duplicate or untrusted storage metadata", () => {
 expect(parsePackageStorage(wire()).packages[0]).toEqual(item);
 for (const patch of [{ contractVersion: "unknown" }, { pending: -1 }, { source: "secret" }, { packages: [item,item] }, { packages: Array(513).fill(item) }]) expect(() => parsePackageStorage({ ...wire(), ...patch })).toThrow();
 for (const patch of [{ addonId: "../outside" }, { generationId: "latest" }, { available: "true" }, { source: "secret" }, { version: "x".repeat(201) }]) expect(() => parsePackageStorage({ ...wire(), packages: [{ ...item, ...patch }] })).toThrow();
});
it("routes exact prepared build reviews without accepting arbitrary package paths", () => {
 expect(parseAppRoute(addonPackageReviewHash("example",hash))).toEqual({ kind: "settings", addonId: "example", generationId: hash });
 expect(parseAppRoute("#/settings/addons/example/packages/latest").kind).toBe("not-found");
 expect(parseAppRoute(addonPackageReviewHash("../outside",hash)).kind).toBe("not-found");
});
