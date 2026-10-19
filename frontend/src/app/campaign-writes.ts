import type { CampaignDataset, CampaignRecord } from "../core/campaign-data.js";
import type {
  CampaignEnumDeleteMutation,
  CampaignTwinMutation,
} from "../core/campaign-mutations.js";
import type { CampaignAppearanceSaveDetail } from "./campaign-appearance.js";
import type { BrandingSaveDetail } from "./campaign-branding.js";
import type { CampaignIdentitySaveDetail } from "./campaign-identity.js";
import type { MapSaveDetail, MapUploadDetail } from "./campaign-map.js";
import type { CampaignPartySaveDetail } from "./campaign-party.js";
import type {
  CampaignCharacterPatch,
  CampaignRecordDeleteDetail,
  CampaignRecordSaveDetail,
} from "./campaign-record-editor.js";
import type { CampaignEnumSaveDetail, CampaignEnumStarterDetail } from "./campaign-settings.js";
import type { SidebarSaveDetail } from "./campaign-sidebar.js";
import type { TimelineDraft } from "./campaign-timeline.js";
import { uiText } from "./ui-localization.js";

/** The campaign writes an editor can ask the app for, by kind. */
export interface CampaignWrites {
  /** A full-form save or a new record. */
  readonly record: CampaignRecordSaveDetail;
  readonly "record-delete": CampaignRecordDeleteDetail;
  /** Chosen fields of one record, as inline edits send them. */
  readonly "record-patch": CampaignCharacterPatch;
  readonly twin: CampaignTwinMutation;
  readonly enum: CampaignEnumSaveDetail;
  readonly "enum-starter": CampaignEnumStarterDetail;
  readonly "enum-delete": CampaignEnumDeleteMutation;
  readonly appearance: CampaignAppearanceSaveDetail;
  readonly party: CampaignPartySaveDetail;
  readonly branding: BrandingSaveDetail;
  readonly sidebar: SidebarSaveDetail;
  readonly identity: CampaignIdentitySaveDetail;
  readonly map: MapSaveDetail;
  readonly "map-upload": MapUploadDetail;
  readonly timeline: TimelineDraft;
}

export type CampaignWriteKind = keyof CampaignWrites;

/**
 * The answer to one write request. Success carries the campaign read back
 * after the write and, for record writes, that record. A failure keeps the
 * editor's draft; `conflict` means the saved data changed elsewhere.
 */
export type CampaignWriteResult =
  | {
      readonly ok: true;
      readonly campaign: CampaignDataset;
      readonly record?: CampaignRecord;
      readonly message?: string;
    }
  | { readonly ok: false; readonly message: string; readonly conflict?: boolean };

export interface CampaignWriteRequest<K extends CampaignWriteKind = CampaignWriteKind> {
  readonly kind: K;
  readonly detail: CampaignWrites[K];
  /** Checked when the write's turn comes; false answers without writing. */
  readonly ready: () => boolean;
  readonly respond: (result: CampaignWriteResult) => void;
}

export const campaignWriteEvent = "campaign-write";

export function writeUnavailable(): CampaignWriteResult {
  return {
    ok: false,
    message: uiText("The entry cannot be saved right now. Your draft is kept."),
  };
}

/**
 * Asks the app to save. Writes run one at a time in request order and the
 * answer belongs to this request alone; an unhandled request keeps the draft.
 */
export function saveCampaign<K extends CampaignWriteKind>(
  source: Element,
  kind: K,
  detail: CampaignWrites[K],
  ready: () => boolean = () => source.isConnected,
): Promise<CampaignWriteResult> {
  return new Promise<CampaignWriteResult>((respond) => {
    const event = new CustomEvent<CampaignWriteRequest<K>>(campaignWriteEvent, {
      detail: { kind, detail, ready, respond },
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    if (source.dispatchEvent(event)) respond(writeUnavailable());
  });
}
