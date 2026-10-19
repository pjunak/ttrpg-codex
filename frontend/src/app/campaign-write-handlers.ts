import type {
  CampaignCollectionName,
  CampaignDataset,
  CampaignRecord,
} from "../core/campaign-data.js";
import {
  CampaignMutationHTTPError,
  type CampaignEnumDeleteMutation,
  type CampaignMutation,
  type CampaignMutationResult,
  type CampaignTwinMutation,
} from "../core/campaign-mutations.js";
import type { MediaKind } from "../core/media.js";
import {
  CampaignAppearanceEditError,
  prepareCampaignAppearanceSave,
} from "./campaign-appearance.js";
import { BrandingEditError, prepareBrandingSave } from "./campaign-branding.js";
import { CampaignIdentityEditError, prepareCampaignIdentitySave } from "./campaign-identity.js";
import {
  CampaignMapEditError,
  mapLocationRecord,
  prepareLocalMapImage,
  prepareMapSave,
} from "./campaign-map.js";
import { CampaignPartyEditError, prepareCampaignPartySave } from "./campaign-party.js";
import {
  CampaignRecordEditError,
  patchOverwritten,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
  prepareCharacterPatch,
} from "./campaign-record-editor.js";
import {
  CampaignSettingsEditError,
  prepareCampaignEnumDelete,
  prepareCampaignEnumSave,
  prepareCampaignEnumStarter,
} from "./campaign-settings.js";
import {
  prepareAddonSidebarSave,
  prepareSidebarSave,
  SidebarEditError,
} from "./campaign-sidebar.js";
import { prepareTimelineReorder, TimelineEditError } from "./campaign-timeline.js";
import type { CampaignWriteKind, CampaignWrites } from "./campaign-writes.js";
import { attachCharacterPortrait } from "./character-portrait.js";
import { uiRequestError } from "./ui-errors.js";
import { uiText, type MessageKey } from "./ui-localization.js";

/** What a handler uses for one write. */
export interface CampaignWriteContext {
  /** The campaign as shown when the write's turn came. */
  readonly campaign: CampaignDataset;
  readonly canManage: boolean;
  readonly csrfToken: string;
  readonly signal: AbortSignal;
  commit(mutations: readonly CampaignMutation[]): Promise<readonly CampaignMutationResult[]>;
  mutateTwin(mutation: CampaignTwinMutation): Promise<readonly CampaignMutationResult[]>;
  deleteEnumItem(mutation: CampaignEnumDeleteMutation): Promise<readonly CampaignMutationResult[]>;
  /** Uploads a media file and returns its URL. */
  upload(kind: MediaKind, target: string, file: File): Promise<string>;
}

/** What the read-back must show before the editor hears that its write succeeded. */
export interface CampaignWriteReceipt {
  readonly results: readonly CampaignMutationResult[];
  /** The record the editor wrote; the answer carries its read-back copy. */
  readonly target?: { readonly collection: CampaignCollectionName; readonly key: string };
  /** Checks the read-back target, which another author may have changed again. */
  readonly check?: (
    current: CampaignRecord,
    result: CampaignMutationResult,
  ) => CampaignWriteFailure | undefined;
  readonly message?: string;
}

export interface CampaignWriteFailure {
  readonly message: string;
  readonly conflict?: boolean;
}

export interface CampaignWriteHandler<D> {
  /** Whether the write belongs to the campaign owner (a DM). */
  manage(detail: D): boolean;
  /** Prepares and sends the write; undefined when there is nothing to write. */
  write(context: CampaignWriteContext, detail: D): Promise<CampaignWriteReceipt | undefined>;
  /** The editor's message for a failed write. */
  failure(cause: unknown, detail: D): CampaignWriteFailure;
}

type CampaignWriteHandlers = {
  readonly [K in CampaignWriteKind]: CampaignWriteHandler<CampaignWrites[K]>;
};

const recordSaveConflict =
  "The entry or its relationships changed. Your draft is kept; copy any notes you need, then cancel and reopen to review the current version.";

