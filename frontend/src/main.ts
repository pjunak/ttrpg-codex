import "./styles.css";
import { initializeCachedCampaignTheme } from "./app/campaign-appearance.js";
import { initializeUiLocalization } from "./app/ui-localization.js";

initializeCachedCampaignTheme();
initializeUiLocalization();
await import("./app/codex-app.js");
