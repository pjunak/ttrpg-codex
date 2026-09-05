import { describe, expect, it } from "vitest";
import { attitudeRing, attitudeFilter, markerGlowLayers } from "../src/app/campaign-attitude-glow.js";

const ally = { color: "#4caf50", strength: .6 };
const danger = { color: "#f00", strength: 1 };

describe("preserved attitude glow visuals", () => {
  it("uses the original portrait border rings and icon silhouettes without changing strength", () => {
    expect(attitudeRing([ally, danger])).toBe("0 0 10px 1px rgba(76, 175, 80, 0.6), 0 0 4px 1px rgba(76, 175, 80, 0.6), 0 0 10px 1px rgba(255, 0, 0, 1), 0 0 4px 1px rgba(255, 0, 0, 1)");
    expect(attitudeFilter([ally])).toBe("drop-shadow(0 0 10px rgba(76, 175, 80, 0.6)) drop-shadow(0 0 4px rgba(76, 175, 80, 0.6))");
    expect(attitudeRing([{ ...ally, strength: 0 }])).toBeUndefined();
    expect(attitudeFilter([])).toBeUndefined();
  });
  it("keeps artwork outlined and scales marker blur with the configured size", () => {
    expect(markerGlowLayers([], 36, true)).toEqual([{ filter: "drop-shadow(0 0 1px rgba(0,0,0,0.95)) drop-shadow(0 0 1px rgba(0,0,0,0.95))", clipPath: "" }]);
    expect(markerGlowLayers([], 36, false)).toEqual([{ filter: "", clipPath: "" }]);
    expect(markerGlowLayers([ally], 36, false)).toEqual([{ filter: "drop-shadow(0 0 8px rgba(76, 175, 80, 0.6)) drop-shadow(0 0 3px rgba(76, 175, 80, 0.6))", clipPath: "" }]);
    expect(markerGlowLayers([ally], 16, false)[0]?.filter).toContain("0 0 5px");
    expect(markerGlowLayers([ally], 60, false)[0]?.filter).toContain("0 0 13px");
  });
  it("matches the preserved two- and three-attitude diagonal bands with extended outer edges", () => {
    const two = markerGlowLayers([ally, { ...danger, strength: 0 }, danger], 36, false);
    expect(two.map(layer => layer.clipPath)).toEqual([
      "polygon(-100.00% -100%, 147.50% -100%, -47.50% 200%, -100.00% 200%)",
      "polygon(147.50% -100%, 200.00% -100%, 200.00% 200%, -47.50% 200%)",
    ]);
    expect(two[0]?.filter).not.toContain("255, 0, 0");
    expect(two[1]?.filter).not.toContain("76, 175, 80");
    expect(markerGlowLayers([ally, danger, ally], 36, false).map(layer => layer.clipPath)).toEqual([
      "polygon(-100.00% -100%, 98.33% -100%, -31.67% 200%, -100.00% 200%)",
      "polygon(98.33% -100%, 131.67% -100%, 1.67% 200%, -31.67% 200%)",
      "polygon(131.67% -100%, 200.00% -100%, 200.00% 200%, 1.67% 200%)",
    ]);
  });
});