/** One handler per write kind: how it is prepared and what its failures mean. */
export const campaignWriteHandlers: CampaignWriteHandlers = {
  record: {
    manage: () => false,
    async write(context, detail) {
      const prepared = await attachCharacterPortrait(
        prepareCampaignRecordSave(context.campaign, detail, context.canManage),
        detail,
        context.csrfToken,
        context.signal,
      );
      return {
        results: await context.commit(prepared.mutations),
        target: { collection: detail.collection, key: detail.key },
      };
    },
    failure(cause) {
      if (cause instanceof CampaignRecordEditError) {
        if (cause.kind === "stale") return failed(uiText(recordSaveConflict), true);
        if (cause.kind === "portrait-visibility")
          return failed(
            uiText("Save visibility changes first, then replace the portrait. Your draft is kept."),
          );
        return failed(
          cause.field === undefined
            ? uiText("The entry contains a value that cannot be saved.")
            : uiText("{0} contains a value that cannot be saved.", { "0": cause.field.label }),
        );
      }
      if (conflictResponse(cause)) return failed(uiText(recordSaveConflict), true);
      return failed(uiText("The entry could not be saved: {0}", { "0": uiRequestError(cause) }));
    },
  },
  "record-delete": {
    manage: () => false,
    async write(context, detail) {
      const prepared = prepareCampaignRecordDelete(context.campaign, detail);
      return { results: await context.commit(prepared.mutations) };
    },
    failure(cause) {
      if (cause instanceof CampaignRecordEditError)
        return cause.kind === "stale"
          ? failed(
              uiText("The entry changed before it could be deleted. Refresh and try again."),
              true,
            )
          : failed(uiText("The delete request is no longer valid."));
      if (conflictResponse(cause))
        return failed(
          uiText("The entry changed while deleting. Reload its current version and try again."),
          true,
        );
      return failed(uiText("The entry could not be deleted: {0}", { "0": uiRequestError(cause) }));
    },
  },
  "record-patch": {
    manage: () => false,
    async write(context, patch) {
      const collection = patch.collection ?? "characters";
      const prepared = await attachCharacterPortrait(
        prepareCharacterPatch(context.campaign, patch, context.canManage),
        {
          collection,
          key: patch.base.key,
          expectedRevision: patch.base.revision,
          creating: false,
          fields: patch.fields,
          ...(patch.portrait !== undefined ? { portrait: patch.portrait } : {}),
          ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        },
        context.csrfToken,
        context.signal,
      );
      const written = prepared.mutations[0];
      return {
        results: await context.commit(prepared.mutations),
        target: { collection, key: patch.base.key },
        check: (current, result) =>
          current.revision > result.afterRevision &&
          written?.operation === "put" &&
          patchOverwritten(patch, written.value, current)
            ? failed(
                uiText(
                  "Your change was saved, but this field changed again elsewhere. Review the current value.",
                ),
                true,
              )
            : undefined,
      };
    },
    failure(cause) {
      return (cause instanceof CampaignRecordEditError && cause.kind === "stale") ||
        conflictResponse(cause)
        ? failed(
            uiText(
              "This field changed elsewhere. Your draft is kept. Review the current value before retrying.",
            ),
            true,
          )
        : failed(uiText("The entry could not be saved: {0}", { "0": uiRequestError(cause) }));
    },
  },
  twin: {
    manage: () => true,
    async write(context, mutation) {
      return { results: await context.mutateTwin(mutation), message: uiText("twins.saved") };
    },
    failure(cause) {
      return conflictResponse(cause)
        ? failed(uiText("twins.stale"), true)
        : failed(uiText("twins.failed"));
    },
  },
  enum: {
    manage: () => true,
    async write(context, detail) {
      return { results: await context.commit([prepareCampaignEnumSave(context.campaign, detail)]) };
    },
    failure(cause) {
      if (cause instanceof CampaignSettingsEditError)
        return cause.kind === "stale"
          ? failed(
              uiText(
                "The definition changed. Your draft is kept; copy any notes you need, then cancel and reopen to review the current version.",
              ),
              true,
            )
          : failed(uiText("The definition contains a value that cannot be saved."));
      if (conflictResponse(cause))
        return failed(
          uiText("Settings changed while saving. Reload the current definition and try again."),
          true,
        );
      return failed(
        uiText("The definition could not be saved: {0}", { "0": uiRequestError(cause) }),
      );
    },
  },
  "enum-starter": {
    manage: () => true,
    async write(context, detail) {
      return {
        results: await context.commit([prepareCampaignEnumStarter(context.campaign, detail)]),
      };
    },
    failure(cause) {
      return (cause instanceof CampaignSettingsEditError && cause.kind === "stale") ||
        conflictResponse(cause)
        ? failed(uiText("This category was filled elsewhere. Review the current entries."), true)
        : failed(uiText("The starter set could not be added: {0}", { "0": uiRequestError(cause) }));
    },
  },
  "enum-delete": {
    manage: () => true,
    async write(context, detail) {
      return {
        results: await context.deleteEnumItem(prepareCampaignEnumDelete(context.campaign, detail)),
      };
    },
    failure(cause, detail) {
      if (cause instanceof CampaignSettingsEditError)
        return failed(uiText("The definition changed before it could be deleted."), true);
      if (conflictResponse(cause))
        return failed(
          detail.mode === "reject-if-used"
            ? uiText(
                "The definition is now in use or settings changed. Review the category and try again.",
              )
            : uiText("Settings changed while deleting. Review the category and try again."),
          true,
        );
      return failed(
        uiText("The definition could not be deleted: {0}", { "0": uiRequestError(cause) }),
      );
    },
  },
  appearance: {
    manage: () => true,
    async write(context, detail) {
      return {
        results: await context.commit([prepareCampaignAppearanceSave(context.campaign, detail)]),
      };
    },
    failure(cause) {
      if (cause instanceof CampaignAppearanceEditError)
        return cause.kind === "stale"
          ? failed(
              uiText("Appearance changed elsewhere. Review the current theme and pick again."),
              true,
            )
          : failed(uiText("The appearance setting is invalid."));
      if (conflictResponse(cause))
        return failed(
          uiText("Appearance changed while saving. Review the current theme and try again."),
          true,
        );
      return failed(uiText("Appearance could not be saved: {0}", { "0": uiRequestError(cause) }));
    },
  },
  party: {
    manage: () => true,
    async write(context, detail) {
      return {
        results: await context.commit([prepareCampaignPartySave(context.campaign, detail)]),
      };
    },
    failure: (cause) =>
      settingFailure(cause, cause instanceof CampaignPartyEditError ? cause.kind : undefined, {
        stale: "settings.partyStale",
        invalid: "settings.partyInvalid",
        failed: "settings.partyFailed",
      }),
  },
  branding: {
    manage: () => true,
    async write(context, detail) {
      let mutation = prepareBrandingSave(context.campaign, detail);
      if (detail.file !== undefined) {
        const logoUrl = await context.upload("branding-logo", "main", detail.file);
        mutation = prepareBrandingSave(context.campaign, { ...detail, logoUrl });
      }
      return { results: await context.commit([mutation]) };
    },
    failure: (cause) =>
      settingFailure(cause, cause instanceof BrandingEditError ? cause.kind : undefined, {
        stale: "branding.stale",
        invalid: "branding.invalid",
        failed: "branding.failed",
      }),
  },
  sidebar: {
    manage: () => true,
    async write(context, detail) {
      const mutations = [prepareSidebarSave(context.campaign, detail)];
      if (detail.addonVisibility !== undefined)
        mutations.push(prepareAddonSidebarSave(context.campaign, detail.addonVisibility));
      return { results: await context.commit(mutations) };
    },
    failure: (cause) =>
      settingFailure(cause, cause instanceof SidebarEditError ? cause.kind : undefined, {
        stale: "sidebar.stale",
        invalid: "sidebar.invalid",
        failed: "sidebar.failed",
      }),
  },
  identity: {
    manage: () => true,
    async write(context, detail) {
      return {
        results: await context.commit([prepareCampaignIdentitySave(context.campaign, detail)]),
      };
    },
    failure: (cause) =>
      settingFailure(cause, cause instanceof CampaignIdentityEditError ? cause.kind : undefined, {
        stale: "dashboard.identityStale",
        invalid: "dashboard.identityInvalid",
        failed: "dashboard.identityFailed",
      }),
  },
  map: {
    // The shared map view and map configuration belong to the campaign owner.
    manage: (detail) => detail.kind === "view" || detail.kind === "config",
    async write(context, detail) {
      return { results: await context.commit([prepareMapSave(context.campaign, detail)]) };
    },
    failure: mapFailure,
  },
  "map-upload": {
    manage: (detail) => detail.parentId === null,
    async write(context, { parentId, expectedRevision, file }) {
      if (
        parentId !== null &&
        mapLocationRecord(context.campaign, parentId)?.revision !== expectedRevision
      )
        throw new CampaignMapEditError("stale");
      const url = await context.upload(
        parentId === null ? "world-map" : "location-map",
        parentId ?? "main",
        file,
      );
      return {
        results:
          parentId === null
            ? []
            : await context.commit([
                prepareLocalMapImage(context.campaign, parentId, expectedRevision, url),
              ]),
      };
    },
    failure: mapFailure,
  },
  timeline: {
    manage: () => false,
    async write(context, draft) {
      const mutations = prepareTimelineReorder(context.campaign, draft);
      return mutations.length === 0 ? undefined : { results: await context.commit(mutations) };
    },
    failure(cause) {
      const kind = cause instanceof TimelineEditError ? cause.kind : undefined;
      const stale = kind === "stale" || (kind === undefined && conflictResponse(cause));
      return failed(
        uiText(
          stale
            ? "timeline.stale"
            : kind === "limit"
              ? "timeline.limit"
              : kind === undefined
                ? "timeline.failed"
                : "timeline.invalid",
        ),
        stale,
      );
    },
  },
};

function conflictResponse(cause: unknown): boolean {
  return cause instanceof CampaignMutationHTTPError && cause.status === 409;
}

function failed(message: string, conflict = false): CampaignWriteFailure {
  return conflict ? { message, conflict } : { message };
}

function mapFailure(cause: unknown): CampaignWriteFailure {
  const conflict =
    (cause instanceof CampaignMapEditError && cause.kind === "stale") || conflictResponse(cause);
  return failed(uiText(conflict ? "map.stale" : "map.saveFailed"), conflict);
}

/** A settings record's failure, where `kind` is its edit error's kind, if any. */
function settingFailure(
  cause: unknown,
  kind: string | undefined,
  messages: {
    readonly stale: MessageKey;
    readonly invalid: MessageKey;
    readonly failed: MessageKey;
  },
): CampaignWriteFailure {
  if (kind === "stale" || (kind === undefined && conflictResponse(cause)))
    return failed(uiText(messages.stale), true);
  return failed(uiText(kind === undefined ? messages.failed : messages.invalid));
}
