import { BoundaryValidationError } from "../core/boundary.js";
import { uiText } from "./ui-localization.js";

/** Keep protocol diagnostics on the error; show a localized recovery action in the UI. */
export function uiRequestError(cause: unknown): string {
  if (cause instanceof BoundaryValidationError) return uiText("The server returned an unexpected response. Reload and try again.");
  const status = cause instanceof Error && "status" in cause ? cause.status : undefined;
  if (status === 401) return uiText("Sign in with the correct password and try again.");
  if (status === 403) return uiText("You do not have permission for this action in the current view.");
  if (status === 404) return uiText("The requested item is no longer available.");
  if (status === 409) return uiText("Data changed. Refresh and review the current version before retrying.");
  if (status === 429) return uiText("Too many requests. Wait a moment and try again.");
  if (typeof status === "number" && status >= 500) return uiText("The server is unavailable. Try again shortly.");
  if (cause instanceof TypeError) return uiText("Check your connection and try again.");
  return uiText("The request could not be completed. Reload and try again.");
}
