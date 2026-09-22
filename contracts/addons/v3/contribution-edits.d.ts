/** Mounted contribution guards. Handles expire on removal or generation abort. */
export interface BrowserContributionEditState {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly retainOnQueryChange?: boolean;
}
export interface BrowserContributionEditHandle {
  set(state: BrowserContributionEditState): void;
  /** Optional for integrated record article sections; feature-detect on older hosts. */
  readonly handoff?: BrowserContributionHandoff;
}
/** Page-memory transfer to the same contribution/record after reload or update. */
export interface BrowserContributionHandoff {
  /** Detached plain JSON, at most 2 MiB, depth 40 and 100,000 values. Undefined clears it. */
  checkpoint(value: unknown): void;
  /** One detached copy per replacement mount; undefined when nothing was handed off. */
  take(): unknown;
}
