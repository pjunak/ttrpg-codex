import { describe, expect, it } from "vitest";
import { formText, formTextValues } from "../src/core/forms.js";

describe("text form boundaries", () => {
  it("preserves submitted text and rejects file values", () => {
    const data = new FormData();
    data.append("name", "  Authored text 🐉  ");
    data.append("upload", new File(["private contents"], "notes.txt"));
    expect(formText(data, "name")).toBe("  Authored text 🐉  ");
    expect(formText(data, "missing")).toBe("");
    expect(formText(data, "upload")).toBe("");
  });

  it("keeps ordered repeated text fields without coercing files", () => {
    const data = new FormData();
    data.append("tags", "first");
    data.append("tags", new File(["contents"], "notes.txt"));
    data.append("tags", "");
    data.append("tags", "first");
    expect(formTextValues(data, "tags")).toEqual(["first", "", "first"]);
    expect(formTextValues(data, "missing")).toEqual([]);
  });
});
