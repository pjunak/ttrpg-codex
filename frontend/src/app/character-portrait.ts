import { isRecord } from "../core/boundary.js";
import { MediaClient } from "../core/media.js";
import type { CampaignRecordSaveDetail, PreparedCampaignRecordTransaction } from "./campaign-record-editor.js";

export const portraitAccept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
export function validPortraitFile(file: File): boolean {
  return file.size > 0 && file.size <= 20 * 1024 * 1024 && portraitAccept.split(",").includes(file.type);
}

// Uploads are immutable. Only the subsequent revision-checked record transaction
// publishes the selected URL; never delete the previous image or recovery data.
export async function attachCharacterPortrait(
  prepared: PreparedCampaignRecordTransaction,
  detail: CampaignRecordSaveDetail,
  csrfToken: string,
  signal: AbortSignal,
  media = new MediaClient(),
): Promise<PreparedCampaignRecordTransaction> {
  if (detail.portrait === undefined) return prepared;
  const mutation = prepared.mutations[0];
  if (detail.creating || detail.collection !== "characters" || mutation?.operation !== "put" ||
    mutation.collection !== "characters" || mutation.key !== detail.key || !isRecord(mutation.value)) {
    throw new Error("Invalid portrait target");
  }
  const value = { ...mutation.value };
  if (detail.portrait === null) delete value["portrait"];
  else {
    if (!validPortraitFile(detail.portrait)) throw new Error("Invalid portrait file");
    const uploaded = await media.upload("character-portrait", detail.key, detail.portrait,
      detail.portrait.name, csrfToken, signal);
    if (uploaded.kind !== "character-portrait" || uploaded.target !== detail.key) throw new Error("Portrait target differs");
    value["portrait"] = uploaded.url;
  }
  return { ...prepared, mutations: [{ ...mutation, value }, ...prepared.mutations.slice(1)] };
}
