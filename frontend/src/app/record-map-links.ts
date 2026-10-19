import { html, nothing } from "lit";
import type { CampaignRecord } from "../core/campaign-data.js";
import { mapCoordinate, mapParent } from "./campaign-map.js";
import { recordValue } from "./campaign-projection.js";
import { locationMapHash } from "./routes.js";
import { uiText } from "./ui-localization.js";

/** Show a location on its parent map and, for editors, place or move it there. */
export function locationPlacementLinks(record: CampaignRecord, canEdit: boolean) {
  const value = recordValue(record),
    placed = mapCoordinate(value["x"]) && mapCoordinate(value["y"]);
  return html`
    ${placed ? html`<a class="record-action" href=${locationMapHash(mapParent(value), record.key, "show")}>${uiText("map.show")}</a>` : nothing}
    ${canEdit ? html`<a class="record-action" href=${locationMapHash(mapParent(value), record.key, "place")}>${uiText(placed ? "map.moveLocation" : "map.placeLocation")}</a>` : nothing}
  `;
}
