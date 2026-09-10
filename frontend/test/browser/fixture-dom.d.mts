import type { FixtureCampaign } from './fixture-types.mts';

export interface CampaignElement extends HTMLElement {
  campaign: FixtureCampaign;
  saving: boolean;
}
export interface GraphElement extends CampaignElement {
  mode: string;
  positions: ReadonlyMap<string, { x: number; y: number }>;
  pan: { x: number; y: number };
  zoom: number;
  updateComplete: Promise<boolean>;
}

declare global {
  interface HTMLElementTagNameMap {
    'codex-settings': CampaignElement;
    'codex-party-settings': CampaignElement;
    'codex-dm-dashboard': CampaignElement;
    'codex-campaign-graph': GraphElement;
    'codex-timeline': CampaignElement & { draft: unknown };
    'codex-credential-settings': HTMLElement & { loading: boolean };
    'codex-recovery-settings': HTMLElement & { busy: boolean; listing: unknown };
    'codex-app': HTMLElement & { busy: boolean };
  }
  interface Window {
    graphStorageBlocked: boolean;
    graphAnimationFrames: number;
    detachedGraphObservations: number;
    departedGraph: GraphElement;
    heldCard: Element | null;
    savedOpen: typeof window.open;
    originalCharacterSheet: Element | null;
  }
}
