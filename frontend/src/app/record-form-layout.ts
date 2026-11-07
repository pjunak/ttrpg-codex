import type { CampaignCollectionName } from "../core/campaign-data.js";
import { editorFieldsFor } from "./campaign-record-editor.js";
import type { MessageKey } from "./ui-localization.js";

/** A titled group of fields on the record form; the section bar links each one. */
export interface RecordFormSection {
  readonly id: string;
  readonly label: MessageKey;
  readonly fields: readonly string[];
}

/**
 * Where a collection's fields sit on the record form: sections in the main
 * column, and the record's settings (its tags) in the Settings panel beside
 * them, together with visibility and any picture.
 */
export interface RecordFormLayout {
  readonly sections: readonly RecordFormSection[];
  readonly settings: readonly string[];
}

const story = { id: "story", label: "form.story" } as const;
const involved = {
  id: "involved",
  label: "form.involved",
  fields: ["characters", "locations"],
} as const;

const layouts: Readonly<Partial<Record<CampaignCollectionName, RecordFormLayout>>> = {
  characters: {
    sections: [
      {
        id: "basics",
        label: "form.basics",
        fields: ["name", "title", "species", "gender", "age", "status", "circumstances"],
      },
      {
        id: "connections",
        label: "Connections",
        fields: ["faction", "rankAssignment", "attitudes", "location", "locationRoles"],
      },
      { ...story, fields: ["description"] },
      { id: "facts", label: "form.facts", fields: ["known", "unknown"] },
    ],
    settings: ["tags"],
  },
  locations: {
    sections: [
      { id: "basics", label: "form.basics", fields: ["name", "type", "region", "attitudes"] },
      { id: "whereabouts", label: "form.whereabouts", fields: ["parentId", "connections"] },
      { id: "map", label: "form.map", fields: ["pinType", "size", "mapNotes"] },
      { ...story, fields: ["description", "history"] },
      { id: "notes", label: "notes.private", fields: ["notes"] },
    ],
    settings: ["tags"],
  },
  factions: {
    sections: [
      { id: "basics", label: "form.basics", fields: ["name", "attitudes"] },
      { id: "look", label: "form.look", fields: ["badge", "color"] },
      { id: "ranks", label: "form.ranks", fields: ["rankChains"] },
      { ...story, fields: ["description"] },
    ],
    settings: [],
  },
  events: {
    sections: [
      { id: "basics", label: "form.basics", fields: ["name", "short", "priority"] },
      { id: "when", label: "form.when", fields: ["date", "sitting", "consequence"] },
      involved,
      { ...story, fields: ["description"] },
    ],
    settings: ["tags"],
  },
  mysteries: {
    sections: [
      { id: "basics", label: "form.basics", fields: ["name", "priority", "solved"] },
      { id: "investigation", label: "form.investigation", fields: ["questions", "clues"] },
      involved,
      { ...story, fields: ["description"] },
    ],
    settings: [],
  },
  pantheon: {
    sections: [
      {
        id: "basics",
        label: "form.basics",
        fields: ["name", "domain", "symbol", "alignment"],
      },
      { ...story, fields: ["description"] },
    ],
    settings: [],
  },
  artifacts: {
    sections: [
      { id: "basics", label: "form.basics", fields: ["name"] },
      {
        id: "whereabouts",
        label: "form.whereabouts",
        fields: ["ownerCharacterId", "locationId"],
      },
      { ...story, fields: ["description"] },
    ],
    settings: ["tags"],
  },
  historicalEvents: {
    sections: [
      { id: "basics", label: "form.basics", fields: ["name", "start", "end"] },
      involved,
      { ...story, fields: ["summary", "body"] },
    ],
    settings: ["tags"],
  },
  companions: {
    sections: [
      {
        id: "basics",
        label: "form.basics",
        fields: ["name", "icon", "species", "owner", "note"],
      },
    ],
    settings: [],
  },
};

/**
 * The form layout of a collection. A field the layout does not place joins
 * the first section, so a new editor field is never left off the form.
 */
export function recordFormLayout(collection: CampaignCollectionName): RecordFormLayout {
  const layout = layouts[collection] ?? {
    sections: [{ id: "basics", label: "form.basics", fields: [] }],
    settings: [],
  };
  const placed = new Set([...layout.sections.flatMap(({ fields }) => fields), ...layout.settings]);
  const unplaced = editorFieldsFor(collection)
    .map(({ key }) => key)
    .filter((key) => !placed.has(key));
  if (unplaced.length === 0) return layout;
  const [first, ...rest] = layout.sections;
  return {
    ...layout,
    sections: [{ ...first!, fields: [...first!.fields, ...unplaced] }, ...rest],
  };
}
