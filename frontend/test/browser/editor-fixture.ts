import "../../src/styles.css";
import type { EditorFixtureApi } from './editor-fixture-api.js';
import { setUiLocale } from '../../src/app/ui-localization.js';
import { CodexRecordPage } from "../../src/app/codex-record-page.js";
import { CodexSettings } from "../../src/app/codex-settings.js";
import { parseAppRoute } from "../../src/app/routes.js";
import { CampaignRecordEditError, prepareCharacterPatch, prepareCampaignRecordSave, type CampaignRecordSaveDetail, type CampaignCharacterSaveRequest } from "../../src/app/campaign-record-editor.js";
import { prepareCampaignEnumSave, type CampaignEnumSaveDetail } from "../../src/app/campaign-settings.js";
import { prepareCampaignAppearanceSave, type CampaignAppearanceSaveDetail } from "../../src/app/campaign-appearance.js";
import { parseCampaignDataset, type CampaignDataset } from "../../src/core/campaign-data.js";

let campaign: CampaignDataset;
let editor: CodexRecordPage | CodexSettings;
const submissions: unknown[] = [];
const dirty: boolean[] = [];
let failure = "";
let delay = 0;

function submit<T>(event: Event, prepare: (detail: T) => unknown): void {
  const detail = (event as CustomEvent<T>).detail;
  try { submissions.push({ detail, mutation: prepare(detail) }); }
  catch (cause: unknown) { submissions.push({ detail, error: cause instanceof Error ? cause.message : String(cause) }); }
}

const fixture: EditorFixtureApi = {
    submissions, dirty,
    language: setUiLocale,
    failNextSave(message) { failure = message; },
    saveDelay(milliseconds) { delay = milliseconds; },
    async mount(value: unknown, route?: string) {
      campaign = parseCampaignDataset(value);
      if (route === undefined) {
        editor = new CodexSettings();
        editor.canManageCampaign = true;
      } else {
        editor = new CodexRecordPage();
        const parsed = parseAppRoute(route);
        if (parsed.kind !== "record" && parsed.kind !== "collection") throw new Error("Invalid fixture route");
        editor.route = parsed;
        editor.canEdit = true;
        editor.canManageVisibility = true;
      }
      editor.campaign = campaign;
      editor.addEventListener("campaign-edit-dirty", event => dirty.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty));
      editor.addEventListener("campaign-record-save", event => submit(event, (detail: CampaignRecordSaveDetail) => prepareCampaignRecordSave(campaign, detail, true)));
      editor.addEventListener("campaign-character-save", event => {
        event.preventDefault();
        const { respond, ...detail } = (event as CustomEvent<CampaignCharacterSaveRequest>).detail;
        void (async () => {
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          if (failure) { const message = failure; failure = ""; respond({ ok: false, message }); return; }
          try {
            const mutation = prepareCharacterPatch(campaign, detail, true);
            submissions.push({ detail, mutation });
            campaign = { ...campaign, collections: campaign.collections.map(collection => {
              let records = [...collection.records];
              for (const change of mutation.mutations.filter(change => change.collection === collection.name)) {
                records = records.filter(record => record.key !== change.key);
                if (change.operation === "put") records.push({ key: change.key, revision: change.expectedRevision + 1, value: change.value });
              }
              return { ...collection, records };
            }) };
            editor.campaign = campaign;
            const record = campaign.collections.find(collection => collection.name === "characters")!.records.find(record => record.key === detail.base.key)!;
            respond({ ok: true, campaign, record });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            submissions.push({ detail, error: message });
            respond({ ok: false, message, conflict: cause instanceof CampaignRecordEditError && cause.kind === "stale" });
          }
        })();
      });
      editor.addEventListener("campaign-enum-save", event => submit(event, (detail: CampaignEnumSaveDetail) => prepareCampaignEnumSave(campaign, detail)));
      editor.addEventListener("campaign-appearance-save", event => submit(event, (detail: CampaignAppearanceSaveDetail) => prepareCampaignAppearanceSave(campaign, detail)));
      document.body.append(editor);
      await editor.updateComplete;
    },
    async refresh(value: unknown) {
      campaign = parseCampaignDataset(value);
      editor.campaign = campaign;
      await editor.updateComplete;
    },
    async complete() {
      editor.editCompletion += 1;
      await editor.updateComplete;
    },
};
window.editorFixture = fixture;
