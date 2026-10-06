import { html } from "lit";

/** The pencil glyph used by small inline edit links and buttons. */
export function pencilIcon() {
  return html`<svg class="edit-icon" viewBox="0 0 24 24" width="14" height="14" fill="none"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false"><path d="m15 5 4 4M4 20l1-5L16 4a2.83 2.83 0 0 1 4 4L9 19l-5 1Z" /></svg>`;
}
