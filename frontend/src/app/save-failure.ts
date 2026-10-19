import { html, nothing } from "lit";

/** A failed save's message, shown beside the editor that asked for the save. */
export function saveFailure(message: string) {
  return message === "" ? nothing : html`<p class="save-failure" role="alert">${message}</p>`;
}
