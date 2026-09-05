import "./styles.css";
import { initializeCachedCampaignTheme } from "./app/campaign-appearance.js";
import { initializeUiLocalization } from "./app/ui-localization.js";
import { initializePlayerPreview } from "./core/player-preview.js";

initializePlayerPreview();
initializeCachedCampaignTheme();
initializeUiLocalization();
await import("./app/codex-app.js");
