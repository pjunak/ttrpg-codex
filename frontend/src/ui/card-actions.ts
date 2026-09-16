import { html } from "lit";

/** Sibling of the card's primary link; editing retains native link navigation. */
export function cardEditLink(href: string, label: string) {
  return html`<a class="ui-card-action" href=${href} aria-label=${label} title=${label}>
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="m15 5 4 4M4 20l1-5L16 4a2.83 2.83 0 0 1 4 4L9 19l-5 1Z" />
    </svg>
  </a>`;
}
