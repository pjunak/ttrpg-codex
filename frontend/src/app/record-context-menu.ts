import {
  campaignCollection,
  type CampaignCollectionName,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import type { ContextMenuItem } from "../ui/context-menu.js";
import { editorFieldsFor, editorOptionsFor } from "./campaign-record-editor.js";
import { eventMapParent, hasEventPin, mapCoordinate, mapParent } from "./campaign-map.js";
import { projectEntity, recordValue, stringList, text } from "./campaign-projection.js";
import {
  campaignPages,
  contextualCreateHash,
  eventMapHash,
  locationMapHash,
  recordEditHash,
  recordHash,
  type CampaignPageDefinition,
} from "./routes.js";
import { uiText } from "./ui-localization.js";

/** What the menu may do; the app keeps authority over navigation and writes. */
export interface RecordMenuActions {
  readonly canEdit: boolean;
  /** The menu is for the record already on screen, so "Open" is redundant. */
  readonly current?: boolean;
  /** Why writes are unavailable right now (an open editor or a save in progress). */
  readonly writeBlocked: string;
  navigate(hash: string): void;
  openInNewTab(hash: string): void;
  copy(text: string, done: string): void;
  patch(
    collection: CampaignCollectionName,
    record: CampaignRecord,
    fields: Readonly<Record<string, unknown>>,
    done: string,
  ): void;
}

export interface RecordMenu {
  readonly title: string;
  readonly items: readonly ContextMenuItem[];
}

/**
 * Actions for one record, built from the current authorized dataset and the
 * editor's field definitions so every write is one the editor also allows.
 */
export function recordContextMenu(
  campaign: CampaignDataset,
  page: CampaignPageDefinition,
  key: string,
  actions: RecordMenuActions,
): RecordMenu | undefined {
  const record = campaignCollection(campaign, page.collection).records.find(
    (item) => item.key === key,
  );
  if (!record) return undefined;
  const entity = projectEntity(campaign, record, page);
  const value = recordValue(record);
  const route = recordHash(page, key);
  const blocked = actions.writeBlocked || false;
  const items: ContextMenuItem[] = [
    ...(actions.current
      ? []
      : [{ label: uiText("menu.open"), icon: "↗", run: () => actions.navigate(route) }]),
    { label: uiText("menu.openTab"), icon: "⧉", run: () => actions.openInNewTab(route) },
    {
      label: uiText("menu.copyLink"),
      icon: "🔗",
      run: () => actions.copy(new URL(route, location.href).href, uiText("menu.copied")),
    },
    {
      label: uiText("menu.copyWiki"),
      icon: "[[",
      run: () => actions.copy(`[[${entity.name}]]`, uiText("menu.copied")),
    },
  ];
  if (!actions.canEdit) return { title: entity.name, items };
  items.push({
    label: uiText("Edit"),
    icon: "✎",
    separator: true,
    run: () => actions.navigate(recordEditHash(page, key)),
  });
  const field = (name: string) =>
    editorFieldsFor(page.collection).find((candidate) => candidate.key === name);
  const save = (fields: Readonly<Record<string, unknown>>, done: string) =>
    actions.patch(page.collection, record, fields, done);

  /** One choice from a field's options, saved immediately. */
  const choose = (name: string, icon: string): ContextMenuItem | undefined => {
    const definition = field(name);
    if (!definition) return undefined;
    const options = editorOptionsFor(campaign, definition, key);
    const currentValue = text(value[name]);
    return {
      label: definition.label,
      icon,
      detail: options.find((option) => option.value === currentValue)?.label ?? "",
      disabled: blocked,
      searchable: options.length > 8,
      children: () => [
        ...(definition.kind === "reference" && name !== "faction"
          ? [
              {
                label: uiText("None"),
                checked: currentValue === "",
                run: () => save({ [name]: "" }, uiText("menu.saved", { "0": definition.label })),
              },
            ]
          : []),
        ...options.map((option) => ({
          label: option.label,
          checked: option.value === currentValue,
          run: () =>
            save({ [name]: option.value }, uiText("menu.saved", { "0": definition.label })),
        })),
      ],
    };
  };
  /** Toggle membership in a multi-value field of this record. */
  const toggle = (name: string, icon: string): ContextMenuItem | undefined => {
    const definition = field(name);
    if (!definition) return undefined;
    const options = editorOptionsFor(campaign, definition, key);
    const selected = new Set(
      definition.kind === "attitudes" ? attitudeIds(value[name]) : stringList(value[name]),
    );
    return {
      label: definition.label,
      icon,
      detail: selected.size ? String(selected.size) : "",
      disabled: blocked,
      searchable: options.length > 8,
      children: () =>
        options.map((option) => ({
          label: option.label,
          checked: selected.has(option.value),
          run: () => {
            const next = new Set(selected);
            if (next.has(option.value)) next.delete(option.value);
            else next.add(option.value);
            save({ [name]: [...next] }, uiText("menu.saved", { "0": definition.label }));
          },
        })),
    };
  };
  /** Add this record to (or remove it from) a reference list on other records. */
  const addTo = (
    collection: CampaignCollectionName,
    listField: string,
    label: string,
    icon: string,
  ): ContextMenuItem => {
    const targetPage = campaignPages.find((candidate) => candidate.collection === collection)!;
    const targets = campaignCollection(campaign, collection).records;
    return {
      label,
      icon,
      disabled: blocked,
      searchable: targets.length > 8,
      children: () =>
        targets
          .map((target) => ({
            target,
            name: projectEntity(campaign, target, targetPage).name,
            members: stringList(recordValue(target)[listField]),
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ target, name, members }) => ({
            label: name,
            checked: members.includes(key),
            run: () =>
              actions.patch(
                collection,
                target,
                {
                  [listField]: members.includes(key)
                    ? members.filter((member) => member !== key)
                    : [...members, key],
                },
                uiText("menu.saved", { "0": name }),
              ),
          })),
    };
  };

  const more: (ContextMenuItem | undefined)[] = [];
  switch (page.collection) {
    case "characters":
      more.push(
        choose("status", "●"),
        choose("faction", "⬡"),
        choose("location", "📍"),
        value["faction"] === "party"
          ? { label: field("attitudes")!.label, icon: "♥", disabled: uiText("menu.partyAttitudes") }
          : toggle("attitudes", "♥"),
        addTo("events", "characters", uiText("menu.addToEvent"), "⏳"),
        addTo("mysteries", "characters", uiText("menu.linkMystery"), "❓"),
      );
      break;
    case "locations": {
      const placed = mapCoordinate(value["x"]) && mapCoordinate(value["y"]);
      more.push(
        {
          label: uiText("menu.addHere"),
          icon: "+",
          children: [
            {
              label: uiText("creation.character"),
              run: () => actions.navigate(contextualCreateHash("character-here", key)),
            },
            {
              label: uiText("creation.event"),
              run: () => actions.navigate(contextualCreateHash("event-here", key)),
            },
            {
              label: uiText("creation.child"),
              run: () => actions.navigate(contextualCreateHash("sub-location", key)),
            },
          ],
        },
        {
          label: uiText(placed ? "menu.showOnMap" : "menu.placeOnMap"),
          icon: "⌖",
          run: () =>
            actions.navigate(locationMapHash(mapParent(value), key, placed ? "show" : "place")),
        },
        choose("parentId", "⤒"),
        toggle("connections", "⇄"),
        toggle("attitudes", "♥"),
        addTo("events", "locations", uiText("menu.addToEvent"), "⏳"),
      );
      break;
    }
    case "factions":
      more.push({
        label: uiText("menu.members"),
        icon: "👤",
        disabled: blocked,
        searchable: true,
        children: () => {
          const characters = campaignPages.find((candidate) => candidate.id === "characters")!;
          return campaignCollection(campaign, "characters")
            .records.map((member) => ({
              member,
              name: projectEntity(campaign, member, characters).name,
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(({ member, name }) => {
              const inFaction = text(recordValue(member)["faction"]) === key;
              return {
                label: name,
                checked: inFaction,
                run: () =>
                  actions.patch(
                    "characters",
                    member,
                    { faction: inFaction ? "neutral" : key },
                    uiText("menu.saved", { "0": name }),
                  ),
              };
            });
        },
      });
      more.push({
        label: uiText("creation.member"),
        icon: "+",
        run: () => actions.navigate(contextualCreateHash("faction-member", key)),
      });
      break;
    case "events":
      more.push(toggle("characters", "👤"), toggle("locations", "📍"), {
        label: uiText(hasEventPin(value) ? "menu.showOnMap" : "menu.placeOnMap"),
        icon: "⌖",
        run: () =>
          actions.navigate(
            eventMapHash(eventMapParent(value), key, hasEventPin(value) ? "show" : "place"),
          ),
      });
      break;
    case "mysteries":
      more.push(toggle("characters", "👤"), toggle("locations", "📍"));
      break;
    case "historicalEvents":
      more.push(toggle("characters", "👤"), toggle("locations", "📍"));
      break;
    case "artifacts":
    case "campaign":
    case "companions":
    case "pantheon":
    case "relationships":
    case "settings":
      break;
  }
  const defined = more.filter((item): item is ContextMenuItem => item !== undefined);
  if (defined.length) items.push({ ...defined[0]!, separator: true }, ...defined.slice(1));
  return { title: entity.name, items };
}

function attitudeIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string"
          ? [(item as { id: string }).id]
          : [],
      )
    : [];
}
