/** ui.controls.v1 — reviewed integrated browser contributions only. */
export interface UIControlsHandle {
  /** Reconcile current DOM/properties without replacing original controls or values. */
  refresh(): void;
  /** Idempotently release enhancements; native values remain. */
  dispose(): void;
}
export interface UIControlsAPI {
  /** Requires ui.controls.v1 and a live integrated SDK session. */
  enhance(root: HTMLElement): UIControlsHandle;
}
export interface UIQueryDetail { readonly value: string }
export type UIState = "loading" | "empty" | "unavailable" | "info" | "success" | "error";
export type UIButtonVariant = "primary" | "danger" | "quiet";
