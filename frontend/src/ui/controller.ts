import type { ReactiveController, ReactiveControllerHost } from "lit";
import { enhanceControls, type UIControlsHandle } from "./controls.js";

/** Host Lit views use the same DOM contract and lifetime as integrated add-ons. */
export class UIControlsController implements ReactiveController {
  #handle: UIControlsHandle | undefined;
  constructor(private readonly host: ReactiveControllerHost & HTMLElement) { host.addController(this); }
  hostUpdated(): void { this.#handle ??= enhanceControls(this.host); this.#handle.refresh(); }
  hostDisconnected(): void { this.#handle?.dispose(); this.#handle = undefined; }
}
