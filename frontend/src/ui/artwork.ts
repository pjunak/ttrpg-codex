import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { keyed } from "lit/directives/keyed.js";

interface ArtworkOptions {
  readonly source: string | undefined;
  readonly className: string;
  readonly fallback: string | TemplateResult;
  readonly style?: string | undefined;
  readonly label?: string | undefined;
  readonly unavailableLabel?: string;
  readonly loading?: "eager" | "lazy";
}

class ArtworkDirective extends AsyncDirective {
  #options: ArtworkOptions | undefined;
  #state: "empty" | "loading" | "ready" | "unavailable" = "empty";
  #generation = 0;

  override render(options: ArtworkOptions) {
    if (this.#options === undefined || options.source !== this.#options.source) {
      this.#generation++;
      this.#state = options.source === undefined ? "empty" : "loading";
    }
    this.#options = options;
    return this.#template();
  }

  protected override reconnected(): void {
    this.setValue(this.#template());
  }

  #template() {
    const options = this.#options;
    if (options === undefined) return nothing;
    const generation = this.#generation;
    const label =
      this.#state === "unavailable" ? (options.unavailableLabel ?? options.label) : options.label;
    return html`<span class=${`ui-artwork ${options.className}`}
      style=${options.style ?? nothing} data-ui-artwork-state=${this.#state}
      role=${label === undefined ? nothing : "img"}
      aria-label=${label ?? nothing} aria-hidden=${label === undefined ? "true" : nothing}><span class="ui-artwork-fallback" aria-hidden="true">${options.fallback}</span>${
        options.source === undefined
          ? nothing
          : keyed(
              generation,
              html`<img
        src=${options.source} alt="" loading=${options.loading ?? "eager"}
        @load=${(event: Event) => this.#settle(event, generation)}
        @error=${(event: Event) => this.#settle(event, generation)} />`,
            )
      }</span>`;
  }

  #settle(event: Event, generation: number): void {
    // The same URL can return after another source. Retired native image events
    // belong to their original element, even when the URL matches again.
    if (generation !== this.#generation) return;
    const image = event.currentTarget as HTMLImageElement;
    this.#state = event.type === "load" && image.naturalWidth > 0 ? "ready" : "unavailable";
    // Native completion can arrive while its Lit owner is disconnected. Keep
    // that result for reconnect without publishing into a retired template.
    if (this.isConnected) this.setValue(this.#template());
  }
}

/** The caller validates the source and owns its URL and media lifetime. */
export const artwork = directive(ArtworkDirective);
