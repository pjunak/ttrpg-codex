export interface UIControlsFixture {
 readonly queries: string[]; readonly submissions: Record<string, FormDataEntryValue>[]; readonly changes: number; readonly pendingClicks: number;
 refresh(): void; dispose(): void; abort(): void; reattach(): void;
 theme(value: string): void; locale(value: string): void; options(count: number): void; state(value: string): void;
 disabled(value: boolean): void; value(value: string): void; sdk(): Promise<() => void>;
}
declare global { interface Window { uiControlsFixture: UIControlsFixture } }
