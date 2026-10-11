import { describe, expect, it } from "vitest";
import { editorFieldsFor } from "../src/app/campaign-record-editor.js";
import type { CampaignCollectionName } from "../src/core/campaign-data.js";
// Written by `go test ./internal/domain/campaign -update-references` from the
// host's reference table.
import table from "./fixtures/campaign-references.json" with { type: "json" };

interface ReferenceField {
  readonly field: string;
  readonly target: string;
  readonly kind: string;
}

const hostTable = table as unknown as Readonly<
  Record<
    string,
    { readonly references?: readonly ReferenceField[]; readonly dmOnly?: readonly string[] }
  >
>;

// Host references the record forms do not edit.
const editedElsewhere = new Set([
  "locations.characters", // older saved data only; kept consistent by the host
  "events.mapParentId", // set by placing the event on a map
]);

const editorKinds: Readonly<Record<string, string>> = {
  reference: "one",
  references: "many",
  "location-roles": "objects",
};

describe("campaign reference table", () => {
  it("matches every editor reference field to the host declaration", () => {
    for (const [collection, declared] of Object.entries(hostTable)) {
      const fields = editorFieldsFor(collection as CampaignCollectionName);
      const editorReferences = fields
        .filter((field) => editorKinds[field.kind] !== undefined)
        .map((field) => ({
          field: field.key,
          target: field.kind === "location-roles" ? "locations" : field.referenceCollection,
          kind: editorKinds[field.kind],
        }));
      const hostReferences = (declared.references ?? [])
        .filter((reference) => !editedElsewhere.has(`${collection}.${reference.field}`))
        .map(({ field, target, kind }) => ({ field, target, kind }));
      expect(editorReferences, collection).toEqual(hostReferences);
    }
  });

  it("marks the same fields DM-only as the host projection", () => {
    for (const [collection, declared] of Object.entries(hostTable)) {
      const editorDMOnly = editorFieldsFor(collection as CampaignCollectionName)
        .filter((field) => field.dmOnly === true)
        .map((field) => field.key);
      // Twin links are managed by the twin workflow, not a form field.
      const hostDMOnly = (declared.dmOnly ?? []).filter((field) => field !== "linkedTwinId");
      expect(editorDMOnly, collection).toEqual(hostDMOnly);
    }
  });

  it("declares every collection that has editor references", () => {
    const collections: readonly CampaignCollectionName[] = [
      "characters",
      "locations",
      "events",
      "mysteries",
      "factions",
      "pantheon",
      "artifacts",
      "historicalEvents",
      "companions",
    ];
    for (const collection of collections) {
      const references = editorFieldsFor(collection).filter(
        (field) => editorKinds[field.kind] !== undefined,
      );
      if (references.length > 0) expect(hostTable[collection], collection).toBeDefined();
    }
  });
});
