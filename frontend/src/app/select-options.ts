import { html } from "lit";

export function selectOptions(options: readonly { readonly value: string; readonly label: string }[], selected: string) {
  // Set selection on each option after it exists, including on the first render.
  return options.map(option => html`<option value=${option.value} .selected=${option.value === selected}>${option.label}</option>`);
}
