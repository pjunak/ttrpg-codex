import "../../src/styles.css";
import { CodexRecordPage } from "../../src/app/codex-record-page.js";
import { CodexSettings } from "../../src/app/codex-settings.js";
import { parseAppRoute } from "../../src/app/routes.js";
import { prepareCampaignRecordSave, type CampaignRecordSaveDetail } from "../../src/app/campaign-record-editor.js";
import { prepareCampaignEnumSave, type CampaignEnumSaveDetail } from "../../src/app/campaign-settings.js";
import { prepareCampaignAppearanceSave, type CampaignAppearanceSaveDetail } from "../../src/app/campaign-appearance.js";
import { parseCampaignDataset, type CampaignDataset } from "../../src/core/campaign-data.js";

let campaign: CampaignDataset;
let editor: CodexRecordPage | CodexSettings;
const submissions: unknown[] = [];
const dirty: boolean[] = [];

function submit<T>(event: Event, prepare: (detail: T) => unknown): void {
  const detail = (event as CustomEvent<T>).detail;
  try { submissions.push({ detail, mutation: prepare(detail) }); }
  catch (cause: unknown) { submissions.push({ detail, error: cause instanceof Error ? cause.message : String(cause) }); }
}

Object.assign(window, {
  editorFixture: {
    submissions, dirty,
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
  },
});
